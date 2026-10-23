import type { TransactionSql } from "postgres";
import type { Sql } from "../db";
import { MAX_AMOUNT } from "./money";

type Q = Sql | TransactionSql<{ bigint: bigint }>;
type Tx = TransactionSql<{ bigint: bigint }>;

export type ItemIn = { product_id: string; quantity: number };
/** A priced catalogue line; name, price and discount are snapshotted onto checkout_items. */
export type CartLine = {
  productId: string;
  name: string;
  price: bigint;
  discount: bigint;
  quantity: number;
};
export type Cart = { lines: CartLine[]; total: bigint };

type ProductRow = {
  id: string;
  name: string;
  currency: string;
  price: bigint;
  discount: bigint;
  stock: number | null;
  active: boolean;
  status: string;
};

export type CartError = { error: string; status: 404 | 422 };

function merge(items: ItemIn[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) m.set(it.product_id, (m.get(it.product_id) ?? 0) + it.quantity);
  return m;
}

function sellable(p: ProductRow, quantity: number): string | null {
  if (!p.active || p.status !== "available") return "product_unavailable";
  if (p.currency !== "USD") return "currency_unsupported";
  if (p.stock !== null && p.stock < quantity) return "out_of_stock";
  return null;
}

/** Read-only: price a cart against the merchant's live catalogue and check it is sellable now. */
export async function quoteCart(q: Q, merchantId: string, items: ItemIn[]): Promise<{ cart: Cart } | CartError> {
  const want = merge(items);
  const rows = await q<ProductRow[]>`
    select id, name, currency, price, discount, stock, active, status from products
     where account_id = ${merchantId} and id in ${q([...want.keys()])}`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const lines: CartLine[] = [];
  let total = 0n;
  for (const [productId, quantity] of want) {
    const p = byId.get(productId);
    if (!p) return { error: "product_not_found", status: 404 };
    const bad = sellable(p, quantity);
    if (bad) return { error: bad, status: 422 };
    total += (p.price - p.discount) * BigInt(quantity);
    lines.push({ productId, name: p.name, price: p.price, discount: p.discount, quantity });
  }
  if (total <= 0n || total > MAX_AMOUNT) return { error: "invalid_total", status: 422 };
  return { cart: { lines, total } };
}

export type StockLine = { productId: string; quantity: number };

/** Read-only availability check for lines already on a checkout (price is snapshotted). */
export async function checkStock(q: Q, merchantId: string, lines: StockLine[]): Promise<string | null> {
  if (lines.length === 0) return null;
  const want = new Map<string, number>();
  for (const l of lines) want.set(l.productId, (want.get(l.productId) ?? 0) + l.quantity);
  const rows = await q<ProductRow[]>`
    select id, name, currency, price, discount, stock, active, status from products
     where account_id = ${merchantId} and id in ${q([...want.keys()])}`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const [id, qty] of want) {
    const p = byId.get(id);
    if (!p) return "product_unavailable";
    const bad = sellable(p, qty);
    if (bad) return bad;
  }
  return null;
}

/**
 * Inside the payment transaction: lock the products (stable order) and re-check availability.
 * Returns a decline code, or null when the lines can be sold.
 */
export async function reserveStock(tx: Tx, merchantId: string, lines: StockLine[]): Promise<string | null> {
  if (lines.length === 0) return null;
  const want = new Map<string, number>();
  for (const l of lines) want.set(l.productId, (want.get(l.productId) ?? 0) + l.quantity);
  const ids = [...want.keys()].sort();
  const rows = await tx<ProductRow[]>`
    select id, name, currency, price, discount, stock, active, status from products
     where account_id = ${merchantId} and id in ${tx(ids)}
     order by id for no key update`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const [id, qty] of want) {
    const p = byId.get(id);
    if (!p) return "product_unavailable";
    const bad = sellable(p, qty);
    if (bad) return bad;
  }
  return null;
}

/** After the payment completed: decrement tracked stock and count the sale. */
export async function commitStock(tx: Tx, lines: StockLine[]): Promise<void> {
  const want = new Map<string, number>();
  for (const l of lines) want.set(l.productId, (want.get(l.productId) ?? 0) + l.quantity);
  // One round trip; the updates are applied in product-id order (the lock order).
  await Promise.all([...want].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([id, qty]) => tx`
      update products
         set stock = case when stock is null then null else stock - ${qty} end,
             total_sold = total_sold + ${qty},
             sold_today = case when sold_day = program_today() then sold_today + ${qty} else ${qty} end,
             sold_day = program_today()
       where id = ${id}`));
}
