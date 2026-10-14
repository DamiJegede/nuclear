import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import type { Sql } from "../db";
import { amount, n } from "../lib/money";
import { decryptTagUrl } from "../lib/tagproof";
import { consumeCounter, isFresh, loadTag } from "../lib/tap";
import { findPay, payCore, PAY_COLS, type PayOutcome, type PayRow } from "../lib/pay";
import { requireSession, requireTerminal } from "../session";

const uuid = z.string().uuid();
const reference = z.string().trim().min(1).max(64).optional();

export const credentialSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tag"), url: z.string().min(1).max(512) }),
  z.object({ type: z.literal("pass"), id: z.string().max(128).optional(), proof: z.string().max(4096).optional() }),
]);

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

// ---- Customer-confirmed payment: /v1/payments -------------------------------------------------
// The customer's own authenticated call is the confirmation (no tap protocol needed). This is the
// path for in-app payments and for phone passes until reader verification is certified.

export const payments = new Hono<AppContext>();
payments.use("*", requireSession);

const confirmBody = z.object({
  amount,
  reference,
  terminal_id: uuid,
  from_wallet_id: uuid.optional(),
});

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

  // The terminal identifies the merchant and attributes the payment.
  const [t] = await sql<{ id: string; account_id: string }[]>`
    select t.id, t.account_id from terminals t
      join accounts a on a.id = t.account_id and a.type = 'B' and a.status = 'active'
     where t.id = ${b.terminal_id}`;
  if (!t) return c.json({ error: "terminal_not_found" }, 404);
  if (t.account_id === accountId) return c.json({ error: "self_payment" }, 422);

  const out = await sql.begin((tx) =>
    payCore(tx, {
      payerWalletId: wallet.id,
      payerAccountId: accountId,
      merchantAccountId: t.account_id,
      terminalId: t.id,
      tagId: null,
      tagLimit: null,
      amount: b.amount,
      idempotencyKey: `c:${accountId}:${key}`, // customer keys are namespaced per payer
      reference: b.reference ?? null,
    }),
  );
  return respond(c, out as PayOutcome, {
    merchant: { account_id: t.account_id, display_name: await merchantName(sql, t.account_id) },
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
  return c.json({
    payment: paymentJson(r, { merchant: { account_id: r.to_account_id, display_name: await merchantName(sql, r.to_account_id) } }),
  });
});

// ---- Terminal-initiated payment: /v1/terminal/payments ----------------------------------------

export const terminalPayments = new Hono<AppContext>();
terminalPayments.use("*", requireTerminal);

const terminalBody = z.object({ amount, reference, credential: credentialSchema });

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
    // Reader-verified Apple/Google pass taps need certified reader protocols; use the
    // customer-confirmed path (POST /v1/payments) until then.
    return c.json({ error: "pass_verification_unavailable" }, 501);
  }

  const proof = await decryptTagUrl(c.env, b.credential.url);
  if (!proof) return c.json({ error: "invalid_tag" }, 400);

  const attemptKey = `t:${key}`;
  const result = (await sql.begin(async (tx): Promise<TagResult> => {
    const tag = await loadTag(tx, proof.uid, true);
    if (!tag) return { error: "tag_not_found", status: 404 };

    // Same attempt retried (lost response): return the recorded result, no counter test, no debit.
    const prev = await findPay(tx, accountId, attemptKey);
    if (prev) {
      if (prev.tag_id !== tag.id || prev.amount !== b.amount) return { out: { kind: "conflict" } };
      return { out: { kind: prev.status === "completed" ? "ok" : "declined", row: prev, replayed: true } };
    }

    // A proof is single-use: the counter must advance, and it is consumed atomically with the
    // outcome below, including when the attempt is then declined.
    if (!isFresh(tag, proof.counter)) return { error: "proof_replayed", status: 409 };
    await consumeCounter(tx, tag.id, proof.counter);

    if (!tag.wallet_id || !tag.account_id) return { error: "tag_unassigned", status: 422 };
    if (tag.locked) return { error: "tag_locked", status: 422 };
    if (tag.account_id === accountId) return { error: "self_payment", status: 422 };

    const out = await payCore(tx, {
      payerWalletId: tag.wallet_id,
      payerAccountId: tag.account_id,
      merchantAccountId: accountId,
      terminalId,
      tagId: tag.id,
      tagLimit: tag.transaction_limit,
      amount: b.amount,
      idempotencyKey: attemptKey,
      reference: b.reference ?? null,
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

// Recover an outcome after a lost response or BLE drop, using the original attempt id.
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
  return c.json({ payment: paymentJson(r, { payer }) });
});
