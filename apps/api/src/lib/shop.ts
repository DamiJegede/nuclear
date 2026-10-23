import type { Sql } from "../db";
import { n } from "./money";
import { apiUrl, imageUrl } from "./images";
import { callMoney } from "./txn";

export const MAX_PER_ORDER = 20;

export type Shipping = {
  name: string; line1: string; line2?: string; city: string; region: string; postal_code: string; country: string;
};

type ModelRow = {
  id: string; type: string; name: string; photo: string | null; currency: string; price: bigint;
  limited: boolean; quantity: number; sold: number;
};

const modelJson = (m: ModelRow) => ({
  id: m.id, type: m.type, name: m.name, photo: imageUrl(m.photo), currency: m.currency, price: n(m.price),
  limited: m.limited, remaining: m.quantity - m.sold, max_per_order: Math.min(MAX_PER_ORDER, m.quantity - m.sold),
});

/** Tag models on sale: status available and at least one unit left. */
export async function availableModels(sql: Sql, id?: string) {
  const rows = await sql<ModelRow[]>`
    select m.id, m.type, m.name, m.photo, m.currency, m.price, m.limited, m.quantity, m.sold
      from tag_models m
     where m.status = 'available' and m.quantity > m.sold and m.price > 0
       ${id ? sql`and m.id = ${id}` : sql``}
     order by m.created_at, m.id`;
  return rows.map(modelJson);
}

type ItemRow = {
  id: string; name: string; description: string | null; photo: string | null; currency: string; price: bigint; stock: number | null; sold: number; kind: "physical" | "digital";
};
const itemJson = (i: ItemRow) => ({
  id: i.id, name: i.name, description: i.description, photo: imageUrl(i.photo), currency: i.currency, price: n(i.price),
  kind: i.kind, requires_shipping: i.kind === "physical",
  remaining: i.stock, max_per_order: i.kind === "digital" ? 1 : i.stock === null ? MAX_PER_ORDER : Math.min(MAX_PER_ORDER, i.stock),
});

/** Merchandise on sale: status available, stock left (or not tracked) and a price. */
export async function availableItems(sql: Sql, id?: string) {
  const rows = await sql<ItemRow[]>`
    select id, name, description, photo, currency, price, stock, sold, kind from shop
     where status = 'available' and (stock is null or stock > 0) and price > 0
       ${id ? sql`and id = ${id}` : sql``}
     order by created_at, id`;
  return rows.map(itemJson);
}

type OrderRow = {
  id: string; type: "tag" | "shop"; model_id: string | null; shop_id: string | null; name: string; model_type: string | null; quantity: number;
  unit_price: bigint; total: bigint; currency: string; shipping: Shipping | null; delivery: "ship" | "download"; status: string; transaction_id: string; created_at: Date;
};
const ORDER_COLS = "id, type, model_id, shop_id, name, model_type, quantity, unit_price, total, currency, shipping, delivery, status, transaction_id, created_at";

export const orderJson = (o: OrderRow) => ({
  id: o.id, type: o.type,
  ...(o.type === "tag" ? { model: { id: o.model_id, name: o.name, type: o.model_type } } : { item: { id: o.shop_id, name: o.name } }),
  name: o.name, quantity: o.quantity,
  unit_price: n(o.unit_price), total: n(o.total), currency: o.currency, shipping: o.shipping, delivery: o.delivery,
  ...(o.delivery === "download" ? { download_url: apiUrl(`/v1/shop/orders/${o.id}/download`) } : {}),
  status: o.status, transaction_id: o.transaction_id, created_at: o.created_at,
});

export type PurchaseInput = {
  accountId: string;
  walletId: string | null;
  /** What is being bought: a tag model (kind 'tag') or a merchandise item (kind 'shop'). */
  kind: "tag" | "shop";
  productId: string;
  quantity: number;
  /** Required for bands, cards and physical items; digital items have none. */
  shipping: Shipping | null;
  idempotencyKey: string;
};

export type PurchaseOutcome =
  | { kind: "ok"; order: OrderRow; replayed: boolean }
  | { kind: "declined"; transactionId: string; code: string; replayed: boolean }
  | { kind: "error"; status: 404 | 409 | 422; error: string };

/**
 * Buy a tag model or a merchandise item with wallet balance. One DB transaction. Lock order: balances, wallet; the product's stock is
 * claimed last by one conditional update (no up-front product lock). Stock problems are returned before anything is recorded; money
 * problems are committed as a failed 'purchase' transaction with a status_code. On success the buyer's funded
 * balance moves to the platform (platform_clearing), the product's sold count (and a shop item's stock) is
 * updated and an `orders` row is written (type 'tag' or 'shop'). A tag is attached to a tag order at shipping.
 */
export async function purchase(sql: Sql, i: PurchaseInput): Promise<PurchaseOutcome> {
  type Answer =
    | { kind: "ok"; order: Record<string, unknown>; replayed: boolean }
    | { kind: "declined"; transaction_id: string; code: string; replayed: boolean }
    | { kind: "error"; status: 404 | 409 | 422; error: string };
  const a = await callMoney<Answer>(sql, "app_purchase", {
    account: i.accountId, wallet: i.walletId, kind: i.kind, product_id: i.productId, quantity: i.quantity, shipping: i.shipping, key: i.idempotencyKey,
  });
  if (a.kind === "error") return a;
  if (a.kind === "declined") return { kind: "declined", transactionId: a.transaction_id, code: a.code, replayed: a.replayed };
  const o = a.order;
  const order: OrderRow = {
    id: o.id as string, type: o.type as "tag" | "shop", model_id: (o.model_id as string | null) ?? null, shop_id: (o.shop_id as string | null) ?? null,
    name: o.name as string, model_type: (o.model_type as string | null) ?? null, quantity: o.quantity as number, unit_price: BigInt(o.unit_price as number),
    total: BigInt(o.total as number), currency: o.currency as string, shipping: (o.shipping as Shipping | null) ?? null, delivery: o.delivery as "ship" | "download",
    status: o.status as string, transaction_id: o.transaction_id as string, created_at: new Date(o.created_at as string),
  };
  return { kind: "ok", order, replayed: a.replayed };
}

export async function listOrders(sql: Sql, accountId: string) {
  const rows = await sql<OrderRow[]>`
    select ${sql.unsafe(ORDER_COLS)} from orders where account_id = ${accountId}
     order by created_at desc, id desc limit 100`;
  return rows.map(orderJson);
}

export async function getOrder(sql: Sql, accountId: string, id: string) {
  const [o] = await sql<OrderRow[]>`
    select ${sql.unsafe(ORDER_COLS)} from orders where id = ${id} and account_id = ${accountId}`;
  return o ? orderJson(o) : null;
}
