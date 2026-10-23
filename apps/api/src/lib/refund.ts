import { creditWallet } from "./walletFunds";
import { SYSTEM_ACCOUNT } from "./system";
import { getCheckout, itemsOf } from "./checkout";
import { insertTx } from "./txn";
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
  | { kind: "error"; status: 404 | 409 | 422; error: string };

type OriginalPay = {
  id: string; status: string; amount: bigint; credit_amount: bigint; from_account_id: string; from_wallet_id: string;
  checkout_id: string | null; merchant_wallet_id: string;
};

export const refundIdem = (merchantAccountId: string, key: string) => `refund:${merchantAccountId}:${key}`;

export async function findRefund(tx: Tx, merchantAccountId: string, key: string): Promise<RefundRow | undefined> {
  const [r] = await tx<RefundRow[]>`
    select ${tx.unsafe(R_COLS)} from txn
     where type = 'refund' and idempotency_key = ${refundIdem(merchantAccountId, key)}`;
  return r;
}

async function lockOriginal(tx: Tx, merchantAccountId: string, ref: OriginalRef): Promise<OriginalPay | undefined> {
  const cols = tx`t.id, t.status, t.amount, t.credit_amount, t.from_wallet_id, fw.account_id as from_account_id, t.checkout_id,
        (select id from wallets where account_id = ${merchantAccountId} and type = 'default') as merchant_wallet_id`;
  const [o] = "paymentId" in ref
    ? await tx<OriginalPay[]>`
        select ${cols} from transactions t
          join wallets fw on fw.id = t.from_wallet_id join wallets tw on tw.id = t.to_wallet_id
         where t.id = ${ref.paymentId} and t.type = 'pay' and tw.account_id = ${merchantAccountId}
           for no key update of t`
    : await tx<OriginalPay[]>`
        select ${cols} from transactions t
          join wallets fw on fw.id = t.from_wallet_id
         where t.type = 'pay' and t.idem = ${`pay:${merchantAccountId}:t:${ref.attempt}`}
           for no key update of t`;
  return o;
}

/** Completed refunds and pending (reserved) refunds against one payment. */
async function sums(tx: Tx, paymentId: string): Promise<{ completed: bigint; pending: bigint }> {
  const [[c], [p]] = await Promise.all([
    tx<{ n: bigint }[]>`select coalesce(sum(amount), 0)::bigint as n from transactions
                         where type = 'refund' and status = 'completed' and related_id = ${paymentId}`,
    tx<{ n: bigint }[]>`select coalesce(sum(amount), 0)::bigint as n from refunds
                         where pay_transaction_id = ${paymentId} and status = 'pending'`,
  ]);
  return { completed: c!.n, pending: p!.n };
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

type ItemsJson = { checkout_item_id: string; quantity: number; restock: boolean }[];

/**
 * Move the money for a refund and write its transaction (with `id` when an approved request keeps its own id).
 *
 * Merchant balance is debited (it may go negative). The customer's outstanding credit from that
 * payment is restored first, bounded by credit actually still owed; the rest becomes funded balance.
 * Either way it is immediately available for payment. Caller holds the original payment row lock.
 */
async function settle(
  tx: Tx,
  i: { id?: string; idem: string; terminalId: string | null; items: ItemsJson | null; approver: string | null; resolvedBy: string | null; merchantAccountId: string; amount: bigint },
  orig: OriginalPay,
): Promise<RefundRow> {
  // Restock first: products are locked before balances everywhere (payments do the same), so a
  // refund and a sale of the same product cannot deadlock.
  const back = (i.items ?? []).filter((x) => x.restock);
  if (back.length > 0 && orig.checkout_id) {
    const rows = await tx<{ product_id: string; q: number }[]>`
      select ci.item ->> 'product_id' as product_id, sum(x.quantity)::int as q
        from jsonb_to_recordset(${tx.json(back as never)}) as x(checkout_item_id text, quantity int)
        join checkouts c on c.id = ${orig.checkout_id}
        cross join lateral jsonb_array_elements(c.items) ci(item)
       where ci.item ->> 'id' = x.checkout_item_id and ci.item ->> 'product_id' is not null
       group by 1 order by 1`;
    // Sent together (one round trip), applied in product-id order.
    await Promise.all(rows.map((r) => tx`update products set stock = stock + ${r.q} where id = ${r.product_id}::uuid and stock is not null`));
  }

  const [bal, [restored]] = await Promise.all([
    tx<{ account_id: string; credit_spent: bigint }[]>`
      select account_id, credit_spent from balances
       where account_id in (${i.merchantAccountId}, ${orig.from_account_id})
       order by account_id for no key update`,
    tx<{ n: bigint }[]>`
      select coalesce(sum(credit_amount), 0)::bigint as n from transactions
       where type = 'refund' and status = 'completed' and related_id = ${orig.id}`,
  ]);
  const payer = bal.find((b) => b.account_id === orig.from_account_id);
  if (!payer || bal.length !== 2) throw new Error("balances row missing");

  const attributable = orig.credit_amount - restored!.n;
  const creditRestore = min(min(i.amount, attributable > 0n ? attributable : 0n), payer.credit_spent);
  const toBalance = i.amount - creditRestore;
  const amt = i.amount.toString();

  // The refund goes back to the wallet that paid: a Benefits wallet gets its own money back (never ordinary headroom; refunds are never
  // capped and never counted against the daily value).
  const [, , , [w]] = await Promise.all([
    tx`update balances set balance = balance - ${amt} where account_id = ${i.merchantAccountId}`,
    creditWallet(tx, orig.from_wallet_id, toBalance),   // back to an earmarked wallet
    tx`update balances set balance = balance + ${toBalance.toString()},
                           credit_spent = credit_spent - ${creditRestore.toString()}
        where account_id = ${orig.from_account_id}`,
    insertTx(tx, {
      id: i.id, type: "refund", from: orig.merchant_wallet_id, to: orig.from_wallet_id, amount: i.amount, credit: creditRestore,
      related: orig.id, terminal: i.terminalId, checkout: orig.checkout_id, account: i.approver ?? (i.resolvedBy ? SYSTEM_ACCOUNT : i.merchantAccountId), idem: i.idem,
      meta: {
        ...(i.items ? { items: i.items } : {}),
        ...(i.approver || i.resolvedBy ? { approved: true } : {}),
        ...(i.resolvedBy ? { provider_reference: i.resolvedBy } : {}),
      },
    }),
  ]);
  return {
    id: w!.id, status: "completed", status_code: null, amount: i.amount, from_account_id: i.merchantAccountId,
    to_account_id: orig.from_account_id, to_wallet_id: orig.from_wallet_id, related_transaction_id: orig.id, terminal_id: i.terminalId,
    approved_by_account_id: i.approver ? i.approver : i.resolvedBy ? SYSTEM_ACCOUNT : null, items: i.items,
    idempotency_key: i.idem, timestamp: w!.created_at, completed_at: w!.created_at,
  };
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

  const idem = refundIdem(i.merchantAccountId, i.idempotencyKey);
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
  let itemsJson: ItemsJson | null = null;
  if (i.mode === "full") {
    if (remaining <= 0n) {
      return { kind: "error", status: 422, error: s.pending > 0n ? "refund_pending" : "already_refunded" };
    }
    amount = remaining;
  } else if (i.mode === "items") {
    if (!orig.checkout_id) return { kind: "error", status: 422, error: "payment_has_no_items" };
    const want = new Map<string, number>();
    for (const it of i.items ?? []) want.set(it.checkoutItemId, (want.get(it.checkoutItemId) ?? 0) + it.quantity);
    if (want.size === 0) return { kind: "error", status: 422, error: "invalid_items" };

    // Free units per line = quantity - refunded - reserved by pending refunds (read under the payment's row lock).
    const co = await getCheckout(tx, null, orig.checkout_id);
    const lines = co ? await itemsOf(tx, co) : [];
    if (lines.length === 0) return { kind: "error", status: 422, error: "payment_has_no_items" };
    const byId = new Map(lines.map((l) => [l.id, l]));
    amount = 0n;
    itemsJson = [];
    for (const [itemId, qty] of want) {
      const l = byId.get(itemId);
      if (!l) return { kind: "error", status: 404, error: "item_not_found" };
      if (qty > l.quantity - l.refunded_quantity - l.refund_pending_quantity) return { kind: "error", status: 422, error: "item_quantity_exceeded" };
      amount += (l.unit_price - l.discount) * BigInt(qty);
      itemsJson.push({ checkout_item_id: itemId, quantity: qty, restock: i.restock ?? false });
    }
    if (amount <= 0n) return { kind: "error", status: 422, error: "invalid_amount" };
  } else {
    if (i.amount === null || i.amount <= 0n) return { kind: "error", status: 422, error: "invalid_amount" };
    amount = i.amount;
  }

  if (amount > remaining) {
    const [w] = await insertTx(tx, {
      type: "refund", declined: "exceeds_refundable", from: orig.merchant_wallet_id, to: orig.from_wallet_id, amount,
      related: orig.id, terminal: i.terminalId, checkout: orig.checkout_id, account: i.merchantAccountId, idem,
      meta: itemsJson ? { items: itemsJson } : {},
    });
    const row: RefundRow = {
      id: w!.id, status: "failed", status_code: "exceeds_refundable", amount, from_account_id: i.merchantAccountId,
      to_account_id: orig.from_account_id, to_wallet_id: orig.from_wallet_id, related_transaction_id: orig.id, terminal_id: i.terminalId,
      approved_by_account_id: null, items: itemsJson, idempotency_key: idem, timestamp: w!.created_at, completed_at: null,
    };
    return { kind: "declined", row, replayed: false, remaining };
  }

  if (i.disposition === "queue") {
    // A pending request reserves its amount and units; the refund transaction is written when it is approved.
    const [q] = await tx<{ id: string; created_at: Date }[]>`
      insert into refunds (merchant_account_id, pay_transaction_id, terminal_id, amount, mode, items, idem)
      values (${i.merchantAccountId}, ${orig.id}, ${i.terminalId}, ${amount.toString()}, ${i.mode},
              ${itemsJson === null ? null : tx.json(itemsJson as never)}, ${idem})
      returning id, created_at`;
    const row: RefundRow = {
      id: q!.id, status: "pending", status_code: "awaiting_approval", amount, from_account_id: i.merchantAccountId,
      to_account_id: orig.from_account_id, to_wallet_id: orig.from_wallet_id, related_transaction_id: orig.id, terminal_id: i.terminalId,
      approved_by_account_id: null, items: itemsJson, idempotency_key: idem, timestamp: q!.created_at, completed_at: null,
    };
    return { kind: "pending", row, replayed: false, remaining: remaining - amount };
  }

  const row = await settle(tx, { idem, terminalId: i.terminalId, items: itemsJson, approver: i.approvedByAccountId, resolvedBy: i.resolvedBy ?? null, merchantAccountId: i.merchantAccountId, amount }, orig);
  return { kind: "ok", row, replayed: false, remaining: remaining - amount };
}

type Request = {
  id: string; status: string; pay_transaction_id: string; terminal_id: string | null; amount: bigint; items: ItemsJson | null; idem: string;
  created_at: Date;
};

const loadRequest = async (tx: Tx, merchantAccountId: string, refundId: string): Promise<Request | undefined> =>
  (await tx<Request[]>`
    select id, status, pay_transaction_id, terminal_id, amount, items, idem, created_at from refunds
     where id = ${refundId} and merchant_account_id = ${merchantAccountId}`)[0];

/** Approve a pending refund: moves the money now. Idempotent: an already completed refund is returned. */
export async function approvePending(
  tx: Tx,
  merchantAccountId: string,
  refundId: string,
  approver: string | null,
  resolvedBy: string | null = null,
): Promise<RefundOutcome> {
  const head = await loadRequest(tx, merchantAccountId, refundId);
  if (!head) {
    // A refund that was never a request (it executed at once) is already completed: approving it again changes nothing.
    const [done] = await tx<RefundRow[]>`select ${tx.unsafe(R_COLS)} from txn where id = ${refundId} and type = 'refund' and from_account_id = ${merchantAccountId}`;
    if (!done) return { kind: "error", status: 404, error: "refund_not_found" };
    const s = await sums(tx, done.related_transaction_id);
    const [p] = await tx<{ amount: bigint }[]>`select amount from transactions where id = ${done.related_transaction_id}`;
    if (done.status === "completed") return { kind: "ok", row: done, replayed: true, remaining: p!.amount - s.completed - s.pending };
    return { kind: "error", status: 422, error: "refund_not_pending" };
  }

  const orig = await lockOriginal(tx, merchantAccountId, { paymentId: head.pay_transaction_id });
  if (!orig) return { kind: "error", status: 404, error: "payment_not_found" };
  const [r] = await tx<Request[]>`select id, status from refunds where id = ${refundId} for no key update`;
  const s = await sums(tx, orig.id);
  const remaining = orig.amount - s.completed - s.pending;
  if (r!.status === "approved") {
    const [done] = await tx<RefundRow[]>`select ${tx.unsafe(R_COLS)} from txn where id = ${refundId} and type = 'refund'`;
    return { kind: "ok", row: done!, replayed: true, remaining };
  }
  if (r!.status !== "pending") return { kind: "error", status: 422, error: "refund_not_pending" };

  const row = await settle(tx, {
    id: head.id, idem: head.idem, terminalId: head.terminal_id, items: head.items, approver, resolvedBy, merchantAccountId, amount: head.amount,
  }, orig);
  await tx`update refunds set status = 'approved', approved_by_account_id = ${approver ?? SYSTEM_ACCOUNT}, resolved_at = now() where id = ${refundId}`;
  return { kind: "ok", row, replayed: false, remaining };
}

/** Reject a pending refund: releases its reservation, no money moves. Idempotent. */
export async function rejectPending(tx: Tx, merchantAccountId: string, refundId: string): Promise<RefundOutcome> {
  const head = await loadRequest(tx, merchantAccountId, refundId);
  if (!head) {
    const [done] = await tx<{ id: string }[]>`select id from txn where id = ${refundId} and type = 'refund' and from_account_id = ${merchantAccountId}`;
    return done ? { kind: "error", status: 422, error: "refund_not_pending" } : { kind: "error", status: 404, error: "refund_not_found" };
  }

  const orig = await lockOriginal(tx, merchantAccountId, { paymentId: head.pay_transaction_id });
  if (!orig) return { kind: "error", status: 404, error: "payment_not_found" };
  const [cur] = await tx<{ status: string }[]>`select status from refunds where id = ${refundId} for no key update`;
  if (cur!.status === "approved") return { kind: "error", status: 422, error: "refund_not_pending" };
  if (cur!.status === "pending") await tx`update refunds set status = 'rejected', resolved_at = now() where id = ${refundId}`;
  const [row] = await tx<RefundRow[]>`select ${tx.unsafe(R_COLS)} from txn where id = ${refundId} and type = 'refund'`;
  const s = await sums(tx, orig.id);
  return { kind: "declined", row: row!, replayed: cur!.status === "rejected", remaining: orig.amount - s.completed - s.pending };
}
