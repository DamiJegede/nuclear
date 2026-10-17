import type { Sql } from "../db";
import { debitWallet, spendable } from "./walletFunds";
import { n } from "./money";
import { imageUrl } from "./images";

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
  id: string; name: string; description: string | null; photo: string | null; currency: string; price: bigint; stock: number | null; sold: number;
};
const itemJson = (i: ItemRow) => ({
  id: i.id, name: i.name, description: i.description, photo: imageUrl(i.photo), currency: i.currency, price: n(i.price),
  remaining: i.stock, max_per_order: i.stock === null ? MAX_PER_ORDER : Math.min(MAX_PER_ORDER, i.stock),
});

/** Merchandise on sale: status available, stock left (or not tracked) and a price. */
export async function availableItems(sql: Sql, id?: string) {
  const rows = await sql<ItemRow[]>`
    select id, name, description, photo, currency, price, stock, sold from shop
     where status = 'available' and (stock is null or stock > 0) and price > 0
       ${id ? sql`and id = ${id}` : sql``}
     order by created_at, id`;
  return rows.map(itemJson);
}

type OrderRow = {
  id: string; type: "tag" | "shop"; model_id: string | null; shop_id: string | null; name: string; model_type: string | null; quantity: number;
  unit_price: bigint; total: bigint; currency: string; shipping: Shipping; status: string; transaction_id: string; created_at: Date;
};
const ORDER_COLS = "id, type, model_id, shop_id, name, model_type, quantity, unit_price, total, currency, shipping, status, transaction_id, created_at";

export const orderJson = (o: OrderRow) => ({
  id: o.id, type: o.type,
  ...(o.type === "tag" ? { model: { id: o.model_id, name: o.name, type: o.model_type } } : { item: { id: o.shop_id, name: o.name } }),
  name: o.name, quantity: o.quantity,
  unit_price: n(o.unit_price), total: n(o.total), currency: o.currency, shipping: o.shipping,
  status: o.status, transaction_id: o.transaction_id, created_at: o.created_at,
});

export type PurchaseInput = {
  accountId: string;
  walletId: string | null;
  /** What is being bought: a tag model (kind 'tag') or a merchandise item (kind 'shop'). */
  kind: "tag" | "shop";
  productId: string;
  quantity: number;
  shipping: Shipping;
  idempotencyKey: string;
};

export type PurchaseOutcome =
  | { kind: "ok"; order: OrderRow; replayed: boolean }
  | { kind: "declined"; transactionId: string; code: string; replayed: boolean }
  | { kind: "error"; status: 404 | 409 | 422; error: string };

/**
 * Buy a tag model or a merchandise item with wallet balance. One DB transaction. Lock order: product
 * (tag model or shop item), balances, wallet. Stock problems are returned before anything is recorded; money
 * problems are committed as a failed 'purchase' transaction with a status_code. On success the buyer's funded
 * balance moves to the platform (platform_clearing), the product's sold count (and a shop item's stock) is
 * updated and an `orders` row is written (type 'tag' or 'shop'). A tag is attached to a tag order at shipping.
 */
export async function purchase(sql: Sql, i: PurchaseInput): Promise<PurchaseOutcome> {
  const [wallet] = i.walletId
    ? await sql<{ id: string }[]>`select id from wallets where id = ${i.walletId} and account_id = ${i.accountId}`
    : await sql<{ id: string }[]>`select id from wallets where account_id = ${i.accountId} and type = 'default'`;
  if (!wallet) return { kind: "error", status: 404, error: "wallet_not_found" };

  return sql.begin(async (tx): Promise<PurchaseOutcome> => {
    const replay = async (): Promise<PurchaseOutcome | null> => {
      const [prev] = await tx<(OrderRow & { tx_status: string; tx_code: string | null; tx_id: string; oid: string | null }) []>`
        select t.id as tx_id, t.status as tx_status, t.status_code as tx_code, o.id as oid,
               ${tx.unsafe(ORDER_COLS.split(", ").filter((c) => c !== "id").map((c) => "o." + c).join(", "))}
          from transactions t left join orders o on o.transaction_id = t.id
         where t.type = 'purchase' and t.from_account_id = ${i.accountId} and t.idempotency_key = ${i.idempotencyKey}`;
      if (!prev) return null;
      if (prev.tx_status === "failed") return { kind: "declined", transactionId: prev.tx_id, code: prev.tx_code ?? "declined", replayed: true };
      const sameProduct = prev.type === i.kind && (i.kind === "tag" ? prev.model_id === i.productId : prev.shop_id === i.productId);
      if (!prev.oid || !sameProduct || prev.quantity !== i.quantity) return { kind: "error", status: 409, error: "idempotency_mismatch" };
      return { kind: "ok", order: { ...prev, id: prev.oid }, replayed: true };
    };
    const earlier = await replay();
    if (earlier) return earlier;

    // The product: price, name and availability, locked.
    let name: string, price: bigint, currency: string, modelType: string | null = null;
    if (i.kind === "tag") {
      const [m] = await tx<{ type: string; name: string; currency: string; price: bigint; quantity: number; sold: number; status: string }[]>`
        select type, name, currency, price, quantity, sold, status from tag_models where id = ${i.productId} for no key update`;
      if (!m || m.status !== "available" || m.price <= 0n) return { kind: "error", status: 404, error: "model_not_found" };
      if (m.quantity - m.sold < i.quantity) return { kind: "error", status: 409, error: m.quantity - m.sold <= 0 ? "sold_out" : "not_enough_stock" };
      ({ name, price, currency } = m); modelType = m.type;
    } else {
      const [m] = await tx<{ name: string; currency: string; price: bigint; stock: number | null; status: string }[]>`
        select name, currency, price, stock, status from shop where id = ${i.productId} for no key update`;
      if (!m || m.status !== "available" || m.price <= 0n) return { kind: "error", status: 404, error: "item_not_found" };
      if (m.stock !== null && m.stock < i.quantity) return { kind: "error", status: 409, error: m.stock <= 0 ? "sold_out" : "not_enough_stock" };
      ({ name, price, currency } = m);
    }

    const total = price * BigInt(i.quantity);
    const amt = total.toString();
    const ins = await tx<{ id: string }[]>`
      insert into transactions (type, from_account_id, from_wallet_id, amount, status, idempotency_key)
      values ('purchase', ${i.accountId}, ${wallet.id}, ${amt}, 'pending', ${i.idempotencyKey})
      on conflict (type, from_account_id, idempotency_key) where from_account_id is not null and type <> 'pay'
      do nothing returning id`;
    if (!ins[0]) return (await replay()) ?? { kind: "error", status: 409, error: "idempotency_mismatch" };
    const txId = ins[0].id;

    const [b] = await tx<{ balance: bigint; credit_limit: bigint; credit_spent: bigint }[]>`
      select balance, credit_limit, credit_spent from balances where account_id = ${i.accountId} for no key update`;
    const [w] = await tx<{ status: string; daily_limit: bigint | null; spent_today: bigint; balance: bigint | null }[]>`
      select status, daily_limit, spent_today, balance from wallets where id = ${wallet.id} for no key update`;
    const [a] = await tx<{ status: string }[]>`select status from accounts where id = ${i.accountId}`;

    const funds = await spendable(tx, i.accountId, b ? b.balance : 0n, w ? w.balance : null);
    let code: string | null = null;
    if (!a || a.status !== "active" || !w || w.status !== "active") code = "buyer_unavailable";
    else if (!b || b.balance < 0n || b.credit_spent > b.credit_limit) code = "account_restricted";
    else if (funds.funds < total) code = funds.earmarked ? "wallet_balance_exceeded" : "insufficient_balance"; // funded balance only, never credit
    else if (w.daily_limit !== null && w.spent_today + total > w.daily_limit) code = "spend_limit_exceeded";
    if (code) {
      await tx`update transactions set status = 'failed', status_code = ${code} where id = ${txId}`;
      return { kind: "declined", transactionId: txId, code, replayed: false };
    }

    await tx`update balances set balance = balance - ${amt} where account_id = ${i.accountId}`;
    await tx`update wallets set spent_today = spent_today + ${amt} where id = ${wallet.id}`;
    await debitWallet(tx, wallet.id, total);
    await tx`
      insert into ledger_entries (transaction_id, posting_key, line_no, account_id, bucket, direction, amount)
      values (${txId}, 'purchase', 1, ${i.accountId}, 'funded_balance', 'debit', ${amt}),
             (${txId}, 'purchase', 2, null, 'platform_clearing', 'credit', ${amt})`;
    if (i.kind === "tag") await tx`update tag_models set sold = sold + ${i.quantity} where id = ${i.productId}`;
    else await tx`update shop set sold = sold + ${i.quantity}, stock = case when stock is null then null else stock - ${i.quantity} end where id = ${i.productId}`;
    const [order] = await tx<OrderRow[]>`
      insert into orders (type, account_id, wallet_id, model_id, shop_id, name, model_type, quantity, unit_price, total, currency, shipping, transaction_id)
      values (${i.kind}, ${i.accountId}, ${wallet.id}, ${i.kind === "tag" ? i.productId : null}, ${i.kind === "shop" ? i.productId : null},
              ${name}, ${modelType}, ${i.quantity}, ${price.toString()}, ${amt}, ${currency},
              ${JSON.stringify(i.shipping)}::text::jsonb, ${txId})
      returning ${tx.unsafe(ORDER_COLS)}`;
    await tx`update transactions set status = 'completed', completed_at = now() where id = ${txId}`;
    return { kind: "ok", order: order!, replayed: false };
  }) as Promise<PurchaseOutcome>;
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
