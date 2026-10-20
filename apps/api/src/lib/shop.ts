import type { Sql } from "../db";
import { earmarkedTotalQuery, spendableFrom } from "./walletFunds";
import { n } from "./money";
import { apiUrl, imageUrl } from "./images";

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
  const [wallet] = i.walletId
    ? await sql<{ id: string; type: string }[]>`select id, type from wallets where id = ${i.walletId} and account_id = ${i.accountId}`
    : await sql<{ id: string; type: string }[]>`select id, type from wallets where account_id = ${i.accountId} and type = 'default'`;
  if (!wallet) return { kind: "error", status: 404, error: "wallet_not_found" };

  class StockRace extends Error {}
  try {
  return await (sql.begin(async (tx): Promise<PurchaseOutcome> => {
    const replayQuery = () => tx<(OrderRow & { tx_status: string; tx_code: string | null; tx_id: string; oid: string | null }) []>`
        select t.id as tx_id, t.status as tx_status, t.status_code as tx_code, o.id as oid,
               ${tx.unsafe(ORDER_COLS.split(", ").filter((c) => c !== "id").map((c) => "o." + c).join(", "))}
          from transactions t left join orders o on o.transaction_id = t.id
         where t.type = 'purchase' and t.from_account_id = ${i.accountId} and t.idempotency_key = ${i.idempotencyKey}`;
    const fromReplay = (prev: Awaited<ReturnType<typeof replayQuery>>[number] | undefined): PurchaseOutcome | null => {
      if (!prev) return null;
      if (prev.tx_status === "failed") return { kind: "declined", transactionId: prev.tx_id, code: prev.tx_code ?? "declined", replayed: true };
      const sameProduct = prev.type === i.kind && (i.kind === "tag" ? prev.model_id === i.productId : prev.shop_id === i.productId);
      if (!prev.oid || !sameProduct || prev.quantity !== i.quantity) return { kind: "error", status: 409, error: "idempotency_mismatch" };
      return { kind: "ok", order: { ...prev, id: prev.oid }, replayed: true };
    };

    // The earlier attempt (a retry returns it) and the product, read together in one round trip. The product is read WITHOUT a lock:
    // its stock is claimed by one conditional update right before commit, so a popular item is locked for milliseconds, not for the
    // whole purchase.
    type TagRow = { type: string; name: string; currency: string; price: bigint; quantity: number; sold: number; status: string };
    type ItemRow2 = { name: string; currency: string; price: bigint; stock: number | null; status: string; kind: string; file: string | null };
    const [[prev0], productRows] = await Promise.all([
      replayQuery(),
      i.kind === "tag"
        ? tx<TagRow[]>`select type, name, currency, price, quantity, sold, status from tag_models where id = ${i.productId}`
        : tx<ItemRow2[]>`select name, currency, price, stock, status, kind, file from shop where id = ${i.productId}`,
    ]);
    const earlier = fromReplay(prev0);
    if (earlier) return earlier;

    let name: string, price: bigint, currency: string, modelType: string | null = null, digital = false;
    if (i.kind === "tag") {
      if (!i.shipping) return { kind: "error", status: 422, error: "shipping_required" };
      const m = (productRows as TagRow[])[0];
      if (!m || m.status !== "available" || m.price <= 0n) return { kind: "error", status: 404, error: "model_not_found" };
      if (m.quantity - m.sold < i.quantity) return { kind: "error", status: 409, error: m.quantity - m.sold <= 0 ? "sold_out" : "not_enough_stock" };
      ({ name, price, currency } = m); modelType = m.type;
    } else {
      const m = (productRows as ItemRow2[])[0];
      if (!m || m.status !== "available" || m.price <= 0n) return { kind: "error", status: 404, error: "item_not_found" };
      digital = m.kind === "digital";
      if (digital && !m.file) return { kind: "error", status: 404, error: "item_not_found" };
      if (digital && i.quantity !== 1) return { kind: "error", status: 422, error: "digital_quantity_one" };
      if (!digital && !i.shipping) return { kind: "error", status: 422, error: "shipping_required" };
      if (m.stock !== null && m.stock < i.quantity) return { kind: "error", status: 409, error: m.stock <= 0 ? "sold_out" : "not_enough_stock" };
      ({ name, price, currency } = m);
    }

    const total = price * BigInt(i.quantity);
    const amt = total.toString();
    // The attempt row and the reads that follow go out together. Lock order: balances, wallet (the product is claimed last).
    const [ins, [b], [w], [a], [em]] = await Promise.all([
      tx<{ id: string }[]>`
        insert into transactions (type, from_account_id, from_wallet_id, amount, status, idempotency_key)
        values ('purchase', ${i.accountId}, ${wallet.id}, ${amt}, 'pending', ${i.idempotencyKey})
        on conflict (type, from_account_id, idempotency_key) where from_account_id is not null and type <> 'pay'
        do nothing returning id`,
      tx<{ balance: bigint; credit_limit: bigint; credit_spent: bigint }[]>`
        select balance, credit_limit, credit_spent from balances where account_id = ${i.accountId} for no key update`,
      tx<{ status: string; daily_limit: bigint | null; spent_today: bigint; balance: bigint | null }[]>`
        select status, daily_limit, spent_today, balance from wallets where id = ${wallet.id} for no key update`,
      tx<{ status: string }[]>`select status from accounts where id = ${i.accountId}`,
      earmarkedTotalQuery(tx, i.accountId),
    ]);
    if (!ins[0]) return fromReplay((await replayQuery())[0]) ?? { kind: "error", status: 409, error: "idempotency_mismatch" };
    const txId = ins[0].id;

    const funds = spendableFrom(b ? b.balance : 0n, w ? w.balance : null, em!.total);
    let code: string | null = null;
    if (!a || a.status !== "active" || !w || w.status !== "active") code = "buyer_unavailable";
    else if (!b || b.balance < 0n || b.credit_spent > b.credit_limit) code = "account_restricted";
    else if (funds.funds < total) code = funds.earmarked ? "wallet_balance_exceeded" : "insufficient_balance"; // funded balance only, never credit
    else if (w.daily_limit !== null && w.spent_today + total > w.daily_limit) code = "spend_limit_exceeded";
    if (code) {
      await tx`update transactions set status = 'failed', status_code = ${code} where id = ${txId}`;
      return { kind: "declined", transactionId: txId, code, replayed: false };
    }

    // Every write in one round trip. The stock claim is conditional: if another buyer took the last units meanwhile it changes no
    // row, the whole purchase rolls back (nothing is recorded) and the buyer is told it sold out.
    const [, , , claimed, [order]] = await Promise.all([
      tx`update balances set balance = balance - ${amt} where account_id = ${i.accountId}`,
      tx`update wallets set spent_today = spent_today + ${amt}, balance = case when balance is not null then balance - ${amt} else balance end where id = ${wallet.id}`,
      // A Benefits wallet buys like any other wallet; its debit is attributed to it in the ledger.
      tx`insert into ledger_entries (transaction_id, posting_key, line_no, account_id, bucket, direction, amount, wallet_id)
         values (${txId}, 'purchase', 1, ${i.accountId}, 'funded_balance', 'debit', ${amt}, ${wallet.type === "benefits" ? wallet.id : null}),
                (${txId}, 'purchase', 2, null, 'platform_clearing', 'credit', ${amt}, null)`,
      i.kind === "tag"
        ? tx<{ id: string }[]>`update tag_models set sold = sold + ${i.quantity} where id = ${i.productId} and quantity - sold >= ${i.quantity} returning id`
        : tx<{ id: string }[]>`update shop set sold = sold + ${i.quantity}, stock = case when stock is null then null else stock - ${i.quantity} end
                                where id = ${i.productId} and (stock is null or stock >= ${i.quantity}) returning id`,
      tx<OrderRow[]>`
        insert into orders (type, account_id, wallet_id, model_id, shop_id, name, model_type, quantity, unit_price, total, currency, shipping, delivery, transaction_id)
        values (${i.kind}, ${i.accountId}, ${wallet.id}, ${i.kind === "tag" ? i.productId : null}, ${i.kind === "shop" ? i.productId : null},
                ${name}, ${modelType}, ${i.quantity}, ${price.toString()}, ${amt}, ${currency},
                ${digital ? null : JSON.stringify(i.shipping)}::text::jsonb, ${digital ? "download" : "ship"}, ${txId})
        returning ${tx.unsafe(ORDER_COLS)}`,
    ]);
    if (claimed.length === 0) throw new StockRace();
    await tx`update transactions set status = 'completed', completed_at = now() where id = ${txId}`;
    return { kind: "ok", order: order!, replayed: false };
  }) as Promise<PurchaseOutcome>);
  } catch (err) {
    if (!(err instanceof StockRace)) throw err;
    // Lost the race for the last units: nothing was recorded. Say whether it is sold out or just short.
    const left = i.kind === "tag"
      ? (await sql<{ left: number }[]>`select quantity - sold as left from tag_models where id = ${i.productId}`)[0]?.left ?? 0
      : (await sql<{ left: number | null }[]>`select stock as left from shop where id = ${i.productId}`)[0]?.left ?? 0;
    return { kind: "error", status: 409, error: (left ?? 0) <= 0 ? "sold_out" : "not_enough_stock" };
  }
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
