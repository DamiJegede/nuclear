import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { sessionGuard } from "../session";
import { MAX_PER_ORDER, availableModels, getOrder, listOrders, orderJson, purchaseTags } from "../lib/shop";

export const shop = new Hono<AppContext>();

const uuid = z.string().uuid();

// ---- Catalogue (public) -----------------------------------------------------------------------

// Bands and cards on sale, with their price in cents. Only available models with stock left.
shop.get("/models", async (c) => c.json({ models: await availableModels(c.get("sql")) }));

shop.get("/models/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const [m] = await availableModels(c.get("sql"), id.data);
  return m ? c.json({ model: m }) : c.json({ error: "not_found" }, 404);
});

// The uploaded photo. The URL carries a version (?v=), so it can be cached hard.
shop.get("/models/:id/photo", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const [p] = await c.get("sql")<{ content_type: string; hex: string }[]>`
    select content_type, encode(data, 'hex') as hex from tag_model_photos where model_id = ${id.data}`;
  if (!p) return c.json({ error: "not_found" }, 404);
  const bytes = new Uint8Array(p.hex.length / 2);
  for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(p.hex.slice(k * 2, k * 2 + 2), 16);
  return new Response(bytes, {
    headers: { "content-type": p.content_type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
  });
});

// ---- Buying (the account holder's own session) ------------------------------------------------

shop.use("/orders", sessionGuard("owner"));
shop.use("/orders/*", sessionGuard("owner"));

const text = (max: number) => z.string().trim().min(1).max(max);
const orderBody = z.object({
  model_id: uuid,
  quantity: z.number().int().min(1).max(MAX_PER_ORDER),
  wallet_id: uuid.optional(),
  shipping: z.object({
    name: text(100), line1: text(120), line2: z.string().trim().max(120).optional().transform((v) => v || undefined),
    city: text(80), region: text(80), postal_code: text(20),
    country: z.string().trim().toUpperCase().length(2),
  }),
});

// Checkout: pay for bands/cards with wallet balance. Idempotency-Key required; a retry returns the same order.
shop.post("/orders", async (c) => {
  const key = c.req.header("idempotency-key")?.trim();
  if (!key || key.length > 128) return c.json({ error: "idempotency_key_required" }, 400);
  const body = orderBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);

  const out = await purchaseTags(c.get("sql"), {
    accountId: c.get("auth").accountId,
    walletId: body.data.wallet_id ?? null,
    modelId: body.data.model_id,
    quantity: body.data.quantity,
    shipping: body.data.shipping,
    idempotencyKey: key,
  });
  if (out.kind === "error") return c.json({ error: out.error }, out.status);
  if (out.kind === "declined") return c.json({ error: "declined", status_code: out.code, transaction_id: out.transactionId }, 422);
  return c.json({ order: orderJson(out.order) }, out.replayed ? 200 : 201);
});

shop.get("/orders", async (c) => c.json({ orders: await listOrders(c.get("sql"), c.get("auth").accountId) }));

shop.get("/orders/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const o = await getOrder(c.get("sql"), c.get("auth").accountId, id.data);
  return o ? c.json({ order: o }) : c.json({ error: "not_found" }, 404);
});
