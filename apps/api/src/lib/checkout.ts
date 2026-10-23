import type { TransactionSql } from "postgres";
import type { Sql } from "../db";
import { n } from "./money";
import type { CartLine } from "./catalog";

type Q = Sql | TransactionSql<{ bigint: bigint }>;
type Tx = TransactionSql<{ bigint: bigint }>;

/** One line of a checkout's immutable snapshot. */
export type ItemSnapshot = {
  id: string;
  product_id: string | null;
  name: string;
  unit_price: number;
  discount: number;
  quantity: number;
};

export type CheckoutRow = {
  id: string;
  account_id: string;
  terminal_id: string | null;
  reference: string | null;
  currency: string;
  total: bigint;
  items: ItemSnapshot[];
  /** open | paid | canceled | expired (expired is derived from expires_at). */
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

const CO_COLS = `id, account_id, terminal_id, reference, currency, total, items,
  case when status = 'open' and expires_at is not null and expires_at <= now() then 'expired' else status end as status,
  expires_at, created_at`;

export const snapshotOf = (lines: CartLine[]): ItemSnapshot[] =>
  lines.map((l) => ({
    id: crypto.randomUUID(),
    product_id: l.productId,
    name: l.name,
    unit_price: Number(l.price),
    discount: Number(l.discount),
    quantity: l.quantity,
  }));

export async function insertCheckout(
  tx: Tx,
  i: {
    merchantId: string;
    terminalId: string | null;
    reference: string | null;
    total: bigint;
    lines: CartLine[];
    expiresInSeconds: number | null;
    /** `paid` for a one-step payment that is written together with its payment. */
    status?: "open" | "paid";
  },
): Promise<CheckoutRow> {
  const [c] = await tx<CheckoutRow[]>`
    insert into checkouts (account_id, terminal_id, reference, total, items, expires_at, status)
    values (${i.merchantId}, ${i.terminalId}, ${i.reference}, ${i.total.toString()}, ${tx.json(snapshotOf(i.lines) as never)},
            ${i.expiresInSeconds === null ? null : tx`now() + make_interval(secs => ${i.expiresInSeconds})`}, ${i.status ?? "open"})
    returning ${tx.unsafe(CO_COLS)}`;
  return c!;
}

export async function getCheckout(q: Q, merchantId: string | null, id: string): Promise<CheckoutRow | undefined> {
  const [c] = await q<CheckoutRow[]>`
    select ${q.unsafe(CO_COLS)} from checkouts
     where id = ${id} ${merchantId ? q`and account_id = ${merchantId}` : q``}`;
  return c;
}

type Counts = Map<string, { done: number; pending: number }>;

/**
 * Units already refunded or reserved by pending refunds, per line, for the given checkouts. A refund's lines are in its transaction's
 * `meta.items` (a pending request keeps them on the `refunds` row), so nothing is stored on the checkout: the payment stays immutable.
 */
async function refundCounts(q: Q, checkoutIds: string[]): Promise<Map<string, Counts>> {
  const out = new Map<string, Counts>();
  if (checkoutIds.length === 0) return out;
  const rows = await q<{ checkout_id: string; item_id: string; done: number; pending: number }[]>`
    select p.checkout_id, i.item ->> 'checkout_item_id' as item_id,
           coalesce(sum((i.item ->> 'quantity')::int) filter (where r.kind = 'done'), 0)::int as done,
           coalesce(sum((i.item ->> 'quantity')::int) filter (where r.kind = 'pending'), 0)::int as pending
      from transactions p
      join (select related_id as pay_id, meta -> 'items' as items, 'done' as kind from transactions where type = 'refund' and status = 'completed' and meta ? 'items'
            union all
            select pay_transaction_id, items, 'pending' from refunds where status = 'pending' and items is not null) r on r.pay_id = p.id
      cross join lateral jsonb_array_elements(r.items) i(item)
     where p.type = 'pay' and p.status = 'completed' and p.checkout_id in ${q(checkoutIds)}
     group by 1, 2`;
  for (const r of rows) {
    let m = out.get(r.checkout_id);
    if (!m) out.set(r.checkout_id, (m = new Map()));
    m.set(r.item_id, { done: r.done, pending: r.pending });
  }
  return out;
}

const toItems = (c: CheckoutRow, counts: Counts | undefined): ItemRow[] =>
  c.items.map((it) => ({
    id: it.id,
    product_id: it.product_id,
    name: it.name,
    unit_price: BigInt(it.unit_price),
    discount: BigInt(it.discount),
    quantity: it.quantity,
    refunded_quantity: counts?.get(it.id)?.done ?? 0,
    refund_pending_quantity: counts?.get(it.id)?.pending ?? 0,
  }));

export async function getItems(q: Q, checkoutId: string): Promise<ItemRow[]> {
  const c = await getCheckout(q, null, checkoutId);
  if (!c) return [];
  return toItems(c, c.status === "paid" ? (await refundCounts(q, [c.id])).get(c.id) : undefined);
}

/** The items of a checkout already read (no extra read of the checkout; one query for the refund counts when it is paid). */
export async function itemsOf(q: Q, c: CheckoutRow): Promise<ItemRow[]> {
  return toItems(c, c.status === "paid" && c.items.length > 0 ? (await refundCounts(q, [c.id])).get(c.id) : undefined);
}

/** A page of a business's checkouts with their items: two queries in all, however many rows (never one per checkout). */
export async function listCheckouts(q: Q, accountId: string, status: string, limit: number) {
  const where =
    status === "open" ? q`status = 'open' and (expires_at is null or expires_at > now())`
    : status === "expired" ? q`status = 'open' and expires_at is not null and expires_at <= now()`
    : q`status = ${status}`;
  const rows = await q<CheckoutRow[]>`
    select ${q.unsafe(CO_COLS)} from checkouts where account_id = ${accountId} and ${where}
     order by created_at desc, id desc limit ${limit}`;
  if (rows.length === 0) return [];
  const counts = status === "paid" ? await refundCounts(q, rows.map((r) => r.id)) : new Map<string, Counts>();
  return rows.map((r) => checkoutJson(r, toItems(r, counts.get(r.id))));
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
