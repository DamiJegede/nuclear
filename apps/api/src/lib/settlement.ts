import type { TransactionSql } from "postgres";
import type { Sql } from "../db";
import type { Env } from "../env";
import { achProvider, type AchItem, type AchProvider } from "./ach";
import { log } from "./audit";
import { addDays } from "./dates";
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
 * Safety: (settle_date, merchant) is unique and each transaction's key (`settle:<merchant>:<date>`) is unique, so a repeated or overlapping
 * run (the cron fires twice a day) cannot settle anyone twice; a run that stopped half way is finished by the next call. If the cron is
 * missed, the next run's net already includes everything since (the net is the live balance).
 */

export type RunSummary =
  | { ran: false; reason: "no_provider" | "already_done" }
  | { ran: true; cutoff_date: string; created: number; payouts: number; collections: number; payout_total: number; collection_total: number; status: string };

/** Settles the program day before `today`. Safe to call repeatedly. */
export async function runSettlement(env: Env, sql: Sql, today: string, provider: AchProvider | null = achProvider(env)): Promise<RunSummary> {
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
    if (await settleMerchant(sql, date, m.id)) created += 1;
  }

  const items = await openItems(sql, date, true);
  if (items.length > 0) {
    try {
      const sub = await provider.submit(date, items);
      await sql`update settlements set provider_reference = ${sub.reference} where settle_date = ${date}::date and status = 'submitted' and provider_reference is null`;
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

/** One merchant: works out the net under the balance lock and records the payout or collection. Returns whether a row was created. */
async function settleMerchant(sql: Sql, date: string, accountId: string): Promise<boolean> {
  return sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Tx;
    const [[bal], [bank], [inflight], [wallet]] = await Promise.all([
      tx<{ balance: bigint }[]>`select balance from balances where account_id = ${accountId} for no key update`,
      tx<{ id: string }[]>`
        select ba.id from businesses bz join bank_accounts ba on ba.id = bz.bank_account_id and ba.status = 'active' where bz.account_id = ${accountId}`,
      // Collections the bank has not answered yet already count against the debt.
      tx<{ total: bigint }[]>`
        select coalesce(sum(amount), 0)::bigint as total from settlements
         where merchant_account_id = ${accountId} and direction = 'debit' and status = 'submitted'`,
      tx<{ id: string }[]>`select id from wallets where account_id = ${accountId} and type = 'default'`,
    ]);
    if (!bal || !bank || !wallet) return false;
    const net = bal.balance + inflight!.total;
    if (net === 0n) return false;
    const amount = net > 0n ? net : -net;

    const [s] = await tx<{ id: string }[]>`
      insert into settlements (settle_date, merchant_account_id, bank_account_id, direction, amount)
      values (${date}::date, ${accountId}, ${bank.id}, ${net > 0n ? "credit" : "debit"}, ${amount.toString()})
      on conflict (settle_date, merchant_account_id) do nothing returning id`;
    if (!s) return false;                                                         // this merchant was already settled for the date
    if (net > 0n) {
      await Promise.all([
        tx`update balances set balance = balance - ${amount.toString()} where account_id = ${accountId}`,
        insertTx(tx, { type: "settle", from: wallet.id, to: BANK_WALLET, amount, settlement: s.id, account: SYSTEM_ACCOUNT, idem: `settle:${accountId}:${date}` }),
      ]);
    }
    return true;
  }) as Promise<boolean>;
}

/** The day's rows still waiting for the bank (and, for `fresh`, not yet sent). */
const openItems = (sql: Sql, date: string, fresh = false) => sql<AchItem[]>`
  select id as "itemId", direction, amount as "amountCents", bank_account_id as "bankAccountId", merchant_account_id as "accountId"
    from settlements where settle_date = ${date}::date and status = 'submitted' ${fresh ? sql`and provider_reference is null` : sql``} order by id`;

/** Asks the bank for results and finishes every row it has answered. */
export async function confirmSettlement(sql: Sql, date: string, provider: AchProvider | null): Promise<{ status: string; settled: number; returned: number }> {
  const [run] = await sql<{ n: number; ref: string | null }[]>`
    select count(*)::int as n, max(provider_reference) as ref from settlements where settle_date = ${date}::date`;
  if (!run || run.n === 0) return { status: "missing", settled: 0, returned: 0 };
  const items = await sql<(AchItem & { ref: string | null })[]>`
    select id as "itemId", direction, amount as "amountCents", bank_account_id as "bankAccountId", merchant_account_id as "accountId", provider_reference as ref
      from settlements where settle_date = ${date}::date and status = 'submitted' and provider_reference is not null order by id`;
  let settled = 0, returned = 0;
  if (provider) {
    for (const ref of new Set(items.map((i) => i.ref!))) {
      const batch = items.filter((i) => i.ref === ref);
      const results = await provider.outcomes(ref, batch);
      for (const r of results) {
        const item = batch.find((i) => i.itemId === r.itemId);
        if (!item) continue;
        if (await finishItem(sql, item, r.outcome === "settled" ? null : r.code ?? "bank_returned", "returned")) {
          if (r.outcome === "settled") settled += 1; else returned += 1;
        }
      }
    }
  }
  const [left] = await sql<{ n: number }[]>`select count(*)::int as n from settlements where settle_date = ${date}::date and status = 'submitted'`;
  if (left!.n === 0) {
    await log(sql, { actor: { type: "system", label: "settlement" }, action: "settlement.completed", target: { type: "settlement", label: date }, details: { date, settled, returned } });
    return { status: "completed", settled, returned };
  }
  return { status: "submitted", settled, returned };
}

/**
 * Applies the bank's answer to one waiting row (a repeat finds nothing waiting and does nothing).
 * `code` null = settled; otherwise the bank returned it (`outcome` is the status the row ends in: `returned`, or `failed` when the batch was refused).
 */
async function finishItem(sql: Sql, item: AchItem, code: string | null, outcome: "returned" | "failed"): Promise<boolean> {
  return sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Tx;
    const [s] = await tx<{ id: string; settle_date: string }[]>`
      select id, settle_date::text from settlements where id = ${item.itemId} and status = 'submitted' for no key update`;
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
export async function pollSubmittedSettlements(env: Env, sql: Sql, provider: AchProvider | null = achProvider(env)) {
  const days = await sql<{ d: string }[]>`select distinct settle_date::text as d from settlements where status = 'submitted' order by d`;
  let completed = 0;
  for (const r of days) if ((await confirmSettlement(sql, r.d, provider)).status === "completed") completed += 1;
  return { polled: days.length, completed };
}
