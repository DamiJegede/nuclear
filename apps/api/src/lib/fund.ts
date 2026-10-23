import { CAP_COLS, capApplies, capHeadroom, capToday, type CapRow } from "./cap";
import { BANK_WALLET, SYSTEM_ACCOUNT } from "./system";
import { insertTx } from "./txn";
import type { Sql } from "../db";

export type FundingOutcome =
  | { kind: "ok"; funding: FundingRow; replayed: boolean }
  | { kind: "failed"; funding: FundingRow; replayed: boolean }
  | { kind: "error"; status: 409; error: string };

export type FundingRow = {
  id: string;
  account_id: string;
  amount: bigint;
  status: string;
  failure_code: string | null;
  transaction_id: string | null;
  created_at: Date;
  released_at: Date | null;
};

const F_COLS = `id, account_id, amount, status, failure_code, transaction_id, created_at, released_at`;

/**
 * Release a load into the account (the step a real bank adapter reuses once the bank confirms): credit principal is repaid first, only the
 * remainder increases funded balance, and one `fund` transaction goes from the bank wallet to the account's default wallet. The funding row
 * (workflow state, not money) is linked to it. Runs inside the caller's transaction, holding the account's balances lock.
 */
export async function releaseFunding(
  tx: import("postgres").TransactionSql<{ bigint: bigint }>,
  i: { fundingId: string; accountId: string; amount: bigint; idempotencyKey: string },
  b: { credit_spent: bigint } & CapRow,
  walletId: string,
): Promise<FundingRow> {
  const repay = b.credit_spent < i.amount ? b.credit_spent : i.amount;
  const toBalance = i.amount - repay;
  const [, [t]] = await Promise.all([
    // The whole load counts as today's addition (even the part that repays credit); a stale row rolls to today first.
    tx`update balances set balance = balance + ${toBalance.toString()},
                           credit_spent = credit_spent - ${repay.toString()}
                           ${capApplies(b) ? tx`, ordinary_opening = ${capToday(b).opening.toString()}, added_today = ${(capToday(b).added + i.amount).toString()}, opening_day = greatest(opening_day, ${b.today}::date)` : tx``}
        where account_id = ${i.accountId}`,
    insertTx(tx, {
      type: "fund", from: BANK_WALLET, to: walletId, amount: i.amount, credit: repay, funding: i.fundingId,
      account: i.accountId, idem: `fund:${i.accountId}:${i.idempotencyKey}`,
    }),
  ]);
  const [f] = await tx<FundingRow[]>`
    update fundings set status = 'completed', released_at = now(), transaction_id = ${t!.id}
     where id = ${i.fundingId} returning ${tx.unsafe(F_COLS)}`;
  return f!;
}

/**
 * SANDBOX ONLY: simulates a bank load that is confirmed and released immediately.
 */
export async function sandboxFund(
  sql: Sql,
  i: { accountId: string; amount: bigint; idempotencyKey: string; dailyCap: bigint },
): Promise<FundingOutcome> {
  return sql.begin(async (tx): Promise<FundingOutcome> => {
    let [bank] = await tx<{ id: string }[]>`
      select id from bank_accounts
       where account_id = ${i.accountId} and status = 'active' and provider_account_id is null
         and routing_number = 'SANDBOX'
       limit 1`;
    if (!bank) {
      [bank] = await tx<{ id: string }[]>`
        insert into bank_accounts (account_id, routing_number, account_number, last4)
        values (${i.accountId}, 'SANDBOX', 'SANDBOX', '0000') returning id`;
    }

    const ins = await tx<{ id: string }[]>`
      insert into fundings (account_id, bank_account_id, amount, idempotency_key, status)
      values (${i.accountId}, ${bank!.id}, ${i.amount.toString()}, ${i.idempotencyKey}, 'created')
      on conflict (account_id, idempotency_key) do nothing
      returning id`;
    if (!ins[0]) {
      const [prev] = await tx<FundingRow[]>`
        select ${tx.unsafe(F_COLS)} from fundings
         where account_id = ${i.accountId} and idempotency_key = ${i.idempotencyKey}`;
      if (!prev || prev.amount !== i.amount) return { kind: "error", status: 409, error: "idempotency_mismatch" };
      return { kind: prev.status === "completed" ? "ok" : "failed", funding: prev, replayed: true };
    }
    const fundingId = ins[0].id;

    const [[b], [w]] = await Promise.all([
      tx<({ credit_spent: bigint } & CapRow)[]>`
        select b.balance, b.credit_spent, ${tx.unsafe(CAP_COLS)}
          from balances b join accounts a on a.id = b.account_id
         where b.account_id = ${i.accountId} for no key update of b`,
      tx<{ id: string }[]>`select id from wallets where account_id = ${i.accountId} and type = 'default'`,
    ]);
    if (!b || !w) throw new Error("balances row missing");

    // One daily rule for a consumer's ordinary money: cap - opening value - added today. Organizations and businesses are exempt.
    if (capApplies(b) && capHeadroom(b, i.dailyCap) < i.amount) {
      const [f] = await tx<FundingRow[]>`
        update fundings set status = 'failed', failure_code = 'daily_value_limit_exceeded'
         where id = ${fundingId} returning ${tx.unsafe(F_COLS)}`;
      return { kind: "failed", funding: f!, replayed: false };
    }
    const f = await releaseFunding(tx, { fundingId, accountId: i.accountId, amount: i.amount, idempotencyKey: i.idempotencyKey }, b, w.id);
    return { kind: "ok", funding: f, replayed: false };
  }) as Promise<FundingOutcome>;
}

export { SYSTEM_ACCOUNT };
