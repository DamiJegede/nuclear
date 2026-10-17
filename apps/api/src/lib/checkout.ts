import type { TransactionSql } from "postgres";
import type { Sql } from "../db";
import { n } from "./money";
import { commitStock, reserveStock, type CartLine, type StockLine } from "./catalog";
import { findPay, payCore, type PayInput, type PayOutcome } from "./pay";

type Q = Sql | TransactionSql<{ bigint: bigint }>;
type Tx = TransactionSql<{ bigint: bigint }>;

export type CheckoutRow = {
  id: string;
  account_id: string;
  terminal_id: string | null;
  reference: string | null;
  currency: string;
  total: bigint;
  status: string;
  expires_at: Date | null;
  created_at: Date;
};

export type ItemRow = {
  id: string;
  product_id: string | null;
  name: string;
  unit_price: bigint;
  discount: bigint;
  quantity: number;
  /** Units returned by completed item refunds. */
  refunded_quantity: number;
  /** Units reserved by pending item refunds. */
  refund_pending_quantity: number;
};

const CO_COLS = `id, account_id, terminal_id, reference, currency, total, status, expires_at, created_at`;

export async function insertCheckout(
  tx: Tx,
  i: {
    merchantId: string;
    terminalId: string | null;
    reference: string | null;
    total: bigint;
    lines: CartLine[];
    expiresInSeconds: number | null;
  },
): Promise<CheckoutRow> {
  const [c] = await tx<CheckoutRow[]>`
    insert into checkouts (account_id, terminal_id, reference, total, expires_at)
    values (${i.merchantId}, ${i.terminalId}, ${i.reference}, ${i.total.toString()},
            ${i.expiresInSeconds === null ? null : tx`now() + make_interval(secs => ${i.expiresInSeconds})`})
    returning ${tx.unsafe(CO_COLS)}`;
  if (i.lines.length > 0) {
    await tx`
      insert into checkout_items ${tx(
        i.lines.map((l) => ({
          checkout_id: c!.id,
          product_id: l.productId,
          name: l.name,
          unit_price: l.price.toString(),
          discount: l.discount.toString(),
          quantity: l.quantity,
        })),
        "checkout_id", "product_id", "name", "unit_price", "discount", "quantity",
      )}`;
  }
  return c!;
}

export async function getCheckout(q: Q, merchantId: string | null, id: string): Promise<CheckoutRow | undefined> {
  const [c] = await q<CheckoutRow[]>`
    select ${q.unsafe(CO_COLS)} from checkouts
     where id = ${id} ${merchantId ? q`and account_id = ${merchantId}` : q``}`;
  return c;
}

export async function getItems(q: Q, checkoutId: string): Promise<ItemRow[]> {
  return q<ItemRow[]>`
    select id, product_id, name, unit_price, discount, quantity, refunded_quantity, refund_pending_quantity
      from checkout_items where checkout_id = ${checkoutId}
     order by created_at, id`;
}

/** A page of a business's checkouts with their items: two queries in all, however many rows (never one per checkout). */
export async function listCheckouts(q: Q, accountId: string, status: string, limit: number) {
  const rows = await q<CheckoutRow[]>`
    select ${q.unsafe(CO_COLS)} from checkouts where account_id = ${accountId} and status = ${status}
     order by created_at desc, id desc limit ${limit}`;
  if (rows.length === 0) return [];
  const items = await q<(ItemRow & { checkout_id: string })[]>`
    select id, checkout_id, product_id, name, unit_price, discount, quantity, refunded_quantity, refund_pending_quantity
      from checkout_items where checkout_id in ${q(rows.map((r) => r.id))}
     order by created_at, id`;
  const by = new Map<string, ItemRow[]>();
  for (const it of items) (by.get(it.checkout_id) ?? by.set(it.checkout_id, []).get(it.checkout_id)!).push(it);
  return rows.map((r) => checkoutJson(r, by.get(r.id) ?? []));
}

export const itemJson = (it: ItemRow) => ({
  id: it.id,
  product_id: it.product_id,
  name: it.name,
  unit_price: n(it.unit_price),
  discount: n(it.discount),
  net_price: n(it.unit_price - it.discount),
  quantity: it.quantity,
  refunded_quantity: it.refunded_quantity,
  pending_refund_quantity: it.refund_pending_quantity,
  refundable_quantity: it.quantity - it.refunded_quantity - it.refund_pending_quantity,
});

export const checkoutJson = (c: CheckoutRow, items: ItemRow[]) => ({
  id: c.id,
  status: c.status,
  reference: c.reference,
  currency: c.currency,
  total: n(c.total),
  terminal_id: c.terminal_id,
  expires_at: c.expires_at,
  created_at: c.created_at,
  items: items.map(itemJson),
});

export type PayCheckoutInput = Omit<PayInput, "checkoutId" | "amount" | "forceDecline" | "reference"> & {
  /** Pay this existing checkout... */
  checkoutId: string | null;
  /** ...or create one in the same transaction (one-step). */
  create: { lines: CartLine[]; total: bigint; reference: string | null } | null;
  /** If set, a recorded attempt of a different amount is a conflict. */
  expectAmount?: bigint;
};

const stockLines = (items: { product_id: string | null; quantity: number }[]): StockLine[] =>
  items.filter((x) => x.product_id !== null).map((x) => ({ productId: x.product_id!, quantity: x.quantity }));

/**
 * Settle a checkout with a payment, inside the caller's DB transaction. Idempotent per attempt key:
 * a recorded attempt returns its result without creating or touching anything.
 *
 * Locks, in order: the checkout, its products (stable order), then the payment's balance/wallet
 * rows (see payCore). Stock is taken here, at payment, only when the payment completes.
 */
export async function payCheckout(tx: Tx, i: PayCheckoutInput): Promise<PayOutcome> {
  // Replay first, so a retry never creates a second checkout.
  const prev = await findPay(tx, i.merchantAccountId, i.idempotencyKey);
  if (prev) {
    if (i.expectAmount !== undefined && i.expectAmount !== prev.amount) return { kind: "conflict" };
    return payCore(tx, { ...i, checkoutId: prev.checkout_id, amount: prev.amount, reference: prev.reference });
  }

  let checkout: CheckoutRow;
  let decline: string | null = null;
  let created = false;

  if (i.checkoutId) {
    const [c] = await tx<(CheckoutRow & { is_expired: boolean })[]>`
      select ${tx.unsafe(CO_COLS)}, (expires_at is not null and expires_at <= now()) as is_expired
        from checkouts where id = ${i.checkoutId} and account_id = ${i.merchantAccountId}
         for no key update`;
    if (!c) throw new Error("checkout missing");
    checkout = c;
    if (c.status !== "open") {
      decline = c.status === "paid" ? "checkout_paid" : "checkout_not_open";
    } else if (c.is_expired) {
      await tx`update checkouts set status = 'expired' where id = ${c.id}`;
      decline = "checkout_expired";
    }
  } else {
    checkout = await insertCheckout(tx, {
      merchantId: i.merchantAccountId,
      terminalId: i.terminalId,
      reference: i.create!.reference,
      total: i.create!.total,
      lines: i.create!.lines,
      expiresInSeconds: null,
    });
    created = true;
  }

  const items = await tx<{ product_id: string | null; quantity: number }[]>`
    select product_id, quantity from checkout_items where checkout_id = ${checkout.id}`;
  const lines = stockLines(items);
  if (!decline) decline = await reserveStock(tx, i.merchantAccountId, lines);

  const out = await payCore(tx, {
    ...i,
    checkoutId: checkout.id,
    amount: checkout.total,
    reference: checkout.reference,
    forceDecline: decline,
  });

  if (out.kind === "ok" && !out.replayed) {
    await commitStock(tx, lines);
    await tx`update checkouts set status = 'paid' where id = ${checkout.id}`;
  } else if (out.kind === "declined" && !out.replayed && created) {
    // A one-step checkout that failed to settle is dead; the POS starts a new one.
    await tx`update checkouts set status = 'canceled' where id = ${checkout.id}`;
  }
  return out;
}
