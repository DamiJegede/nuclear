import type { TransactionSql } from "postgres";
import type { Sql } from "../db";
import type { Env } from "../env";
import { achProvider, type AchItem, type AchProvider } from "./ach";
import { log } from "./audit";
import { addDays, easternDate } from "./dates";
import { BANK_WALLET, SYSTEM_ACCOUNT } from "./system";
import { insertTx } from "./txn";

type Tx = TransactionSql<{ bigint: bigint }>;

/**
 * Merchant settlement (docs/SCHEME-V2.md, section 5; one `settlements` row per merchant per day).
 *
 * Once a day, after midnight New York time, every active merchant with a payout bank is settled for its WHOLE net balance, never a part:
 *
 *   * positive net -> a payout (`direction = 'credit'`). The money leaves the merchant's balance at once (so a sale a second later belongs to
 *     the next cycle and the same money can never be paid twice) and a `settle` transaction goes from the merchant's wallet to the bank.
 *   * negative net (refunds exceeded sales) -> a collection (`direction = 'debit'`) from the merchant's bank. NOTHING moves until the bank
 *     confirms: submitting a debit does not clear the debt. Collections still in flight are counted, so the same debt is never collected twice.
 *   * zero -> nothing.
 *
 * The bank's answer finishes the row. A payout the bank returns is reversed by a `settle_return` transaction (bank to merchant) and the row
 * is `returned`; a collection that arrives writes a `collect` transaction (bank to merchant); a collection the bank returns leaves the debt
 * standing and it is collected again in the next run. Customers' refunds are never affected. Transactions are never updated.
 *
 * Close out (`closeOut`): the merchant can run its own sweep at any time ("end the day"): the same whole-balance sweep, for today's date, source
 * `close_out`. Still ONE settlement per merchant per day: a second close-out is refused and the nightly run skips a merchant already settled for
 * the day, so anything sold after a close-out simply stays in the balance and is swept by the next day's settlement. A close-out never collects
 * (a negative balance is left to the nightly run). Instant payments (the bank's `routing_numbers.instant`) go by RTP or FedNow; a bank that is not (or not
 * known to be) instant gets same-day ACH, and an instant payment the bank cannot take falls back to same-day ACH too.
 *
 * Safety: (settle_date, merchant) is unique and each transaction's key (`settle:<merchant>:<date>`) is unique, so a repeated or overlapping
 * run (the cron fires twice a day) cannot settle anyone twice; a run that stopped half way is finished by the next call. If the cron is
 * missed, the next run's net already includes everything since (the net is the live balance).
 */

export type RunSummary =
  | { ran: false; reason: "no_provider" | "already_done" }
  | { ran: true; cutoff_date: string; created: number; payouts: number; collections: number; payout_total: number; collection_total: number; status: string };

/** Settles the program day before `today`. Safe to call repeatedly. */
export async function runSettlement(env: Env, sql: Sql, today: string, provider: AchProvider | null = achProvider(env, sql)): Promise<RunSummary> {
  if (!provider) return { ran: false, reason: "no_provider" };
  const date = addDays(today, -1);
  const [done] = await sql<{ value: string }[]>`select value from system where key = 'settled_day'`;
  if (done && done.value >= date) return { ran: false, reason: "already_done" };

  const due = await sql<{ id: string }[]>`
    select a.id
      from accounts a
      join balances b on b.account_id = a.id
      join businesses bz on bz.account_id = a.id
      join bank_accounts ba on ba.id = bz.bank_account_id and ba.status = 'active'
     where a.type = 'B' and a.status = 'active'
       and (b.balance <> 0 or exists (select 1 from settlements s where s.merchant_account_id = a.id and s.direction = 'debit' and s.status = 'submitted'))
     order by a.id`;
  let created = 0;
  for (const m of due) {
    if ((await sweepMerchant(sql, date, m.id, "nightly")).ok) created += 1;
  }

  const items = await openItems(sql, date, true);
  if (items.length > 0) {
    try {
      await submitItems(sql, provider, date, items);
    } catch (err) {
      console.error("settlement submit failed", err);
      await failDay(sql, date, "submit_failed");
      await markDone(sql, date);
      return summarize(sql, date, created);
    }
    await confirmSettlement(sql, date, provider);
  }
  await markDone(sql, date);
  return summarize(sql, date, created);
}

/** The cron's day claim only moves forward; a run that stopped half way never reaches it and is finished by the next call. */
const markDone = (sql: Sql, date: string) => sql`
  insert into system (key, value) values ('settled_day', ${date}) on conflict (key) do update set value = excluded.value where system.value < excluded.value`;

export type Sweep =
  | { ok: true; id: string; amount: bigint; direction: "credit" | "debit"; rail: "instant" | "ach" }
  | { ok: false; reason: "no_bank" | "inactive" | "already_settled" | "nothing_to_settle" | "owes"; owed?: bigint };

/**
 * One merchant: works out the net under the balance lock and records the payout or collection. A close-out (`allowDebit` false) turns a negative
 * net away (`owes`); the nightly run records it as a collection. Credits go by the bank's best rail; a collection is always ACH.
 */
async function sweepMerchant(sql: Sql, date: string, accountId: string, source: "nightly" | "close_out"): Promise<Sweep> {
  return sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Tx;
    const [[bal], [bank], [inflight], [wallet], [acct]] = await Promise.all([
      tx<{ balance: bigint }[]>`select balance from balances where account_id = ${accountId} for no key update`,
      tx<{ id: string; instant: boolean | null }[]>`
        select ba.id, bk.instant from businesses bz join bank_accounts ba on ba.id = bz.bank_account_id and ba.status = 'active'
          left join routing_numbers bk on bk.id = ba.routing_number_id where bz.account_id = ${accountId}`,
      // Collections the bank has not answered yet already count against the debt.
      tx<{ total: bigint }[]>`
        select coalesce(sum(amount), 0)::bigint as total from settlements
         where merchant_account_id = ${accountId} and direction = 'debit' and status = 'submitted'`,
      tx<{ id: string }[]>`select id from wallets where account_id = ${accountId} and type = 'default'`,
      tx<{ status: string }[]>`select status from accounts where id = ${accountId}`,
    ]);
    if (!acct || acct.status !== "active") return { ok: false, reason: "inactive" } as Sweep;
    if (!bal || !bank || !wallet) return { ok: false, reason: "no_bank" } as Sweep;
    const net = bal.balance + inflight!.total;
    if (net === 0n) return { ok: false, reason: "nothing_to_settle" } as Sweep;
    if (net < 0n && source === "close_out") return { ok: false, reason: "owes", owed: -net } as Sweep;
    const amount = net > 0n ? net : -net;
    const rail = net > 0n && bank.instant === true ? "instant" : "ach";

    const [s] = await tx<{ id: string }[]>`
      insert into settlements (settle_date, merchant_account_id, bank_account_id, direction, amount, source, rail)
      values (${date}::date, ${accountId}, ${bank.id}, ${net > 0n ? "credit" : "debit"}, ${amount.toString()}, ${source}, ${rail})
      on conflict (settle_date, merchant_account_id) do nothing returning id`;
    if (!s) return { ok: false, reason: "already_settled" } as Sweep;             // this merchant was already settled for the date
    if (net > 0n) {
      await Promise.all([
        tx`update balances set balance = balance - ${amount.toString()} where account_id = ${accountId}`,
        insertTx(tx, { type: "settle", from: wallet.id, to: BANK_WALLET, amount, settlement: s.id, account: SYSTEM_ACCOUNT, idem: `settle:${accountId}:${date}` }),
      ]);
    }
    return { ok: true, id: s.id, amount, direction: net > 0n ? "credit" : "debit", rail } as Sweep;
  }) as Promise<Sweep>;
}

/** A Postgres array literal of row ids (they come from our own database, so they are plain uuids): the driver here does not serialize uuid arrays. */
const pgUuidArray = (ids: string[]) => `{${ids.join(",")}}`;

const ITEM_COLS = `id as "itemId", direction, amount as "amountCents", bank_account_id as "bankAccountId", merchant_account_id as "accountId", rail,
    case when source = 'close_out' then 'SameDay' else 'Standard' end as "serviceType"`;

/** Sends items to the bank and remembers its reference on exactly those rows. Throws when the bank accepted nothing. */
async function submitItems(sql: Sql, provider: AchProvider, batchKey: string, items: AchItem[]) {
  const sub = await provider.submit(batchKey, items);
  if (sub.references) {
    const refs = Object.entries(sub.references);
    await sql.begin((tx) => refs.map(([id, ref]) => tx`update settlements set provider_reference = ${ref} where id = ${id} and status = 'submitted'`));
    return;
  }
  await sql`update settlements set provider_reference = ${sub.reference} where id = any(${pgUuidArray(items.map((i) => i.itemId))}::uuid[]) and status = 'submitted'`;
}

export type CloseOutResult =
  | { ok: true; settlement: { id: string; date: string; amount: number; rail: "instant" | "ach"; status: string; arrival: "instant" | "today" | "next_business_day" } }
  | { ok: false; error: "payouts_unavailable" | "no_bank" | "account_inactive" | "already_closed_out" | "nothing_to_close_out" | "owes"; owed?: number };

/** Same-day ACH is cut off at this time (Eastern); after it, or on a weekend, a payout goes the next business day. Confirm the bank's windows (docs/CROSS-RIVER.md). */
export const SAME_DAY_CUTOFF_HOUR_ET = 16;

/** When the money reaches the merchant's bank, as far as we can tell now. Holidays are not known here. */
export function arrivalOf(rail: "instant" | "ach", now: Date): "instant" | "today" | "next_business_day" {
  if (rail === "instant") return "instant";
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(now);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(now)) % 24;
  return wd === "Sat" || wd === "Sun" || hour >= SAME_DAY_CUTOFF_HOUR_ET ? "next_business_day" : "today";
}

/**
 * "Close out": the merchant ends its day now. The whole balance is paid out at once, for today's date, and everything sold afterwards belongs
 * to the next day. The balance drops under the lock before anything is sent (so a double click, or a sale a moment later, cannot pay the same money
 * twice); if the bank cannot be reached the row simply stays `submitted` and the next run sends it (the bank sees our row id as the idempotency key).
 */
export async function closeOut(env: Env, sql: Sql, accountId: string, provider: AchProvider | null = achProvider(env, sql), now = new Date()): Promise<CloseOutResult> {
  if (!provider) return { ok: false, error: "payouts_unavailable" };
  const date = easternDate(now);
  const sweep = await sweepMerchant(sql, date, accountId, "close_out");
  if (!sweep.ok) {
    const error = ({ no_bank: "no_bank", inactive: "account_inactive", already_settled: "already_closed_out", nothing_to_settle: "nothing_to_close_out", owes: "owes" } as const)[sweep.reason];
    return { ok: false, error, ...(sweep.owed !== undefined ? { owed: Number(sweep.owed) } : {}) };
  }
  const item: AchItem = { itemId: sweep.id, direction: "credit", amountCents: sweep.amount, bankAccountId: "", accountId, rail: sweep.rail, serviceType: "SameDay" };
  const [row] = await sql<{ bank_account_id: string }[]>`select bank_account_id from settlements where id = ${sweep.id}`;
  item.bankAccountId = row!.bank_account_id;
  try {
    await submitItems(sql, provider, `${date}:${accountId}`, [item]);
    await confirmItems(sql, provider, [sweep.id]);
  } catch (err) {
    console.error("close-out submit failed; the next run sends it", err);
  }
  await log(sql, { actor: { type: "customer", id: accountId }, action: "merchant.closed_out", target: { type: "settlement", id: sweep.id, label: date }, details: { amount: Number(sweep.amount), rail: sweep.rail } });
  const [fin] = await sql<{ status: string; rail: "instant" | "ach" }[]>`select status, rail from settlements where id = ${sweep.id}`;
  return { ok: true, settlement: { id: sweep.id, date, amount: Number(sweep.amount), rail: fin!.rail, status: fin!.status, arrival: arrivalOf(fin!.rail, now) } };
}

/** The day's rows still waiting for the bank. With `fresh`: every row up to that day that was never sent (a close-out made while the bank was unreachable, or a missed run). */
const openItems = (sql: Sql, date: string, fresh = false) => sql<AchItem[]>`
  select ${sql.unsafe(ITEM_COLS)}
    from settlements where ${fresh ? sql`settle_date <= ${date}::date and provider_reference is null` : sql`settle_date = ${date}::date`} and status = 'submitted' order by id`;

/** Asks the bank for results and finishes every row it has answered. */
export async function confirmSettlement(sql: Sql, date: string, provider: AchProvider | null): Promise<{ status: string; settled: number; returned: number }> {
  const [run] = await sql<{ n: number }[]>`select count(*)::int as n from settlements where settle_date = ${date}::date`;
  if (!run || run.n === 0) return { status: "missing", settled: 0, returned: 0 };
  let settled = 0, returned = 0;
  if (provider) {
    const ids = await sql<{ id: string }[]>`select id from settlements where settle_date = ${date}::date and status = 'submitted' and provider_reference is not null order by id`;
    const r = await confirmItems(sql, provider, ids.map((x) => x.id));
    settled = r.settled; returned = r.returned;
  }
  const [left] = await sql<{ n: number }[]>`select count(*)::int as n from settlements where settle_date = ${date}::date and status = 'submitted'`;
  if (left!.n === 0) {
    await log(sql, { actor: { type: "system", label: "settlement" }, action: "settlement.completed", target: { type: "settlement", label: date }, details: { date, settled, returned } });
    return { status: "completed", settled, returned };
  }
  return { status: "submitted", settled, returned };
}

/**
 * Asks the bank for the answer to these waiting rows and finishes the ones it has answered. An instant payment the bank cannot take (`retry_ach`)
 * is moved to same-day ACH, sent at once and asked about again, once; an item still waiting is simply left for the next poll.
 */
export async function confirmItems(sql: Sql, provider: AchProvider, ids: string[]): Promise<{ settled: number; returned: number; retried: number }> {
  let settled = 0, returned = 0, retried = 0;
  let pending = ids;
  for (let pass = 0; pass < 2 && pending.length > 0; pass++) {
    const items = await sql<(AchItem & { ref: string })[]>`
      select ${sql.unsafe(ITEM_COLS)}, provider_reference as ref from settlements
       where id = any(${pgUuidArray(pending)}::uuid[]) and status = 'submitted' and provider_reference is not null order by id`;
    const again: AchItem[] = [];
    for (const ref of new Set(items.map((i) => i.ref))) {
      const batch = items.filter((i) => i.ref === ref);
      for (const r of await provider.outcomes(ref, batch)) {
        const item = batch.find((i) => i.itemId === r.itemId);
        if (!item) continue;
        if (r.outcome === "retry_ach") {
          const [moved] = await sql<{ id: string }[]>`
            update settlements set rail = 'ach', provider_reference = null where id = ${item.itemId} and status = 'submitted' and rail = 'instant' returning id`;
          if (moved) { again.push({ ...item, rail: "ach", serviceType: "SameDay" }); retried += 1; }
        } else if (await finishItem(sql, item, r.outcome === "settled" ? null : r.code ?? "bank_returned", "returned")) {
          if (r.outcome === "settled") settled += 1; else returned += 1;
        }
      }
    }
    if (again.length === 0) break;
    await submitItems(sql, provider, `retry:${again[0]!.itemId}`, again);
    pending = again.map((i) => i.itemId);
  }
  return { settled, returned, retried };
}

/**
 * Applies the bank's answer to one waiting row (a repeat finds nothing waiting and does nothing).
 * `code` null = settled; otherwise the bank returned it (`outcome` is the status the row ends in: `returned`, or `failed` when the batch was refused).
 */
async function finishItem(sql: Sql, item: AchItem, code: string | null, outcome: "returned" | "failed", from: string[] = ["submitted"]): Promise<boolean> {
  return sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Tx;
    const [s] = await tx<{ id: string; settle_date: string }[]>`
      select id, settle_date::text from settlements where id = ${item.itemId} and status = any(${`{${from.join(",")}}`}::text[]) for no key update`;
    if (!s) return false;
    const amt = item.amountCents.toString();
    // Same lock order as the money paths: the balance row.
    await tx`select 1 from balances where account_id = ${item.accountId} for no key update`;
    const [wallet] = await tx<{ id: string }[]>`select id from wallets where account_id = ${item.accountId} and type = 'default'`;
    if (code === null) {
      if (item.direction === "debit") {
        // The collection arrived: the merchant's debt is cleared now, not before.
        await Promise.all([
          tx`update balances set balance = balance + ${amt} where account_id = ${item.accountId}`,
          insertTx(tx, { type: "collect", from: BANK_WALLET, to: wallet!.id, amount: item.amountCents, settlement: s.id, account: SYSTEM_ACCOUNT, idem: `collect:${item.accountId}:${s.settle_date}` }),
        ]);
      }
      await tx`update settlements set status = 'settled', failure_code = null, resolved_at = now() where id = ${s.id}`;
      return true;
    }
    if (item.direction === "credit") {
      // A payout the bank did not take goes back into the merchant's balance, as a new transaction.
      const [paid] = await tx<{ id: string }[]>`select id from transactions where settlement_id = ${s.id} and type = 'settle'`;
      await Promise.all([
        tx`update balances set balance = balance + ${amt} where account_id = ${item.accountId}`,
        insertTx(tx, { type: "settle_return", from: BANK_WALLET, to: wallet!.id, amount: item.amountCents, related: paid!.id, settlement: s.id, account: SYSTEM_ACCOUNT, idem: `settle_return:${item.accountId}:${s.settle_date}` }),
      ]);
    }
    await tx`update settlements set status = ${outcome}, failure_code = ${code}, resolved_at = now() where id = ${s.id}`;
    return true;
  }) as Promise<boolean>;
}

/**
 * The bank sent an item back after it had arrived (an ACH return can come days later). A payout goes back into the merchant's balance, as when a
 * payout is returned before it settles. A collection that had arrived is taken back out: a `collect_return` transaction (merchant to Nuclear Bank,
 * related to the `collect`) puts the debt back and the next nightly run collects it again. `settled` and `submitted` rows are both accepted; a
 * repeat finds a `returned` row and does nothing.
 */
export async function returnItem(sql: Sql, settlementId: string, code: string): Promise<"returned" | "ignored"> {
  const [item] = await sql<(AchItem & { status: string })[]>`select ${sql.unsafe(ITEM_COLS)}, status from settlements where id = ${settlementId}`;
  if (!item || (item.status !== "submitted" && item.status !== "settled")) return "ignored";
  if (item.direction === "debit" && item.status === "settled") return takeBackCollection(sql, item, code);
  return (await finishItem(sql, item, code, "returned", ["submitted", "settled"])) ? "returned" : "ignored";
}

async function takeBackCollection(sql: Sql, item: AchItem, code: string): Promise<"returned" | "ignored"> {
  return sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Tx;
    const [s] = await tx<{ id: string; settle_date: string }[]>`select id, settle_date::text from settlements where id = ${item.itemId} and status = 'settled' for no key update`;
    if (!s) return "ignored";
    await tx`select 1 from balances where account_id = ${item.accountId} for no key update`;
    const [wallet] = await tx<{ id: string }[]>`select id from wallets where account_id = ${item.accountId} and type = 'default'`;
    const [collected] = await tx<{ id: string }[]>`select id from transactions where settlement_id = ${s.id} and type = 'collect'`;
    const amt = item.amountCents.toString();
    await Promise.all([
      tx`update balances set balance = balance - ${amt} where account_id = ${item.accountId}`,
      insertTx(tx, { type: "collect_return", from: wallet!.id, to: BANK_WALLET, amount: item.amountCents, related: collected!.id, settlement: s.id, account: SYSTEM_ACCOUNT, idem: `collect_return:${item.accountId}:${s.settle_date}` }),
      tx`update settlements set status = 'returned', failure_code = ${code}, resolved_at = now() where id = ${s.id}`,
    ]);
    return "returned";
  }) as Promise<"returned" | "ignored">;
}

/** The whole batch was refused: give every payout back and fail every waiting row. */
async function failDay(sql: Sql, date: string, code: string) {
  const items = await openItems(sql, date);
  for (const i of items) await finishItem(sql, i, code, "failed").catch((e) => console.error("settlement reverse failed", e));
  await log(sql, { actor: { type: "system", label: "settlement" }, action: "settlement.failed", target: { type: "settlement", label: date }, details: { date, code } });
}

async function summarize(sql: Sql, date: string, created: number): Promise<RunSummary> {
  const [s] = await sql<{ payouts: number; collections: number; payout_total: bigint; collection_total: bigint; open: number; failed: number; total: number }[]>`
    select count(*) filter (where direction = 'credit')::int as payouts,
           count(*) filter (where direction = 'debit')::int as collections,
           coalesce(sum(amount) filter (where direction = 'credit'), 0)::bigint as payout_total,
           coalesce(sum(amount) filter (where direction = 'debit'), 0)::bigint as collection_total,
           count(*) filter (where status = 'submitted')::int as open,
           count(*) filter (where status = 'failed')::int as failed,
           count(*)::int as total
      from settlements where settle_date = ${date}::date`;
  const status = s!.open > 0 ? "submitted" : s!.total > 0 && s!.failed === s!.total ? "failed" : "completed";
  return { ran: true, cutoff_date: date, created, payouts: s!.payouts, collections: s!.collections, payout_total: Number(s!.payout_total), collection_total: Number(s!.collection_total), status };
}

/** The daily job also polls days the bank had not answered yet. */
export async function pollSubmittedSettlements(env: Env, sql: Sql, provider: AchProvider | null = achProvider(env, sql)) {
  const days = await sql<{ d: string }[]>`select distinct settle_date::text as d from settlements where status = 'submitted' order by d`;
  let completed = 0;
  for (const r of days) if ((await confirmSettlement(sql, r.d, provider)).status === "completed") completed += 1;
  return { polled: days.length, completed };
}
