import { creditWallet } from "./walletFunds";
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
};

export type RefundOutcome =
  | { kind: "ok" | "declined" | "pending"; row: RefundRow; replayed: boolean; remaining: bigint }
  | { kind: "error"; status: 404 | 409 | 422; error: string };

type OriginalPay = {
  id: string; status: string; amount: bigint; from_account_id: string; from_wallet_id: string; checkout_id: string | null;
};

export async function findRefund(tx: Tx, merchantAccountId: string, key: string): Promise<RefundRow | undefined> {
  const [r] = await tx<RefundRow[]>`
    select ${tx.unsafe(R_COLS)} from transactions
     where type = 'refund' and from_account_id = ${merchantAccountId} and idempotency_key = ${key}`;
  return r;
}

async function lockOriginal(tx: Tx, merchantAccountId: string, ref: OriginalRef): Promise<OriginalPay | undefined> {
  const [o] = "paymentId" in ref
    ? await tx<OriginalPay[]>`
        select id, status, amount, from_account_id, from_wallet_id, checkout_id from transactions
         where id = ${ref.paymentId} and type = 'pay' and to_account_id = ${merchantAccountId}
         for no key update`
    : await tx<OriginalPay[]>`
        select id, status, amount, from_account_id, from_wallet_id, checkout_id from transactions
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
  // Restock first: products are locked before balances everywhere (payments do the same), so a
  // refund and a sale of the same product cannot deadlock.
  const [self] = await tx<{ items: RefundRow["items"] }[]>`select items from transactions where id = ${refundId}`;
  const back = (self?.items ?? []).filter((x) => x.restock);
  if (back.length > 0) {
    const rows = await tx<{ product_id: string; q: number }[]>`
      select ci.product_id, sum(x.quantity)::int as q
        from jsonb_to_recordset(${tx.json(back as never)}) as x(checkout_item_id uuid, quantity int)
        join checkout_items ci on ci.id = x.checkout_item_id
       where ci.product_id is not null
       group by ci.product_id order by ci.product_id`;
    // Sent together (one round trip), applied in product-id order.
    await Promise.all(rows.map((r) => tx`update products set stock = stock + ${r.q} where id = ${r.product_id} and stock is not null`));
  }

  // Item refunds: the reserved units become refunded units on the order's lines.
  await Promise.all((self?.items ?? []).map((it) => tx`
      update checkout_items
         set refund_pending_quantity = refund_pending_quantity - ${it.quantity},
             refunded_quantity = refunded_quantity + ${it.quantity}
       where id = ${it.checkout_item_id}`));

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
  if (orig.from_wallet_id) await creditWallet(tx, orig.from_wallet_id, toBalance);   // back to an earmarked wallet
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
  let itemsJson: { checkout_item_id: string; quantity: number; restock: boolean }[] | null = null;
  if (i.mode === "full") {
    if (remaining <= 0n) {
      return { kind: "error", status: 422, error: s.pending > 0n ? "refund_pending" : "already_refunded" };
    }
    amount = remaining;
  } else if (i.mode === "items") {
    const [pay] = await tx<{ checkout_id: string | null }[]>`select checkout_id from transactions where id = ${orig.id}`;
    if (!pay?.checkout_id) return { kind: "error", status: 422, error: "payment_has_no_items" };
    const want = new Map<string, number>();
    for (const it of i.items ?? []) want.set(it.checkoutItemId, (want.get(it.checkoutItemId) ?? 0) + it.quantity);
    if (want.size === 0) return { kind: "error", status: 422, error: "invalid_items" };

    // Free units per line = quantity - refunded - reserved by pending refunds.
    const lines = await tx<{ id: string; unit_price: bigint; discount: bigint; free: number }[]>`
      select id, unit_price, discount, (quantity - refunded_quantity - refund_pending_quantity) as free
        from checkout_items where checkout_id = ${pay.checkout_id}`;
    if (lines.length === 0) return { kind: "error", status: 422, error: "payment_has_no_items" };
    const byId = new Map(lines.map((l) => [l.id, l]));
    amount = 0n;
    itemsJson = [];
    for (const [itemId, qty] of want) {
      const l = byId.get(itemId);
      if (!l) return { kind: "error", status: 404, error: "item_not_found" };
      if (qty > l.free) return { kind: "error", status: 422, error: "item_quantity_exceeded" };
      amount += (l.unit_price - l.discount) * BigInt(qty);
      itemsJson.push({ checkout_item_id: itemId, quantity: qty, restock: i.restock ?? false });
    }
    if (amount <= 0n) return { kind: "error", status: 422, error: "invalid_amount" };
  } else {
    if (i.amount === null || i.amount <= 0n) return { kind: "error", status: 422, error: "invalid_amount" };
    amount = i.amount;
  }

  const queue = i.disposition === "queue";
  const ins = await tx<{ id: string }[]>`
    insert into transactions (type, from_account_id, to_account_id, to_wallet_id, related_transaction_id,
                              terminal_id, checkout_id, items, amount, status, status_code, idempotency_key)
    values ('refund', ${i.merchantAccountId}, ${orig.from_account_id}, ${orig.from_wallet_id}, ${orig.id},
            ${i.terminalId}, ${orig.checkout_id}, ${itemsJson === null ? null : tx.json(itemsJson as never)},
            ${amount.toString()}, 'pending', ${queue ? "awaiting_approval" : null}, ${i.idempotencyKey})
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

  // Accepted: reserve the units on the order's lines (settle() moves them to refunded).
  await Promise.all((itemsJson ?? []).map((it) => tx`
      update checkout_items set refund_pending_quantity = refund_pending_quantity + ${it.quantity}
       where id = ${it.checkout_item_id}`));

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
  approver: string | null,
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
  await Promise.all((row!.items ?? []).map((it) => tx`
      update checkout_items set refund_pending_quantity = refund_pending_quantity - ${it.quantity}
       where id = ${it.checkout_item_id}`));
  const s = await sums(tx, orig.id);
  return { kind: "declined", row: row!, replayed: false, remaining: orig.amount - s.completed - s.pending };
}
