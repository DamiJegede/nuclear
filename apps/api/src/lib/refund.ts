import { callMoney } from "./txn";
import type { TransactionSql } from "postgres";

type Tx = TransactionSql<{ bigint: bigint }>;

/** A refund as readers see it: a refund transaction, or a request that is still waiting (or was rejected) on the `refunds` table. */
export type RefundRow = {
  id: string;
  status: string;
  status_code: string | null;
  amount: bigint;
  from_account_id: string;
  to_account_id: string;
  to_wallet_id: string;
  related_transaction_id: string;
  terminal_id: string | null;
  approved_by_account_id: string | null;
  items: { checkout_item_id: string; quantity: number; restock: boolean }[] | null;
  idempotency_key: string;
  timestamp: Date;
  completed_at: Date | null;
};

export const R_COLS = `id, status, status_code, amount, from_account_id, to_account_id, to_wallet_id,
  related_transaction_id, terminal_id, approved_by_account_id, items, idempotency_key, "timestamp", completed_at`;

export type OriginalRef = { paymentId: string } | { attempt: string };

export type RefundInput = {
  merchantAccountId: string;
  terminalId: string;
  original: OriginalRef;
  /** full/partial move an amount; items refunds specific units of the paid order. */
  mode: "full" | "partial" | "items";
  /** Required for partial. */
  amount: bigint | null;
  /** Required for items. */
  items?: { checkoutItemId: string; quantity: number }[];
  /** Items mode: put the units back on the shelf when the refund completes. Default false. */
  restock?: boolean;
  idempotencyKey: string;
  /**
   * execute: refund now (direct, or already approved by tap/owner).
   * queue: record a pending request (awaiting approval); nothing moves and the amount is reserved.
   */
  disposition: "execute" | "queue";
  /** Approving staff/owner account, or null for a direct refund. */
  approvedByAccountId: string | null;
  /** Who resolved it when that is not an account (an admin: `admin:<ACCESS ID>`), kept on the transaction. */
  resolvedBy?: string | null;
};

export type RefundOutcome =
  | { kind: "ok" | "declined" | "pending"; row: RefundRow; replayed: boolean; remaining: bigint }
  | { kind: "error"; status: 404 | 409 | 422; error: string; max?: number; remaining?: number };

type Answer =
  | { kind: "ok" | "declined" | "pending"; replayed: boolean; remaining: number; row: Record<string, unknown> }
  | { kind: "error"; status: 404 | 409 | 422; error: string; max?: number; remaining?: number };

export const refundIdem = (merchantAccountId: string, key: string) => `refund:${merchantAccountId}:${key}`;

const rowOf = (j: Record<string, unknown>): RefundRow => ({
  id: j.id as string, status: j.status as string, status_code: (j.status_code as string | null) ?? null, amount: BigInt(j.amount as number),
  from_account_id: j.from_account_id as string, to_account_id: j.to_account_id as string, to_wallet_id: j.to_wallet_id as string,
  related_transaction_id: j.related_transaction_id as string, terminal_id: (j.terminal_id as string | null) ?? null,
  approved_by_account_id: (j.approved_by_account_id as string | null) ?? null, items: (j.items as RefundRow["items"]) ?? null,
  idempotency_key: j.idempotency_key as string, timestamp: new Date(j.timestamp as string), completed_at: j.completed_at ? new Date(j.completed_at as string) : null,
});

const outcome = (a: Answer): RefundOutcome =>
  a.kind === "error" ? a : { kind: a.kind, row: rowOf(a.row), replayed: a.replayed, remaining: BigInt(a.remaining) };

export async function findRefund(tx: Tx, merchantAccountId: string, key: string): Promise<RefundRow | undefined> {
  const [r] = await tx<RefundRow[]>`
    select ${tx.unsafe(R_COLS)} from txn
     where type = 'refund' and idempotency_key = ${refundIdem(merchantAccountId, key)}`;
  return r;
}

/**
 * Create a refund against a completed payment (the `app_refund` SQL function, migrations/0002), inside the caller's DB transaction.
 *
 * - Bounded by the unrefunded amount minus pending (reserved) refunds; the original payment row is
 *   locked so concurrent requests serialize and can never exceed it. Full = everything still free.
 * - disposition "execute" refunds now; "queue" records a pending request awaiting approval.
 * - Idempotent per (merchant, key); retries return the original outcome.
 */
export async function refundCore(tx: Tx, i: RefundInput): Promise<RefundOutcome> {
  return outcome(await callMoney<Answer>(tx, "app_refund", {
    merchant: i.merchantAccountId, terminal_id: i.terminalId,
    payment_id: "paymentId" in i.original ? i.original.paymentId : null, attempt: "attempt" in i.original ? i.original.attempt : null,
    mode: i.mode, amount: i.amount === null ? null : Number(i.amount),
    items: i.items?.map((x) => ({ checkout_item_id: x.checkoutItemId, quantity: x.quantity })) ?? null, restock: i.restock ?? false,
    key: i.idempotencyKey, disposition: i.disposition, approver: i.approvedByAccountId, resolved_by: i.resolvedBy ?? null,
  }));
}

/** Approve a pending refund: moves the money now. Idempotent: an already completed refund is returned. */
export async function approvePending(tx: Tx, merchantAccountId: string, refundId: string, approver: string | null, resolvedBy: string | null = null): Promise<RefundOutcome> {
  return outcome(await callMoney<Answer>(tx, "app_refund_resolve", { merchant: merchantAccountId, refund_id: refundId, action: "approve", approver, resolved_by: resolvedBy }));
}

/** Reject a pending refund: releases its reservation, no money moves. Idempotent. */
export async function rejectPending(tx: Tx, merchantAccountId: string, refundId: string): Promise<RefundOutcome> {
  return outcome(await callMoney<Answer>(tx, "app_refund_resolve", { merchant: merchantAccountId, refund_id: refundId, action: "reject" }));
}
