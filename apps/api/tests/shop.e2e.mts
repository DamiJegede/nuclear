import { ROOT, applyMigration, migrate, psql, resetSchema } from "./db.ts";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { memoryLimiter } from "../src/lib/throttle.ts";

psql(["-c", "drop schema public cascade; create schema public;"]);
migrate();
const adm = postgres("postgres://postgres@127.0.0.1:54340/nuclear", { max: 4, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
// A fake R2 bucket: put/get over a Map.
const store = new Map<string, { bytes: Uint8Array; httpMetadata?: any }>();
const IMAGES = {
  delete: async (k: string) => { store.delete(k); },
  put: async (k: string, v: Uint8Array, o?: any) => { store.set(k, { bytes: new Uint8Array(v), httpMetadata: o?.httpMetadata }); },
  get: async (k: string) => { const e = store.get(k); return e ? { httpMetadata: e.httpMetadata, arrayBuffer: async () => e.bytes.buffer.slice(e.bytes.byteOffset, e.bytes.byteOffset + e.bytes.byteLength) } : null; },
};
const files = new Map<string, { bytes: Uint8Array; mime?: string }>();
const UPLOADS = {
  put: async (k: string, v: Uint8Array, o?: any) => { files.set(k, { bytes: new Uint8Array(v), mime: o?.httpMetadata?.contentType }); },
  delete: async (k: string) => { files.delete(k); },
  get: async (k: string) => { const f = files.get(k); return f ? { httpMetadata: { contentType: f.mime }, arrayBuffer: async () => f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) } : null; },
};
// A fake Cloudflare Images binding for the non-tag pictures: returns a small JPEG.
const JPEG_OUT = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);
const IMG = { input: (_s: ReadableStream) => { const ch: any = { transform: () => ch, output: async () => ({ response: () => new Response(JPEG_OUT) }) }; return ch; } };
const env: any = { STATS_TTL_SECONDS: "0", IMAGES, IMG, UPLOADS, HYPERDRIVE: { connectionString: "postgres://postgres@127.0.0.1:54340/nuclear" }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const raw = (method: string, path: string, o: { body?: unknown; token?: string; key?: string; type?: string; bytes?: Uint8Array } = {}) =>
  app.fetch(new Request("http://x" + path, { method, headers: { "content-type": o.type ?? "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) },
    body: o.bytes ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) }), env, ctx);
const call = async (m: string, p: string, o: any = {}) => { const r = await raw(m, p, o); const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null, headers: r.headers }; };
const op = (m: string, p: string, body?: unknown) => call(m, p, { token: OP, body });
const signup = async (name: string, email: string) => (await call("POST", "/v1/auth/signup", { body: { name, email, password: "correct horse battery", type: "C" } })).json;
const SHIP = { name: "Ada Lovelace", line1: "1 Analytical Way", city: "London", region: "LDN", postal_code: "N1 1AA", country: "gb" };

const ada = await signup("Ada", "ada@example.com"), bob = await signup("Bob", "bob@example.com");
const A = ada.session_token, B = bob.session_token;
await call("POST", "/v1/sandbox/fundings", { token: A, key: "f1", body: { amount: 10000 } });

// ---- catalogue
const mk = async (b: object) => (await op("POST", "/v1/admin/tag-models", b)).json.model;
const band = await mk({ type: "band", name: "NEO Band", price: 2999, quantity: 5, status: "available" });
const pending = await mk({ type: "card", name: "Pending Card", price: 1500, quantity: 10 });
const soldout = await mk({ type: "card", name: "Gone Card", price: 1500, quantity: 1, status: "available" });
await q("update tag_models set sold = 1 where id = $1", [soldout.id]);
const free = await mk({ type: "band", name: "Free", price: 0, quantity: 4, status: "available" });
const list = await call("GET", "/v1/shop/models");
eq("public list shows only available models with stock and a price", [list.status, list.json.models.map((m: any) => m.name)], [200, ["NEO Band"]]);
eq("a model carries price in cents, remaining and a per-order maximum", list.json.models[0], { id: band.id, type: "band", name: "NEO Band", photo: null, currency: "USD", price: 2999, limited: false, remaining: 5, max_per_order: 5 });
eq("single model lookup; unavailable ones are 404", [(await call("GET", `/v1/shop/models/${band.id}`)).status, (await call("GET", `/v1/shop/models/${pending.id}`)).status, (await call("GET", "/v1/shop/models/nope")).status], [200, 404, 404]);

// ---- photo upload
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
eq("photo upload needs admin credentials", (await call("PUT", `/v1/admin/tag-models/${band.id}/photo`, { type: "image/png", bytes: png })).status, 401);
eq("photo upload rejects other types, empty and oversize bodies", [
  (await call("PUT", `/v1/admin/tag-models/${band.id}/photo`, { token: OP, type: "image/jpeg", bytes: png })).status,
  (await call("PUT", `/v1/admin/tag-models/${band.id}/photo`, { token: OP, type: "image/png", bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) })).status,
  (await call("PUT", `/v1/admin/tag-models/${band.id}/photo`, { token: OP, type: "image/png", bytes: new Uint8Array(0) })).status,
  (await call("PUT", `/v1/admin/tag-models/${band.id}/photo`, { token: OP, type: "image/png", bytes: new Uint8Array(262145) })).status], [415, 400, 400, 413]);
eq("a valid photo is stored; unknown model is 404", [(await call("PUT", `/v1/admin/tag-models/${band.id}/photo`, { token: OP, type: "image/png", bytes: png })).status, (await call("PUT", `/v1/admin/tag-models/00000000-0000-7000-8000-000000000000/photo`, { token: OP, type: "image/png", bytes: png })).status], [204, 404]);
const withPhoto = (await call("GET", "/v1/shop/models")).json.models[0];
eq("the model now has a full photo URL built from its R2 key", /^http:\/\/x\/v1\/photos\/tags\/[0-9a-f-]{36}-\d+\.png$/.test(withPhoto.photo), true);
const ph = await raw("GET", new URL(withPhoto.photo).pathname);
eq("the photo is served publicly with its type, the same bytes and a long cache", [ph.status, ph.headers.get("content-type"), Array.from(new Uint8Array(await ph.arrayBuffer())), ph.headers.get("cache-control")], [200, "image/png", Array.from(png), "public, max-age=31536000, immutable"]);
eq("admin list shows the photo path too", (await op("GET", "/v1/admin/tag-models")).json.models.find((m: any) => m.id === band.id).photo, withPhoto.photo);
const stored = (await q("select photo from tag_models where id=$1", [band.id]))[0].photo;
eq("the database keeps only the R2 key (folder and file name); the API builds the full URL", [/^tags\/[0-9a-f-]{36}-\d+\.png$/.test(stored), store.has(stored), withPhoto.photo === `http://x/v1/photos/${stored}`], [true, true, true]);
await new Promise((r) => setTimeout(r, 5));
await raw("PUT", `/v1/admin/tag-models/${band.id}/photo`, { token: OP, type: "image/png", bytes: png });
eq("a new upload gets a new file name and the old object is deleted", [(await q("select photo from tag_models where id=$1", [band.id]))[0].photo !== stored, store.has(stored)], [true, false]);
eq("a model without a photo has null; an unknown or malformed key is 404", [(await op("GET", `/v1/admin/tag-models/${pending.id}`)).json.model.photo, (await call("GET", `/v1/photos/tags/${pending.id}-1.png`)).status, (await call("GET", "/v1/photos/tags/nope.png")).status], [null, 404, 404]);

// ---- buying
// The shop allows ten orders a minute per account (see ratelimit.e2e.mts); these scenarios place many, so clear the counter first.
const order = async (token: string, key: string | undefined, body: object) => { memoryLimiter.windows.clear("shop-order:"); return call("POST", "/v1/shop/orders", { token, key, body }); };
eq("buying needs a session and an idempotency key", [(await order("", "k", { model_id: band.id, quantity: 1, shipping: SHIP })).status, (await order(A, undefined, { model_id: band.id, quantity: 1, shipping: SHIP })).json.error], [401, "idempotency_key_required"]);
eq("bad bodies are refused (quantity, shipping, country)", [
  (await order(A, "b1", { model_id: band.id, quantity: 0, shipping: SHIP })).status,
  (await order(A, "b2", { model_id: band.id, quantity: 21, shipping: SHIP })).status,
  (await order(A, "b3", { model_id: band.id, quantity: 1 })).status,
  (await order(A, "b4", { model_id: band.id, quantity: 1, shipping: { ...SHIP, country: "GBR" } })).status], [400, 400, 422, 400]);
const o1 = await order(A, "buy-1", { model_id: band.id, quantity: 2, shipping: SHIP });
eq("a purchase creates a paid order with a price snapshot, total and normalised shipping", [o1.status, o1.json.order.status, o1.json.order.quantity, o1.json.order.unit_price, o1.json.order.total, o1.json.order.model.name, o1.json.order.shipping.country], [201, "paid", 2, 2999, 5998, "NEO Band", "GB"]);
eq("the buyer's balance dropped and the model's sold count rose", [(await call("GET", "/v1/balance", { token: A })).json.balance, (await q("select sold from tag_models where id=$1", [band.id]))[0].sold], [10000 - 5998, 2]);
eq("a retry with the same key returns the same order, charging once", [(await order(A, "buy-1", { model_id: band.id, quantity: 2, shipping: SHIP })).json.order.id === o1.json.order.id, (await q("select sold from tag_models where id=$1", [band.id]))[0].sold, (await q("select count(*)::int n from orders"))[0].n], [true, 2, 1]);
eq("the same key for a different purchase is a mismatch", (await order(A, "buy-1", { model_id: band.id, quantity: 1, shipping: SHIP })).json.error, "idempotency_mismatch");
const ledger = await q("select bucket, direction, amount::int a, account_id is null as platform from ledger_entries where transaction_id = $1 order by line_no", [o1.json.order.transaction_id]);
eq("the ledger posts buyer funded_balance debit and platform_clearing credit, balanced", ledger, [{ bucket: "funded_balance", direction: "debit", a: 5998, platform: false }, { bucket: "platform_clearing", direction: "credit", a: 5998, platform: true }]);
eq("the system stats still reconcile", (await op("GET", "/v1/admin/stats")).json.reconciliation.ledger_balanced, true);
eq("the price is a snapshot: changing it later does not change the order", await (async () => { await q("update tag_models set price = 9999 where id=$1", [band.id]); const r = (await call("GET", `/v1/shop/orders/${o1.json.order.id}`, { token: A })).json.order; await q("update tag_models set price = 2999 where id=$1", [band.id]); return [r.unit_price, r.total]; })(), [2999, 5998]);

eq("only the buyer sees the order; lists are per account", [(await call("GET", `/v1/shop/orders/${o1.json.order.id}`, { token: B })).status, (await call("GET", "/v1/shop/orders", { token: A })).json.orders.length, (await call("GET", "/v1/shop/orders", { token: B })).json.orders.length], [404, 1, 0]);
const poor = await order(B, "poor-1", { model_id: band.id, quantity: 1, shipping: SHIP });
eq("not enough balance is a recorded decline, and nothing is sold", [poor.status, poor.json.status_code, (await q("select status, status_code from transactions where type='purchase' and from_account_id=(select account_id from devices limit 0) or idempotency_key='poor-1'"))[0], (await q("select sold from tag_models where id=$1", [band.id]))[0].sold], [422, "insufficient_balance", { status: "failed", status_code: "insufficient_balance" }, 2]);
eq("a declined attempt replays as the same decline", (await order(B, "poor-1", { model_id: band.id, quantity: 1, shipping: SHIP })).json.status_code, "insufficient_balance");
eq("unavailable, unknown and free models cannot be bought", [(await order(A, "u1", { model_id: pending.id, quantity: 1, shipping: SHIP })).json.error, (await order(A, "u2", { model_id: free.id, quantity: 1, shipping: SHIP })).json.error, (await order(A, "u3", { model_id: "00000000-0000-7000-8000-000000000000", quantity: 1, shipping: SHIP })).json.error, (await order(A, "u4", { model_id: soldout.id, quantity: 1, shipping: SHIP })).json.error], ["model_not_found", "model_not_found", "model_not_found", "sold_out"]);
eq("asking for more than remains is refused without recording anything", [(await order(A, "m1", { model_id: band.id, quantity: 4, shipping: SHIP })).json.error, (await q("select count(*)::int n from transactions where idempotency_key='m1'"))[0].n], ["not_enough_stock", 0]);

// ---- the last units under concurrency
await call("POST", "/v1/sandbox/fundings", { token: A, key: "f2", body: { amount: 50000 } });
const race = await Promise.all([1, 2, 3, 4].map((i) => order(A, `race-${i}`, { model_id: band.id, quantity: 2, shipping: SHIP })));
const ok = race.filter((r) => r.status === 201).length;
eq("four buyers race for three remaining units: exactly one wins, the rest see stock errors", [ok, race.filter((r) => r.status === 409).length, (await q("select sold from tag_models where id=$1", [band.id]))[0].sold], [1, 3, 4]);
const last = await order(A, "last-1", { model_id: band.id, quantity: 1, shipping: SHIP });
eq("the last unit sells and the model then leaves the catalogue", [last.status, (await call("GET", "/v1/shop/models")).json.models.length, (await order(A, "last-2", { model_id: band.id, quantity: 1, shipping: SHIP })).json.error], [201, 0, "sold_out"]);
eq("sold never exceeds quantity, balances equal the ledger, the ledger balances", [(await q("select sold <= quantity ok from tag_models where id=$1", [band.id]))[0].ok, (await op("GET", "/v1/admin/stats")).json.reconciliation.ledger_balanced], [true, true]);


// ---- model detail and edit (admin)
const uidsFor = (n: number, base = 0) => Array.from({ length: n }, (_, i) => (0x04ae42000000 + base + i).toString(16).toUpperCase().padStart(14, "0"));
await op("POST", `/v1/admin/tag-models/${band.id}/tags`, { uids: uidsFor(3) });
const wl = (await call("GET", "/v1/wallets", { token: A })).json.wallets[0].id;
await q("update tags set wallet_id=$1 where uid=$2", [wl, uidsFor(1)[0]]);
const det = (await op("GET", `/v1/admin/tag-models/${band.id}`)).json.model;
eq("detail: provisioning, activation, pending and rank", [det.quantity, det.tags, det.activated, det.unassigned, det.pending, det.rank, det.sold], [5, 3, 1, 2, 2, 1, 5]);
eq("rank counts models that sold more; equal sales share a rank", [(await op("GET", `/v1/admin/tag-models/${pending.id}`)).json.model.rank, (await op("GET", `/v1/admin/tag-models/${free.id}`)).json.model.rank], [3, 3]);
eq("detail of an unknown model is 404", [(await op("GET", "/v1/admin/tag-models/00000000-0000-7000-8000-000000000000")).status, (await op("GET", "/v1/admin/tag-models/nope")).status], [404, 404]);
const ed = await op("PATCH", `/v1/admin/tag-models/${pending.id}`, { name: "Renamed Card", price: 1800, quantity: 12, limited: true, status: "available" });
eq("a model can be edited (partial update)", [ed.status, ed.json.model.name, ed.json.model.price, ed.json.model.quantity, ed.json.model.limited, ed.json.model.status, ed.json.model.type], [200, "Renamed Card", 1800, 12, true, "available", "card"]);
eq("quantity cannot go below sold; type is locked once tags or sales exist", [(await op("PATCH", `/v1/admin/tag-models/${band.id}`, { quantity: 3 })).json.error, (await op("PATCH", `/v1/admin/tag-models/${band.id}`, { type: "card" })).json.error], ["quantity_below_sold", "type_locked"]);
eq("an untouched model can change type; empty and invalid bodies are refused; unknown is 404", [(await op("PATCH", `/v1/admin/tag-models/${free.id}`, { type: "card" })).json.model.type, (await op("PATCH", `/v1/admin/tag-models/${band.id}`, {})).status, (await op("PATCH", `/v1/admin/tag-models/${band.id}`, { price: -5 })).status, (await op("PATCH", "/v1/admin/tag-models/00000000-0000-7000-8000-000000000000", { name: "x" })).status], ["card", 400, 400, 404]);
eq("editing needs admin credentials", (await call("PATCH", `/v1/admin/tag-models/${band.id}`, { body: { name: "x" } })).status, 401);

// ---- authority
const link = (await call("POST", "/v1/wallets", { token: A, body: { display_name: "Kid", type: "person" } })).json;
eq("activity labels the purchase", (await call("GET", "/v1/activity", { token: A })).json.items.some((i: any) => i.type === "purchase" && i.counterparty.display_name === "Nuclear store"), true);
// ---- merchandise (shop table) and orders of type "shop"
const mkItem = async (b: object) => (await op("POST", "/v1/admin/shop-items", b));
const tee = (await mkItem({ name: "Nuclear Tee", description: "Soft cotton", price: 2500, stock: 3, status: "available" })).json.item;
const draft = (await mkItem({ name: "Draft Hat", price: 1500 })).json.item;
eq("a shop item is created pending by default; bad bodies are refused", [draft.status, (await mkItem({ name: "", price: 1 })).status, (await mkItem({ name: "x", price: -1 })).status], ["pending", 400, 400]);
eq("public items list shows only available items with stock", [(await call("GET", "/v1/shop/items")).json.items.map((i: any) => i.name), (await call("GET", `/v1/shop/items/${draft.id}`)).status], [["Nuclear Tee"], 404]);
await op("PUT", `/v1/admin/shop-items/${tee.id}/photo`, {});
eq("an item picture may be any image (not only PNG): it is compressed to a JPEG in R2 and served publicly", await (async () => { const r = await raw("PUT", `/v1/admin/shop-items/${tee.id}/photo`, { token: OP, type: "image/png", bytes: png }); const g = (await op("GET", `/v1/admin/shop-items/${tee.id}`)).json.item; const f = await raw("GET", new URL(g.photo).pathname); return [r.status, /^http:\/\/x\/v1\/photos\/shop\/[0-9a-f-]{36}-\d+\.jpg$/.test(g.photo), f.status, [...store.keys()].some((k) => k.startsWith(`shop/${tee.id}-`))]; })(), [204, true, 200, true]);
const t1 = await order(A, "tee-1", { item_id: tee.id, quantity: 2, shipping: SHIP });
eq("buying merch creates a shop order with a snapshot; stock and sold move", [t1.status, t1.json.order.type, t1.json.order.item.name, t1.json.order.total, (await q("select stock, sold from shop where id=$1", [tee.id]))[0]], [201, "shop", "Nuclear Tee", 5000, { stock: 1, sold: 2 }]);
eq("tag orders are type tag, shop orders type shop", (await q("select type, count(*)::int n from orders group by type order by type")), [{ type: "shop", n: 1 }, { type: "tag", n: 3 }]);
eq("merch: not enough stock, both ids, neither id", [(await order(A, "tee-2", { item_id: tee.id, quantity: 2, shipping: SHIP })).json.error, (await order(A, "tee-3", { item_id: tee.id, model_id: band.id, quantity: 1, shipping: SHIP })).status, (await order(A, "tee-4", { quantity: 1, shipping: SHIP })).status], ["not_enough_stock", 400, 400]);
await order(A, "tee-5", { item_id: tee.id, quantity: 1, shipping: SHIP });
eq("the last unit flips nothing wrong: item leaves the catalogue at zero stock", (await call("GET", "/v1/shop/items")).json.items.length, 0);
eq("shop item admin: update and unknown", [(await op("PATCH", `/v1/admin/shop-items/${draft.id}`, { status: "available", stock: null })).json.item.status, (await op("PATCH", `/v1/admin/shop-items/00000000-0000-7000-8000-000000000000`, { name: "x" })).status], ["available", 404]);

// ---- audit log
const logs = (await op("GET", "/v1/admin/logs?limit=200")).json.logs;
const acts = new Set(logs.map((l: any) => l.action));
eq("admin actions and customer events are logged", ["tag_model.created", "tag_model.updated", "tag_model.photo_uploaded", "tag_model.tags_imported", "shop_item.created", "shop_item.updated", "shop_item.photo_uploaded", "customer.signed_up"].every((a) => acts.has(a)), true);
eq("log rows are append-only", await (async () => { try { await q("update logs set action='x'"); return "updated"; } catch { return "refused"; } })(), "refused");
eq("a log needs the audit page; filters work", [(await call("GET", "/v1/admin/logs")).status, (await op("GET", "/v1/admin/logs?who=customer")).json.logs.every((l: any) => l.actor_type === "customer"), (await op("GET", "/v1/admin/logs?action=shop_item.")).json.logs.length], [401, true, 4]);
eq("a person's activity lists their own events", (await op("GET", `/v1/admin/users/${ada.account_id}/activity`)).json.logs.some((l: any) => l.action === "customer.signed_up"), true);

// ---- digital products: a file the buyer downloads after paying; no shipping, no stock
const dig = (await mkItem({ name: "Nuclear Handbook", price: 1200, kind: "digital" })).json.item;
eq("a digital item is created pending, untracked, without a file; physical is the default kind", [dig.kind, dig.status, dig.stock, dig.has_file, dig.file_ext, tee.kind, "file" in dig], ["digital", "pending", null, false, null, "physical", false]);
eq("a digital item cannot be published without its file, nor created as available", [(await op("PATCH", `/v1/admin/shop-items/${dig.id}`, { status: "available" })).json.error, (await mkItem({ name: "X", price: 100, kind: "digital", status: "available" })).json.error], ["file_required", "file_required"]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]);
eq("the file upload takes only listed types, non-empty, up to 25 MB, for digital items", [
  (await call("PUT", `/v1/admin/shop-items/${dig.id}/file`, { token: OP, type: "application/x-msdownload", bytes: PDF })).status,
  (await call("PUT", `/v1/admin/shop-items/${dig.id}/file`, { token: OP, type: "application/pdf", bytes: new Uint8Array(0) })).status,
  (await call("PUT", `/v1/admin/shop-items/${dig.id}/file`, { token: OP, type: "application/pdf", bytes: new Uint8Array(25 * 1024 * 1024 + 1) })).status,
  (await call("PUT", `/v1/admin/shop-items/${tee.id}/file`, { token: OP, type: "application/pdf", bytes: PDF })).status,
  (await call("PUT", `/v1/admin/shop-items/${dig.id}/file`, { type: "application/pdf", bytes: PDF })).status], [415, 400, 413, 409, 401]);
const upf = await call("PUT", `/v1/admin/shop-items/${dig.id}/file`, { token: OP, type: "application/pdf", bytes: PDF });
const dkey = (await q("select file from shop where id=$1", [dig.id]))[0].file;
eq("the file goes to the private bucket under downloads/<item>-<ms>.pdf; the admin JSON shows only that it exists", [upf.status, /^downloads\/[0-9a-f-]{36}-\d+\.pdf$/.test(dkey), files.has(dkey), (await op("GET", `/v1/admin/shop-items/${dig.id}`)).json.item.has_file, (await op("GET", `/v1/admin/shop-items/${dig.id}`)).json.item.file_ext, "file" in (await op("GET", `/v1/admin/shop-items/${dig.id}`)).json.item], [204, true, true, true, "pdf", false]);
await new Promise((r) => setTimeout(r, 5));
await call("PUT", `/v1/admin/shop-items/${dig.id}/file`, { token: OP, type: "application/zip", bytes: new Uint8Array([0x50, 0x4b, 3, 4]) });
eq("a new file replaces the old one and deletes it", [files.has(dkey), (await q("select file from shop where id=$1", [dig.id]))[0].file !== dkey], [false, true]);
eq("now it can be published; the public list says digital, no shipping, one per order", await (async () => { await op("PATCH", `/v1/admin/shop-items/${dig.id}`, { status: "available" }); const it = (await call("GET", `/v1/shop/items/${dig.id}`)).json.item; return [it.kind, it.requires_shipping, it.max_per_order, it.remaining]; })(), ["digital", false, 1, null]);
await call("POST", "/v1/sandbox/fundings", { token: A, key: "fdig", body: { amount: 20000 } });
const d1 = await order(A, "dig-1", { item_id: dig.id, quantity: 1 });
eq("buying a digital item needs no shipping address; the order is a download order with a full download URL", [d1.status, d1.json.order.delivery, d1.json.order.shipping, d1.json.order.download_url === `http://x/v1/shop/orders/${d1.json.order.id}/download`, d1.json.order.total], [201, "download", null, true, 1200]);
eq("digital quantity is one; physical items still need shipping; tags too", [(await order(A, "dig-2", { item_id: dig.id, quantity: 2 })).json.error, (await order(A, "tee-ship", { item_id: tee.id, quantity: 1 })).json.error, (await order(A, "band-ship", { model_id: band.id, quantity: 1 })).json.error], ["digital_quantity_one", "shipping_required", "shipping_required"]);
eq("a retry returns the same order", (await order(A, "dig-1", { item_id: dig.id, quantity: 1 })).json.order.id, d1.json.order.id);
const dlr = await raw("GET", `/v1/shop/orders/${d1.json.order.id}/download`, { token: A });
eq("the buyer downloads the file with a private attachment response", [dlr.status, dlr.headers.get("content-type"), dlr.headers.get("content-disposition"), dlr.headers.get("cache-control"), Array.from(new Uint8Array(await dlr.arrayBuffer()))], [200, "application/zip", 'attachment; filename="Nuclear Handbook.zip"', "private, no-store", [0x50, 0x4b, 3, 4]]);
eq("only the buyer; physical orders have no download; no session is 401", [(await call("GET", `/v1/shop/orders/${d1.json.order.id}/download`, { token: B })).status, (await call("GET", `/v1/shop/orders/${t1.json.order.id}/download`, { token: A })).status, (await call("GET", `/v1/shop/orders/${d1.json.order.id}/download`)).status], [404, 404, 401]);
eq("the kind is locked once units are sold; stock stays untracked", [(await op("PATCH", `/v1/admin/shop-items/${dig.id}`, { kind: "physical" })).json.error, (await op("PATCH", `/v1/admin/shop-items/${dig.id}`, { stock: 5 })).json.item.stock, (await q("select sold from shop where id=$1", [dig.id]))[0].sold], ["kind_locked", null, 1]);
eq("a digital order lists without shipping; the database keeps shipping NULL exactly for downloads", [(await call("GET", "/v1/shop/orders", { token: A })).json.orders.find((o: any) => o.id === d1.json.order.id).shipping, (await q("select count(*)::int n from orders where (delivery='download') <> (shipping is null)"))[0].n], [null, 0]);
const sw = (await mkItem({ name: "Switchable", price: 100, kind: "digital" })).json.item;
await call("PUT", `/v1/admin/shop-items/${sw.id}/file`, { token: OP, type: "application/pdf", bytes: PDF });
const swKey = (await q("select file from shop where id=$1", [sw.id]))[0].file;
eq("switching an unsold digital item to physical drops its file", [(await op("PATCH", `/v1/admin/shop-items/${sw.id}`, { kind: "physical" })).json.item.has_file, files.has(swKey)], [false, false]);
eq("the user's orders list in the admin shows delivery", (await op("GET", `/v1/admin/users/${ada.account_id}/orders`)).json.orders.some((o: any) => o.delivery === "download" && o.shipping && Object.keys(o.shipping).length === 0), true);

console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
