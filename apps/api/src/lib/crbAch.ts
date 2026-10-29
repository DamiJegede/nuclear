import type { Sql } from "../db";
import type { Env } from "../env";
import type { AchItem, AchOutcome, AchProvider } from "./ach";
import { revealBank } from "./bank";
import { crbClient, CrbError, type CrbClient } from "./crb";

/**
 * The payout rail on Cross River: ACH for the nightly run and same-day close-outs, instant payments (`/rtp`) for banks that take them.
 * Each settlement row is one payment at the bank (its id is the idempotency key and the `clientIdentifier`), and the row's
 * `provider_reference` says which: `ach:<payment id>` or `rtp:<payment id>`. Two references stand for a definitive "no" at creation, so the row can
 * finish without a payment existing: `retry:<code>` (an instant payment the bank cannot take: pay it by same-day ACH) and `fail:<code>`.
 * The answer to "did it arrive" comes from the bank's webhooks (lib/crbHooks.ts); `outcomes` reads the same status for the daily catch-up.
 */
type Payment = { id: string; status?: string; postingCode?: string; result?: { code?: string } };

/** What the bank prints on a statement: ASCII only, upper case, a fixed length. */
const ascii = (s: string, n: number) => s.normalize("NFKD").replace(/[^\x20-\x7E]/g, "").replace(/[^A-Za-z0-9 .&'-]/g, " ").replace(/\s+/g, " ").trim().toUpperCase().slice(0, n);

export function crbProvider(env: Env, sql: Sql, crb: CrbClient | null = crbClient(env)): AchProvider | null {
  if (!crb || !env.CR_ACCOUNT) return null;
  const account = env.CR_ACCOUNT;

  async function findByClient(kind: "ach" | "rtp", id: string): Promise<Payment | null> {
    const r = await crb!.call<{ results?: Payment[] }>("GET", `/${kind}/v1/payments?filter.clientIdentifier=${encodeURIComponent(id)}`);
    return r.results?.[0] ?? null;
  }

  /** Creates the payment and returns the row's reference. Throws when the bank could not be reached (the row stays unsent and the next run tries again). */
  async function sendItem(item: AchItem): Promise<string> {
    const kind = item.rail === "instant" ? "rtp" : "ach";
    const bank = await revealBank(sql, env, item.bankAccountId, { type: "system", label: "settlement" }, `payout ${item.itemId}`);
    if (!bank) return `fail:no_account`;
    const [biz] = await sql<{ name: string | null }[]>`select coalesce(display_name, legal_name) as name from businesses where account_id = ${item.accountId}`;
    const name = ascii(biz?.name ?? "", 22) || "MERCHANT";
    const amount = Number(item.amountCents);
    const body = kind === "rtp"
      ? { accountNumber: account, amount, ...(env.CR_RTP_NETWORK ? { networkPlatform: env.CR_RTP_NETWORK } : {}), clientIdentifier: item.itemId,
          creditor: { name, accountNumber: bank.account_number, routingNumber: bank.routing_number } }
      : { accountNumber: account, receiver: { routingNumber: bank.routing_number, accountNumber: bank.account_number, accountType: "Checking", name, identification: item.itemId.replace(/-/g, "").slice(-15) },
          secCode: "CCD", description: "NUCLEAR", transactionType: item.direction === "credit" ? "Push" : "Pull", amount, serviceType: item.serviceType, clientIdentifier: item.itemId };
    try {
      const p = await crb!.call<Payment>("POST", `/${kind}/v1/payments`, { body, idem: item.itemId });
      return `${kind}:${p.id}`;
    } catch (err) {
      if (err instanceof CrbError && err.definitive) {
        const code = err.codes[0] ? String(err.codes[0]) : "rejected";
        console.error(`bank refused payout ${item.itemId}: ${code} ${err.message}`);
        return kind === "rtp" ? `retry:${code}` : `fail:${code}`;
      }
      // No answer (a timeout, an outage): the payment may exist. Ask by our id before giving up, so a retry never pays twice.
      const found = await findByClient(kind, item.itemId).catch(() => null);
      if (found) return `${kind}:${found.id}`;
      throw err;
    }
  }

  return {
    name: "crossriver",
    async submit(batchKey, items) {
      const references: Record<string, string> = {};
      let failure: unknown = null;
      for (const item of items) {
        try { references[item.itemId] = await sendItem(item); } catch (err) { failure = err; break; }
      }
      if (Object.keys(references).length === 0) throw failure ?? new Error("bank accepted nothing");
      if (failure) console.error("bank batch stopped early; the rest is sent by the next run", failure);
      return { reference: batchKey, references };
    },
    async outcomes(ref, items) {
      const out: AchOutcome[] = [];
      for (const item of items) {
        const o = await outcomeOf(crb, ref);
        if (o) out.push({ itemId: item.itemId, ...o });
      }
      return out;
    },
  };
}

/** The result a reference stands for, or null while the payment is still on its way. */
export async function outcomeOf(crb: CrbClient, ref: string): Promise<{ outcome: AchOutcome["outcome"]; code?: string } | null> {
  const [kind, id] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
  if (kind === "retry") return { outcome: "retry_ach", code: id };
  if (kind === "fail") return { outcome: "returned", code: id };
  if (kind !== "ach" && kind !== "rtp") return null;
  const p = await crb.call<Payment>("GET", `/${kind}/v1/payments/${encodeURIComponent(id)}`);
  const s = (p.status ?? "").toLowerCase();
  const code = (p.postingCode ?? p.result?.code ?? s) || "rejected";
  if (s === "completed") return { outcome: "settled" };
  if (kind === "ach") return s === "rejected" || s === "canceled" || s === "blocked" ? { outcome: "returned", code } : null;
  // Instant: our own account's lack of money is ours to fix, anything else (the receiving bank said no, a timeout) goes by same-day ACH.
  if (s === "rejected" || s === "canceled" || s === "timedout") return p.postingCode === "NSF" ? { outcome: "returned", code: "NSF" } : { outcome: "retry_ach", code };
  return null;
}
