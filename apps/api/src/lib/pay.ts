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

export type PayOutcome =
  | { kind: "ok" | "declined"; row: PayRow; replayed: boolean }
  | { kind: "conflict" };

/** The idempotency key of a payment: scoped to the merchant (the attempt key is `t:<attempt>` or `c:<payer>:<key>`). */
export const payIdem = (merchantAccountId: string, key: string) => `pay:${merchantAccountId}:${key}`;

/** A payment as the money functions return it (json). */
export function payRowFromJson(j: Record<string, unknown>): PayRow {
  return {
    id: j.id as string, status: j.status as string, status_code: (j.status_code as string | null) ?? null, amount: BigInt(j.amount as number),
    from_account_id: j.from_account_id as string, to_account_id: j.to_account_id as string, from_wallet_id: j.from_wallet_id as string,
    tag_id: (j.tag_id as string | null) ?? null, terminal_id: (j.terminal_id as string | null) ?? null, checkout_id: (j.checkout_id as string | null) ?? null,
    reference: (j.reference as string | null) ?? null, idempotency_key: j.idempotency_key as string,
    timestamp: new Date(j.timestamp as string), completed_at: j.completed_at ? new Date(j.completed_at as string) : null,
  };
}
