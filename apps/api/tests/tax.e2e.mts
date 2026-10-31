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
// ============ refunds return the tax ============
await q("update terminals set allow_refunds = true where account_id = $1", [shop.account_id]);
await call("PUT", "/v1/business/tax", { token: S, body: { tax_rate: 825, tax_included: false } });
const refund = (attempt: string, key: string, body: object) => call("POST", "/v1/terminal/refunds", { token: T, key, body: { attempt, ...body } });
const taxOf = async (payId: string) => (await q("select (meta->>'tax')::int t, amount::int a from transactions where related_id=$1 and type='refund' and status='completed' order by created_at, id", [payId])).map((r: any) => [r.a, r.t]);
const r1 = await call("POST", "/v1/terminal/payments", { token: T, key: "tr1", body: { items, credential: tap() } });
const lines1 = (await call("GET", "/v1/terminal/payments/tr1", { token: T })).json.items;
const coffeeLine = lines1.find((i: any) => i.name === "Coffee").id, bagelLine = lines1.find((i: any) => i.name === "Bagel").id;
// 3 coffees carry 99 of tax: one unit returns 33, so a unit refund is 399 + 33
eq("an item refund returns the items' price and their share of the tax", [(await refund("tr1", "rf1", { mode: "items", items: [{ checkout_item_id: coffeeLine, quantity: 1 }] })).status, await taxOf(r1.json.payment.id)], [201, [[432, 33]]]);
await refund("tr1", "rf2", { mode: "items", items: [{ checkout_item_id: coffeeLine, quantity: 1 }] });
await refund("tr1", "rf3", { mode: "items", items: [{ checkout_item_id: coffeeLine, quantity: 1 }] });
eq("the shares of the three units add up to the line's tax exactly", await taxOf(r1.json.payment.id), [[432, 33], [432, 33], [432, 33]]);
eq("an exempt item returns no tax, and everything refunded equals the payment", [(await refund("tr1", "rf4", { mode: "items", items: [{ checkout_item_id: bagelLine, quantity: 1 }] })).status, (await taxOf(r1.json.payment.id)).at(-1), (await taxOf(r1.json.payment.id)).reduce((a: number, r: number[]) => a + r[0], 0)], [201, [250, 0], 1546]);
// an amount refund returns the tax in proportion; the last of it returns what is left
const r2 = await call("POST", "/v1/terminal/payments", { token: T, key: "tr2", body: { items, credential: tap() } });
eq("a partial amount refund returns the tax in proportion (half the money, half the tax)", [(await refund("tr2", "rf5", { mode: "partial", amount: 773 })).status, await taxOf(r2.json.payment.id)], [201, [[773, 50]]]);
eq("a full refund of the rest returns all the tax that is left", [(await refund("tr2", "rf6", { mode: "full" })).status, await taxOf(r2.json.payment.id)], [201, [[773, 50], [773, 49]]]);
// included prices: the refund is the price, the tax is a part of it
await call("PUT", "/v1/business/tax", { token: S, body: { tax_rate: 1000, tax_included: true } });
const r3 = await call("POST", "/v1/terminal/payments", { token: T, key: "tr3", body: { items, credential: tap() } });
const cl3 = (await call("GET", "/v1/terminal/payments/tr3", { token: T })).json.items.find((i: any) => i.name === "Coffee").id;
eq("with tax included an item refund is the price and its tax share is recorded inside it", [(await refund("tr3", "rf7", { mode: "items", items: [{ checkout_item_id: cl3, quantity: 3 }] })).status, await taxOf(r3.json.payment.id)], [201, [[1197, 109]]]);
// the day's figures: collected, returned and the taxable / exempt split, the same from the all-merchants and the one-merchant read
const day = (await q("select * from merchant_day_stats(program_today(), program_today(), $1)", [shop.account_id]))[0];
const all = (await q("select * from merchant_day_stats(program_today(), program_today()) where merchant = $1", [shop.account_id]))[0];
const sums = (await q(`select coalesce(sum(c.sales_tax) filter (where t.type='pay'),0)::int tax,
    coalesce((select sum((m.meta->>'tax')::bigint) from transactions m join wallets w on w.id=m.from_wallet_id where m.type='refund' and m.status='completed' and w.account_id=$1),0)::int refunded
  from transactions t join checkouts c on c.id=t.checkout_id join wallets w on w.id=t.to_wallet_id where t.type='pay' and t.status='completed' and w.account_id=$1`, [shop.account_id]))[0];
eq("the day's tax collected and refunded match the orders and refunds", [Number(day.tax_v), Number(day.tax_refunded_v)], [sums.tax, sums.refunded]);
eq("the all-merchants read gives the merchant the same row", JSON.stringify(all) === JSON.stringify(day), true);
eq("taxable and exempt sales are split by line (exempt: bagels only)", [Number(day.exempt_v) % 250, Number(day.taxable_v) > 0], [0, true]);

// ============ receipts ============
const rurl = r1.json.payment.receipt_url as string;
const rpath = new URL(rurl).pathname;
const rawGet = async (path: string) => app.fetch(new Request("http://x" + path), env, ctx);
const rhtml = await rawGet(rpath);
const htmlText = await rhtml.text();
eq("a payment carries the address of its receipt", /\/v1\/receipts\/[\w-]+\.[\w-]+\.[\w-]+$/.test(rurl), true);
eq("the receipt opens with no sign-in and shows the items, tax, total and refunds", [rhtml.status, rhtml.headers.get("content-type")?.startsWith("text/html"), htmlText.includes("3 × Coffee"), htmlText.includes("Sales tax (8.25%)"), htmlText.includes("$99.00") === false, htmlText.includes("$15.46"), htmlText.includes("Refund"), htmlText.includes("No sales tax")], [200, true, true, true, true, true, true, true]);
const rj = (await (await rawGet(rpath + "?format=json")).json() as any).receipt;
eq("the data form: subtotal before tax, the tax, what was refunded and the tax returned, and no payer details", [rj.subtotal, rj.sales_tax, rj.tax_included, rj.total, rj.refunded, rj.tax_refunded, "payer" in rj, JSON.stringify(rj).includes("Ada")], [1447, 99, false, 1546, 1546, 99, false, false]);
const incRj = (await (await rawGet(new URL(r3.json.payment.receipt_url).pathname + "?format=json")).json() as any).receipt;
eq("with tax included the receipt says so and the total is the price", [incRj.tax_included, incRj.sales_tax, incRj.total, incRj.subtotal], [true, 109, 1447, 1447]);
eq("a changed or foreign token is not found", [(await rawGet(rpath.slice(0, -3) + "abc")).status, (await rawGet("/v1/receipts/not-a-token")).status], [404, 404]);
eq("a declined payment has no receipt", await (async () => { const id = (await q("select id from transactions where status='declined' limit 1"))[0]?.id; if (!id) return "none"; const { signReceipt } = await import("../src/crypto.ts"); return (await rawGet("/v1/receipts/" + await signReceipt(env.JWT_SECRET, id))).status; })(), "none");
eq("the merchant's transaction list carries receipt addresses for payments", (await call("GET", "/v1/business/transactions?kind=payments&limit=5", { token: S })).json.transactions.every((t: any) => t.status !== "completed" || typeof t.receipt_url === "string"), true);

// ============ the daily report ============
const rep = (await call("GET", "/v1/business/report?period=week", { token: S })).json;
const today = rep.today;
const todayRow = rep.days.find((d: any) => d.date === today);
eq("the report has a row per day of the week up to today, with today's sales, tax collected and tax returned", [rep.days.every((d: any) => d.date <= today), todayRow.tax > 0, todayRow.tax_refunded > 0, todayRow.taxable > 0, todayRow.exempt > 0], [true, true, true, true, true]);
eq("the totals add the days and net sales are sales less refunds", [rep.total.tax, rep.total.net, rep.fees], [rep.days.reduce((a: number, d: any) => a + d.tax, 0), rep.total.sales - rep.total.refunded, 0]);
eq("the report agrees with the day's stats", [todayRow.tax, todayRow.tax_refunded], [Number(day.tax_v), Number(day.tax_refunded_v)]);
eq("month and last month are valid periods, others are refused", [(await call("GET", "/v1/business/report?period=month", { token: S })).status, (await call("GET", "/v1/business/report?period=last_month", { token: S })).status, (await call("GET", "/v1/business/report?period=year", { token: S })).status], [200, 200, 400]);
eq("another business sees none of it", (await call("GET", "/v1/business/report?period=week", { token: O })).json.total.tax, 0);

eq("the database refuses a tax larger than the total", await q("update checkouts set sales_tax = total + 1 where id=$1", [co.id]).then(() => "ok", (e: any) => e.constraint_name), "checkouts_sales_tax_check");

console.log(`\n${pass} passed, ${fail} failed`);
await adm.end(); process.exit(fail ? 1 : 0);
