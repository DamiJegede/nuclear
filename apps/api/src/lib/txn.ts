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

/** The program-day rule for a product's sold counter as an SQL fragment: a row from an earlier day counts as zero. */
export const soldToday = `(case when sold_day = program_today() then sold_today else 0 end)`;

export const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505";

/** The recorded transaction for an idempotency key, in reader shape (or undefined). */
export async function findByIdem(q: Q, idem: string): Promise<TxRow | undefined> {
  const [r] = await q<TxRow[]>`select ${q.unsafe(TX_COLS)} from txn where idempotency_key = ${idem}`;
  return r;
}

/** A transaction row as an SQL money function returns it (json: amounts are numbers, times are ISO strings). */
export function txRowFromJson(j: Record<string, unknown>): TxRow {
  return {
    id: j.id as string, type: j.type as string, status: j.status as string, status_code: (j.status_code as string | null) ?? null,
    amount: BigInt(j.amount as number), from_account_id: (j.from_account_id as string | null) ?? null, to_account_id: (j.to_account_id as string | null) ?? null,
    from_wallet_id: (j.from_wallet_id as string | null) ?? null, to_wallet_id: (j.to_wallet_id as string | null) ?? null,
    timestamp: new Date(j.timestamp as string), completed_at: j.completed_at ? new Date(j.completed_at as string) : null,
  };
}

/**
 * Calls one of the money functions (migrations/0002) as a single statement, which is its own transaction. A repeated key that two calls
 * race to write with different lock orders raises a unique violation; the call is then made again and replays the winner.
 */
export async function callMoney<T>(q: Q, fn: "app_send" | "app_pay_app" | "app_pay_tap" | "app_refund" | "app_refund_resolve" | "app_purchase", arg: Record<string, unknown>): Promise<T> {
  const once = async () => (await q.unsafe(`select public.${fn}($1::text::jsonb) as r`, [JSON.stringify(arg)] as never))[0]!.r as T;
  try {
    return await once();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    return once();
  }
}
