import type { TransactionSql } from "postgres";
import type { Sql } from "../db";
import { MAX_AMOUNT } from "./money";

type Q = Sql | TransactionSql<{ bigint: bigint }>;
type Tx = TransactionSql<{ bigint: bigint }>;

export type ItemIn = { product_id: string; quantity: number };
export type CartLine = { productId: string; quantity: number; unitPrice: bigint };
export type Cart = { lines: CartLine[]; total: bigint };

type ProductRow = {
  id: string;
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

function evaluate(
  rows: ProductRow[],
  want: Map<string, number>,
): { cart: Cart } | CartError {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const lines: CartLine[] = [];
  let total = 0n;
  for (const [productId, quantity] of want) {
    const p = byId.get(productId);
    if (!p) return { error: "product_not_found", status: 404 };
    if (!p.active || p.status !== "available") return { error: "product_unavailable", status: 422 };
    if (p.currency !== "USD") return { error: "currency_unsupported", status: 422 };
    if (p.stock !== null && p.stock < quantity) return { error: "out_of_stock", status: 422 };
    const unitPrice = p.price - p.discount;
    total += unitPrice * BigInt(quantity);
    lines.push({ productId, quantity, unitPrice });
  }
  if (total <= 0n || total > MAX_AMOUNT) return { error: "invalid_total", status: 422 };
  return { cart: { lines, total } };
}

/** Read-only: price a cart against the merchant's live catalogue. */
export async function quoteCart(q: Q, merchantId: string, items: ItemIn[]): Promise<{ cart: Cart } | CartError> {
  const want = merge(items);
  const rows = await q<ProductRow[]>`
    select id, currency, price, discount, stock, active, status from products
     where account_id = ${merchantId} and id in ${q([...want.keys()])}`;
  return evaluate(rows, want);
}

/**
 * Inside the payment transaction: lock the products (stable order) and re-check availability and
 * price. Returns a decline code, or null when the cart can be sold.
 */
export async function reserveCart(tx: Tx, merchantId: string, cart: Cart): Promise<string | null> {
  const ids = cart.lines.map((l) => l.productId).sort();
  const rows = await tx<ProductRow[]>`
    select id, currency, price, discount, stock, active, status from products
     where account_id = ${merchantId} and id in ${tx(ids)}
     order by id for no key update`;
  const want = new Map(cart.lines.map((l) => [l.productId, l.quantity]));
  const r = evaluate(rows, want);
  if ("error" in r) return r.error === "product_not_found" ? "product_unavailable" : r.error;
  if (r.cart.total !== cart.total) return "price_changed";
  return null;
}

/** After the payment completed: decrement tracked stock and count the sale. */
export async function commitCart(tx: Tx, cart: Cart): Promise<void> {
  for (const l of cart.lines) {
    await tx`
      update products
         set stock = case when stock is null then null else stock - ${l.quantity} end,
             total_sold = total_sold + ${l.quantity},
             sold_today = sold_today + ${l.quantity}
       where id = ${l.productId}`;
  }
}
