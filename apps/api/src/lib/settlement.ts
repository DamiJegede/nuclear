import type { TransactionSql } from "postgres";
import type { Sql } from "../db";
import type { Env } from "../env";
import { achProvider, type AchItem, type AchProvider } from "./ach";
import { log } from "./audit";

type Tx = TransactionSql<{ bigint: bigint }>;

/**
 * Merchant settlement (docs/TABLES.md, "Merchant refunds, settlement and historical integrity"; no tables beyond `settlements`).
 *
 * Once a day, after midnight New York time, every active merchant with a payout bank is settled for its WHOLE net balance, never a part:
 *
 *   * positive net -> a payout. The money leaves the merchant's balance at once (so a sale a second later belongs to the next cycle and
 *     the same money can never be paid twice), a `settle` transaction goes `pending`, and the ledger moves funded_balance -> bank_settlement.
 *   * negative net (refunds exceeded sales) -> a collection from the merchant's bank. NOTHING moves until the bank confirms: submitting
 *     a debit does not clear the debt. Collections still in flight are counted, so the same debt is never collected twice.
 *   * zero -> nothing.
 *
 * The bank's answer completes the transaction. A payout the bank returns is reversed (balance and ledger restored, status `returned`);
 * a collection the bank returns leaves the debt standing and it is collected again in the next run. Customers' refunds are never affected.
 *
 * Safety: the run claims its program date in `settlements` (unique), and each merchant's `settle:<date>` idempotency key is unique, so a
 * repeated or overlapping run (the cron fires twice a day) cannot settle anyone twice; a run that stopped half way is resumed.
 * If the cron is missed, the next run's net already includes everything since (the net is the live balance).
 */

const dayBefore = (iso: string) => new Date(Date.parse(`${iso}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

export type SettlementRun = { id: string; cutoff_date: string; status: string };
export type RunSummary =
  | { ran: false; reason: "no_provider" | "already_done" }
  | { ran: true; settlement_id: string; cutoff_date: string; created: number; payouts: number; collections: number; payout_total: number; collection_total: number; status: string };

/** Settles the program day before `today`. Safe to call repeatedly. */
export async function runSettlement(env: Env, sql: Sql, today: string, provider: AchProvider | null = achProvider(env)): Promise<RunSummary> {
  if (!provider) return { ran: false, reason: "no_provider" };
  const date = dayBefore(today);
  const [claimed] = await sql<{ id: string }[]>`
    insert into settlements (cutoff_date, cutoff_at) values (${date}::date, now())
    on conflict (cutoff_date) do nothing returning id`;
  let id = claimed?.id;
  if (!id) {
    const [existing] = await sql<{ id: string; status: string }[]>`select id, status from settlements where cutoff_date = ${date}::date`;
    if (!existing) return { ran: false, reason: "already_done" };
    if (existing.status === "completed" || existing.status === "failed") return { ran: false, reason: "already_done" };
    id = existing.id;
    // A submitted run only waits for the bank's answer.
    if (existing.status === "submitted") {
      const c = await confirmSettlement(sql, id, provider);
      return summarize(sql, id, date, 0, c.status);
    }
    // A run that was left 'running' is resumed below: merchants already settled are skipped by their idempotency key.
  }

  const due = await sql<{ id: string }[]>`
    select a.id
      from accounts a
      join balances b on b.account_id = a.id
      join businesses bz on bz.account_id = a.id
      join bank_accounts ba on ba.id = bz.bank_account_id and ba.status = 'active'
     where a.type = 'B' and a.status = 'active'
       and (b.balance <> 0 or exists (select 1 from transactions t where t.type = 'settle' and t.from_account_id = a.id and t.status = 'pending'))
     order by a.id`;
  let created = 0;
  for (const m of due) {
    if (await settleMerchant(sql, id, date, m.id)) created += 1;
  }

  const items = await pendingItems(sql, id);
  if (items.length === 0) {
    await sql`update settlements set status = 'completed', completed_at = now(), merchants = 0 where id = ${id} and status = 'running'`;
    return summarize(sql, id, date, created, "completed");
  }
  try {
    const sub = await provider.submit(date, items);
    await sql`update settlements set status = 'submitted', provider_reference = ${sub.reference} where id = ${id}`;
    await sql`update transactions set provider_reference = ${sub.reference} where settlement_id = ${id} and status = 'pending'`;
  } catch (err) {
    console.error("settlement submit failed", err);
    await failRun(sql, id, "submit_failed");
    return summarize(sql, id, date, created, "failed");
  }
  const c = await confirmSettlement(sql, id, provider);
  return summarize(sql, id, date, created, c.status);
}

/** One merchant: works out the net under the balance lock and records the payout or collection. Returns whether a transaction was created. */
async function settleMerchant(sql: Sql, settlementId: string, date: string, accountId: string): Promise<boolean> {
  return sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Tx;
    const [bal] = await tx<{ balance: bigint }[]>`select balance from balances where account_id = ${accountId} for no key update`;
    if (!bal) return false;
    const [bank] = await tx<{ id: string }[]>`
      select ba.id from businesses bz join bank_accounts ba on ba.id = bz.bank_account_id and ba.status = 'active' where bz.account_id = ${accountId}`;
    if (!bank) return false;
    // Collections the bank has not answered yet already count against the debt.
    const [inflight] = await tx<{ total: bigint }[]>`
      select coalesce(sum(amount), 0)::bigint as total from transactions
       where type = 'settle' and from_account_id = ${accountId} and from_bank_account_id is not null and status = 'pending'`;
    const net = bal.balance + inflight!.total;
    if (net === 0n) return false;
    const key = `settle:${date}`;

    if (net > 0n) {
      const [t] = await tx<{ id: string }[]>`
        insert into transactions (type, from_account_id, to_account_id, to_bank_account_id, amount, status, status_code, idempotency_key, settlement_id)
        values ('settle', ${accountId}, ${accountId}, ${bank.id}, ${net.toString()}, 'pending', 'submitted', ${key}, ${settlementId})
        on conflict do nothing returning id`;
      if (!t) return false;                                                       // this merchant was already settled for the date
      await tx`update balances set balance = balance - ${net.toString()} where account_id = ${accountId}`;
      await tx`
        insert into ledger_entries (transaction_id, posting_key, line_no, account_id, bucket, direction, amount) values
          (${t.id}, 'settle', 1, ${accountId}, 'funded_balance', 'debit', ${net.toString()}),
          (${t.id}, 'settle', 2, null, 'bank_settlement', 'credit', ${net.toString()})`;
      return true;
    }
    const owed = -net;
    const [t] = await tx<{ id: string }[]>`
      insert into transactions (type, from_account_id, to_account_id, from_bank_account_id, amount, status, status_code, idempotency_key, settlement_id)
      values ('settle', ${accountId}, ${accountId}, ${bank.id}, ${owed.toString()}, 'pending', 'submitted', ${key}, ${settlementId})
      on conflict do nothing returning id`;
    return !!t;
  }) as Promise<boolean>;
}

const pendingItems = (sql: Sql, settlementId: string) => sql<AchItem[]>`
  select id as "transactionId", case when to_bank_account_id is not null then 'credit' else 'debit' end as direction,
         amount as "amountCents", coalesce(to_bank_account_id, from_bank_account_id) as "bankAccountId", from_account_id as "accountId"
    from transactions where settlement_id = ${settlementId} and status = 'pending' order by id`;

/** Asks the bank for results and finishes every transaction it has answered. Closes the run when nothing is left in flight. */
export async function confirmSettlement(sql: Sql, settlementId: string, provider: AchProvider | null): Promise<{ status: string; settled: number; returned: number }> {
  const [run] = await sql<{ status: string; provider_reference: string | null }[]>`select status, provider_reference from settlements where id = ${settlementId}`;
  if (!run || run.status !== "submitted" || !run.provider_reference || !provider) return { status: run?.status ?? "missing", settled: 0, returned: 0 };
  const items = await pendingItems(sql, settlementId);
  const results = await provider.outcomes(run.provider_reference, items);
  let settled = 0, returned = 0;
  for (const r of results) {
    const item = items.find((i) => i.transactionId === r.transactionId);
    if (!item) continue;
    if (await finishTransaction(sql, item, r.outcome === "settled" ? null : r.code ?? "bank_returned")) {
      if (r.outcome === "settled") settled += 1; else returned += 1;
    }
  }
  const [left] = await sql<{ n: number }[]>`select count(*)::int as n from transactions where settlement_id = ${settlementId} and status = 'pending'`;
  if (left!.n === 0) {
    await sql`
      update settlements s set status = 'completed', completed_at = now(),
             merchants = (select count(*) from transactions t where t.settlement_id = s.id),
             payout_total = (select coalesce(sum(amount), 0) from transactions t where t.settlement_id = s.id and t.to_bank_account_id is not null and t.status = 'completed'),
             collection_total = (select coalesce(sum(amount), 0) from transactions t where t.settlement_id = s.id and t.from_bank_account_id is not null and t.status = 'completed')
       where s.id = ${settlementId} and s.status = 'submitted'`;
    await log(sql, { actor: { type: "system", label: "settlement" }, action: "settlement.completed", target: { type: "settlement", id: settlementId }, details: { settled, returned } });
    return { status: "completed", settled, returned };
  }
  return { status: "submitted", settled, returned };
}

/**
 * Applies the bank's answer to one pending transaction (a repeat finds nothing pending and does nothing).
 * `code` null = settled; otherwise the bank returned it.
 */
async function finishTransaction(sql: Sql, item: AchItem, code: string | null): Promise<boolean> {
  return sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Tx;
    const [t] = await tx<{ id: string }[]>`select id from transactions where id = ${item.transactionId} and status = 'pending' for no key update`;
    if (!t) return false;
    const amt = item.amountCents.toString();
    // Same lock order as the money paths: the balance row.
    await tx`select 1 from balances where account_id = ${item.accountId} for no key update`;
    if (code === null) {
      if (item.direction === "debit") {
        // The collection arrived: the merchant's debt is cleared now, not before.
        await tx`update balances set balance = balance + ${amt} where account_id = ${item.accountId}`;
        await tx`
          insert into ledger_entries (transaction_id, posting_key, line_no, account_id, bucket, direction, amount) values
            (${t.id}, 'collect', 1, null, 'bank_settlement', 'debit', ${amt}),
            (${t.id}, 'collect', 2, ${item.accountId}, 'funded_balance', 'credit', ${amt})`;
      }
      await tx`update transactions set status = 'completed', status_code = null, completed_at = now() where id = ${t.id}`;
      return true;
    }
    if (item.direction === "credit") await reversePayout(tx, t.id, item.accountId, amt);
    await tx`update transactions set status = 'returned', status_code = ${code} where id = ${t.id}`;
    return true;
  }) as Promise<boolean>;
}

/** Puts a payout the bank did not take back into the merchant's balance, with a reversing ledger posting (the ledger is append-only). */
async function reversePayout(tx: Tx, transactionId: string, accountId: string, amt: string) {
  await tx`update balances set balance = balance + ${amt} where account_id = ${accountId}`;
  await tx`
    insert into ledger_entries (transaction_id, posting_key, line_no, account_id, bucket, direction, amount) values
      (${transactionId}, 'settle_return', 1, null, 'bank_settlement', 'debit', ${amt}),
      (${transactionId}, 'settle_return', 2, ${accountId}, 'funded_balance', 'credit', ${amt})`;
}

/** The whole batch was refused: give every payout back and fail every pending transaction. */
async function failRun(sql: Sql, settlementId: string, code: string) {
  const items = await pendingItems(sql, settlementId);
  for (const i of items) await finishTransaction(sql, i, code).catch((e) => console.error("settlement reverse failed", e));
  await sql`update settlements set status = 'failed', failure_code = ${code}, completed_at = now() where id = ${settlementId}`;
  await log(sql, { actor: { type: "system", label: "settlement" }, action: "settlement.failed", target: { type: "settlement", id: settlementId }, details: { code } });
}

async function summarize(sql: Sql, id: string, date: string, created: number, status: string): Promise<RunSummary> {
  const [s] = await sql<{ payouts: number; collections: number; payout_total: bigint; collection_total: bigint }[]>`
    select count(*) filter (where to_bank_account_id is not null)::int as payouts,
           count(*) filter (where from_bank_account_id is not null)::int as collections,
           coalesce(sum(amount) filter (where to_bank_account_id is not null), 0)::bigint as payout_total,
           coalesce(sum(amount) filter (where from_bank_account_id is not null), 0)::bigint as collection_total
      from transactions where settlement_id = ${id}`;
  return { ran: true, settlement_id: id, cutoff_date: date, created, payouts: s!.payouts, collections: s!.collections, payout_total: Number(s!.payout_total), collection_total: Number(s!.collection_total), status };
}

/** The daily job also polls runs the bank had not answered yet. */
export async function pollSubmittedSettlements(env: Env, sql: Sql, provider: AchProvider | null = achProvider(env)) {
  const runs = await sql<{ id: string }[]>`select id from settlements where status = 'submitted' order by cutoff_date`;
  let completed = 0;
  for (const r of runs) if ((await confirmSettlement(sql, r.id, provider)).status === "completed") completed += 1;
  return { polled: runs.length, completed };
}
