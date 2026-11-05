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
const offer = async (body: object, token = S) => call("POST", "/v1/business/offers", { token, body });
const mk = async (items: { product_id: string; quantity: number }[]) => (await call("POST", "/v1/terminal/checkouts", { token: T, body: { items } })).json.checkout;
const lines = (co: any) => co.items.map((i: any) => [i.name, i.quantity, i.net_price, i.offer?.percent_off ?? null]);


await call("PUT", "/v1/business/profile", { token: S, body: { legal_name: "Shop LLC", display_name: "Shop" } });
await call("PUT", "/v1/business/profile", { token: O, body: { legal_name: "Other LLC", display_name: "Other" } });
const beer = await prod("Beer", 900), wine = await prod("Wine", 1400), burrata = await prod("Burrata", 1500), salmon = await prod("Salmon", 2900), cake = await prod("Cake", 999), lamp = await prod("Lamp", 1000, { discount: 200 });
const theirs = (await call("POST", "/v1/business/products", { token: O, body: { name: "Theirs", price: 500 } })).json.product;

// ============ managing offers ============
const bogo = (await offer({ buy_product_id: beer.id, buy_qty: 1, get_qty: 1, percent_off: 100 })).json.offer;
eq("an offer for the same product: named for itself, stored as the same product", [bogo.name, bogo.description, bogo.same_product, bogo.get_product_id === beer.id, bogo.active], ["Buy Beer, get 1 free", "Buy Beer, get 1 free", true, true, true]);
const half = (await offer({ buy_product_id: wine.id, buy_qty: 2, get_qty: 1, percent_off: 50 })).json.offer;
eq("buy 2 get 1 half price reads in words", half.description, "Buy 2 × Wine, get 1 50% off");
const cross = (await offer({ buy_product_id: burrata.id, buy_qty: 1, get_product_id: salmon.id, get_qty: 1, percent_off: 50, name: "Starter and a main" })).json.offer;
eq("another product can be given, with the merchant's own name", [cross.name, cross.description, cross.same_product], ["Starter and a main", "Buy Burrata, get Salmon 50% off", false]);
eq("a product that is not theirs is 404, in the buy or the get", [(await offer({ buy_product_id: theirs.id, buy_qty: 1, get_qty: 1, percent_off: 100 })).status, (await offer({ buy_product_id: beer.id, buy_qty: 1, get_product_id: theirs.id, get_qty: 1, percent_off: 100 })).status], [404, 404]);
eq("quantities 1-20 and a percent 1-100 are enforced", await Promise.all([[0, 1, 100], [21, 1, 100], [1, 0, 100], [1, 1, 0], [1, 1, 101]].map(async ([b, g, p]) => (await offer({ buy_product_id: beer.id, buy_qty: b, get_qty: g, percent_off: p })).status)), [400, 400, 400, 400, 400]);
eq("the list shows the merchant's own offers only", [(await call("GET", "/v1/business/offers", { token: S })).json.offers.length, (await call("GET", "/v1/business/offers", { token: O })).json.offers.length], [3, 0]);
eq("a customer cannot manage offers", (await call("GET", "/v1/business/offers", { token: A })).status, 403);
eq("another business cannot change or delete an offer", [(await call("PATCH", `/v1/business/offers/${bogo.id}`, { token: O, body: { active: false } })).status, (await call("DELETE", `/v1/business/offers/${bogo.id}`, { token: O })).status], [404, 404]);

// ============ buy one get one free ============
const b2 = await mk([{ product_id: beer.id, quantity: 2 }]);
eq("two beers on a buy-one-get-one: one is paid, one is free; the lines keep the offer", [b2.total, lines(b2)], [900, [["Beer", 1, 900, null], ["Beer", 1, 0, 100]]]);
const b3 = await mk([{ product_id: beer.id, quantity: 3 }]);
eq("three beers: one set, the third is paid", [b3.total, lines(b3)], [1800, [["Beer", 2, 900, null], ["Beer", 1, 0, 100]]]);
eq("one beer: nothing is free", [(await mk([{ product_id: beer.id, quantity: 1 }])).total], [900]);
eq("four beers: two sets", [(await mk([{ product_id: beer.id, quantity: 4 }])).total], [1800]);
eq("the checkout line snapshot stores the offer's id, name and percent", (await coAt(b2.id)).items.map((i: any) => i.offer ?? null), [null, { id: bogo.id, name: bogo.name, percent_off: 100 }]);

// ============ buy 2 get 1 half price ============
const w3 = await mk([{ product_id: wine.id, quantity: 3 }]);
eq("three wines: the third is half price", [w3.total, lines(w3)], [3500, [["Wine", 2, 1400, null], ["Wine", 1, 700, 50]]]);
eq("two wines: nothing yet; six wines: two halves", [(await mk([{ product_id: wine.id, quantity: 2 }])).total, (await mk([{ product_id: wine.id, quantity: 6 }])).total], [2800, 7000]);

// ============ buy this, get another product ============
const bs = await mk([{ product_id: burrata.id, quantity: 1 }, { product_id: salmon.id, quantity: 1 }]);
eq("a starter and a main: the main is half price", [bs.total, lines(bs)], [2950, [["Burrata", 1, 1500, null], ["Salmon", 1, 1450, 50]]]);
eq("a main alone is full price; two mains and one starter give half off only one", [(await mk([{ product_id: salmon.id, quantity: 1 }])).total, (await mk([{ product_id: burrata.id, quantity: 1 }, { product_id: salmon.id, quantity: 2 }])).total], [2900, 1500 + 2900 + 1450]);

// ============ the better offer wins; a unit is used once ============
const quarter = (await offer({ buy_product_id: beer.id, buy_qty: 1, get_qty: 1, percent_off: 25 })).json.offer;
eq("two offers on beer: the one that saves more is used, the other gets nothing", [(await mk([{ product_id: beer.id, quantity: 2 }])).total], [900]);
await call("PATCH", `/v1/business/offers/${bogo.id}`, { token: S, body: { active: false } });
eq("with the better offer off, the 25% offer applies (the cheaper unit pays 675)", [(await mk([{ product_id: beer.id, quantity: 2 }])).total], [900 + 675]);
await call("PATCH", `/v1/business/offers/${bogo.id}`, { token: S, body: { active: true } });
eq("switched back on, the better one wins again", [(await mk([{ product_id: beer.id, quantity: 2 }])).total], [900]);
await call("DELETE", `/v1/business/offers/${quarter.id}`, { token: S });

// ============ rounding and the product's own discount ============
const slice = (await offer({ buy_product_id: cake.id, buy_qty: 1, get_qty: 1, percent_off: 50 })).json.offer;
const c2 = await mk([{ product_id: cake.id, quantity: 2 }]);
eq("half of 9.99 is rounded down, so the customer pays the 5.00 that is left", [c2.total, lines(c2)], [999 + 500, [["Cake", 1, 999, null], ["Cake", 1, 500, 50]]]);
const lampOffer = (await offer({ buy_product_id: lamp.id, buy_qty: 1, get_qty: 1, percent_off: 100 })).json.offer;
const l2 = await mk([{ product_id: lamp.id, quantity: 2 }]);
eq("the offer works on the price after the product's own discount", [l2.total, lines(l2)], [800, [["Lamp", 1, 800, null], ["Lamp", 1, 0, 100]]]);
await call("DELETE", `/v1/business/offers/${lampOffer.id}`, { token: S });
await call("DELETE", `/v1/business/offers/${slice.id}`, { token: S });

// ============ other products and other merchants are untouched ============
const mixed = await mk([{ product_id: beer.id, quantity: 2 }, { product_id: cake.id, quantity: 1 }]);
eq("an order with other products prices each on its own", mixed.total, 900 + 999);
eq("another merchant's identical product gets no offer", await (async () => {
  const ob = (await call("POST", "/v1/business/products", { token: O, body: { name: "Beer", price: 900 } })).json.product;
  const OT = (await call("POST", "/v1/terminals", { token: O, body: { name: "Counter" } })).json.session_token;
  return (await call("POST", "/v1/terminal/checkouts", { token: OT, body: { items: [{ product_id: ob.id, quantity: 2 }] } })).json.checkout.total;
})(), 1800);

// ============ the terminal and the one-step payment agree ============
eq("the terminal lists the live offers with their words", (await call("GET", "/v1/terminal/offers", { token: T })).json.offers.map((o: any) => o.description), ["Buy Beer, get 1 free", "Buy 2 × Wine, get 1 50% off", "Buy Burrata, get Salmon 50% off"]);
const one = await call("POST", "/v1/terminal/payments", { token: T, key: "o1", body: { items: [{ product_id: beer.id, quantity: 3 }], credential: tap() } });
eq("a one-step payment with items applies the same offers: three beers cost 18.00", [one.status, one.json.payment.amount], [201, 1800]);
const oneCo = (await q("select items from checkouts c join transactions t on t.checkout_id = c.id where t.id = $1", [one.json.payment.id]))[0];
eq("and its checkout records the offer line", oneCo.items.map((i: any) => [i.quantity, i.unit_price - i.discount, i.offer?.percent_off ?? null]), [[2, 900, null], [1, 0, 100]]);
eq("an amount that ignores the offer is refused", (await call("POST", "/v1/terminal/checkouts", { token: T, body: { items: [{ product_id: beer.id, quantity: 2 }], amount: 1800 } })).json.error, "amount_mismatch");
const paidCo = await call("POST", "/v1/terminal/payments", { token: T, key: "o2", body: { checkout_id: b2.id, credential: tap() } });
eq("paying a checkout with an offer charges what it said", [paidCo.status, paidCo.json.payment.amount], [201, 900]);
const rcpt = { json: ((await (await app.fetch(new Request("http://x" + new URL(paidCo.json.payment.receipt_url).pathname + "?format=json"), env, ctx)).json()) as any).receipt };
eq("the receipt names the offer on its line", rcpt.json.items.map((i: any) => [i.quantity, i.line_total, i.offer]), [[1, 900, null], [1, 0, bogo.name]]);

// ============ stock counts every unit, free or not ============
const keg = await prod("Keg", 500, { stock: 5 });
const kegOffer = (await offer({ buy_product_id: keg.id, buy_qty: 1, get_qty: 1, percent_off: 100 })).json.offer;
await call("POST", "/v1/terminal/payments", { token: T, key: "o3", body: { items: [{ product_id: keg.id, quantity: 4 }], credential: tap() } });
eq("four kegs on a buy-one-get-one: paid for two, four leave the shelf", [(await q("select stock, total_sold from products where id=$1", [keg.id]))[0].stock, Number((await q("select total_sold from products where id=$1", [keg.id]))[0].total_sold)], [1, 4]);
eq("an offer cannot sell more than is in stock", (await call("POST", "/v1/terminal/checkouts", { token: T, body: { items: [{ product_id: keg.id, quantity: 2 }] } })).json.error, "out_of_stock");

// ============ sales tax is worked out on what is paid ============
await call("PUT", "/v1/business/tax", { token: S, body: { tax_rate: 825, tax_included: false } });
const tx2 = await mk([{ product_id: beer.id, quantity: 2 }]);
eq("two beers with the free one: tax is 8.25% of the 9.00 paid (74), the free line carries none", [tx2.total, tx2.sales_tax, (await coAt(tx2.id)).items.map((i: any) => i.tax)], [974, 74, [74, 0]]);
const tx1 = await call("POST", "/v1/terminal/payments", { token: T, key: "o4", body: { items: [{ product_id: beer.id, quantity: 2 }], credential: tap() } });
eq("the one-step payment agrees to the cent", tx1.json.payment.amount, 974);
await call("PUT", "/v1/business/tax", { token: S, body: { tax_rate: 0, tax_included: false } });

// ============ the menu and deleting a product ============
const table = (await call("POST", "/v1/business/tables", { token: S, body: { name: "T1" } })).json.table;
const menu = await call("GET", `/v1/menu/${table.code}`);
eq("the public menu shows the live offers", menu.json.offers.map((o: any) => o.name), [bogo.name, half.name, "Starter and a main", kegOffer.name]);
await call("PATCH", `/v1/business/offers/${half.id}`, { token: S, body: { active: false } });
eq("an offer that is switched off is not on the menu", (await call("GET", `/v1/menu/${table.code}`)).json.offers.map((o: any) => o.name), [bogo.name, "Starter and a main", kegOffer.name]);
const spare = await prod("Spare", 300), spareOffer = (await offer({ buy_product_id: spare.id, buy_qty: 1, get_qty: 1, percent_off: 100 })).json.offer;
eq("a product sold before cannot be deleted, so its offers stay", (await call("DELETE", `/v1/business/products/${keg.id}`, { token: S })).status, 409);
eq("an offer goes with a product that is deleted", [(await call("DELETE", `/v1/business/products/${spare.id}`, { token: S })).status, Number((await q("select count(*)::int as n from offers where id=$1", [spareOffer.id]))[0].n)], [204, 0]);
eq("a changed offer re-words an automatic name and keeps a custom one", await (async () => {
  const a = (await call("PATCH", `/v1/business/offers/${bogo.id}`, { token: S, body: { percent_off: 50 } })).json.offer.name;
  const b = (await call("PATCH", `/v1/business/offers/${cross.id}`, { token: S, body: { percent_off: 100 } })).json.offer.name;
  return [a, b];
})(), ["Buy Beer, get 1 50% off", "Starter and a main"]);

console.log(`\n${pass} passed, ${fail} failed`);
await adm.end(); process.exit(fail ? 1 : 0);
