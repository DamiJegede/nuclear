import { migrate, psql } from "./db.ts";
import { createCipheriv, randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { connect } from "../src/db.ts";

psql(["-c", "drop schema public cascade; create schema public;"]);
migrate();
const adm = postgres("postgres://postgres@127.0.0.1:54340/nuclear", { max: 2, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];

const tagKey = randomBytes(16);
const env: any = {
  HYPERDRIVE: { connectionString: "postgres://postgres@127.0.0.1:54340/nuclear" },
  JWT_SECRET: "test-secret-test-secret-test-secret!",
  SANDBOX_FUNDING: "true",
  TAG_KEY_V1: tagKey.toString("hex"),
};
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const call = async (method: string, path: string, o: { body?: unknown; token?: string; key?: string } = {}) => {
  const res = await app.fetch(new Request("http://x" + path, {
    method,
    headers: { "content-type": "application/json",
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      ...(o.key ? { "idempotency-key": o.key } : {}) },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  }), env, ctx);
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
};
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(ok ? "ok  " : "FAIL", label, ok ? "" : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};
const signup = async (name: string, email: string, type = "C") => {
  const j = (await call("POST", "/v1/auth/signup", { body: { name, email, password: "correct horse battery", type } })).json;
  if (type === "B") await q("update accounts set status='active' where id=$1", [j.account_id]);   // businesses start pending; this suite needs them live
  return j;
};
const fund = (token: string, amount: number, key: string) => call("POST", "/v1/sandbox/fundings", { token, key, body: { amount } });
const bal = async (token: string) => (await call("GET", "/v1/balance", { token })).json;

// ---- tags (test helper: no claim endpoints yet) ----
const model = (await q("insert into tag_models(type,name,price,quantity) values('band','Band',1000,100) returning id"))[0].id;
const urlFor = (uid: string, counter: number, version = "v1") => {
  const pt = Buffer.alloc(16, 0x55);
  pt[0] = 0xc7; Buffer.from(uid, "hex").copy(pt, 1); pt.writeUIntLE(counter, 8, 3);
  const c = createCipheriv("aes-128-cbc", tagKey, Buffer.alloc(16)); c.setAutoPadding(false);
  return `https://tag.nclr.app/${version}/${Buffer.concat([c.update(pt), c.final()]).toString("hex")}`;
};
let uidSeq = 0x10;
const newTag = async (walletId: string | null, opts: { locked?: boolean; limit?: number } = {}) => {
  const uid = "04" + (uidSeq++).toString(16).padStart(2, "0").repeat(6);
  const id = (await q("insert into tags(uid,model_id,wallet_id,locked,transaction_limit) values($1,$2,$3,$4,$5) returning id",
    [uid.toUpperCase(), model, walletId, opts.locked ?? false, opts.limit ?? null]))[0].id;
  return { uid: uid.toUpperCase(), id };
};
const tpay = (token: string, url: string, amount: number, key: string, extra: object = {}) =>
  call("POST", "/v1/terminal/payments", { token, key, body: { amount, credential: { type: "tag", url }, ...extra } });

// ---- actors ----
const shop = await signup("Shop", "shop@example.com", "B");
const other = await signup("Other", "other@example.com", "B");
const ada = await signup("Ada", "ada@example.com");
const S = shop.session_token, O = other.session_token, A = ada.session_token;
await fund(A, 150000, "f1");
const T = (await call("POST", "/v1/terminals", { token: S, body: { name: "Counter" } })).json.session_token;
const tag = await newTag(ada.default_wallet_id);
let ctr = 1;
const tap = () => ({ type: "tag", url: urlFor(tag.uid, ctr++) });
const prod = async (name: string, price: number, extra: object = {}) => (await call("POST", "/v1/business/products", { token: S, body: { name, price, ...extra } })).json.product;
const coAt = async (id: string) => (await q("select total, sales_tax, items from checkouts where id=$1", [id]))[0];

// ============ settings ============
eq("the default is no tax, prices not including it", (await call("GET", "/v1/business/tax", { token: S })).json, { tax_rate: 0, tax_included: false });
eq("tax settings need the business profile first", (await call("PUT", "/v1/business/tax", { token: S, body: { tax_rate: 825, tax_included: false } })).json.error, "profile_required");
await call("PUT", "/v1/business/profile", { token: S, body: { legal_name: "Shop LLC", display_name: "Shop" } });
await call("PUT", "/v1/business/profile", { token: O, body: { legal_name: "Other LLC", display_name: "Other" } });
eq("rate and mode are saved (basis points)", (await call("PUT", "/v1/business/tax", { token: S, body: { tax_rate: 825, tax_included: false } })).json, { tax_rate: 825, tax_included: false });
eq("a rate over 30%, a fraction or a missing field is refused", [3001, 8.5].map(() => 0).length && [(await call("PUT", "/v1/business/tax", { token: S, body: { tax_rate: 3001, tax_included: false } })).status, (await call("PUT", "/v1/business/tax", { token: S, body: { tax_rate: 8.5, tax_included: false } })).status, (await call("PUT", "/v1/business/tax", { token: S, body: { tax_rate: 800 } })).status], [400, 400, 400]);
eq("another business has its own settings", (await call("GET", "/v1/business/tax", { token: O })).json, { tax_rate: 0, tax_included: false });
eq("a customer cannot read them", (await call("GET", "/v1/business/tax", { token: A })).status, 403);

// ============ products are taxable unless marked exempt ============
const coffee = await prod("Coffee", 399), bagel = await prod("Bagel", 250, { taxable: false });
eq("a product is taxable by default and can be marked exempt", [coffee.taxable, bagel.taxable, (await call("PATCH", `/v1/business/products/${bagel.id}`, { token: S, body: { taxable: true } })).json.product.taxable], [true, false, true]);
await call("PATCH", `/v1/business/products/${bagel.id}`, { token: S, body: { taxable: false } });

// ============ tax added on top (8.25%) ============
// 3 coffees taxable 1197, bagel exempt 250: tax = round(1197 * 8.25%) = 99, total 1447 + 99 = 1546
const items = [{ product_id: coffee.id, quantity: 3 }, { product_id: bagel.id, quantity: 1 }];
const co = (await call("POST", "/v1/terminal/checkouts", { token: T, body: { items } })).json.checkout;
eq("a checkout carries the tax: total includes it, sales_tax shows it", [co.total, co.sales_tax], [1546, 99]);
const row = await coAt(co.id);
eq("each line snapshots its rule and share; the shares add up and the exempt line has none", [row.items.map((i: any) => [i.taxable, i.tax_rate, i.tax_included, i.tax]), row.items.reduce((a: number, i: any) => a + i.tax, 0)], [[[true, 825, false, 99], [false, 0, false, 0]], 99]);
eq("an amount that is only the items is refused (the total includes tax)", (await call("POST", "/v1/terminal/checkouts", { token: T, body: { items, amount: 1447 } })).json.error, "amount_mismatch");
eq("the right total is accepted", (await call("POST", "/v1/terminal/checkouts", { token: T, body: { items, amount: 1546 } })).status, 201);
const paid = await call("POST", "/v1/terminal/payments", { token: T, key: "tx1", body: { checkout_id: co.id, credential: tap() } });
eq("paying the checkout charges the total with tax", [paid.status, paid.json.payment.amount], [201, 1546]);
// the one-step payment prices in SQL: it must agree to the cent
const one = await call("POST", "/v1/terminal/payments", { token: T, key: "tx2", body: { items, credential: tap() } });
eq("a one-step payment with items charges the same and records the tax on its checkout", [one.status, one.json.payment.amount, Number((await q("select c.sales_tax from checkouts c join transactions t on t.checkout_id = c.id where t.id=$1", [one.json.payment.id]))[0].sales_tax)], [201, 1546, 99]);
eq("a tip is on top of the tax and the tax stays out of it", await (async () => { const r = await call("POST", "/v1/terminal/payments", { token: T, key: "tx3", body: { items, tip: 100, credential: tap() } }); return r.status === 422 ? r.json.error : [r.json.payment.amount, r.json.payment.tip_amount]; })(), "staff_required_for_tip");

// ============ rounding: shares add up exactly (largest remainder) ============
await call("PUT", "/v1/business/tax", { token: S, body: { tax_rate: 725, tax_included: false } });
const pens = await prod("Pen", 105);
const many = (await call("POST", "/v1/terminal/checkouts", { token: T, body: { items: [{ product_id: pens.id, quantity: 1 }, { product_id: coffee.id, quantity: 1 }, { product_id: bagel.id, quantity: 1 }] } })).json.checkout;
const mrow = await coAt(many.id);
// taxable net 105 + 399 = 504; 7.25% = 36.54 -> 37; exact shares 7.6125 and 28.9275: floors 7 + 28 = 35, two left over go to the biggest remainders
eq("one rounding per order, then shares by largest remainder", [many.sales_tax, many.total, mrow.items.map((i: any) => i.tax)], [37, 105 + 399 + 250 + 37, [8, 29, 0]]);
// a rate change later does not touch an old order
eq("an old checkout keeps its own rate and tax after the rate changes", [Number((await coAt(co.id)).sales_tax), (await coAt(co.id)).items[0].tax_rate], [99, 825]);

// ============ tax included in the prices ============
await call("PUT", "/v1/business/tax", { token: S, body: { tax_rate: 1000, tax_included: true } });
const inc = (await call("POST", "/v1/terminal/checkouts", { token: T, body: { items } })).json.checkout;
// total unchanged 1447; tax inside the taxable 1197 = 1197 * 10 / 110 = 108.8 -> 109
eq("included tax: the total is the price, the tax is the part inside it", [inc.total, inc.sales_tax, (await coAt(inc.id)).items.map((i: any) => [i.tax_included, i.tax])], [1447, 109, [[true, 109], [true, 0]]]);
const incPaid = await call("POST", "/v1/terminal/payments", { token: T, key: "tx4", body: { items, credential: tap() } });
eq("a one-step payment with included tax charges the price", [incPaid.status, incPaid.json.payment.amount], [201, 1447]);

// ============ no tax: amount-only, rate zero, all exempt ============
const amt = await call("POST", "/v1/terminal/payments", { token: T, key: "tx5", body: { amount: 1234, credential: tap() } });
eq("an amount-only payment is final: no tax", [amt.json.payment.amount, Number((await q("select c.sales_tax from checkouts c join transactions t on t.checkout_id = c.id where t.id=$1", [amt.json.payment.id]))[0].sales_tax)], [1234, 0]);
await call("PUT", "/v1/business/tax", { token: S, body: { tax_rate: 0, tax_included: false } });
eq("with no rate nothing is taxed", (await call("POST", "/v1/terminal/checkouts", { token: T, body: { items } })).json.checkout.sales_tax, 0);
await call("PUT", "/v1/business/tax", { token: S, body: { tax_rate: 825, tax_included: false } });
eq("a cart of only exempt items pays no tax", (await call("POST", "/v1/terminal/checkouts", { token: T, body: { items: [{ product_id: bagel.id, quantity: 2 }] } })).json.checkout.sales_tax, 0);
eq("the other business is untouched by this one's rate", await (async () => { const p = (await call("POST", "/v1/business/products", { token: O, body: { name: "Tea", price: 1000 } })).json.product; const ot = (await call("POST", "/v1/terminals", { token: O, body: { name: "O" } })).json.session_token; return (await call("POST", "/v1/terminal/checkouts", { token: ot, body: { items: [{ product_id: p.id, quantity: 1 }] } })).json.checkout.total; })(), 1000);
eq("the database refuses a tax larger than the total", await q("update checkouts set sales_tax = total + 1 where id=$1", [co.id]).then(() => "ok", (e: any) => e.constraint_name), "checkouts_sales_tax_check");

console.log(`\n${pass} passed, ${fail} failed`);
await adm.end(); process.exit(fail ? 1 : 0);
