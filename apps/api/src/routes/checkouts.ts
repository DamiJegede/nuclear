import { Hono } from "hono";
import { z } from "zod";
import { uuid } from "../lib/validate";
import type { AppContext } from "../env";
import { amount } from "../lib/money";
import { quoteCart, type CartLine } from "../lib/catalog";
import { checkoutJson, getCheckout, getItems, insertCheckout, listCheckouts } from "../lib/checkout";
import { requireSession, requireTerminal } from "../session";


// ---- Terminal: /v1/terminal/checkouts ---------------------------------------------------------
// The POS creates an order, then the customer pays it (tap via /v1/terminal/payments, or their own
// app via /v1/payments). Stock is taken when it is paid, not when it is created.

export const terminalCheckouts = new Hono<AppContext>();
terminalCheckouts.use("*", requireTerminal);

const createBody = z
  .object({
    amount: amount.optional(),
    items: z
      .array(z.object({ product_id: uuid, quantity: z.number().int().min(1).max(1000) }))
      .min(1)
      .max(50)
      .optional(),
    reference: z.string().trim().min(1).max(64).optional(),
    expires_in: z.number().int().min(60).max(7 * 24 * 3600).optional(),
  })
  .refine((b) => b.amount !== undefined || b.items !== undefined, { message: "amount_or_items_required" });

terminalCheckouts.post("/", async (c) => {
  const body = createBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const b = body.data;
  const { accountId, terminalId } = c.get("terminal");
  const sql = c.get("sql");

  // Items are priced from the live catalogue now and snapshotted; an amount-only checkout has none.
  let lines: CartLine[] = [];
  let total = b.amount ?? 0n;
  if (b.items) {
    const q = await quoteCart(sql, accountId, b.items);
    if ("error" in q) return c.json({ error: q.error }, q.status);
    if (b.amount !== undefined && b.amount !== q.cart.total) return c.json({ error: "amount_mismatch" }, 400);
    lines = q.cart.lines;
    total = q.cart.total;
  }

  const co = await sql.begin((tx) =>
    insertCheckout(tx, {
      merchantId: accountId,
      terminalId,
      reference: b.reference ?? null,
      total,
      lines,
      expiresInSeconds: b.expires_in ?? null,
    }),
  );
  return c.json({ checkout: checkoutJson(co as never, await getItems(sql, (co as { id: string }).id)) }, 201);
});

terminalCheckouts.get("/", async (c) => {
  const status = z.enum(["open", "paid", "canceled", "expired"]).default("open").safeParse(c.req.query("status"));
  const limit = z.coerce.number().int().min(1).max(100).default(50).safeParse(c.req.query("limit"));
  if (!status.success || !limit.success) return c.json({ error: "invalid_request" }, 400);
  return c.json({ checkouts: await listCheckouts(c.get("sql"), c.get("terminal").accountId, status.data, limit.data) });
});

terminalCheckouts.get("/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const sql = c.get("sql");
  const co = await getCheckout(sql, c.get("terminal").accountId, id.data);
  if (!co) return c.json({ error: "not_found" }, 404);
  const [paid] = co.status === "paid"
    ? await sql<{ id: string; idempotency_key: string }[]>`
        select id, idempotency_key from transactions
         where checkout_id = ${co.id} and type = 'pay' and status = 'completed'`
    : [];
  return c.json({
    checkout: checkoutJson(co, await getItems(sql, co.id)),
    payment: paid
      ? { id: paid.id, attempt: paid.idempotency_key.startsWith("t:") ? paid.idempotency_key.slice(2) : null }
      : null,
  });
});

// Cancel an unpaid order. Idempotent; a paid order cannot be canceled (refund it instead).
terminalCheckouts.post("/:id/cancel", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const sql = c.get("sql");
  const { accountId } = c.get("terminal");
  const result = await sql.begin(async (tx) => {
    const [co] = await tx<{ status: string }[]>`
      select status from checkouts where id = ${id.data} and account_id = ${accountId} for no key update`;
    if (!co) return "not_found" as const;
    if (co.status === "paid") return "paid" as const;
    if (co.status === "open") await tx`update checkouts set status = 'canceled' where id = ${id.data}`;
    return "ok" as const;
  });
  if (result === "not_found") return c.json({ error: "not_found" }, 404);
  if (result === "paid") return c.json({ error: "checkout_paid" }, 409);
  const co = await getCheckout(sql, accountId, id.data);
  return c.json({ checkout: checkoutJson(co!, await getItems(sql, id.data)) });
});

// ---- Customer view: /v1/checkouts/:id ---------------------------------------------------------
// What the customer sees before confirming: the merchant, the items and the total. The id is an
// unguessable UUID the POS shows (for example as a QR code).

export const checkouts = new Hono<AppContext>();
checkouts.use("*", requireSession);

checkouts.get("/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const sql = c.get("sql");
  const co = await getCheckout(sql, null, id.data);
  if (!co) return c.json({ error: "not_found" }, 404);
  const [m] = await sql<{ name: string }[]>`
    select coalesce(b.display_name, a.name) as name
      from accounts a left join businesses b on b.account_id = a.id where a.id = ${co.account_id}`;
  const expired = co.status === "open" && co.expires_at !== null && co.expires_at.getTime() <= Date.now();
  if (co.status !== "open" || expired) {
    // Only the outcome is shown for an order that can no longer be paid.
    return c.json({ checkout: { id: co.id, status: expired ? "expired" : co.status, merchant: { display_name: m?.name ?? "" } } });
  }
  const items = await getItems(sql, co.id);
  return c.json({
    checkout: {
      id: co.id,
      status: co.status,
      total: Number(co.total),
      currency: co.currency,
      reference: co.reference,
      expires_at: co.expires_at,
      merchant: { display_name: m?.name ?? "" },
      items: items.map((it) => ({ name: it.name, quantity: it.quantity, net_price: Number(it.unit_price - it.discount) })),
    },
  });
});
