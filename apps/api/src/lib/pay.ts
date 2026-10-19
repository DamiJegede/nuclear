import { earmarkedTotalQuery, spendableFrom } from "./walletFunds";
import type { TransactionSql } from "postgres";

type Tx = TransactionSql<{ bigint: bigint }>;

export type PayRow = {
  id: string;
  status: string;
  status_code: string | null;
  amount: bigint;
  from_account_id: string;
  to_account_id: string;
  from_wallet_id: string;
  tag_id: string | null;
  terminal_id: string | null;
  checkout_id: string | null;
  reference: string | null;
  idempotency_key: string;
  timestamp: Date;
  completed_at: Date | null;
};

export const PAY_COLS = `id, status, status_code, amount, from_account_id, to_account_id,
  from_wallet_id, tag_id, terminal_id, checkout_id, reference, idempotency_key, "timestamp", completed_at`;

export type PayInput = {
  payerWalletId: string;
  payerAccountId: string;
  merchantAccountId: string;
  terminalId: string | null;
  checkoutId: string | null;
  tagId: string | null;
  /** Per-payment ceiling from tags.transaction_limit (tag path only). */
  tagLimit: bigint | null;
  amount: bigint;
  /** Already namespaced; unique per merchant. */
  idempotencyKey: string;
  reference: string | null;
  /** When set, record the attempt as failed with this code without moving money (e.g. out_of_stock). */
  forceDecline?: string | null;
};

export type PayOutcome =
  | { kind: "ok" | "declined"; row: PayRow; replayed: boolean }
  | { kind: "conflict" };

export async function findPay(tx: Tx, merchantAccountId: string, key: string): Promise<PayRow | undefined> {
  const [row] = await tx<PayRow[]>`
    select ${tx.unsafe(PAY_COLS)} from transactions
     where type = 'pay' and to_account_id = ${merchantAccountId} and idempotency_key = ${key}`;
  return row;
}

const pos = (v: bigint) => (v > 0n ? v : 0n);

/**
 * Merchant payment, inside the caller's DB transaction. Idempotent per (merchant, key); declines are
 * committed as failed rows. Funds: funded balance first, then approved credit; the credit portion is
 * journaled on this transaction so refunds can restore it first. Merchant balance accrues the full
 * amount. Locks: both balance rows (stable order), then the payer wallet's counters.
 */
export async function payCore(tx: Tx, i: PayInput): Promise<PayOutcome> {
  const ins = await tx<{ id: string }[]>`
    insert into transactions (type, from_account_id, to_account_id, from_wallet_id, tag_id, terminal_id,
                              checkout_id, amount, reference, status, idempotency_key)
    values ('pay', ${i.payerAccountId}, ${i.merchantAccountId}, ${i.payerWalletId}, ${i.tagId},
            ${i.terminalId}, ${i.checkoutId}, ${i.amount.toString()}, ${i.reference}, 'pending',
            ${i.idempotencyKey})
    on conflict do nothing
    returning id`;

  if (!ins[0]) {
    const prev = await findPay(tx, i.merchantAccountId, i.idempotencyKey);
    if (
      !prev ||
      prev.from_wallet_id !== i.payerWalletId ||
      prev.amount !== i.amount ||
      prev.tag_id !== i.tagId
    ) {
      return { kind: "conflict" };
    }
    return { kind: prev.status === "completed" ? "ok" : "declined", row: prev, replayed: true };
  }
  const txId = ins[0].id;

  if (i.forceDecline) {
    const [r] = await tx<PayRow[]>`
      update transactions set status = 'failed', status_code = ${i.forceDecline}
       where id = ${txId} returning ${tx.unsafe(PAY_COLS)}`;
    return { kind: "declined", row: r!, replayed: false };
  }

  // One round trip for all the reads. They are sent together but run in this order on the server, so the lock order is unchanged:
  // both balance rows (stable order), then the payer wallet; the rest is plain reads taken while those locks are held.
  const [bal, [w], [pa], [ma], [em]] = await Promise.all([
    tx<{ account_id: string; balance: bigint; credit_limit: bigint; credit_spent: bigint }[]>`
      select account_id, balance, credit_limit, credit_spent from balances
       where account_id in (${i.payerAccountId}, ${i.merchantAccountId})
       order by account_id for no key update`,
    tx<{ status: string; allow_pay: boolean; daily_limit: bigint | null; spent_today: bigint; balance: bigint | null }[]>`
      select status, allow_pay, daily_limit, spent_today, balance from wallets
       where id = ${i.payerWalletId} for no key update`,
    tx<{ status: string }[]>`select status from accounts where id = ${i.payerAccountId}`,
    tx<{ status: string; type: string }[]>`select status, type from accounts where id = ${i.merchantAccountId}`,
    earmarkedTotalQuery(tx, i.payerAccountId),
  ]);
  const pb = bal.find((r) => r.account_id === i.payerAccountId);
  if (!pb || bal.length !== 2) throw new Error("balances row missing");

  // An earmarked wallet can spend only its own balance (a hard limit, never credit); otherwise the
  // account's funds minus what is earmarked for other wallets, plus approved credit.
  const funds = spendableFrom(pb.balance, w ? w.balance : null, em!.total);
  const creditAvailable = funds.earmarked ? 0n : pos(pb.credit_limit - pb.credit_spent);
  let code: string | null = null;
  if (!pa || pa.status !== "active" || !w || w.status !== "active") code = "payer_unavailable";
  else if (!w.allow_pay) code = "pay_not_allowed";
  else if (pb.balance < 0n || pb.credit_spent > pb.credit_limit) code = "account_restricted";
  else if (!ma || ma.status !== "active" || ma.type !== "B") code = "merchant_unavailable";
  else if (i.tagLimit !== null && i.amount > i.tagLimit) code = "tag_limit_exceeded";
  else if (funds.funds + creditAvailable < i.amount) code = funds.earmarked ? "wallet_balance_exceeded" : "insufficient_balance";
  else if (w.daily_limit !== null && w.spent_today + i.amount > w.daily_limit) code = "spend_limit_exceeded";

  if (code) {
    const [r] = await tx<PayRow[]>`
      update transactions set status = 'failed', status_code = ${code}
       where id = ${txId} returning ${tx.unsafe(PAY_COLS)}`;
    return { kind: "declined", row: r!, replayed: false };
  }

  const fromBalance = funds.funds < i.amount ? funds.funds : i.amount;
  const fromCredit = i.amount - fromBalance;
  const amt = i.amount.toString();

  // Debits: payer funded balance and/or credit receivable. Credit: merchant funded balance.
  const lines: { account_id: string; bucket: string; direction: "debit" | "credit"; amount: string }[] = [];
  if (fromBalance > 0n) {
    lines.push({ account_id: i.payerAccountId, bucket: "funded_balance", direction: "debit", amount: fromBalance.toString() });
  }
  if (fromCredit > 0n) {
    lines.push({ account_id: i.payerAccountId, bucket: "credit_receivable", direction: "debit", amount: fromCredit.toString() });
  }
  lines.push({ account_id: i.merchantAccountId, bucket: "funded_balance", direction: "credit", amount: amt });
  // Every write in one round trip (sent together, applied in this order). The ledger balance trigger is deferred, so order within the batch is free.
  const [, , , , [r]] = await Promise.all([
    tx`update balances
          set balance = balance - ${fromBalance.toString()},
              credit_spent = credit_spent + ${fromCredit.toString()}
        where account_id = ${i.payerAccountId}`,
    tx`update balances set balance = balance + ${amt} where account_id = ${i.merchantAccountId}`,
    // The payer wallet's day counter, and its earmark when it has one (a hard limit that shrinks as it spends).
    tx`update wallets set spent_today = spent_today + ${amt},
              balance = case when balance is not null then balance - ${fromBalance.toString()} else balance end
        where id = ${i.payerWalletId}`,
    tx`insert into ledger_entries ${tx(
      lines.map((l, idx) => ({ transaction_id: txId, posting_key: "pay", line_no: idx + 1, ...l })),
      "transaction_id", "posting_key", "line_no", "account_id", "bucket", "direction", "amount",
    )}`,
    tx<PayRow[]>`update transactions set status = 'completed', completed_at = now()
                  where id = ${txId} returning ${tx.unsafe(PAY_COLS)}`,
  ]);
  return { kind: "ok", row: r!, replayed: false };
}
