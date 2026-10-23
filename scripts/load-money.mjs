#!/usr/bin/env node
// Load test of the money functions (docs/SCHEME-V2.md, phase 5) against a database that already has the v2 schema (use a throwaway branch,
// never nuclear-dev main). It seeds consumers and merchants with SQL, then drives `app_pay_app` and `app_send` over many persistent connections
// and reports throughput and latency. One merchant can take a chosen share of the traffic to find the hot-row ceiling.
//
//   LOAD_DB_URL=postgres://... node scripts/load-money.mjs [--seed] [--seconds 30] [--workers 100] [--hot 0.2] [--sends 0.1] [--consumers 3000] [--merchants 30]
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i < 0 ? d : (typeof d === "boolean" ? true : Number(process.argv[i + 1])); };
const URL = process.env.LOAD_DB_URL;
if (!URL) { console.error("set LOAD_DB_URL"); process.exit(2); }
const SECONDS = arg("seconds", 30), WORKERS = arg("workers", 100), HOT = arg("hot", 0.2), SENDS = arg("sends", 0.1);
const CONSUMERS = arg("consumers", 3000), MERCHANTS = arg("merchants", 30);
const sql = postgres(URL.split("?")[0], { ssl: "require", max: WORKERS + 4, prepare: false, idle_timeout: 20, connect_timeout: 30, onnotice: () => {} });

if (process.argv.includes("--seed")) {
  console.log(`seeding ${CONSUMERS} consumers and ${MERCHANTS} merchants...`);
  await sql.unsafe(`
    insert into accounts (type, name, email, status) select 'C', 'L' || g, 'l' || g || '@load.test', 'active' from generate_series(1, ${CONSUMERS}) g;
    insert into accounts (type, name, email, status) select 'B', 'M' || g, 'm' || g || '@load.test', 'active' from generate_series(1, ${MERCHANTS}) g;
    insert into balances (account_id, balance) select id, case when type = 'C' then 100000000 else 0 end from accounts where email like '%@load.test';
    insert into wallets (account_id, display_name, type) select id, name, 'default' from accounts where email like '%@load.test';
    insert into terminals (account_id, name) select id, 'T' from accounts where email like '%@load.test' and type = 'B';
  `);
}

const consumers = await sql`select a.id as account, w.id as wallet from accounts a join wallets w on w.account_id = a.id and w.type = 'default' where a.email like 'l%@load.test' and a.type = 'C'`;
const merchants = await sql`select a.id as account, t.id as terminal from accounts a join terminals t on t.account_id = a.id where a.type = 'B' and a.email like 'm%@load.test' order by a.email`;
console.log(`${consumers.length} consumers, ${merchants.length} merchants, hot merchant share ${HOT}, sends ${SENDS}, ${WORKERS} connections, ${SECONDS}s`);
const hot = merchants[0], rest = merchants.slice(1);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const run = Date.now().toString(36);
let n = 0;
const lat = [], errs = {};
let ok = 0, declined = 0, done = 0, hotCount = 0;
const end = Date.now() + SECONDS * 1000;

async function worker() {
  while (Date.now() < end) {
    const payer = pick(consumers);
    const key = `${run}-${n++}`;
    const t0 = performance.now();
    try {
      let r;
      if (Math.random() < SENDS) {
        let to = pick(consumers); while (to.account === payer.account) to = pick(consumers);
        r = (await sql`select app_send(${sql.json({ actor: payer.account, to_wallet: to.wallet, amount: 100 + Math.floor(Math.random() * 400), key, cap: 1000000000 })}) as r`)[0].r;
      } else {
        const m = Math.random() < HOT ? hot : pick(rest);
        if (m === hot) hotCount++;
        r = (await sql`select app_pay_app(${sql.json({ payer_account: payer.account, terminal_id: m.terminal, amount: 100 + Math.floor(Math.random() * 4900), key })}) as r`)[0].r;
      }
      lat.push(performance.now() - t0);
      r.kind === "ok" ? ok++ : declined++;
    } catch (e) {
      const k = e.code ?? e.message.slice(0, 40);
      errs[k] = (errs[k] ?? 0) + 1;
    }
    done++;
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: WORKERS }, worker));
const secs = (Date.now() - t0) / 1000;
lat.sort((a, b) => a - b);
const q = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))]?.toFixed(1);
console.log(`calls ${done} in ${secs.toFixed(1)}s = ${(done / secs).toFixed(0)}/s | ok ${ok} declined ${declined} errors ${JSON.stringify(errs)} | hot-merchant calls ${hotCount} (${(hotCount / secs).toFixed(0)}/s)`);
console.log(`latency ms: p50 ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)} max ${lat[lat.length - 1]?.toFixed(1)}`);
await sql.end();
