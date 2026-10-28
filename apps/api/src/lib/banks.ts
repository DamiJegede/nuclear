import type { Env } from "../env";
import type { Sql } from "../db";
import { imageUrl } from "./images";

/**
 * Banks: one row per routing number (`banks`), shared by every payout bank, so a bank is looked up once, not once per account.
 * `instant` is true when the bank receives instant payments (RTP or FedNow), false when it does not, and NULL when we have not been able to
 * find out; NULL is treated as "not instant" when a payout is sent (it then goes by same-day ACH), never as a reason to refuse the bank.
 * The directory (Cross River, through the banking server) gives the name and the networks; it has no pictures, so an admin uploads the icon.
 */
export type Network = "RTP" | "FedNow";
export type DirectoryAnswer = { found: boolean; name: string | null; instant: boolean; networks: Network[] };

/** The banking server's side of a lookup. A real client calls it over HTTPS (signed); tests pass their own. Throws when it cannot get an answer. */
export interface BankingClient {
  lookupBank(routingNumber: string): Promise<DirectoryAnswer>;
}

export type BankRow = {
  id: string; routing_number: string; name: string | null; icon: string | null; instant: boolean | null; networks: Network[];
  refreshed_at: Date | null; created_at: Date;
};
export const BANK_COLS = "id, routing_number, name, icon, instant, networks, refreshed_at, created_at";

/** How long a directory answer is trusted, and how long to wait before trying a bank again after a failed lookup. */
export const STALE_DAYS = 30;
export const RETRY_AFTER_FAILURE_HOURS = 1;
const LOOKUP_TIMEOUT_MS = 3000;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Signs a body for the banking server: `t:<seconds>,v1:<hmac-sha256 hex of "<seconds>.<body>">` (the same shape as Cross River's own signature). */
export async function signBankingBody(secret: string, body: string, now = Date.now()): Promise<string> {
  const t = Math.floor(now / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `t:${t},v1:${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)))}`;
}

/** The client for this deployment: an injected one (tests), the HTTP client when the banking server is configured, else null (answers stay unknown). */
export function bankingClient(env: Env): BankingClient | null {
  if (env.BANKING_CLIENT) return env.BANKING_CLIENT;
  if (!env.BANKING_URL || !env.BANKING_SECRET) return null;
  const base = env.BANKING_URL.replace(/\/+$/, ""), secret = env.BANKING_SECRET;
  return {
    async lookupBank(routingNumber) {
      const body = JSON.stringify({ routing_number: routingNumber });
      const res = await fetch(`${base}/v1/banks/lookup`, {
        method: "POST", body, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        headers: { "content-type": "application/json", "x-nuclear-signature": await signBankingBody(secret, body) },
      });
      if (!res.ok) throw new Error(`banking server ${res.status}`);
      const j = (await res.json()) as Partial<DirectoryAnswer>;
      return { found: !!j.found, name: typeof j.name === "string" && j.name ? j.name.slice(0, 120) : null, instant: !!j.instant, networks: (j.networks ?? []).filter((n): n is Network => n === "RTP" || n === "FedNow") };
    },
  };
}

/** The bank row for a routing number, created on first sight (two requests at once end with the same row). */
export async function ensureBank(sql: Sql, routing: string): Promise<BankRow> {
  await sql`insert into banks (routing_number) values (${routing}) on conflict (routing_number) do nothing`;
  const [b] = await sql<BankRow[]>`select ${sql.unsafe(BANK_COLS)} from banks where routing_number = ${routing}`;
  return b!;
}

export const isStale = (b: Pick<BankRow, "refreshed_at">, now = Date.now()) =>
  !b.refreshed_at || b.refreshed_at.getTime() < now - STALE_DAYS * 86_400_000;

/**
 * Reads the directory for one bank when its answer is missing or old. Exactly one caller wins the right to look (an attempt marker per
 * routing number, valid for an hour), so a rush of merchants adding the same bank causes one lookup. A failure leaves everything as it was
 * (`refreshed_at` only moves on success) and the bank is tried again after an hour. Never throws: the caller just gets the bank as it is.
 */
export async function refreshBank(env: Env, sql: Sql, bank: BankRow, client: BankingClient | null = bankingClient(env), now = Date.now()): Promise<BankRow> {
  if (!client || !isStale(bank, now)) return bank;
  const [claim] = await sql`
    insert into system (key, value) values (${`bank_lookup:${bank.routing_number}`}, ${new Date(now).toISOString()})
    on conflict (key) do update set value = excluded.value, updated_at = now()
     where system.value::timestamptz < ${new Date(now - RETRY_AFTER_FAILURE_HOURS * 3_600_000).toISOString()}::timestamptz
    returning key`;
  if (!claim) return bank;
  try {
    const a = await client.lookupBank(bank.routing_number);
    const [b] = await sql<BankRow[]>`
      update banks set instant = ${a.found && a.instant}, networks = ${`{${(a.found ? a.networks : []).join(",")}}`}::text[], refreshed_at = now(),
                       name = coalesce(name, ${a.name})
       where id = ${bank.id} returning ${sql.unsafe(BANK_COLS)}`;
    return b ?? bank;
  } catch (err) {
    console.error("bank lookup failed", bank.routing_number, err);
    return bank;
  }
}

/** The nightly job: refresh the banks in use whose answer is missing or old, oldest first, a few at a time. */
export async function refreshStaleBanks(env: Env, sql: Sql, limit = 50): Promise<{ checked: number; refreshed: number }> {
  const client = bankingClient(env);
  if (!client) return { checked: 0, refreshed: 0 };
  const rows = await sql<BankRow[]>`
    select ${sql.unsafe(BANK_COLS.split(", ").map((c) => `b.${c}`).join(", "))} from banks b
     where (b.refreshed_at is null or b.refreshed_at < now() - ${`${STALE_DAYS} days`}::interval)
       and exists (select 1 from bank_accounts a where a.bank_id = b.id and a.status = 'active')
     order by b.refreshed_at nulls first, b.id limit ${limit}`;
  let refreshed = 0;
  for (const b of rows) {
    const after = await refreshBank(env, sql, b, client);
    if (after.refreshed_at && (!b.refreshed_at || after.refreshed_at > b.refreshed_at)) refreshed += 1;
  }
  return { checked: rows.length, refreshed };
}

/** What the apps and portals get to know about a bank. `instant` null = not known. */
export const bankView = (b: Pick<BankRow, "id" | "name" | "icon" | "instant"> | null | undefined) =>
  b ? { id: b.id, name: b.name, icon: imageUrl(b.icon), instant: b.instant } : null;
