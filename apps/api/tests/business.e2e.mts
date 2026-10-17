import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const store = new Map<string, { bytes: Uint8Array; httpMetadata?: any }>();
const IMAGES = {
  put: async (k: string, v: Uint8Array, o?: any) => { store.set(k, { bytes: new Uint8Array(v), httpMetadata: o?.httpMetadata }); },
  delete: async (k: string) => { store.delete(k); },
  get: async (k: string) => { const e = store.get(k); return e ? { httpMetadata: e.httpMetadata, arrayBuffer: async () => e.bytes.buffer.slice(e.bytes.byteOffset, e.bytes.byteOffset + e.bytes.byteLength) } : null; },
};
const JPEG_OUT = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);
const IMG = { input: (_s: ReadableStream) => { const ch: any = { transform: () => ch, output: async () => ({ response: () => new Response(JPEG_OUT) }) }; return ch; } };
const env: any = { HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true", IMAGES, IMG };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const raw = (method: string, path: string, o: { body?: unknown; token?: string; key?: string; type?: string; bytes?: Uint8Array } = {}) =>
  app.fetch(new Request("http://x" + path, { method, headers: { "content-type": o.type ?? "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.bytes ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) }), env, ctx);
const call = async (m: string, p: string, o: any = {}) => { const r = await raw(m, p, o); const t = await r.text(); let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { /* binary */ } return { status: r.status, json: j }; };

const sign = async (name: string, email: string, type = "C") => (await call("POST", "/v1/auth/signup", { body: { type, name, email, password: "correct horse battery" } })).json;
const biz = await sign("Cafe Nero", "cafe@example.com", "B");
await q("update accounts set status='active' where id=$1", [biz.account_id]);
const other = await sign("Other Shop", "other@example.com", "B");
await q("update accounts set status='active' where id=$1", [other.account_id]);
const pend = await sign("Pending Pizza", "pizza@example.com", "B");
const ada = await sign("Ada", "ada@example.com");
const B = biz.session_token, O = other.session_token;
const get = (p: string, t = B) => call("GET", "/v1/business" + p, { token: t });

eq("only an approved business owner uses it: customers 403, pending 403, no session 401", [(await get("/profile", ada.session_token)).json.error, (await get("/profile", pend.session_token)).json.error, (await call("GET", "/v1/business/profile")).status], ["business_account_required", "account_not_approved", 401]);

// ---- profile
eq("no profile yet", (await get("/profile")).json.profile, null);
eq("a profile needs legal and display names; bad website and country are refused", [
  (await call("PUT", "/v1/business/profile", { token: B, body: { display_name: "Cafe" } })).status,
  (await call("PUT", "/v1/business/profile", { token: B, body: { legal_name: "X", display_name: "Y", website: "javascript:alert(1)" } })).status,
  (await call("PUT", "/v1/business/profile", { token: B, body: { legal_name: "X", display_name: "Y", country: "USA" } })).status], [400, 400, 400]);
const saved = await call("PUT", "/v1/business/profile", { token: B, body: { legal_name: "Nero Holdings LLC", display_name: "Cafe Nero", tax_id: "12-3456789", address: "1 Main St\nSuite 2", city: "Springfield", state: "NY", post_code: "10001", country: "us", website: "https://nero.example" } });
eq("saving the profile returns it with only the last four of the tax id", [saved.status, saved.json.profile.legal_name, saved.json.profile.tax_id_last4, saved.json.profile.country, saved.json.profile.address], [200, "Nero Holdings LLC", "6789", "US", "1 Main St\nSuite 2"]);
await call("PUT", "/v1/business/profile", { token: B, body: { legal_name: "Nero Holdings Inc", display_name: "Cafe Nero", city: "Albany" } });
eq("a later save keeps the saved tax id when none is sent, and updates the rest", [(await get("/profile")).json.profile.tax_id_last4, (await get("/profile")).json.profile.legal_name, (await get("/profile")).json.profile.city, (await q("select tax_id from businesses where account_id=$1", [biz.account_id]))[0].tax_id], ["6789", "Nero Holdings Inc", "Albany", "12-3456789"]);
eq("the merchant page in the admin shows the saved profile", (await call("GET", `/v1/admin/merchants/${biz.account_id}`, { token: OP })).json.merchant.legal_name, "Nero Holdings Inc");

// ---- payout bank
eq("a bank needs the profile first; routing must be 9 digits with a valid checksum", [
  (await call("PUT", "/v1/business/bank", { token: O, body: { routing_number: "110000000", account_number: "123456789012" } })).json.error,
  (await call("PUT", "/v1/business/bank", { token: B, body: { routing_number: "12345", account_number: "123456789012" } })).status,
  (await call("PUT", "/v1/business/bank", { token: B, body: { routing_number: "123456789", account_number: "123456789012" } })).json.error], ["profile_required", 400, "invalid_routing_number"]);
const bank = await call("PUT", "/v1/business/bank", { token: B, body: { routing_number: "110000000", account_number: "000123456789" } });
eq("a payout bank is saved and only its last four come back", [bank.status, bank.json.bank.last4, bank.json.bank.status, JSON.stringify(bank.json).includes("000123456789")], [201, "6789", "active", false]);
await call("PUT", "/v1/business/bank", { token: B, body: { routing_number: "110000000", account_number: "99887766" } });
eq("replacing it marks the old one removed and the page shows the new one", [(await get("/bank")).json.bank.last4, (await q("select status from bank_accounts where account_id=$1 order by created_at", [biz.account_id])).map((r: any) => r.status), (await call("GET", `/v1/admin/merchants/${biz.account_id}`, { token: OP })).json.merchant.bank.last4], ["7766", ["removed", "active"], "7766"]);
eq("removing the bank clears it", [(await call("DELETE", "/v1/business/bank", { token: B })).status, (await get("/bank")).json.bank, (await q("select bank_account_id from businesses where account_id=$1", [biz.account_id]))[0].bank_account_id], [204, null, null]);

// ---- categories and products
const cat = (await call("POST", "/v1/business/categories", { token: B, body: { name: "Drinks" } })).json.category;
const otherCat = (await call("POST", "/v1/business/categories", { token: O, body: { name: "Theirs" } })).json.category;
eq("categories: create, list own only, rename, validate", [cat.name, (await get("/categories")).json.categories.map((c: any) => c.name), (await call("PATCH", `/v1/business/categories/${cat.id}`, { token: B, body: { name: "Hot Drinks" } })).json.category.name, (await call("POST", "/v1/business/categories", { token: B, body: { name: "" } })).status, (await call("PATCH", `/v1/business/categories/${otherCat.id}`, { token: B, body: { name: "x" } })).status], ["Drinks", ["Drinks"], "Hot Drinks", 400, 404]);
const latte = (await call("POST", "/v1/business/products", { token: B, body: { name: "Latte", price: 450, category_id: cat.id, stock: 10 } })).json.product;
eq("a product is created with its price in cents, category and tracked stock", [latte.name, latte.price, latte.discount, latte.effective_price, latte.category_id === cat.id, latte.stock, latte.status, latte.active, latte.photo], ["Latte", 450, 0, 450, true, 10, "available", true, null]);
eq("product rules: discount cannot exceed the price; another business's category is 404; bad bodies are 400", [
  (await call("POST", "/v1/business/products", { token: B, body: { name: "X", price: 100, discount: 200 } })).json.error,
  (await call("POST", "/v1/business/products", { token: B, body: { name: "X", price: 100, category_id: otherCat.id } })).json.error,
  (await call("POST", "/v1/business/products", { token: B, body: { name: "", price: 100 } })).status,
  (await call("POST", "/v1/business/products", { token: B, body: { name: "X", price: -1 } })).status,
  (await call("POST", "/v1/business/products", { token: B, body: { name: "X", price: 1.5 } })).status], ["discount_exceeds_price", "category_not_found", 400, 400, 400]);
const upd = (await call("PATCH", `/v1/business/products/${latte.id}`, { token: B, body: { price: 500, discount: 50, stock: 0, active: false } })).json.product;
eq("editing: price and discount, stock to 0 makes it sold out, deactivate", [upd.price, upd.effective_price, upd.status, upd.active], [500, 450, "sold_out", false]);
eq("a product is private to its business", [(await call("PATCH", `/v1/business/products/${latte.id}`, { token: O, body: { name: "Mine" } })).status, (await call("DELETE", `/v1/business/products/${latte.id}`, { token: O })).status, (await call("GET", "/v1/business/products", { token: O })).json.products.length], [404, 404, 0]);
eq("list filters by category and name (wildcards are literal)", [(await get(`/products?category_id=${cat.id}`)).json.products.length, (await get("/products?q=lat")).json.products.length, (await get("/products?q=%25")).json.products.length], [1, 1, 0]);
eq("a category with products cannot be deleted", (await call("DELETE", `/v1/business/categories/${cat.id}`, { token: B })).json.error, "category_has_products");
const ph = await call("PUT", `/v1/business/products/${latte.id}/photo`, { token: B, type: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]) });
const pkey = (await q("select photo from products where id=$1", [latte.id]))[0].photo;
eq("a product picture is cropped to a JPEG in R2 (products/<id>-<ms>.jpg), stored as a key and returned as a full URL", [ph.status, /^products\/[0-9a-f-]{36}-\d+\.jpg$/.test(pkey), store.has(pkey), ph.json.photo === `http://x/v1/photos/${pkey}`, (await call("PUT", `/v1/business/products/${latte.id}/photo`, { token: O, type: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) })).status], [200, true, true, true, 404]);
const muffin = (await call("POST", "/v1/business/products", { token: B, body: { name: "Muffin", price: 300 } })).json.product;
eq("an unused product can be deleted", [(await call("DELETE", `/v1/business/products/${muffin.id}`, { token: B })).status, (await get("/products")).json.products.length], [204, 1]);

// ---- orders (checkouts), payments and transactions
const term = (await call("POST", "/v1/terminals", { token: B, body: { name: "Counter" } })).json;
const T = term.session_token;
const co = (await call("POST", "/v1/terminal/checkouts", { token: T, body: { amount: 1000, reference: "Order 1" } })).json.checkout;
eq("open orders are listed for the owner", [(await get("/checkouts")).json.checkouts.map((c: any) => c.id), (await get("/checkouts?status=paid")).json.checkouts.length], [[co.id], 0]);
eq("another business cannot cancel it", (await call("POST", `/v1/business/checkouts/${co.id}/cancel`, { token: O })).status, 404);
await call("POST", "/v1/sandbox/fundings", { token: ada.session_token, key: "f1", body: { amount: 5000 } });
const pay = await call("POST", "/v1/payments", { token: ada.session_token, key: "p1", body: { checkout_id: co.id } });
eq("a paid order moves to paid and cannot be cancelled", [pay.status, (await get("/checkouts?status=paid")).json.checkouts.length, (await call("POST", `/v1/business/checkouts/${co.id}/cancel`, { token: B })).json.error], [201, 1, "checkout_paid"]);
const co2 = (await call("POST", "/v1/terminal/checkouts", { token: T, body: { amount: 200 } })).json.checkout;
eq("an open order is cancelled", [(await call("POST", `/v1/business/checkouts/${co2.id}/cancel`, { token: B })).json.checkout.status, (await get("/checkouts?status=canceled")).json.checkouts.length], ["canceled", 1]);
const tx = (await get("/transactions")).json;
eq("transactions: the payment with the customer's name and no account ids; counts and totals", [tx.transactions.length, tx.transactions[0].type, tx.transactions[0].amount, tx.transactions[0].customer, tx.transactions[0].from_party, tx.counts.payments, tx.totals.payments.volume], [1, "pay", 1000, "Ada", null, 1, 1000]);
eq("filters, periods and bad input behave as on the admin page", [(await get("/transactions?kind=refunds")).json.transactions.length, (await get("/transactions?from=2020-01-01&to=2020-01-31")).json.counts.all, (await get("/transactions?from=bad")).status, (await get("/transactions?kind=nope")).status, (await get("/transactions?cursor=nope")).status], [0, 0, 400, 400, 400]);
eq("another business sees none of it", [(await call("GET", "/v1/business/transactions", { token: O })).json.counts.all, (await call("GET", "/v1/business/checkouts?status=paid", { token: O })).json.checkouts.length], [0, 0]);
console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
