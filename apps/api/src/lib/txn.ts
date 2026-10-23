import type { TransactionSql } from "postgres";
import type { Sql } from "../db";

type Tx = TransactionSql<{ bigint: bigint }>;
type Q = Sql | Tx;

/**
 * What the money paths and the readers share about a transaction. Every transaction is wallet to wallet, written once with its final
 * outcome (`completed` or `declined`); the API reports a declined one as `failed`. Readers use the `txn` view, which has the account-level
 * column names (from_account_id, to_account_id...) and shows the system wallets as no account.
 */

export type TxRow = {
  id: string;
  type: string;
  status: string;
  status_code: string | null;
  amount: bigint;
  from_account_id: string | null;
  to_account_id: string | null;
  from_wallet_id: string | null;
  to_wallet_id: string | null;
  timestamp: Date;
  completed_at: Date | null;
};

export const TX_COLS = `id, type, status, status_code, amount, from_account_id, to_account_id,
  from_wallet_id, to_wallet_id, "timestamp", completed_at`;

export type NewTx = {
  type: string;
  declined?: string | null;
  from: string;
  to: string;
  amount: bigint;
  credit?: bigint;
  related?: string | null;
  tag?: string | null;
  pass?: string | null;
  terminal?: string | null;
  checkout?: string | null;
  funding?: string | null;
  settlement?: string | null;
  /** The account that acted or approved; the system account for automated jobs. */
  account: string;
  reference?: string | null;
  /** One scoped key for every type, e.g. `send:<account>:<key>`. */
  idem: string;
  meta?: Record<string, unknown>;
  /** Fixed id (an approved refund request keeps its id). */
  id?: string;
};

/** The insert, as a query to send alone or inside a pipelined batch. A repeated `idem` raises a unique violation (23505). */
export const insertTx = (tx: Tx, t: NewTx) => tx<{ id: string; created_at: Date }[]>`
  insert into transactions (id, type, status, status_code, from_wallet_id, to_wallet_id, amount, credit_amount, related_id, tag_id, pass_id,
                            terminal_id, checkout_id, funding_id, settlement_id, account_id, reference, idem, meta)
  values (${t.id ?? tx`uuidv7()`}, ${t.type}, ${t.declined ? "declined" : "completed"}, ${t.declined ?? null}, ${t.from}, ${t.to},
          ${t.amount.toString()}, ${(t.credit ?? 0n).toString()}, ${t.related ?? null}, ${t.tag ?? null}, ${t.pass ?? null},
          ${t.terminal ?? null}, ${t.checkout ?? null}, ${t.funding ?? null}, ${t.settlement ?? null}, ${t.account},
          ${t.reference ?? null}, ${t.idem}, ${tx.json((t.meta ?? {}) as never)})
  returning id, created_at`;

/** The row a reader would get for a transaction just written. */
export const rowOf = (
  t: NewTx,
  w: { id: string; created_at: Date },
  sides: { fromAccount: string | null; toAccount: string | null; fromWallet: string | null; toWallet: string | null },
): TxRow => ({
  id: w.id,
  type: t.type,
  status: t.declined ? "failed" : "completed",
  status_code: t.declined ?? null,
  amount: t.amount,
  from_account_id: sides.fromAccount,
  to_account_id: sides.toAccount,
  from_wallet_id: sides.fromWallet,
  to_wallet_id: sides.toWallet,
  timestamp: w.created_at,
  completed_at: t.declined ? null : w.created_at,
});

/** The program-day rule for a wallet's spending counter, as SQL fragments: a row from an earlier day counts as zero. */
export const spentToday = `(case when spent_day = program_today() then spent_today else 0 end)`;
export const soldToday = `(case when sold_day = program_today() then sold_today else 0 end)`;

export const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505";

/** The recorded transaction for an idempotency key, in reader shape (or undefined). */
export async function findByIdem(q: Q, idem: string): Promise<TxRow | undefined> {
  const [r] = await q<TxRow[]>`select ${q.unsafe(TX_COLS)} from txn where idempotency_key = ${idem}`;
  return r;
}
