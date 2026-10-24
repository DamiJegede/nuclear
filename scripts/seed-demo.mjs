#!/usr/bin/env node
// Fills the DEV database with demo data through the public API, so every transaction, limit and balance
// is made by the real business logic: consumers and merchants, loads, sends (including agent wallets),
// in-app and tapped payments, refunds (done and awaiting approval), store purchases and declines.
// Afterwards the dashboard's books should still reconcile.
//
//   node scripts/seed-demo.mjs [--users 1000] [--merchants 25] [--no-backdate]
//
// Reads ADMIN_API_TOKEN and TAG_KEY_V1 from apps/api/.dev.vars (never printed). API_URL overrides the target.
// Demo accounts use @seed.nuclear.test emails and the password below; re-running adds more, not duplicates.
import { createCipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf("--" + name); return i < 0 ? dflt : args[i + 1] ?? true; };
const N_USERS = Number(flag("users", 1000));
const N_MERCHANTS = Number(flag("merchants", 25));
const BACKDATE = !args.includes("--no-backdate");
const RUN = flag("run", Date.now().toString(36));          // makes emails unique per run
const API = (process.env.API_URL ?? "https://nuclear-api.a-space.workers.dev").replace(/\/$/, "");
const PASSWORD = "Seed-demo-password-1";

const vars = Object.fromEntries(
  readFileSync(fileURLToPath(new URL("../apps/api/.dev.vars", import.meta.url)), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const OP = vars.ADMIN_API_TOKEN;
const TAG_KEY = Buffer.from(vars.TAG_KEY_V1 ?? "", "hex");
if (!OP || TAG_KEY.length !== 16) { console.error("ADMIN_API_TOKEN and TAG_KEY_V1 are needed in apps/api/.dev.vars"); process.exit(1); }

// ---- helpers --------------------------------------------------------------------------------------
let seed = 0x9e3779b9 ^ [...RUN].reduce((a, c) => a * 31 + c.charCodeAt(0), 7);
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const sample = (a, n) => { const b = [...a]; const out = []; while (out.length < n && b.length) out.push(b.splice(Math.floor(rnd() * b.length), 1)[0]); return out; };

async function call(method, path, { token, key, body } = {}, tries = 4) {
  for (let t = 1; ; t++) {
    try {
      const res = await fetch(API + path, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { "idempotency-key": key } : {}), "x-operator-token": OP },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (res.status >= 500 && t < tries) { await sleep(300 * t); continue; }
      return { status: res.status, json };
    } catch (e) {
      if (t >= tries) throw e;
      await sleep(300 * t);
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; results[i] = await fn(items[i], i); done++; }
  }));
  return results;
}
const step = (s) => console.log(`\n== ${s}`);
const tally = {};
const count = (k) => { tally[k] = (tally[k] ?? 0) + 1; };

const tagUrl = (uid, counter) => {
  const pt = Buffer.alloc(16, 0x55);
  pt[0] = 0xc7; Buffer.from(uid, "hex").copy(pt, 1); pt.writeUIntLE(counter, 8, 3);
  const c = createCipheriv("aes-128-cbc", TAG_KEY, Buffer.alloc(16)); c.setAutoPadding(false);
  return `https://tag.nclr.app/v1/${Buffer.concat([c.update(pt), c.final()]).toString("hex")}`;
};

const FIRST = "Ada Ben Cleo Dev Eli Fay Gus Hana Ivan Jade Kai Lena Milo Nina Omar Pia Quin Rosa Sam Tess Uma Vik Wes Xena Yuri Zoe Amir Bea Cal Dana Eddie Flor Gabe Hope Ines Jonah Kira Leo Maya Noel Opal Pablo Rhea Seth Tara Uri Vera Wade Yara Zane".split(" ");
const LAST = "Adams Brooks Chen Diaz Evans Fox Garcia Hughes Ito Jones Khan Lopez Moore Nguyen Okafor Patel Quinn Rossi Silva Tanaka Usman Vega Walsh Xu Young Zhou Baker Costa Dunn Egan Frost Grant Hale Irwin Joshi Kerr Lowe Mack Nash Ortiz Price Reyes Stone Voss Webb".split(" ");
const SHOPS = "Corner Cafe|Blue Door Bakery|Sunrise Diner|Maple Books|Harbor Pizza|Green Leaf Market|Night Owl Records|Copper Kettle|Fresh Press Juice|Iron Gym|Pixel Arcade|Tidal Sushi|Urban Threads|Velvet Cinema|Wild Rose Florist|Quick Cuts|Atlas Hardware|Bright Smile Dental Cafe|Cedar Grill|Dot Coffee|Echo Vinyl|Fable Toys|Gold Crust|Hive Honey|Jolly Tacos".split("|");
const STREETS = ["Oak St", "Pine Ave", "Maple Rd", "Cedar Ln", "Elm Dr"];

// ---- 1. tag models and inventory ------------------------------------------------------------------
step("tag models");
const mkModel = async (name, type, price, quantity) => {
  const r = await call("POST", "/v1/admin/tag-models", { token: OP, body: { type, name: `${name} (${RUN})`, price, quantity, status: "available" } });
  if (r.status !== 201) throw new Error("model: " + JSON.stringify(r.json));
  return r.json.model;
};
const bandModel = await mkModel("Demo Band", "band", 2999, 3000);
const cardModel = await mkModel("Demo Card", "card", 1499, 2000);
const uidSet = new Set();
const newUid = () => { for (;;) { const u = "04" + randomBytes(6).toString("hex").toUpperCase(); if (!uidSet.has(u)) { uidSet.add(u); return u; } } };
const bandUids = Array.from({ length: Math.round(N_USERS * 0.2) }, newUid);
const cardUids = Array.from({ length: Math.round(N_USERS * 0.06) }, newUid);
for (const [m, uids] of [[bandModel, bandUids], [cardModel, cardUids]]) {
  const r = await call("POST", `/v1/admin/tag-models/${m.id}/tags`, { token: OP, body: { uids } });
  console.log(`${m.name}: ${r.json?.inserted ?? "?"} tags loaded`);
}

// ---- 2. merchants and terminals ---------------------------------------------------------------------
step(`merchants (${N_MERCHANTS})`);
const terminals = [];
await pool(Array.from({ length: N_MERCHANTS }, (_, i) => i), 6, async (i) => {
  const name = `${SHOPS[i % SHOPS.length]}${i >= SHOPS.length ? " " + (Math.floor(i / SHOPS.length) + 1) : ""}`;
  const r = await call("POST", "/v1/auth/signup", { body: { type: "B", name, email: `shop${i}.${RUN}@seed.nuclear.test`, password: PASSWORD } });
  if (r.status !== 201) { console.log("merchant failed", r.status, r.json?.error); return; }
  const owner = r.json.session_token;
  await call("POST", `/v1/admin/merchants/${r.json.account_id}/approve`, { token: OP });   // new businesses start pending
  const nTerm = int(1, 3);
  for (let t = 0; t < nTerm; t++) {
    const approval = (i + t) % 5 === 4;                    // about one terminal in five needs approval for refunds
    const tr = await call("POST", "/v1/terminals", { token: owner, body: { name: `${name} ${t === 0 ? "Counter" : "Register " + (t + 1)}`, allow_refunds: !approval } });
    if (tr.status === 201) terminals.push({ id: tr.json.terminal.id, token: tr.json.session_token, merchant: name, approval });
  }
});
console.log(`${terminals.length} terminals (${terminals.filter((t) => t.approval).length} need refund approval)`);

// ---- 3. consumers ------------------------------------------------------------------------------------
step(`consumers (${N_USERS})`);
const users = [];
await pool(Array.from({ length: N_USERS }, (_, i) => i), 10, async (i) => {
  const first = pick(FIRST), last = pick(LAST);
  const r = await call("POST", "/v1/auth/signup", { body: { type: "C", name: `${first} ${last}`, email: `${first}.${last}.${i}.${RUN}@seed.nuclear.test`.toLowerCase(), password: PASSWORD } });
  if (r.status !== 201) { count("signup_failed"); return; }
  users.push({ i, name: `${first} ${last}`, token: r.json.session_token, account: r.json.account_id, wallet: r.json.default_wallet_id, balance: 0, tags: [] });
  if (users.length % 250 === 0) console.log(`  ${users.length}`);
});
users.sort((a, b) => a.i - b.i);
console.log(`${users.length} consumers`);

// handles for about a third
await pool(sample(users, Math.round(users.length * 0.33)), 10, async (u) => {
  const h = (u.name.replace(/[^A-Za-z]/g, "").slice(0, 6) + u.i).toLowerCase().slice(0, 12);
  const r = await call("PUT", "/v1/account/handle", { token: u.token, body: { handle: h } });
  count(r.status === 200 ? "handles" : "handle_failed");
});

// ---- 4. loads --------------------------------------------------------------------------------------------
step("loads");
const funded = sample(users, Math.round(users.length * 0.62));
let fundingNo = 0;
await pool(funded, 10, async (u) => {
  const times = rnd() < 0.25 ? 2 : 1;
  for (let k = 0; k < times; k++) {
    const amount = pick([2000, 2500, 5000, 5000, 7500, 10000, 10000, 15000, 25000, 40000, 60000]);
    const r = await call("POST", "/v1/sandbox/fundings", { token: u.token, key: `seed-${RUN}-fund-${u.i}-${k}`, body: { amount } });
    if (r.status === 201 || r.status === 200) { u.balance += amount; count("fund_ok"); fundingNo++; } else count("fund_failed:" + r.status);
  }
});
console.log(`${fundingNo} loads`);
const withMoney = users.filter((u) => u.balance > 0);

// ---- 5. agent wallets --------------------------------------------------------------------------------------
step("agent wallets");
const agents = [];
await pool(sample(withMoney.filter((u) => u.balance >= 5000), 70), 8, async (u) => {
  const budget = Math.min(u.balance - 1000, pick([1000, 2000, 5000, 10000]));
  const r = await call("POST", "/v1/wallets", { token: u.token, body: { display_name: `${u.name.split(" ")[0]}'s Agent`, type: "agent", allow_send: true, balance: budget } });
  if (r.status === 201) { agents.push({ owner: u, wallet: r.json.wallet.id, budget }); count("agent_wallets"); } else count("agent_failed:" + r.status);
});
console.log(`${agents.length} agent wallets`);

// ---- 6. tags: claim ----------------------------------------------------------------------------------------
step("tags claimed by customers");
const claimers = sample(withMoney, bandUids.length + cardUids.length - 10);
const allUids = [...bandUids, ...cardUids];
const tagCounters = new Map();
await pool(claimers, 8, async (u, idx) => {
  const uid = allUids[idx];
  const r = await call("POST", "/v1/tags/claim", { token: u.token, body: { url: tagUrl(uid, 1), label: "Everyday" } });
  if (r.status === 201 || r.status === 200) { u.tags.push(uid); tagCounters.set(uid, 1); count("tags_claimed"); } else count("claim_failed:" + r.status);
});

// ---- 7. sends ---------------------------------------------------------------------------------------------
step("sends");
const walletOf = new Map(users.map((u) => [u.account, u.wallet]));
const sends = [];
for (let n = 0; n < 330; n++) {
  const from = rnd() < 0.82 ? pick(withMoney) : pick(users);          // a few come from people with no money: declines
  let to = pick(users); while (to.account === from.account) to = pick(users);
  const viaAgent = rnd() < 0.18 ? agents.find((a) => a.owner.account === from.account) : null;
  sends.push({ n, from, to, viaAgent, amount: int(1, 60) * 100 + pick([0, 0, 0, 50, 99]) });
}
await pool(sends, 10, async (s) => {
  const r = await call("POST", "/v1/transfers", { token: s.from.token, key: `seed-${RUN}-send-${s.n}`, body: { from_wallet_id: s.viaAgent ? s.viaAgent.wallet : s.from.wallet, to_wallet_id: s.to.wallet, amount: s.amount } });
  count(r.status === 201 ? "send_ok" : r.status === 422 ? "send_declined:" + r.json?.status_code : "send_error:" + r.status);
});

// ---- 8. payments: in-app ----------------------------------------------------------------------------------
step("in-app payments");
const payments = [];
const pays = [];
for (let n = 0; n < 230; n++) pays.push({ n, u: rnd() < 0.9 ? pick(withMoney) : pick(users), t: pick(terminals), amount: int(2, 90) * 100 + pick([0, 0, 50, 75, 99]) });
for (let n = 0; n < 12; n++) pays.push({ n: 1000 + n, u: pick(withMoney), t: pick(terminals), amount: int(900, 5000) * 100 });   // too big: declines
await pool(pays, 10, async (p) => {
  const r = await call("POST", "/v1/payments", { token: p.u.token, key: `seed-${RUN}-pay-${p.n}`, body: { amount: p.amount, terminal_id: p.t.id, reference: `ORD-${RUN}-${p.n}` } });
  if (r.status === 201) { count("pay_ok"); payments.push({ id: r.json.payment.id, amount: p.amount, t: p.t }); }
  else count(r.status === 422 ? "pay_declined:" + r.json?.status_code : "pay_error:" + r.status);
});

// ---- 9. payments: taps --------------------------------------------------------------------------------------
step("tapped payments");
const tapUsers = users.filter((u) => u.tags.length > 0);
const taps = [];
for (let n = 0; n < 140; n++) taps.push({ n, u: pick(tapUsers), t: pick(terminals), amount: int(2, 45) * 100 + pick([0, 0, 50, 99]) });
// a tag's counter must keep rising, so each tag's taps are made in order
const byTag = new Map();
for (const tp of taps) { const uid = tp.u.tags[0]; (byTag.get(uid) ?? byTag.set(uid, []).get(uid)).push(tp); }
await pool([...byTag.entries()], 10, async ([uid, list]) => {
  for (const tp of list) {
    const c = tagCounters.get(uid) + 1; tagCounters.set(uid, c);
    const r = await call("POST", "/v1/terminal/payments", { token: tp.t.token, key: `seed-${RUN}-tap-${tp.n}`, body: { amount: tp.amount, reference: `TAP-${RUN}-${tp.n}`, credential: { type: "tag", url: tagUrl(uid, c) } } });
    if (r.status === 201) { count("tap_ok"); payments.push({ id: r.json.payment.id, amount: tp.amount, t: tp.t }); }
    else count(r.status === 422 ? "tap_declined:" + r.json?.status_code : "tap_error:" + r.status + ":" + (r.json?.error ?? ""));
  }
});

// ---- 10. refunds ------------------------------------------------------------------------------------------
step("refunds");
const refundable = sample(payments, 45);
await pool(refundable, 8, async (p, i) => {
  const partial = rnd() < 0.4 && p.amount >= 400;
  const body = partial ? { payment_id: p.id, mode: "partial", amount: Math.floor(p.amount / 2 / 100) * 100 || 100 } : { payment_id: p.id, mode: "full" };
  const r = await call("POST", "/v1/terminal/refunds", { token: p.t.token, key: `seed-${RUN}-refund-${i}`, body });
  count(r.status === 201 ? "refund_done" : r.status === 202 ? "refund_awaiting_approval" : "refund_other:" + r.status + ":" + (r.json?.error ?? r.json?.status_code ?? ""));
});

// ---- 11. store purchases -----------------------------------------------------------------------------------
step("store purchases");
const buyers = [...sample(withMoney.filter((u) => u.balance >= 6000), 26), ...sample(users.filter((u) => u.balance === 0), 4)];
await pool(buyers, 6, async (u, i) => {
  const model = i % 4 === 3 ? cardModel : bandModel;
  const r = await call("POST", "/v1/shop/orders", { token: u.token, key: `seed-${RUN}-order-${i}`, body: {
    model_id: model.id, quantity: int(1, 2),
    shipping: { name: u.name, line1: `${int(10, 990)} ${pick(STREETS)}`, city: "Springfield", region: "NY", postal_code: String(int(10000, 99999)), country: "US" },
  } });
  count(r.status === 201 ? "order_ok" : r.status === 422 ? "order_declined:" + r.json?.status_code : "order_error:" + r.status);
});

// ---- 12. spread the dates --------------------------------------------------------------------------------
if (BACKDATE) {
  step("spreading dates over the last 30 days (so today and lifetime differ)");
  // Which rows belong to this run: accounts whose email ends in ".<run>@seed.nuclear.test". About 8% of the
  // consumers stay "new today" (and so do their transactions); loads go 15-30 days back, everything else 0-15.
  const sqlFile = `
-- transactions are immutable; this one-off script (demo data only) lifts the trigger while it moves rows into the past
alter table transactions disable trigger transactions_no_update;
create temp table _mine as select id from accounts where email like '%.${RUN}@seed.nuclear.test';
create temp table _fresh as select id from accounts where type = 'C' and id in (select id from _mine) and random() < 0.08;
create temp table _shift as
  select x.id, x.type, case when x.type = 'fund' then now() - interval '30 days' * (0.5 + random() * 0.5)
                            else now() - interval '15 days' * power(random(), 1.7) end as ts
    from transactions x join wallets fw on fw.id = x.from_wallet_id join wallets tw on tw.id = x.to_wallet_id
   where (fw.account_id in (select id from _mine) or tw.account_id in (select id from _mine))
     and not (fw.account_id in (select id from _fresh) or tw.account_id in (select id from _fresh));
update transactions x set created_at = s.ts from _shift s where x.id = s.id and x.type <> 'refund';
update transactions r set created_at = least(now(), o.created_at + random() * interval '36 hours')
  from transactions o where r.related_id = o.id and r.type = 'refund' and r.id in (select id from _shift);
update refunds q set created_at = least(now(), o.created_at + random() * interval '36 hours') from transactions o where q.pay_transaction_id = o.id and q.merchant_account_id in (select id from _mine);
update accounts a set created_at = least(a.created_at, coalesce((select min(x.created_at) from transactions x join wallets w on w.id in (x.from_wallet_id, x.to_wallet_id) where w.account_id = a.id), a.created_at) - random() * interval '3 days')
  where a.id in (select id from _mine) and a.id not in (select id from _fresh);
-- what moved into the past no longer counts toward today: the daily counters of those accounts start the day clean
update wallets set spent_day = spent_day - 1 where account_id in (select id from _mine) and account_id not in (select id from _fresh);
update balances set opening_day = opening_day - 1 where account_id in (select id from _mine) and account_id not in (select id from _fresh);
update products set sold_day = sold_day - 1 where account_id in (select id from _mine);
alter table transactions enable trigger transactions_no_update;
`;
  try {
    if (process.env.SEED_PSQL_URL) {                       // a local test database
      execFileSync("psql", [process.env.SEED_PSQL_URL, "-v", "ON_ERROR_STOP=1", "-q", "-c", sqlFile], { encoding: "utf8" });
      console.log("dates spread (local)");
    } else {
      const out = execFileSync("pscale", ["sql", "nuclear-dev", "main", "--org", "nuclear", "--role", "admin", "--force", "--format", "json", "--query", sqlFile], { encoding: "utf8" });
      console.log(JSON.parse(out).status === "ok" ? "dates spread" : out);
    }
  } catch (e) {
    console.log("could not spread dates (needs pscale logged in):", String(e.message).split("\n")[0]);
  }
}

// ---- report -------------------------------------------------------------------------------------------------
step("done");
console.log(Object.entries(tally).sort().map(([k, v]) => `${k}: ${v}`).join("\n"));
// The Overview reads cached snapshots: recompute both now so the report is current.
await call("POST", "/v1/admin/stats/refresh", { token: OP });
await call("POST", "/v1/admin/stats/reconcile", { token: OP });
const stats = await call("GET", "/v1/admin/stats", { token: OP });
if (stats.status === 200) {
  const s = stats.json;
  console.log(`\ndashboard: balance $${(s.scheme.balance / 100).toFixed(2)}, users ${s.users.total}, wallets ${s.users.wallets}, merchants ${s.merchants.total}`);
  console.log("reconciliation:", JSON.stringify(s.reconciliation));
}
