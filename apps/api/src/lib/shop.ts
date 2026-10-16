import type { Sql } from "../db";
import { PHOTO_SQL } from "./photo";
import { n } from "./money";

export const MAX_PER_ORDER = 20;

export type Shipping = {
  name: string; line1: string; line2?: string; city: string; region: string; postal_code: string; country: string;
};

type ModelRow = {
  id: string; type: string; name: string; photo: string | null; currency: string; price: bigint;
  limited: boolean; quantity: number; sold: number;
};

const modelJson = (m: ModelRow) => ({
  id: m.id, type: m.type, name: m.name, photo: m.photo, currency: m.currency, price: n(m.price),
  limited: m.limited, remaining: m.quantity - m.sold, max_per_order: Math.min(MAX_PER_ORDER, m.quantity - m.sold),
});

/** Models on sale: status available and at least one unit left. */
export async function availableModels(sql: Sql, id?: string) {
  const rows = await sql<ModelRow[]>`
    select m.id, m.type, m.name, ${sql.unsafe(PHOTO_SQL)}, m.currency, m.price, m.limited, m.quantity, m.sold
      from tag_models m left join tag_model_photos p on p.model_id = m.id
     where m.status = 'available' and m.quantity > m.sold and m.price > 0
       ${id ? sql`and m.id = ${id}` : sql``}
     order by m.created_at, m.id`;
  return rows.map(modelJson);
}

type OrderRow = {
  id: string; model_id: string; model_name: string; model_type: string; quantity: number;
  unit_price: bigint; total: bigint; currency: string; shipping: Shipping; status: string;
  transaction_id: string; created_at: Date;
};
const ORDER_COLS = "id, model_id, model_name, model_type, quantity, unit_price, total, currency, shipping, status, transaction_id, created_at";

export const orderJson = (o: OrderRow) => ({
  id: o.id, model: { id: o.model_id, name: o.model_name, type: o.model_type }, quantity: o.quantity,
  unit_price: n(o.unit_price), total: n(o.total), currency: o.currency, shipping: o.shipping,
  status: o.status, transaction_id: o.transaction_id, created_at: o.created_at,
});

export type PurchaseInput = {
  accountId: string;
  walletId: string | null;
  modelId: string;
  quantity: number;
  shipping: Shipping;
  idempotencyKey: string;
};

export type PurchaseOutcome =
  | { kind: "ok"; order: OrderRow; replayed: boolean }
  | { kind: "declined"; transactionId: string; code: string; replayed: boolean }
  | { kind: "error"; status: 404 | 409 | 422; error: string };

/**
 * Buy bands/cards with wallet balance. One DB transaction. Lock order: model, balances, wallet.
 * Stock problems are returned before anything is recorded; money problems are committed as a failed
 * 'purchase' transaction with a status_code. On success the buyer's funded balance moves to the
 * platform (platform_clearing), tag_models.sold goes up and a tag_orders row is written. A tag is
 * attached to the order at shipping; the customer then claims it by tapping.
 */
export async function purchaseTags(sql: Sql, i: PurchaseInput): Promise<PurchaseOutcome> {
  const [wallet] = i.walletId
    ? await sql<{ id: string }[]>`select id from wallets where id = ${i.walletId} and account_id = ${i.accountId}`
    : await sql<{ id: string }[]>`select id from wallets where account_id = ${i.accountId} and type = 'default'`;
  if (!wallet) return { kind: "error", status: 404, error: "wallet_not_found" };

  return sql.begin(async (tx): Promise<PurchaseOutcome> => {
    const replay = async (): Promise<PurchaseOutcome | null> => {
      const [prev] = await tx<(OrderRow & { tx_status: string; tx_code: string | null; tx_id: string }) []>`
        select t.id as tx_id, t.status as tx_status, t.status_code as tx_code,
               ${tx.unsafe(ORDER_COLS.split(", ").map((c) => "o." + c).join(", "))}
          from transactions t left join tag_orders o on o.transaction_id = t.id
         where t.type = 'purchase' and t.from_account_id = ${i.accountId} and t.idempotency_key = ${i.idempotencyKey}`;
      if (!prev) return null;
      if (prev.tx_status === "failed") return { kind: "declined", transactionId: prev.tx_id, code: prev.tx_code ?? "declined", replayed: true };
      if (!prev.id || prev.model_id !== i.modelId || prev.quantity !== i.quantity) return { kind: "error", status: 409, error: "idempotency_mismatch" };
      return { kind: "ok", order: prev, replayed: true };
    };
    const earlier = await replay();
    if (earlier) return earlier;

    const [m] = await tx<{ id: string; type: string; name: string; currency: string; price: bigint; quantity: number; sold: number; status: string }[]>`
      select id, type, name, currency, price, quantity, sold, status from tag_models
       where id = ${i.modelId} for no key update`;
    if (!m || m.status !== "available" || m.price <= 0n) return { kind: "error", status: 404, error: "model_not_found" };
    if (m.quantity - m.sold < i.quantity) return { kind: "error", status: 409, error: m.quantity - m.sold <= 0 ? "sold_out" : "not_enough_stock" };

    const total = m.price * BigInt(i.quantity);
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
    const [w] = await tx<{ status: string; daily_limit: bigint | null; spent_today: bigint }[]>`
      select status, daily_limit, spent_today from wallets where id = ${wallet.id} for no key update`;
    const [a] = await tx<{ status: string }[]>`select status from accounts where id = ${i.accountId}`;

    let code: string | null = null;
    if (!a || a.status !== "active" || !w || w.status !== "active") code = "buyer_unavailable";
    else if (!b || b.balance < 0n || b.credit_spent > b.credit_limit) code = "account_restricted";
    else if (b.balance < total) code = "insufficient_balance"; // funded balance only, never credit
    else if (w.daily_limit !== null && w.spent_today + total > w.daily_limit) code = "spend_limit_exceeded";
    if (code) {
      await tx`update transactions set status = 'failed', status_code = ${code} where id = ${txId}`;
      return { kind: "declined", transactionId: txId, code, replayed: false };
    }

    await tx`update balances set balance = balance - ${amt} where account_id = ${i.accountId}`;
    await tx`update wallets set spent_today = spent_today + ${amt} where id = ${wallet.id}`;
    await tx`
      insert into ledger_entries (transaction_id, posting_key, line_no, account_id, bucket, direction, amount)
      values (${txId}, 'purchase', 1, ${i.accountId}, 'funded_balance', 'debit', ${amt}),
             (${txId}, 'purchase', 2, null, 'platform_clearing', 'credit', ${amt})`;
    await tx`update tag_models set sold = sold + ${i.quantity} where id = ${m.id}`;
    const [order] = await tx<OrderRow[]>`
      insert into tag_orders (account_id, wallet_id, model_id, model_name, model_type, quantity, unit_price, total, currency, shipping, transaction_id)
      values (${i.accountId}, ${wallet.id}, ${m.id}, ${m.name}, ${m.type}, ${i.quantity}, ${m.price.toString()}, ${amt}, ${m.currency},
              ${JSON.stringify(i.shipping)}::text::jsonb, ${txId})
      returning ${tx.unsafe(ORDER_COLS)}`;
    await tx`update transactions set status = 'completed', completed_at = now() where id = ${txId}`;
    return { kind: "ok", order: order!, replayed: false };
  }) as Promise<PurchaseOutcome>;
}

export async function listOrders(sql: Sql, accountId: string) {
  const rows = await sql<OrderRow[]>`
    select ${sql.unsafe(ORDER_COLS)} from tag_orders where account_id = ${accountId}
     order by created_at desc, id desc limit 100`;
  return rows.map(orderJson);
}

export async function getOrder(sql: Sql, accountId: string, id: string) {
  const [o] = await sql<OrderRow[]>`
    select ${sql.unsafe(ORDER_COLS)} from tag_orders where id = ${id} and account_id = ${accountId}`;
  return o ? orderJson(o) : null;
}
