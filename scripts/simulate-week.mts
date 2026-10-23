// One simulated stretch of load on a THROWAWAY Postgres (a local one, or a temporary PlanetScale branch with SIM_ALLOW_REMOTE=1; never nuclear-dev main): thousands of users, ~10 transactions per second of every kind, and the
// nightly job (snapshot + conservation check, settlement, the Fixed Benefits schedule) run for each simulated night.
//
//   SIM_DB_URL=postgres://postgres@127.0.0.1:54341/sim npx tsx scripts/simulate-week.mts [--days 7] [--tps 10] [--users 10000] [--merchants 100] [--workers 24] [--tamper-day 0]
//
// Each simulated day's rows are generated as fast as the database allows (money calls go straight to the SQL functions, loads, benefit runs and
// claims through the API's own code), then stamped into that day (the transactions trigger is lifted for the stamping only), the daily counters
// are moved a day on, and `dailyJobs` runs at 00:01 New York time of the next day. A balance tamper (--tamper-day N) shows the check catching it.
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import app from "../apps/api/src/index.ts";
import { connect } from "../apps/api/src/db.ts";
import { dailyJobs } from "../apps/api/src/lib/cron.ts";
import { addDays, easternDate } from "../apps/api/src/lib/dates.ts";
import { sandboxFund } from "../apps/api/src/lib/fund.ts";
import { runBenefitRun, claimCredit } from "../apps/api/src/lib/org.ts";
import { setProgram } from "../apps/api/src/lib/programs.ts";
import { reconciliationStats } from "../apps/api/src/lib/stats.ts";

const arg = (k: string, d: number) => { const i = process.argv.indexOf("--" + k); return i < 0 ? d : Number(process.argv[i + 1]); };
const DAYS = arg("days", 7), TPS = arg("tps", 10), USERS = arg("users", 10000), MERCHANTS = arg("merchants", 100), WORKERS = arg("workers", 24), TAMPER = arg("tamper-day", -1);
const URL = process.env.SIM_DB_URL;
if (!URL) { console.error("set SIM_DB_URL (a throwaway local database)"); process.exit(2); }
const LOCAL = /127\.0\.0\.1|localhost/.test(URL);
if (!LOCAL && process.env.SIM_ALLOW_REMOTE !== "1") { console.error("refusing: SIM_DB_URL is not local (set SIM_ALLOW_REMOTE=1 for a throwaway branch)"); process.exit(2); }
const DDL_URL = process.env.SIM_DDL_URL ?? URL;
const pgOpts = { ssl: LOCAL ? (false as const) : ("require" as const), prepare: false, onnotice: () => {}, idle_timeout: 30, connect_timeout: 60 };
const PERDAY = Math.round(TPS * 86400);
const env: any = { HYPERDRIVE: { connectionString: URL }, JWT_SECRET: "sim-secret-sim-secret-sim-secret-123", SANDBOX_FUNDING: "true", STATS_TTL_SECONDS: "300", ADMIN_API_TOKEN: "sim-operator-token" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
const raw = postgres(URL.split("?")[0]!, { ...pgOpts, max: WORKERS + 4, types: { bigint: { to: 20, from: [20], serialize: (v: any) => String(v), parse: (v: string) => Number(v) } } });
// the API code's own client has 5 connections; the simulation gives it as many as it has workers, with the same bigint handling
const sql = postgres(URL.split("?")[0]!, { ...pgOpts, max: WORKERS + 4, fetch_types: false, types: { bigint: { to: 20, from: [20], serialize: (v: any) => v.toString(), parse: (v: string) => BigInt(v) } } }) as unknown as ReturnType<typeof connect>;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const api = async (m: string, p: string, o: { body?: unknown; token?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + p, { method: m, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;
const rnd = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));

// ---------------------------------------------------------------- setup
const [{ has }] = await raw`select to_regclass('public.accounts') is not null as has` as any;
const existing = has ? (await raw`select count(*)::int as n from accounts` as any)[0].n : 0;
const D0 = addDays(easternDate(new Date()), -DAYS);          // the first simulated day; the day before it holds the opening loads
if (existing <= 1) {
  log("applying the schema");
  for (const f of ["0001_init.sql", "0002_money_functions.sql"]) execFileSync("psql", [DDL_URL, "-q", "-v", "ON_ERROR_STOP=1", "-f", new globalThis.URL(`../migrations/${f}`, import.meta.url).pathname]);
  log(`seeding ${USERS} consumers, ${MERCHANTS} merchants, 3 organizations`);
  await raw.unsafe(`
    insert into accounts (type, name, email, status) select 'C', 'User ' || g, 'u' || g || '@sim.test', 'active' from generate_series(1, ${USERS}) g;
    insert into balances (account_id) select id from accounts where email like 'u%@sim.test';
    insert into wallets (account_id, display_name, type) select id, name, 'default' from accounts where email like 'u%@sim.test';
    insert into tag_models (type, name, price, quantity, status) values ('band', 'Sim band', 2999, 100000000, 'available');
    insert into tags (uid, model_id, wallet_id) select upper(lpad(to_hex(row_number() over (order by a.id)), 14, '0')), (select id from tag_models limit 1), w.id
      from accounts a join wallets w on w.account_id = a.id and w.type = 'default' where a.email like 'u%@sim.test';
    insert into shop (name, price, stock, status, kind) values ('Sim mug', 1500, null, 'available', 'physical');
  `);
  // opening loads: each consumer starts with $300 through real fund transactions (bank wallet -> wallet), dated the day before the week
  await raw.unsafe(`
    alter table transactions disable trigger transactions_no_update;
    insert into transactions (type, status, from_wallet_id, to_wallet_id, amount, account_id, idem, created_at)
      select 'fund', 'completed', '00000000-0000-7000-8000-000000000002', w.id, 30000, w.account_id, 'seed:' || w.account_id,
             ('${addDays(D0, -1)}'::date::timestamp + interval '12 hours') at time zone 'America/New_York'
        from wallets w join accounts a on a.id = w.account_id where a.email like 'u%@sim.test' and w.type = 'default';
    update balances set balance = 30000 where account_id in (select id from accounts where email like 'u%@sim.test');
    alter table transactions enable trigger transactions_no_update;
  `);
  for (let i = 1; i <= MERCHANTS; i++) {
    const s = (await api("POST", "/v1/auth/signup", { body: { type: "B", name: `Merchant ${i}`, email: `m${i}@sim.test`, password: "correct horse battery" } })).json;
    await raw`update accounts set status = 'active' where id = ${s.account_id}`;
    await raw.unsafe(`insert into businesses (account_id, account_type, legal_name, display_name) values ($1::uuid, 'B', $2::text, $3::text) on conflict (account_id) do update set legal_name = excluded.legal_name, display_name = excluded.display_name`, [s.account_id, `Merchant ${i} LLC`, `Merchant ${i}`] as any);
    const [bank] = await raw`insert into bank_accounts (account_id, routing_number, account_number, last4) values (${s.account_id}, 'SANDBOX', 'SANDBOX', '0000') returning id`;
    await raw`update businesses set bank_account_id = ${bank!.id} where account_id = ${s.account_id}`;
    await raw`insert into terminals (account_id, name) values (${s.account_id}, 'Counter')`;
  }
  for (const k of ["A", "B", "C"]) {
    const s = (await api("POST", "/v1/auth/signup", { body: { type: "O", name: `Org ${k}`, email: `org${k}@sim.test`, password: "correct horse battery" } })).json;
    await raw.unsafe(`insert into employees (org_account_id, employee_id, name, email) select '${s.account_id}'::uuid, 'E' || g, 'Employee ' || g, 'e' || g || '.${k.toLowerCase()}@sim.test' from generate_series(1, 300) g`);
  }
}
const consumers = (await raw`select a.id as account, w.id as wallet, t.uid from accounts a join wallets w on w.account_id = a.id and w.type = 'default' join tags t on t.wallet_id = w.id where a.email like 'u%@sim.test' order by a.id`) as any[];
const merchants = (await raw`select a.id as account, t.id as terminal from accounts a join terminals t on t.account_id = a.id where a.email like 'm%@sim.test' and a.type = 'B' order by a.email`) as any[];
const orgs = (await raw`select a.id, a.name from accounts a where a.type = 'O' order by a.name`) as any[];
const counters = new Map<string, number>(); consumers.forEach((c) => counters.set(c.uid, 0));
const hot = merchants[0], coolMerchants = merchants.slice(1);
log(`${consumers.length} consumers, ${merchants.length} merchants (one takes 20%), ${orgs.length} organizations, ${WORKERS} workers`);
// Org A: a flexible CSV run each day; Org B: a weekly Fixed schedule; Org C: API-style credits each day. All of them funded each day.
{ const emp = (await raw`select id, org_account_id from employees where org_account_id = ${orgs[1].id}`) as any[]; await raw`update employees set fixed_benefit = 5000 where org_account_id = ${orgs[1].id}`;
  await setProgram(sql, orgs[1].id, { mode: "fixed", cadence: "weekly", weekday: new Date(`${addDays(D0, 2)}T12:00:00Z`).getUTCDay() } as any, addDays(D0, -1)); void emp; }

// ---------------------------------------------------------------- one day of traffic
let seq = 0;
const recentPays: { id: string; merchant: string; amount: number }[] = [];
const stats: Record<string, number> = {};
let curW = 0;
const tally = (k: string) => { stats[k] = (stats[k] ?? 0) + 1; lastKind[curW] = k.split('_')[0] + (k.startsWith('pay') ? '_' + k.split('_')[1] : ''); };
const lat: number[] = [];
const kinds: Record<string, number[]> = {};
async function one(w: number) {
  const t0 = performance.now();
  await one2(w);
  const ms = performance.now() - t0;
  lat.push(ms);
  (kinds[lastKind[w] ?? "x"] ??= []).push(ms);
}
const lastKind: string[] = [];
async function one2(w: number) {
  curW = w;
  const mine = MINE[w]!;       // a worker owns its consumers, so a tag's counter is never raced
  const c = pick(mine), key = `s${seq++}`;
  const roll = Math.random();
  const m = Math.random() < 0.2 ? hot : pick(coolMerchants);
  try {
    if (roll < 0.35) {                                              // tap
      const amount = rnd(300, 6000); const counter = (counters.get(c.uid) ?? 0) + 1;
      const r = (await raw`select app_pay_tap(${raw.json({ merchant: m.account, terminal_id: m.terminal, uid: c.uid, counter, key, amount } as any)}) as r` as any)[0].r;
      if (r.kind !== "error" || r.error !== "proof_replayed") counters.set(c.uid, counter);
      tally(r.kind === "ok" ? "pay_tap" : "pay_tap_" + (r.kind === "declined" ? r.row.status_code : r.error));
      if (r.kind === "ok" && recentPays.length < 5000) recentPays.push({ id: r.row.id, merchant: m.account, amount });
    } else if (roll < 0.55) {                                       // in app
      const amount = rnd(300, 6000);
      const r = (await raw`select app_pay_app(${raw.json({ payer_account: c.account, terminal_id: m.terminal, amount, key } as any)}) as r` as any)[0].r;
      tally(r.kind === "ok" ? "pay_app" : "pay_app_" + (r.kind === "declined" ? r.row.status_code : r.error));
      if (r.kind === "ok" && recentPays.length < 5000) recentPays.push({ id: r.row.id, merchant: m.account, amount });
    } else if (roll < 0.75) {                                       // send
      let to = pick(consumers); while (to.account === c.account) to = pick(consumers);
      const r = (await raw`select app_send(${raw.json({ actor: c.account, to_wallet: to.wallet, amount: rnd(200, 8000), key, cap: 200000 } as any)}) as r` as any)[0].r;
      tally(r.kind === "ok" ? "send" : "send_" + (r.kind === "declined" ? r.tx.status_code : r.error));
    } else if (roll < 0.83) {                                       // bank load
      const r = await sandboxFund(sql, { accountId: c.account, amount: BigInt(rnd(2000, 30000)), idempotencyKey: key, dailyCap: 200000n });
      tally(r.kind === "ok" ? "load" : "load_" + (r.kind === "failed" ? r.funding.failure_code : "error"));
    } else if (roll < 0.87 && recentPays.length > 50) {              // refund of a recent payment
      const p = recentPays.splice(rnd(0, recentPays.length - 1), 1)[0]!;
      const r = (await raw`select app_refund(${raw.json({ merchant: p.merchant, payment_id: p.id, mode: "partial", amount: Math.max(100, Math.floor(p.amount / 2)), key, disposition: "execute" } as any)}) as r` as any)[0].r;
      tally(r.kind === "ok" ? "refund" : "refund_" + (r.kind === "declined" ? r.row.status_code : r.error));
    } else if (roll < 0.89) {                                       // store purchase
      const shop = Math.random() < 0.5;
      const r = (await raw`select app_purchase(${raw.json({ account: c.account, kind: shop ? "shop" : "tag", product_id: shop ? SHOP : MODEL, quantity: 1, shipping: { name: "Sim", line1: "1 Main", city: "NYC", region: "NY", postal_code: "10001", country: "US" }, key } as any)}) as r` as any)[0].r;
      tally(r.kind === "ok" ? "purchase" : "purchase_" + (r.kind === "declined" ? r.code : r.error));
    } else {                                                        // a payment declined for lack of a limit or funds, and replays of earlier keys
      const r = (await raw`select app_send(${raw.json({ actor: c.account, to_wallet: pick(consumers).wallet, amount: rnd(200, 8000), key: `s${Math.max(0, seq - rnd(1, 50))}`, cap: 200000 } as any)}) as r` as any)[0].r;
      tally("replay_or_mismatch_" + r.kind);
    }
  } catch (e: any) { tally("exception_" + (e.code ?? e.message.slice(0, 30))); }
}
const [{ id: SHOP }] = (await raw`select id from shop limit 1`) as any; const [{ id: MODEL }] = (await raw`select id from tag_models limit 1`) as any;

const MINE: any[][] = Array.from({ length: WORKERS }, (_, w) => consumers.filter((_, i) => i % WORKERS === w));
async function runDay(d: string) {
  lat.length = 0; for (const k of Object.keys(kinds)) delete kinds[k];
  const t0 = Date.now(); const realFrom = new Date(t0 - 2000);
  let left = PERDAY;
  await Promise.all(Array.from({ length: WORKERS }, async (_, w) => { while (left > 0) { left -= 1; await one(w); } }));
  // organizations: funded, one CSV run, one API-style run, some claims
  for (const o of orgs) await sandboxFund(sql, { accountId: o.id, amount: 5_000_000_00n, idempotencyKey: `orgfund-${d}-${o.id}`, dailyCap: 0n });
  const claims = [] as any[];
  for (const [i, o] of [orgs[0], orgs[2]].entries()) {
    const rows = Array.from({ length: 300 }, (_, k) => ({ employee_id: `E${k + 1}`, name: `Employee ${k + 1}`, email: `e${k + 1}.${"abc"[i * 2]}@sim.test`, amount: BigInt(rnd(5000, 30000)) }));
    const r = await runBenefitRun(sql, { orgId: o.id, idempotencyKey: `run-${d}-${i}`, source: i === 0 ? "csv" : "api", rows });
    if (r.kind === "ok") claims.push(...r.notices.slice(0, 120));
    else tally("benefit_run_" + r.error);
  }
  let claimant = rnd(0, consumers.length - 400);
  for (const n of claims) { const r = await claimCredit(sql, { accountId: consumers[claimant++ % consumers.length].account, token: n.token }); tally(r.kind === "ok" ? "claim" : "claim_" + r.error); }
  const secs = (Date.now() - t0) / 1000;
  // stamp the day's rows into the simulated day, in order, then move the daily counters on and run the night
  const [{ ts }] = (await raw`select (${d}::date::timestamp at time zone 'America/New_York') as ts`) as any;
  await raw.unsafe(`alter table transactions disable trigger transactions_no_update`);
  const scale = 86400 / Math.max(1, (Date.now() - realFrom.getTime()) / 1000);
  for (const t of ["transactions", "fundings", "refunds", "orders"]) {
    await raw.unsafe(`update ${t} set created_at = '${new Date(ts).toISOString()}'::timestamptz + (created_at - '${realFrom.toISOString()}'::timestamptz) * ${scale} where created_at >= '${realFrom.toISOString()}'::timestamptz`);
  }
  await raw.unsafe(`update benefit_runs set run_date = '${d}'::date, created_at = '${new Date(ts).toISOString()}'::timestamptz + interval '1 hour' where created_at >= '${realFrom.toISOString()}'::timestamptz and run_date <> '${d}'::date`);
  await raw.unsafe(`alter table transactions enable trigger transactions_no_update`);
  await raw.unsafe(`update wallets set spent_day = spent_day - 1; update products set sold_day = sold_day - 1; update balances set opening_day = opening_day - 1`);
  const rate = PERDAY / secs;
  const sorted = [...lat].sort((a, b) => a - b); const qq = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!.toFixed(0);
  latDays.push({ day: d, rate: Math.round(rate), p50: +qq(0.5), p90: +qq(0.9), p99: +qq(0.99), p999: +qq(0.999), max: +sorted[sorted.length - 1]!.toFixed(0), over250: sorted.filter((x) => x > 250).length, over1000: sorted.filter((x) => x > 1000).length });
  log(`day ${d}: ${PERDAY} requests in ${secs.toFixed(0)}s (${rate.toFixed(0)}/s) latency ms p50 ${qq(0.5)} p90 ${qq(0.9)} p99 ${qq(0.99)} max ${sorted[sorted.length - 1]!.toFixed(0)}; over 250 ms: ${latDays[latDays.length - 1]!.over250}, over 1 s: ${latDays[latDays.length - 1]!.over1000}`);
  return rate;
}

// ---------------------------------------------------------------- the week
const report: any[] = [];
const latDays: any[] = [];
const night = async (forDay: string) => {
  const nextMidnight = Date.parse(`${addDays(forDay, 1)}T05:01:00Z`);   // 00:01 New York of the next day (the second, winter-time run of the two crons is a no-op)
  const job: any = await dailyJobs(nextMidnight, env);
  const [s] = (await raw`select snapshot_date::text d, reconciled, drift, drift_credit, drift_wallets, drift_conservation, effects_delta, edge_flows, balance_midnight, sends_count, taps_count, in_app_count, refunds_count, loads_count, purchases_count, claims_count, payouts_count, lifetime_taps_count from snapshots where snapshot_date = ${forDay}::date`) as any[];
  report.push({ ...s, settlement: job.settlement?.payouts, programs: job.programs?.credited });
  log(`night for ${forDay}: reconciled=${s?.reconciled} drift=${s?.drift} credit=${s?.drift_credit} wallets=${s?.drift_wallets} conservation=${s?.drift_conservation} | payouts ${job.settlement?.payouts ?? "-"} (${job.settlement?.payout_total ?? 0}) fixed-benefit runs ${job.programs?.credited ?? 0}`);
};
await night(addDays(D0, -1));                     // the baseline night: the opening loads
for (let i = 0; i < DAYS; i++) {
  const d = addDays(D0, i);
  if (i === TAMPER) { await raw`update balances set balance = balance + 13 where account_id = ${consumers[7].account}`; log("TAMPER: one balance +13 with no transaction"); }
  if (i === TAMPER + 2 && TAMPER >= 0) { await raw`update balances set balance = balance - 13 where account_id = ${consumers[7].account}`; log("FIX: that balance corrected"); }
  await runDay(d);
  await night(d);
}
// ---------------------------------------------------------------- the report
console.log("\nmix of outcomes:", JSON.stringify(Object.fromEntries(Object.entries(stats).sort((a, b) => b[1] - a[1]))));
console.table(report.map((r) => ({ day: r.d, ok: r.reconciled, drift: r.drift, credit: r.drift_credit, wallets: r.drift_wallets, conserv: r.drift_conservation, effects: r.effects_delta, edge: r.edge_flows, taps: r.taps_count, app: r.in_app_count, sends: r.sends_count, loads: r.loads_count, refunds: r.refunds_count, purch: r.purchases_count, claims: r.claims_count, payouts: r.payouts_count })));
console.log("\nper-call latency by day (client side, includes the network round trip):"); console.table(latDays);
const [{ n: total }] = (await raw`select count(*)::int as n from transactions`) as any;
log(`transactions in the database: ${total}`);
const full = await reconciliationStats(sql);
log("FULL recompute (Run Check) after the week:", JSON.stringify(full));
const [{ n: neg }] = (await raw`select count(*)::int as n from balances b join accounts a on a.id = b.account_id where b.balance < 0 and a.type <> 'B'`) as any;
log(`non-merchant accounts with a negative balance: ${neg}`);
try {
  const top = (await raw`select left(regexp_replace(query, '\s+', ' ', 'g'), 90) as query, calls, round(total_exec_time::numeric / 1000, 1) as total_s, round(mean_exec_time::numeric, 2) as mean_ms, round(max_exec_time::numeric, 1) as max_ms from pg_stat_statements where query not ilike '%pg_stat_statements%' order by total_exec_time desc limit 15`) as any[];
  console.log("\ndatabase-side, top queries by total time (pg_stat_statements):"); console.table(top);
  const slow = (await raw`select left(regexp_replace(query, '\s+', ' ', 'g'), 90) as query, calls, round(mean_exec_time::numeric, 2) as mean_ms, round(max_exec_time::numeric, 1) as max_ms from pg_stat_statements where calls > 100 and query not ilike '%pg_stat_statements%' order by max_exec_time desc limit 10`) as any[];
  console.log("by worst single execution:"); console.table(slow);
} catch (e: any) { console.log("pg_stat_statements not available:", e.message); }
await raw.end(); await sql.end();
