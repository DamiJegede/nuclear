import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import type { Sql } from "../db";
import { amount, n } from "../lib/money";
import { decryptTagUrl } from "../lib/tagproof";
import { consumeCounter, isFresh, loadTag } from "../lib/tap";
import { findPay, PAY_COLS, type PayOutcome, type PayRow } from "../lib/pay";
import { checkStock, quoteCart, type CartLine } from "../lib/catalog";
import { getCheckout, getItems, itemJson, payCheckout } from "../lib/checkout";
import { requireSession, requireTerminal } from "../session";

const uuid = z.string().uuid();
const reference = z.string().trim().min(1).max(64).optional();

export const credentialSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tag"), url: z.string().min(1).max(512) }),
  z.object({ type: z.literal("pass"), id: z.string().max(128).optional(), proof: z.string().max(4096).optional() }),
]);

// Catalogue items. With items the total comes from the merchant's live prices (price - discount);
// an explicit amount, if also sent, must equal it.
const items = z
  .array(z.object({ product_id: uuid, quantity: z.number().int().min(1).max(1000) }))
  .min(1)
  .max(50);

// Pay an existing checkout, or describe one to be created and paid in one step.
const what = {
  checkout_id: uuid.optional(),
  amount: amount.optional(),
  items: items.optional(),
  reference,
};
const oneOf = (b: { checkout_id?: string; amount?: bigint; items?: unknown }) =>
  (b.checkout_id !== undefined) !== (b.amount !== undefined || b.items !== undefined);

function paymentJson(
  r: PayRow,
  extra: { payer?: { display_name: string; photo: string | null } | null; merchant?: { account_id: string; display_name: string } | null } = {},
) {
  return {
    id: r.id,
    status: r.status,
    status_code: r.status_code,
    amount: n(r.amount),
    reference: r.reference,
    checkout_id: r.checkout_id,
    terminal_id: r.terminal_id,
    wallet_id: r.from_wallet_id,
    via: r.tag_id ? "tag" : "wallet",
    timestamp: r.timestamp,
    completed_at: r.completed_at,
    ...(extra.payer !== undefined ? { payer: extra.payer } : {}),
    ...(extra.merchant !== undefined ? { merchant: extra.merchant } : {}),
  };
}

function respond(c: any, out: PayOutcome, extra?: Parameters<typeof paymentJson>[1]) {
  if (out.kind === "conflict") return c.json({ error: "idempotency_mismatch" }, 409);
  const payment = paymentJson(out.row, extra);
  if (out.kind === "declined") return c.json({ error: "declined", status_code: out.row.status_code, payment }, 422);
  return c.json({ payment }, out.replayed ? 200 : 201);
}

async function merchantName(sql: Sql, accountId: string): Promise<string> {
  const [m] = await sql<{ name: string }[]>`
    select coalesce(b.display_name, a.name) as name
      from accounts a left join businesses b on b.account_id = a.id where a.id = ${accountId}`;
  return m?.name ?? "";
}

type Plan =
  | { error: string; status: 400 | 404 | 409 | 422 }
  | { checkoutId: string | null; create: { lines: CartLine[]; total: bigint; reference: string | null } | null; total: bigint };

/**
 * Read-only planning before anything is consumed (a tap, a key): resolve the checkout or price the
 * one-step cart, and refuse unsellable carts early so a catalogue mistake never burns a tap.
 */
async function plan(
  sql: Sql,
  merchantId: string,
  b: { checkout_id?: string; amount?: bigint; items?: { product_id: string; quantity: number }[]; reference?: string },
): Promise<Plan> {
  if (b.checkout_id) {
    const co = await getCheckout(sql, merchantId, b.checkout_id);
    if (!co) return { error: "checkout_not_found", status: 404 };
    if (co.status !== "open") return { error: co.status === "paid" ? "checkout_paid" : "checkout_not_open", status: 409 };
    if (co.expires_at && co.expires_at.getTime() <= Date.now()) return { error: "checkout_expired", status: 409 };
    const its = await getItems(sql, co.id);
    const bad = await checkStock(
      sql, merchantId,
      its.filter((x) => x.product_id).map((x) => ({ productId: x.product_id!, quantity: x.quantity })),
    );
    if (bad) return { error: bad, status: 422 };
    return { checkoutId: co.id, create: null, total: co.total };
  }
  if (b.items) {
    const q = await quoteCart(sql, merchantId, b.items);
    if ("error" in q) return { error: q.error, status: q.status };
    if (b.amount !== undefined && b.amount !== q.cart.total) return { error: "amount_mismatch", status: 400 };
    return { checkoutId: null, create: { lines: q.cart.lines, total: q.cart.total, reference: b.reference ?? null }, total: q.cart.total };
  }
  return { checkoutId: null, create: { lines: [], total: b.amount!, reference: b.reference ?? null }, total: b.amount! };
}

// ---- Customer-confirmed payment: /v1/payments -------------------------------------------------
// The customer's own authenticated call is the confirmation (no tap protocol needed). Pay a checkout
// the POS created (checkout_id), or name a terminal and an amount/items to pay in one step.

export const payments = new Hono<AppContext>();
payments.use("*", requireSession);

const confirmBody = z
  .object({ ...what, terminal_id: uuid.optional(), from_wallet_id: uuid.optional() })
  .refine((b) => oneOf(b), { message: "checkout_id_or_amount_or_items" })
  .refine((b) => b.checkout_id !== undefined || b.terminal_id !== undefined, { message: "terminal_id_required" });

payments.post("/", async (c) => {
  const key = c.req.header("idempotency-key")?.trim();
  if (!key || key.length > 128) return c.json({ error: "idempotency_key_required" }, 400);
  const body = confirmBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const b = body.data;
  const { accountId, walletId } = c.get("auth");
  const sql = c.get("sql");

  // Payer wallet: a delegated device pays from its own wallet; the owner picks one (default wallet).
  if (walletId !== null && b.from_wallet_id !== undefined && b.from_wallet_id !== walletId) {
    return c.json({ error: "wallet_not_found" }, 404);
  }
  const wanted = walletId ?? b.from_wallet_id ?? null;
  const [wallet] = wanted
    ? await sql<{ id: string }[]>`select id from wallets where id = ${wanted} and account_id = ${accountId}`
    : await sql<{ id: string }[]>`select id from wallets where account_id = ${accountId} and type = 'default'`;
  if (!wallet) return c.json({ error: "wallet_not_found" }, 404);

  // Merchant: the checkout's owner, or the terminal's.
  let merchantId: string | null = null;
  let terminalId: string | null = null;
  if (b.checkout_id) {
    const co = await getCheckout(sql, null, b.checkout_id);
    if (!co) return c.json({ error: "checkout_not_found" }, 404);
    merchantId = co.account_id;
    terminalId = co.terminal_id;
  } else {
    const [t] = await sql<{ id: string; account_id: string }[]>`
      select t.id, t.account_id from terminals t where t.id = ${b.terminal_id!}`;
    if (!t) return c.json({ error: "terminal_not_found" }, 404);
    merchantId = t.account_id;
    terminalId = t.id;
  }
  const [m] = await sql<{ type: string; status: string }[]>`select type, status from accounts where id = ${merchantId}`;
  if (!m || m.type !== "B" || m.status !== "active") return c.json({ error: "merchant_unavailable" }, 404);
  if (merchantId === accountId) return c.json({ error: "self_payment" }, 422);

  const idemKey = `c:${accountId}:${key}`; // customer keys are namespaced per payer
  const recorded = await findPay(sql as never, merchantId, idemKey);
  let p: Plan = { checkoutId: b.checkout_id ?? null, create: null, total: recorded?.amount ?? 0n };
  if (!recorded) {
    p = await plan(sql, merchantId, b);
    if ("error" in p) return c.json({ error: p.error }, p.status);
  }

  const out = await sql.begin((tx) =>
    payCheckout(tx, {
      payerWalletId: wallet.id,
      payerAccountId: accountId,
      merchantAccountId: merchantId!,
      terminalId,
      tagId: null,
      tagLimit: null,
      idempotencyKey: idemKey,
      checkoutId: p.checkoutId,
      create: p.create,
      expectAmount: b.amount ?? undefined,
    }),
  );
  return respond(c, out as PayOutcome, {
    merchant: { account_id: merchantId, display_name: await merchantName(sql, merchantId) },
  });
});

payments.get("/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const { accountId, walletId } = c.get("auth");
  const sql = c.get("sql");
  const [r] = await sql<PayRow[]>`
    select ${sql.unsafe(PAY_COLS)} from transactions
     where id = ${id.data} and type = 'pay' and from_account_id = ${accountId}
       ${walletId ? sql`and from_wallet_id = ${walletId}` : sql``}`;
  if (!r) return c.json({ error: "not_found" }, 404);
  const its = r.checkout_id ? await getItems(sql, r.checkout_id) : [];
  return c.json({
    payment: paymentJson(r, { merchant: { account_id: r.to_account_id, display_name: await merchantName(sql, r.to_account_id) } }),
    items: its.map((it) => ({ name: it.name, quantity: it.quantity, net_price: Number(it.unit_price - it.discount) })),
  });
});

// ---- Terminal-initiated payment: /v1/terminal/payments ----------------------------------------

export const terminalPayments = new Hono<AppContext>();
terminalPayments.use("*", requireTerminal);

const terminalBody = z
  .object({ ...what, credential: credentialSchema })
  .refine((b) => oneOf(b), { message: "checkout_id_or_amount_or_items" });

type TagResult = { error: string; status: 404 | 409 | 422 } | { out: PayOutcome };

// POS sends the tap payload; the Idempotency-Key is the attempt id (retries return the original).
// A tap within wallet and tag limits is authorized: no step-up.
terminalPayments.post("/", async (c) => {
  const key = c.req.header("idempotency-key")?.trim();
  if (!key || key.length > 128) return c.json({ error: "idempotency_key_required" }, 400);
  const body = terminalBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const b = body.data;
  const { accountId, terminalId } = c.get("terminal");
  const sql = c.get("sql");

  if (b.credential.type === "pass") {
    // Reader-verified Apple/Google pass taps need certified reader protocols; the customer pays the
    // checkout from their own app (POST /v1/payments) until then.
    return c.json({ error: "pass_verification_unavailable" }, 501);
  }
  const proof = await decryptTagUrl(c.env, b.credential.url);
  if (!proof) return c.json({ error: "invalid_tag" }, 400);

  // Plan before the tap is consumed. A retry of a recorded attempt returns that result untouched.
  const attemptKey = `t:${key}`;
  const recorded = await findPay(sql as never, accountId, attemptKey);
  let p: Plan = { checkoutId: b.checkout_id ?? null, create: null, total: recorded?.amount ?? 0n };
  if (!recorded) {
    p = await plan(sql, accountId, b);
    if ("error" in p) return c.json({ error: p.error }, p.status);
  }

  const result = (await sql.begin(async (tx): Promise<TagResult> => {
    const tag = await loadTag(tx, proof.uid, true);
    if (!tag) return { error: "tag_not_found", status: 404 };

    const prev = await findPay(tx, accountId, attemptKey);
    if (prev) {
      if (prev.tag_id !== tag.id || (b.amount !== undefined && prev.amount !== b.amount)) return { out: { kind: "conflict" } };
      return { out: { kind: prev.status === "completed" ? "ok" : "declined", row: prev, replayed: true } };
    }

    // A proof is single-use: the counter must advance, and it is consumed atomically with the
    // outcome below, including when the attempt is then declined.
    if (!isFresh(tag, proof.counter)) return { error: "proof_replayed", status: 409 };
    await consumeCounter(tx, tag.id, proof.counter);

    if (!tag.wallet_id || !tag.account_id) return { error: "tag_unassigned", status: 422 };
    if (tag.locked) return { error: "tag_locked", status: 422 };
    if (tag.account_id === accountId) return { error: "self_payment", status: 422 };

    const out = await payCheckout(tx, {
      payerWalletId: tag.wallet_id,
      payerAccountId: tag.account_id,
      merchantAccountId: accountId,
      terminalId,
      tagId: tag.id,
      tagLimit: tag.transaction_limit,
      idempotencyKey: attemptKey,
      checkoutId: p.checkoutId,
      create: p.create,
      expectAmount: b.amount ?? undefined,
    });
    return { out };
  })) as TagResult;

  if ("error" in result) return c.json({ error: result.error }, result.status);
  return respond(c, result.out, { payer: await payerView(sql, result.out) });
});

async function payerView(sql: Sql, out: PayOutcome) {
  if (out.kind === "conflict") return null;
  const [w] = await sql<{ display_name: string; photo: string | null }[]>`
    select display_name, photo from wallets where id = ${out.row.from_wallet_id}`;
  return w ?? null;
}

// Recover an outcome after a lost response or BLE drop, using the original attempt id. Includes the
// order's items with how many units are still refundable, so the POS can build an item refund.
terminalPayments.get("/:attempt", async (c) => {
  const attempt = c.req.param("attempt");
  if (!attempt || attempt.length > 128) return c.json({ error: "not_found" }, 404);
  const { accountId } = c.get("terminal");
  const sql = c.get("sql");
  const [r] = await sql<PayRow[]>`
    select ${sql.unsafe(PAY_COLS)} from transactions
     where type = 'pay' and to_account_id = ${accountId} and idempotency_key = ${`t:${attempt}`}`;
  if (!r) return c.json({ error: "not_found" }, 404);
  // Staff see who paid (member attribution) but never wallet balances.
  const payer = await payerView(sql, { kind: "ok", row: r, replayed: true });
  const its = r.checkout_id ? await getItems(sql, r.checkout_id) : [];
  return c.json({ payment: paymentJson(r, { payer }), items: its.map(itemJson) });
});
