import type { Env } from "../env";
import type { Sql } from "../db";
import { imageUrl } from "./images";

/**
 * Routing numbers (`routing_numbers`, one row per 9-digit number, shared by every bank account that uses it, so a number is looked up once, not once
 * per account) and the institutions they belong to (`institutions`: Chase, Wells Fargo...; the display name and the logo, uploaded once however many
 * routing numbers the institution has). `instant` is true when the bank receives instant payments (RTP or FedNow), false when it does not, and NULL when
 * we have not been able to find out; NULL is treated as "not instant" when a payout is sent (it then goes by same-day ACH), never as a reason to refuse
 * the bank. The directory (Cross River, through the banking server) gives the name as it spells it and the networks; it has no pictures, so an admin
 * uploads each institution's logo, and a routing number is linked to its institution by name (aliases) or by an admin.
 */
export type Network = "RTP" | "FedNow";
export type DirectoryAnswer = { found: boolean; name: string | null; instant: boolean; networks: Network[] };

/** The banking server's side of a lookup. A real client calls it over HTTPS (signed); tests pass their own. Throws when it cannot get an answer. */
export interface BankingClient {
  lookupBank(routingNumber: string): Promise<DirectoryAnswer>;
}

/** A routing number as the apps see it: the number's own facts plus its institution's display name and logo (the directory's name when it has no institution yet). */
export type RoutingRow = {
  id: string; routing_number: string; directory_name: string | null; institution_id: string | null; instant: boolean | null; networks: Network[];
  refreshed_at: Date | null; created_at: Date; name: string | null; icon: string | null;
};
/** `routing_numbers r left join institutions i`: the select list and the from clause that give a RoutingRow. */
export const ROUTING_COLS = "r.id, r.routing_number, r.directory_name, r.institution_id, r.instant, r.networks, r.refreshed_at, r.created_at, coalesce(i.name, r.directory_name) as name, i.icon";
export const ROUTING_FROM = "routing_numbers r left join institutions i on i.id = r.institution_id";

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

/** The routing number's row, created on first sight (two requests at once end with the same row). */
export async function ensureRouting(sql: Sql, routing: string): Promise<RoutingRow> {
  await sql`insert into routing_numbers (routing_number) values (${routing}) on conflict (routing_number) do nothing`;
  const [r] = await sql<RoutingRow[]>`select ${sql.unsafe(ROUTING_COLS)} from ${sql.unsafe(ROUTING_FROM)} where r.routing_number = ${routing}`;
  return r!;
}

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/** The institution whose name or alias is the longest whole-word match inside a directory name ("JPMORGAN CHASE BANK, NATIONAL ASSOCIATION" finds Chase through the alias "jpmorgan chase"). */
export async function matchInstitution(sql: Sql, directoryName: string | null): Promise<string | null> {
  if (!directoryName) return null;
  const hay = norm(directoryName);
  const rows = await sql<{ id: string; name: string; aliases: string[] }[]>`select id, name, aliases from institutions`;
  let best: { id: string; len: number } | null = null;
  for (const i of rows) {
    for (const c of [i.name, ...textArray(i.aliases)]) {
      const n = norm(c);
      if (n.trim() && hay.includes(n) && (!best || n.length > best.len)) best = { id: i.id, len: n.length };
    }
  }
  return best?.id ?? null;
}

/** Links every routing number that has no institution yet and whose directory name matches one. Returns how many were linked. */
export async function autoLinkInstitutions(sql: Sql): Promise<number> {
  const rows = await sql<{ id: string; directory_name: string }[]>`select id, directory_name from routing_numbers where institution_id is null and directory_name is not null`;
  let linked = 0;
  for (const r of rows) {
    const inst = await matchInstitution(sql, r.directory_name);
    if (inst && (await sql`update routing_numbers set institution_id = ${inst} where id = ${r.id} and institution_id is null returning id`).length) linked += 1;
  }
  return linked;
}

/** A text[] column as the driver here returns it (the raw `{a,"b c"}` literal, or already an array): the list of strings. */
export function textArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== "string" || v === "{}" || v === "") return [];
  const out: string[] = [];
  const body = v.slice(1, -1);
  const r2 = /"((?:[^"\\]|\\.)*)"|([^,]+)/g;
  let m2: RegExpExecArray | null;
  while ((m2 = r2.exec(body))) out.push(m2[1] !== undefined ? m2[1].replace(/\\(.)/g, "$1") : m2[2]!);
  return out;
}

/** The ABA checksum of a 9-digit routing number. */
export const abaOk = (r: string) => { const d = [...r].map(Number); return (3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!)) % 10 === 0; };

export const isStale = (b: Pick<RoutingRow, "refreshed_at">, now = Date.now()) =>
  !b.refreshed_at || b.refreshed_at.getTime() < now - STALE_DAYS * 86_400_000;

/**
 * Reads the directory for one bank when its answer is missing or old. Exactly one caller wins the right to look (an attempt marker per
 * routing number, valid for an hour), so a rush of merchants adding the same bank causes one lookup. A failure leaves everything as it was
 * (`refreshed_at` only moves on success) and the bank is tried again after an hour. Never throws: the caller just gets the bank as it is.
 */
export async function refreshBank(env: Env, sql: Sql, bank: RoutingRow, client: BankingClient | null = bankingClient(env), now = Date.now()): Promise<RoutingRow> {
  if (!client || !isStale(bank, now)) return bank;
  const [claim] = await sql`
    insert into system (key, value) values (${`bank_lookup:${bank.routing_number}`}, ${new Date(now).toISOString()})
    on conflict (key) do update set value = excluded.value, updated_at = now()
     where system.value::timestamptz < ${new Date(now - RETRY_AFTER_FAILURE_HOURS * 3_600_000).toISOString()}::timestamptz
    returning key`;
  if (!claim) return bank;
  try {
    const a = await client.lookupBank(bank.routing_number);
    const directoryName = a.found ? a.name ?? bank.directory_name : bank.directory_name;
    // An institution an admin chose is never replaced; a number with none is matched by its directory name.
    const inst = bank.institution_id ?? (await matchInstitution(sql, directoryName));
    await sql`
      update routing_numbers set instant = ${a.found && a.instant}, networks = ${`{${(a.found ? a.networks : []).join(",")}}`}::text[], refreshed_at = now(),
                                 directory_name = ${directoryName}, institution_id = ${inst}
       where id = ${bank.id}`;
    const [b] = await sql<RoutingRow[]>`select ${sql.unsafe(ROUTING_COLS)} from ${sql.unsafe(ROUTING_FROM)} where r.id = ${bank.id}`;
    return b ?? bank;
  } catch (err) {
    console.error("bank lookup failed", bank.routing_number, err);
    return bank;
  }
}

/** The nightly job: refresh the routing numbers in use whose answer is missing or old, oldest first, a few at a time. */
export async function refreshStaleBanks(env: Env, sql: Sql, limit = 50): Promise<{ checked: number; refreshed: number }> {
  const client = bankingClient(env);
  if (!client) return { checked: 0, refreshed: 0 };
  const rows = await sql<RoutingRow[]>`
    select ${sql.unsafe(ROUTING_COLS)} from ${sql.unsafe(ROUTING_FROM)}
     where (r.refreshed_at is null or r.refreshed_at < now() - ${`${STALE_DAYS} days`}::interval)
       and exists (select 1 from bank_accounts a where a.routing_number_id = r.id and a.status = 'active')
     order by r.refreshed_at nulls first, r.id limit ${limit}`;
  let refreshed = 0;
  for (const b of rows) {
    const after = await refreshBank(env, sql, b, client);
    if (after.refreshed_at && (!b.refreshed_at || after.refreshed_at > b.refreshed_at)) refreshed += 1;
  }
  return { checked: rows.length, refreshed };
}

/** What the apps and portals get to know about a bank: its institution's name and logo (the directory's name until it has one) and whether it takes instant payouts. `instant` null = not known. */
export const bankView = (b: Pick<RoutingRow, "id" | "name" | "icon" | "instant"> | null | undefined) =>
  b ? { id: b.id, name: b.name, icon: imageUrl(b.icon), instant: b.instant } : null;
