import { track } from "../lib/tracker";
import { Hono } from "hono";
import { downloadMime, getUpload } from "../lib/uploads";
import { customerLog } from "../lib/audit";
import { z } from "zod";
import { uuid } from "../lib/validate";
import type { AppContext } from "../env";
import { sessionGuard } from "../session";
import { RULES, byAccount, rateLimit } from "../lib/throttle";
import { MAX_PER_ORDER, availableItems, availableModels, getOrder, listOrders, orderJson, purchase } from "../lib/shop";

export const shop = new Hono<AppContext>();


// ---- Catalogue (public) -----------------------------------------------------------------------

// Bands and cards on sale, with their price in cents. Only available models with stock left.
shop.get("/models", async (c) => c.json({ models: await availableModels(c.get("sql")) }));

shop.get("/models/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const [m] = await availableModels(c.get("sql"), id.data);
  return m ? c.json({ model: m }) : c.json({ error: "not_found" }, 404);
});

// Our merchandise on sale (status available, stock left or not tracked).
shop.get("/items", async (c) => c.json({ items: await availableItems(c.get("sql")) }));

shop.get("/items/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const [i] = await availableItems(c.get("sql"), id.data);
  return i ? c.json({ item: i }) : c.json({ error: "not_found" }, 404);
});

// ---- Buying (the account holder's own session) ------------------------------------------------

shop.use("/orders", sessionGuard("owner"));
shop.use("/orders/*", sessionGuard("owner"));

const text = (max: number) => z.string().trim().min(1).max(max);
const orderBody = z.object({
  model_id: uuid.optional(),                 // a band or card
  item_id: uuid.optional(),                  // a merchandise item
  quantity: z.number().int().min(1).max(MAX_PER_ORDER),
  wallet_id: uuid.optional(),
  // Required for bands, cards and physical items (422 shipping_required); a digital item is downloaded and has none.
  shipping: z.object({
    name: text(100), line1: text(120), line2: z.string().trim().max(120).optional().transform((v) => v || undefined),
    city: text(80), region: text(80), postal_code: text(20),
    country: z.string().trim().toUpperCase().length(2),
  }).optional(),
}).refine((b) => (b.model_id === undefined) !== (b.item_id === undefined), { message: "model_id_or_item_id" });

// Checkout: pay for a band/card (model_id) or a merchandise item (item_id) with wallet balance. Idempotency-Key
// required; a retry returns the same order.
shop.post("/orders", rateLimit("shop-order", RULES.shopOrder, byAccount), async (c) => {
  const key = c.req.header("idempotency-key")?.trim();
  if (!key || key.length > 128) return c.json({ error: "idempotency_key_required" }, 400);
  const body = orderBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);

  const out = await purchase(c.get("sql"), {
    accountId: c.get("auth").accountId,
    walletId: body.data.wallet_id ?? null,
    kind: body.data.item_id ? "shop" : "tag",
    productId: (body.data.item_id ?? body.data.model_id)!,
    quantity: body.data.quantity,
    shipping: body.data.shipping ?? null,
    idempotencyKey: key,
  });
  if (out.kind === "error") return c.json({ error: out.error }, out.status);
  if (out.kind === "declined") return c.json({ error: "declined", status_code: out.code, transaction_id: out.transactionId }, 422);
  if (!out.replayed) track(c, { purchases_n: 1, purchases_v: Number(out.order.total) });   // today's running estimate
  return c.json({ order: orderJson(out.order) }, out.replayed ? 200 : 201);
});

shop.get("/orders", async (c) => c.json({ orders: await listOrders(c.get("sql"), c.get("auth").accountId) }));

// The file of a paid digital order, for its buyer only. Streamed from the private bucket.
shop.get("/orders/:id/download", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const [o] = await c.get("sql")<{ name: string; file: string | null }[]>`
    select o.name, s.file from orders o join shop s on s.id = o.shop_id
     where o.id = ${id.data} and o.account_id = ${c.get("auth").accountId} and o.delivery = 'download' and o.status = 'paid'`;
  if (!o) return c.json({ error: "not_found" }, 404);
  const obj = o.file ? await getUpload(c.env, o.file) : null;
  if (!o.file || !obj) return c.json({ error: "file_unavailable" }, 404);
  const ext = o.file.split(".").pop()!;
  await customerLog(c, c.get("auth").accountId, null, "order.downloaded", { order_id: id.data }, { type: "order", id: id.data, label: o.name });
  return new Response(await obj.arrayBuffer(), {
    headers: { "content-type": downloadMime(ext), "content-disposition": `attachment; filename="${o.name.replace(/[^A-Za-z0-9._ -]+/g, "").trim() || "download"}.${ext}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
});

shop.get("/orders/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const o = await getOrder(c.get("sql"), c.get("auth").accountId, id.data);
  return o ? c.json({ order: o }) : c.json({ error: "not_found" }, 404);
});
