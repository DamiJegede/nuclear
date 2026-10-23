import { earmarkedTotalQuery, spendableFrom } from "./walletFunds";
import { insertTx, spentToday, type NewTx } from "./txn";
import type { TransactionSql } from "postgres";

type Tx = TransactionSql<{ bigint: bigint }>;

/** A payment as readers see it (the `txn` view's column names; `failed` is a declined transaction). */
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
  /** The account that acted: the merchant for a terminal tap, the payer for a payment confirmed in the app. */
  actorAccountId: string;
  terminalId: string | null;
  checkoutId: string | null;
  tagId: string | null;
  /** Per-payment ceiling from tags.transaction_limit (tag path only). */
  tagLimit: bigint | null;
  amount: bigint;
  /** The attempt key (`t:<attempt>` or `c:<payer>:<key>`), unique per merchant. */
  idempotencyKey: string;
  reference: string | null;
  /** The items snapshot, kept on the transaction. */
  items?: unknown[] | null;
  /** When set, record the attempt as declined with this code without moving money (e.g. out_of_stock). */
  forceDecline?: string | null;
};

export type PayOutcome =
  | { kind: "ok" | "declined"; row: PayRow; replayed: boolean }
  | { kind: "conflict" };

export const payIdem = (merchantAccountId: string, key: string) => `pay:${merchantAccountId}:${key}`;

export async function findPay(tx: Tx, merchantAccountId: string, key: string): Promise<PayRow | undefined> {
  const [row] = await tx<PayRow[]>`
    select ${tx.unsafe(PAY_COLS)} from txn where type = 'pay' and idempotency_key = ${payIdem(merchantAccountId, key)}`;
  return row;
}

const pos = (v: bigint) => (v > 0n ? v : 0n);

/**
 * Merchant payment, inside the caller's DB transaction. Idempotent per (merchant, key); a decline is committed as a `declined`
 * transaction. Funds: funded balance first, then approved credit; the credit portion is recorded on the transaction (`credit_amount`) so
 * refunds can restore it first. The merchant's balance accrues the full amount. Locks: both balance rows (stable order), then the payer
 * wallet; the key is read under those locks, so a concurrent retry replays.
 */
export async function payCore(tx: Tx, i: PayInput): Promise<PayOutcome> {
  const idem = payIdem(i.merchantAccountId, i.idempotencyKey);
  // One round trip for all the reads. They are sent together but run in this order on the server, so the lock order is unchanged:
  // both balance rows (stable order), then the payer wallet; the rest is plain reads taken while those locks are held.
  const [bal, [w], [pa], [ma], [em], [mw], [prev]] = await Promise.all([
    tx<{ account_id: string; balance: bigint; credit_limit: bigint; credit_spent: bigint }[]>`
      select account_id, balance, credit_limit, credit_spent from balances
       where account_id in (${i.payerAccountId}, ${i.merchantAccountId})
       order by account_id for no key update`,
    tx<{ status: string; allow_pay: boolean; daily_limit: bigint | null; spent_today: bigint; balance: bigint | null; type: string }[]>`
      select status, allow_pay, daily_limit, ${tx.unsafe(spentToday)} as spent_today, balance, type from wallets
       where id = ${i.payerWalletId} for no key update`,
    tx<{ status: string }[]>`select status from accounts where id = ${i.payerAccountId}`,
    tx<{ status: string; type: string }[]>`select status, type from accounts where id = ${i.merchantAccountId}`,
    earmarkedTotalQuery(tx, i.payerAccountId),
    tx<{ id: string }[]>`select id from wallets where account_id = ${i.merchantAccountId} and type = 'default'`,
    tx<PayRow[]>`select ${tx.unsafe(PAY_COLS)} from txn where idempotency_key = ${idem}`,
  ]);
  if (prev) {
    if (prev.from_wallet_id !== i.payerWalletId || prev.amount !== i.amount || prev.tag_id !== i.tagId) return { kind: "conflict" };
    return { kind: prev.status === "completed" ? "ok" : "declined", row: prev, replayed: true };
  }
  const pb = bal.find((r) => r.account_id === i.payerAccountId);
  if (!pb || bal.length !== 2 || !mw) throw new Error("balances row missing");

  // An earmarked wallet can spend only its own balance (a hard limit, never credit); otherwise the
  // account's funds minus what is earmarked for other wallets, plus approved credit.
  const funds = spendableFrom(pb.balance, w ? w.balance : null, em!.total);
  const creditAvailable = funds.earmarked ? 0n : pos(pb.credit_limit - pb.credit_spent);
  let code: string | null = i.forceDecline ?? null;
  if (code) { /* decided before the money was looked at (out of stock, closed checkout...) */ }
  else if (!pa || pa.status !== "active" || !w || w.status !== "active") code = "payer_unavailable";
  else if (!w.allow_pay) code = "pay_not_allowed";
  else if (pb.balance < 0n || pb.credit_spent > pb.credit_limit) code = "account_restricted";
  else if (!ma || ma.status !== "active" || ma.type !== "B") code = "merchant_unavailable";
  else if (i.tagLimit !== null && i.amount > i.tagLimit) code = "tag_limit_exceeded";
  else if (funds.funds + creditAvailable < i.amount) code = funds.earmarked ? "wallet_balance_exceeded" : "insufficient_balance";
  else if (w.daily_limit !== null && w.spent_today + i.amount > w.daily_limit) code = "spend_limit_exceeded";

  const fromBalance = code ? 0n : funds.funds < i.amount ? funds.funds : i.amount;
  const fromCredit = code ? 0n : i.amount - fromBalance;
  const t: NewTx = {
    type: "pay", declined: code, from: i.payerWalletId, to: mw.id, amount: i.amount, credit: fromCredit,
    tag: i.tagId, terminal: i.terminalId, checkout: i.checkoutId, account: i.actorAccountId, reference: i.reference, idem,
    meta: i.items && i.items.length > 0 ? { items: i.items } : {},
  };
  const row = (w: { id: string; created_at: Date }): PayRow => ({
    id: w.id, status: code ? "failed" : "completed", status_code: code, amount: i.amount,
    from_account_id: i.payerAccountId, to_account_id: i.merchantAccountId, from_wallet_id: i.payerWalletId, tag_id: i.tagId,
    terminal_id: i.terminalId, checkout_id: i.checkoutId, reference: i.reference, idempotency_key: idem,
    timestamp: w.created_at, completed_at: code ? null : w.created_at,
  });

  if (code) {
    const [r] = await insertTx(tx, t);
    return { kind: "declined", row: row(r!), replayed: false };
  }

  const amt = i.amount.toString();
  // Every write in one round trip (sent together, applied in this order).
  const [, , , [r]] = await Promise.all([
    tx`update balances
          set balance = balance - ${fromBalance.toString()},
              credit_spent = credit_spent + ${fromCredit.toString()}
        where account_id = ${i.payerAccountId}`,
    tx`update balances set balance = balance + ${amt} where account_id = ${i.merchantAccountId}`,
    // The payer wallet's day counter (rolling over on a new day), and its earmark when it has one (a hard limit that shrinks as it spends).
    tx`update wallets set spent_today = case when spent_day = program_today() then spent_today + ${amt} else ${amt} end, spent_day = program_today(),
              balance = case when balance is not null then balance - ${fromBalance.toString()} else balance end
        where id = ${i.payerWalletId}`,
    insertTx(tx, t),
  ]);
  return { kind: "ok", row: row(r!), replayed: false };
}
