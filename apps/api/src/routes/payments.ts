import { track } from "../lib/tracker";
import { RULES, rateLimit } from "../lib/throttle";
import { imageUrl } from "../lib/images";
import { Hono } from "hono";
import { z } from "zod";
import { uuid } from "../lib/validate";
import type { AppContext } from "../env";
import type { Sql } from "../db";
import { amount, n } from "../lib/money";
import { decryptTagUrl } from "../lib/tagproof";
import { PAY_COLS, payIdem, payRowFromJson, type PayOutcome, type PayRow } from "../lib/pay";
import { getItems, itemJson } from "../lib/checkout";
import { callMoney } from "../lib/txn";
import { requireSession, requireTerminal } from "../session";

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

type Answer =
  | { kind: "ok" | "declined"; replayed: boolean; row: Record<string, unknown>; payer?: { display_name: string; photo: string | null } | null; merchant?: { account_id: string; display_name: string } }
  | { kind: "conflict" }
  | { kind: "error"; status: 400 | 404 | 409 | 422; error: string };

function respondAnswer(c: any, a: Answer) {
  if (a.kind === "error") return c.json({ error: a.error }, a.status);
  if (a.kind === "conflict") return c.json({ error: "idempotency_mismatch" }, 409);
  const out: PayOutcome = { kind: a.kind, row: payRowFromJson(a.row), replayed: a.replayed };
  const extra = a.payer !== undefined ? { payer: a.payer ? { ...a.payer, photo: imageUrl(a.payer.photo) } : null } : a.merchant ? { merchant: a.merchant } : undefined;
  return respond(c, out, extra);
}

function respond(c: any, out: PayOutcome, extra?: Parameters<typeof paymentJson>[1]) {
  if (out.kind === "conflict") return c.json({ error: "idempotency_mismatch" }, 409);
  if (out.kind === "ok" && !out.replayed) {
    const v = Number(out.row.amount), agent = c.get("auth")?.kind === "agent";
    track(c, { [out.row.tag_id ? "taps_n" : "in_app_n"]: 1, [out.row.tag_id ? "taps_v" : "in_app_v"]: v, ...(agent ? { agents_n: 1, agents_v: v } : {}) });   // today's running estimate
  }
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

// ---- Customer-confirmed payment: /v1/payments -------------------------------------------------
// The customer's own authenticated call is the confirmation (no tap protocol needed). Pay a checkout
// the POS created (checkout_id), or name a terminal and an amount/items to pay in one step.

export const payments = new Hono<AppContext>();
payments.use("*", requireSession);

const confirmBody = z
  .object({ ...what, terminal_id: uuid.optional(), from_wallet_id: uuid.optional() })
  .refine((b) => oneOf(b), { message: "checkout_id_or_amount_or_items" })
  .refine((b) => b.checkout_id !== undefined || b.terminal_id !== undefined, { message: "terminal_id_required" });

payments.post("/", rateLimit("agent-money", RULES.agentMoney, (c) => (c.get("auth")?.kind === "agent" ? c.get("auth").walletId : null)), async (c) => {
  const key = c.req.header("idempotency-key")?.trim();
  if (!key || key.length > 128) return c.json({ error: "idempotency_key_required" }, 400);
  const body = confirmBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const b = body.data;
  const { accountId, walletId } = c.get("auth");

  // One database call (app_pay_app): the payer wallet (a delegated device pays from its own wallet; the owner picks one, default wallet),
  // the merchant (the checkout's owner, or the terminal's), the plan, and the payment itself.
  const a = await callMoney<Answer>(c.get("sql"), "app_pay_app", {
    payer_account: accountId, auth_wallet: walletId, from_wallet: b.from_wallet_id ?? null, checkout_id: b.checkout_id ?? null,
    terminal_id: b.terminal_id ?? null, amount: b.amount === undefined ? null : Number(b.amount), items: b.items ?? null,
    reference: b.reference ?? null, key,
  });
  return respondAnswer(c, a);
});

payments.get("/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const { accountId, walletId } = c.get("auth");
  const sql = c.get("sql");
  const [r] = await sql<PayRow[]>`
    select ${sql.unsafe(PAY_COLS)} from txn
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

// POS sends the tap payload; the Idempotency-Key is the attempt id (retries return the original).
// A tap within wallet and tag limits is authorized: no step-up.
terminalPayments.post("/", async (c) => {
  const key = c.req.header("idempotency-key")?.trim();
  if (!key || key.length > 128) return c.json({ error: "idempotency_key_required" }, 400);
  const body = terminalBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const b = body.data;
  const { accountId, terminalId } = c.get("terminal");

  if (b.credential.type === "pass") {
    // Reader-verified Apple/Google pass taps need certified reader protocols; the customer pays the
    // checkout from their own app (POST /v1/payments) until then.
    return c.json({ error: "pass_verification_unavailable" }, 501);
  }
  const proof = await decryptTagUrl(c.env, b.credential.url);
  if (!proof) return c.json({ error: "invalid_tag" }, 400);

  // One database call (app_pay_tap): plan before the tap is consumed (a retry of a recorded attempt returns that result untouched), then the
  // tag (its proof is single-use and consumed with the outcome, even when declined), then the payment.
  const a = await callMoney<Answer>(c.get("sql"), "app_pay_tap", {
    merchant: accountId, terminal_id: terminalId, uid: proof.uid, counter: proof.counter, key: `t:${key}`,
    checkout_id: b.checkout_id ?? null, amount: b.amount === undefined ? null : Number(b.amount), items: b.items ?? null, reference: b.reference ?? null,
  });
  return respondAnswer(c, a);
});

// Recover an outcome after a lost response or BLE drop, using the original attempt id. Includes the
// order's items with how many units are still refundable, so the POS can build an item refund.
terminalPayments.get("/:attempt", async (c) => {
  const attempt = c.req.param("attempt");
  if (!attempt || attempt.length > 128) return c.json({ error: "not_found" }, 404);
  const { accountId } = c.get("terminal");
  const sql = c.get("sql");
  const [r] = await sql<PayRow[]>`
    select ${sql.unsafe(PAY_COLS)} from txn
     where type = 'pay' and idempotency_key = ${payIdem(accountId, `t:${attempt}`)}`;
  if (!r) return c.json({ error: "not_found" }, 404);
  // Staff see who paid (member attribution) but never wallet balances.
  const [w] = await sql<{ display_name: string; photo: string | null }[]>`select display_name, photo from wallets where id = ${r.from_wallet_id}`;
  const payer = w ? { ...w, photo: imageUrl(w.photo) } : null;
  const its = r.checkout_id ? await getItems(sql, r.checkout_id) : [];
  return c.json({ payment: paymentJson(r, { payer }), items: its.map(itemJson) });
});
