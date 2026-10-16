import { ROOT, applyMigration, migrate, psql, resetSchema } from "./db.ts";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";

psql(["-c", "drop schema public cascade; create schema public;"]);
migrate();
const adm = postgres("postgres://postgres@127.0.0.1:54340/nuclear", { max: 4, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const env: any = { HYPERDRIVE: { connectionString: "postgres://postgres@127.0.0.1:54340/nuclear" }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true" };
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
eq("the model now points at its photo path", /^\/v1\/shop\/models\/[0-9a-f-]+\/photo\?v=\d+$/.test(withPhoto.photo), true);
const ph = await raw("GET", withPhoto.photo.split("?")[0]);
eq("the photo is served publicly with its type, the same bytes and a long cache", [ph.status, ph.headers.get("content-type"), Array.from(new Uint8Array(await ph.arrayBuffer())), ph.headers.get("cache-control")], [200, "image/png", Array.from(png), "public, max-age=31536000, immutable"]);
eq("admin list shows the photo path too", (await op("GET", "/v1/admin/tag-models")).json.models.find((m: any) => m.id === band.id).photo, withPhoto.photo);
eq("no photo is 404", (await call("GET", `/v1/shop/models/${pending.id}/photo`)).status, 404);

// ---- buying
// The shop allows ten orders a minute per account (see ratelimit.e2e.mts); these scenarios place many, so clear the counter first.
const order = async (token: string, key: string | undefined, body: object) => { await q("delete from throttles where key like 'shop-order:%'"); return call("POST", "/v1/shop/orders", { token, key, body }); };
eq("buying needs a session and an idempotency key", [(await order("", "k", { model_id: band.id, quantity: 1, shipping: SHIP })).status, (await order(A, undefined, { model_id: band.id, quantity: 1, shipping: SHIP })).json.error], [401, "idempotency_key_required"]);
eq("bad bodies are refused (quantity, shipping, country)", [
  (await order(A, "b1", { model_id: band.id, quantity: 0, shipping: SHIP })).status,
  (await order(A, "b2", { model_id: band.id, quantity: 21, shipping: SHIP })).status,
  (await order(A, "b3", { model_id: band.id, quantity: 1 })).status,
  (await order(A, "b4", { model_id: band.id, quantity: 1, shipping: { ...SHIP, country: "GBR" } })).status], [400, 400, 400, 400]);
const o1 = await order(A, "buy-1", { model_id: band.id, quantity: 2, shipping: SHIP });
eq("a purchase creates a paid order with a price snapshot, total and normalised shipping", [o1.status, o1.json.order.status, o1.json.order.quantity, o1.json.order.unit_price, o1.json.order.total, o1.json.order.model.name, o1.json.order.shipping.country], [201, "paid", 2, 2999, 5998, "NEO Band", "GB"]);
eq("the buyer's balance dropped and the model's sold count rose", [(await call("GET", "/v1/balance", { token: A })).json.balance, (await q("select sold from tag_models where id=$1", [band.id]))[0].sold], [10000 - 5998, 2]);
eq("a retry with the same key returns the same order, charging once", [(await order(A, "buy-1", { model_id: band.id, quantity: 2, shipping: SHIP })).json.order.id === o1.json.order.id, (await q("select sold from tag_models where id=$1", [band.id]))[0].sold, (await q("select count(*)::int n from tag_orders"))[0].n], [true, 2, 1]);
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
console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
