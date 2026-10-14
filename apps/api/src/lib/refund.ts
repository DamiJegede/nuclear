import type { TransactionSql } from "postgres";

type Tx = TransactionSql<{ bigint: bigint }>;

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
  idempotency_key: string;
  timestamp: Date;
  completed_at: Date | null;
};

export const R_COLS = `id, status, status_code, amount, from_account_id, to_account_id, to_wallet_id,
  related_transaction_id, terminal_id, approved_by_account_id, idempotency_key, "timestamp", completed_at`;

export type OriginalRef = { paymentId: string } | { attempt: string };

export type RefundInput = {
  merchantAccountId: string;
  terminalId: string;
  original: OriginalRef;
  mode: "full" | "partial";
  /** Required for partial. */
  amount: bigint | null;
  idempotencyKey: string;
  /**
   * execute: refund now (direct, or already approved by tap/owner).
   * queue: record a pending request (awaiting approval); nothing moves and the amount is reserved.
   */
  disposition: "execute" | "queue";
  /** Approving staff/owner account, or null for a direct refund. */
  approvedByAccountId: string | null;
};

export type RefundOutcome =
  | { kind: "ok" | "declined" | "pending"; row: RefundRow; replayed: boolean; remaining: bigint }
  | { kind: "error"; status: 404 | 409 | 422; error: string };

type OriginalPay = { id: string; status: string; amount: bigint; from_account_id: string; from_wallet_id: string };

export async function findRefund(tx: Tx, merchantAccountId: string, key: string): Promise<RefundRow | undefined> {
  const [r] = await tx<RefundRow[]>`
    select ${tx.unsafe(R_COLS)} from transactions
     where type = 'refund' and from_account_id = ${merchantAccountId} and idempotency_key = ${key}`;
  return r;
}

async function lockOriginal(tx: Tx, merchantAccountId: string, ref: OriginalRef): Promise<OriginalPay | undefined> {
  const [o] = "paymentId" in ref
    ? await tx<OriginalPay[]>`
        select id, status, amount, from_account_id, from_wallet_id from transactions
         where id = ${ref.paymentId} and type = 'pay' and to_account_id = ${merchantAccountId}
         for no key update`
    : await tx<OriginalPay[]>`
        select id, status, amount, from_account_id, from_wallet_id from transactions
         where type = 'pay' and to_account_id = ${merchantAccountId}
           and idempotency_key = ${`t:${ref.attempt}`}
         for no key update`;
  return o;
}

/** Completed refunds and pending (reserved) refunds against one payment. */
async function sums(tx: Tx, paymentId: string): Promise<{ completed: bigint; pending: bigint }> {
  const [r] = await tx<{ completed: bigint; pending: bigint }[]>`
    select coalesce(sum(amount) filter (where status = 'completed'), 0)::bigint as completed,
           coalesce(sum(amount) filter (where status = 'pending'), 0)::bigint as pending
      from transactions where type = 'refund' and related_transaction_id = ${paymentId}`;
  return r!;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * Move the money for an already-inserted refund row and mark it completed.
 *
 * Merchant balance is debited (it may go negative). The customer's outstanding credit from that
 * payment is restored first, bounded by credit actually still owed; the rest becomes funded balance.
 * Either way it is immediately available for payment. Caller holds the original payment row lock.
 */
async function settle(
  tx: Tx,
  refundId: string,
  orig: OriginalPay,
  merchantAccountId: string,
  amount: bigint,
  approver: string | null,
): Promise<RefundRow> {
  const bal = await tx<{ account_id: string; credit_spent: bigint }[]>`
    select account_id, credit_spent from balances
     where account_id in (${merchantAccountId}, ${orig.from_account_id})
     order by account_id for no key update`;
  const payer = bal.find((b) => b.account_id === orig.from_account_id);
  if (!payer || bal.length !== 2) throw new Error("balances row missing");

  const [drew] = await tx<{ n: bigint }[]>`
    select coalesce(sum(amount), 0)::bigint as n from ledger_entries
     where transaction_id = ${orig.id} and bucket = 'credit_receivable' and direction = 'debit'`;
  const [restored] = await tx<{ n: bigint }[]>`
    select coalesce(sum(l.amount), 0)::bigint as n
      from ledger_entries l join transactions r on r.id = l.transaction_id
     where r.type = 'refund' and r.related_transaction_id = ${orig.id}
       and l.bucket = 'credit_receivable' and l.direction = 'credit'`;
  const attributable = drew!.n - restored!.n;
  const creditRestore = min(min(amount, attributable > 0n ? attributable : 0n), payer.credit_spent);
  const toBalance = amount - creditRestore;
  const amt = amount.toString();

  await tx`update balances set balance = balance - ${amt} where account_id = ${merchantAccountId}`;
  await tx`
    update balances set balance = balance + ${toBalance.toString()},
                        credit_spent = credit_spent - ${creditRestore.toString()}
     where account_id = ${orig.from_account_id}`;

  const lines: { account_id: string; bucket: string; direction: "debit" | "credit"; amount: string }[] = [
    { account_id: merchantAccountId, bucket: "funded_balance", direction: "debit", amount: amt },
  ];
  if (toBalance > 0n) {
    lines.push({ account_id: orig.from_account_id, bucket: "funded_balance", direction: "credit", amount: toBalance.toString() });
  }
  if (creditRestore > 0n) {
    lines.push({ account_id: orig.from_account_id, bucket: "credit_receivable", direction: "credit", amount: creditRestore.toString() });
  }
  await tx`
    insert into ledger_entries ${tx(
      lines.map((l, idx) => ({ transaction_id: refundId, posting_key: "refund", line_no: idx + 1, ...l })),
      "transaction_id", "posting_key", "line_no", "account_id", "bucket", "direction", "amount",
    )}`;

  const [r] = await tx<RefundRow[]>`
    update transactions
       set status = 'completed', status_code = null, completed_at = now(),
           approved_by_account_id = ${approver}
     where id = ${refundId} returning ${tx.unsafe(R_COLS)}`;
  return r!;
}

/**
 * Create a refund against a completed payment, inside the caller's DB transaction.
 *
 * - Bounded by the unrefunded amount minus pending (reserved) refunds; the original payment row is
 *   locked so concurrent requests serialize and can never exceed it. Full = everything still free.
 * - disposition "execute" refunds now; "queue" records a pending request awaiting approval.
 * - Idempotent per (merchant, key); retries return the original outcome.
 */
export async function refundCore(tx: Tx, i: RefundInput): Promise<RefundOutcome> {
  const orig = await lockOriginal(tx, i.merchantAccountId, i.original);
  if (!orig) return { kind: "error", status: 404, error: "payment_not_found" };

  const prev = await findRefund(tx, i.merchantAccountId, i.idempotencyKey);
  if (prev) {
    if (prev.related_transaction_id !== orig.id) return { kind: "error", status: 409, error: "idempotency_mismatch" };
    const s = await sums(tx, orig.id);
    return {
      kind: prev.status === "completed" ? "ok" : prev.status === "pending" ? "pending" : "declined",
      row: prev,
      replayed: true,
      remaining: orig.amount - s.completed - s.pending,
    };
  }

  if (orig.status !== "completed") return { kind: "error", status: 422, error: "payment_not_refundable" };

  const s = await sums(tx, orig.id);
  const remaining = orig.amount - s.completed - s.pending;

  let amount: bigint;
  if (i.mode === "full") {
    if (remaining <= 0n) {
      return { kind: "error", status: 422, error: s.pending > 0n ? "refund_pending" : "already_refunded" };
    }
    amount = remaining;
  } else {
    if (i.amount === null || i.amount <= 0n) return { kind: "error", status: 422, error: "invalid_amount" };
    amount = i.amount;
  }

  const queue = i.disposition === "queue";
  const ins = await tx<{ id: string }[]>`
    insert into transactions (type, from_account_id, to_account_id, to_wallet_id, related_transaction_id,
                              terminal_id, amount, status, status_code, idempotency_key)
    values ('refund', ${i.merchantAccountId}, ${orig.from_account_id}, ${orig.from_wallet_id}, ${orig.id},
            ${i.terminalId}, ${amount.toString()}, 'pending', ${queue ? "awaiting_approval" : null},
            ${i.idempotencyKey})
    on conflict (type, from_account_id, idempotency_key) where from_account_id is not null and type <> 'pay'
    do nothing
    returning id`;
  if (!ins[0]) return { kind: "error", status: 409, error: "idempotency_mismatch" };
  const refundId = ins[0].id;

  if (amount > remaining) {
    const [r] = await tx<RefundRow[]>`
      update transactions set status = 'failed', status_code = 'exceeds_refundable'
       where id = ${refundId} returning ${tx.unsafe(R_COLS)}`;
    return { kind: "declined", row: r!, replayed: false, remaining };
  }

  if (queue) {
    const [r] = await tx<RefundRow[]>`select ${tx.unsafe(R_COLS)} from transactions where id = ${refundId}`;
    return { kind: "pending", row: r!, replayed: false, remaining: remaining - amount };
  }

  const row = await settle(tx, refundId, orig, i.merchantAccountId, amount, i.approvedByAccountId);
  return { kind: "ok", row, replayed: false, remaining: remaining - amount };
}

/** Approve a pending refund: moves the money now. Idempotent: an already completed refund is returned. */
export async function approvePending(
  tx: Tx,
  merchantAccountId: string,
  refundId: string,
  approver: string,
): Promise<RefundOutcome> {
  const [head] = await tx<{ related_transaction_id: string }[]>`
    select related_transaction_id from transactions
     where id = ${refundId} and type = 'refund' and from_account_id = ${merchantAccountId}`;
  if (!head) return { kind: "error", status: 404, error: "refund_not_found" };

  const orig = await lockOriginal(tx, merchantAccountId, { paymentId: head.related_transaction_id });
  if (!orig) return { kind: "error", status: 404, error: "payment_not_found" };
  const [r] = await tx<RefundRow[]>`
    select ${tx.unsafe(R_COLS)} from transactions where id = ${refundId} for no key update`;
  const s = await sums(tx, orig.id);
  const remaining = orig.amount - s.completed - s.pending;
  if (r!.status === "completed") return { kind: "ok", row: r!, replayed: true, remaining };
  if (r!.status !== "pending") return { kind: "error", status: 422, error: "refund_not_pending" };

  const row = await settle(tx, refundId, orig, merchantAccountId, r!.amount, approver);
  return { kind: "ok", row, replayed: false, remaining };
}

/** Reject a pending refund: releases its reservation, no money moves. Idempotent. */
export async function rejectPending(tx: Tx, merchantAccountId: string, refundId: string): Promise<RefundOutcome> {
  const [head] = await tx<{ related_transaction_id: string }[]>`
    select related_transaction_id from transactions
     where id = ${refundId} and type = 'refund' and from_account_id = ${merchantAccountId}`;
  if (!head) return { kind: "error", status: 404, error: "refund_not_found" };

  const orig = await lockOriginal(tx, merchantAccountId, { paymentId: head.related_transaction_id });
  if (!orig) return { kind: "error", status: 404, error: "payment_not_found" };
  const [r] = await tx<RefundRow[]>`
    select ${tx.unsafe(R_COLS)} from transactions where id = ${refundId} for no key update`;
  if (r!.status === "failed" && r!.status_code === "rejected") {
    const s = await sums(tx, orig.id);
    return { kind: "declined", row: r!, replayed: true, remaining: orig.amount - s.completed - s.pending };
  }
  if (r!.status !== "pending") return { kind: "error", status: 422, error: "refund_not_pending" };

  const [row] = await tx<RefundRow[]>`
    update transactions set status = 'failed', status_code = 'rejected'
     where id = ${refundId} returning ${tx.unsafe(R_COLS)}`;
  const s = await sums(tx, orig.id);
  return { kind: "declined", row: row!, replayed: false, remaining: orig.amount - s.completed - s.pending };
}
