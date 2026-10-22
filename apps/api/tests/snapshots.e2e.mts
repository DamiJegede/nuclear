import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { connect } from "../src/db.ts";
import { Counters } from "../src/lib/counters.ts";
import { StatsCounter } from "../src/lib/statsCounter.ts";
import { takeSnapshot, catchUpSnapshots, addDays } from "../src/lib/snapshots.ts";
import { easternDate } from "../src/lib/dailyReset.ts";
import { dailyJobs } from "../src/lib/cron.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");

// A stand-in for the Durable Object namespace: the same Counters logic, in memory, one per shard name.
const objects = new Map<string, Counters>();
const STATS = {
  idFromName: (n: string) => n,
  get: (id: string) => ({ fetch: async (url: string, init?: { method?: string; body?: string }) => {
    if (!objects.has(id)) objects.set(id, new Counters());
    return objects.get(id)!.handle(new Request(url, init));
  } }),
};
const env: any = { HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true", APP_URL: "https://app.test", STATS };   // snapshot mode: no STATS_TTL_SECONDS
const pending: Promise<unknown>[] = [];
const ctx: any = { waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => {})); }, passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (m: string, p: string, o: { body?: unknown; token?: string; key?: string; e?: any } = {}) => {
  const r = await app.fetch(new Request("http://x" + p, { method: m, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), o.e ?? env, ctx);
  const t = await r.text(); while (pending.length) await pending.shift();
  return { status: r.status, json: t ? JSON.parse(t) : null };
};
const stats = async () => (await call("GET", "/v1/admin/stats", { token: OP })).json;
const sign = async (name: string, email: string, type = "C") => (await call("POST", "/v1/auth/signup", { body: { type, name, email, password: "correct horse battery" } })).json;
const today = easternDate(new Date()), y = addDays(today, -1);
const sqlc = connect(env);
const traced: string[] = [];
(globalThis as any).__sqlTrace = (s: string) => traced.push(s);
// Snapshots are final (a trigger refuses deletes), so tests that simulate a missed night switch it off around their setup.
const wipe = async (sqlText: string, p: unknown[] = []) => { await q("alter table snapshots disable trigger snapshots_final"); await q(sqlText, p); await q("alter table snapshots enable trigger snapshots_final"); };
const noonOf = (d: string) => `((${"'" + d + "'"}::date)::timestamp + interval '12 hours') at time zone 'America/New_York'`;

// ---- the counters themselves
const c = new Counters();
c.add("2026-11-01", { sends_n: 1, sends_v: 500 }); c.add("2026-11-01", { sends_n: 2, sends_v: 100, zero: 0 }); c.add("2026-11-02", { loads_n: 1 });
eq("counters add per day and ignore zeros", c.read(["2026-11-01", "2026-11-02", "2026-11-03"]), { "2026-11-01": { sends_n: 3, sends_v: 600 }, "2026-11-02": { loads_n: 1 }, "2026-11-03": {} });
c.prune("2026-11-02");
eq("pruning drops older days only", Object.keys(c.days), ["2026-11-02"]);
eq("the protocol rejects nonsense", (await c.handle(new Request("https://s/add", { method: "POST", body: "{}" }))).status, 400);

// ---- the Durable Object saves its counters shortly after they change and loads them after an eviction
const store = new Map<string, unknown>(); let alarm: number | null = null;
const state: any = { storage: { get: async (k: string) => store.get(k), put: async (k: string, v: unknown) => { store.set(k, JSON.parse(JSON.stringify(v))); }, setAlarm: async (t: number) => { alarm = t; }, getAlarm: async () => alarm }, blockConcurrencyWhile: (f: () => Promise<unknown>) => f() };
const o1 = new StatsCounter(state, {}); await new Promise((r) => setTimeout(r, 5));
await o1.fetch(new Request("https://s/add", { method: "POST", body: JSON.stringify({ day: "2026-11-05", deltas: { taps_n: 2 } }) }));
eq("a change schedules a save", [alarm !== null, store.has("days")], [true, false]);
await o1.alarm(); alarm = null;
eq("the alarm saves the counters", store.get("days"), { "2026-11-05": { taps_n: 2 } });
const o2 = new StatsCounter(state, {}); await new Promise((r) => setTimeout(r, 5));
const back = await (await o2.fetch(new Request("https://s/read", { method: "POST", body: JSON.stringify({ days: ["2026-11-05"] }) }))).json() as any;
eq("a new life of the object (after an eviction) loads them back", back.days, { "2026-11-05": { taps_n: 2 } });

// ---- the data: a merchant, a payer, an organization with a benefits run; then all of it is dated yesterday
const payer = await sign("Payer", "payer@x.test"), friend = await sign("Friend", "friend@x.test");
const shop = await sign("Shop", "shop@x.test", "B"); await q("update accounts set status='active' where id=$1", [shop.account_id]);
const term = (await call("POST", "/v1/terminals", { token: shop.session_token, body: { name: "Counter" } })).json;
const org = await sign("Acme", "hr@acme.test", "O");
const fund = (p: any, amount: number, key: string) => call("POST", "/v1/sandbox/fundings", { token: p.session_token, key, body: { amount } });
await fund(payer, 50000, "f1"); await fund(org, 100000, "fo");
const friendWallet = (await call("GET", "/v1/wallets", { token: friend.session_token })).json.wallets[0].id;
await call("POST", "/v1/transfers", { token: payer.session_token, key: "s1", body: { to_wallet_id: friendWallet, amount: 1500 } });
const pay1 = (await call("POST", "/v1/payments", { token: payer.session_token, key: "p1", body: { amount: 2500, terminal_id: term.terminal.id } })).json.payment;
await call("POST", "/v1/payments", { token: payer.session_token, key: "p2", body: { amount: 1000, terminal_id: term.terminal.id } });
await call("POST", "/v1/terminal/refunds", { token: term.session_token, key: "r1", body: { payment_id: pay1.id, mode: "partial", amount: 400 } });
await call("POST", "/v1/org/benefit-runs", { token: org.session_token, key: "b1", body: { rows: [{ employee_id: "E1", name: "Eve", email: "eve@example.com", amount: 6000 }] } });
eq("events were tracked while they happened", [objects.size, [...objects.values()][0]!.days[today]!.sends_n, [...objects.values()][0]!.days[today]!.in_app_n, [...objects.values()][0]!.days[today]!.loads_n, [...objects.values()][0]!.days[today]!.refunds_v, [...objects.values()][0]!.days[today]!.benefit_held_v, [...objects.values()][0]!.days[today]!.users_new_n, [...objects.values()][0]!.days[today]!.merchants_new_n, [...objects.values()][0]!.days[today]!.organizations_new_n], [1, 1, 2, 2, 400, 6000, 2, 1, 1]);

// replays and declines are not counted
const before = JSON.stringify([...objects.values()][0]!.days);
await call("POST", "/v1/transfers", { token: payer.session_token, key: "s1", body: { to_wallet_id: friendWallet, amount: 1500 } });
await call("POST", "/v1/transfers", { token: friend.session_token, key: "big", body: { to_wallet_id: (await call("GET", "/v1/wallets", { token: payer.session_token })).json.wallets[0].id, amount: 99999999 } });
eq("a replayed send and a declined send leave the counters alone", JSON.stringify([...objects.values()][0]!.days), before);

// move every row to yesterday noon (New York), then clear the running counters: yesterday is the snapshot's business
await q(`update transactions set "timestamp" = ${noonOf(y)}, completed_at = ${noonOf(y)} where completed_at is not null`);
await q(`update accounts set created_at = ${noonOf(y)}`);
await q(`update benefit_runs set created_at = ${noonOf(y)}`);
await q(`update employees set created_at = ${noonOf(y)}`);
objects.clear();

// ---- the exact snapshot of yesterday
eq("a snapshot is taken", await takeSnapshot(sqlc, y), true);
const [s] = await q("select *, snapshot_date::text d from snapshots");
eq("it is for that day", s.d, y);
eq("activity of the day: sends, in-app payments, refunds, loads", [Number(s.sends_count), Number(s.sends_volume), Number(s.in_app_count), Number(s.in_app_volume), Number(s.taps_count), Number(s.refunds_count), Number(s.refunds_volume), Number(s.loads_count), Number(s.loads_volume)], [1, 1500, 2, 3500, 0, 1, 400, 2, 150000]);
eq("the merchants paid, and the people who joined", [Number(s.merchants_paid), Number(s.users_new), Number(s.merchants_new), Number(s.organizations_new)], [1, 2, 1, 1]);
eq("benefits: the run, what was held, the employee", [Number(s.benefit_runs_count), Number(s.benefit_credited), Number(s.benefit_sent), Number(s.benefit_held), Number(s.employees_added), Number(s.employees_total), Number(s.employees_claimed), Number(s.employees_unclaimed), Number(s.employee_escrow)], [1, 6000, 0, 6000, 1, 1, 0, 1, 6000]);
eq("allocations to employees are in the ledger as claims-in-waiting, claims are zero", [Number(s.claims_count), Number(s.claims_volume)], [0, 0]);
const sumBal = Number((await q("select sum(balance)::bigint t from balances"))[0].t);
eq("money held: the scheme balance is every balance, split by kind", [Number(s.scheme_balance) === sumBal, Number(s.merchant_balance), Number(s.organization_balance), Number(s.consumer_balance) + Number(s.merchant_balance) + Number(s.organization_balance) === sumBal], [true, 3100, 94000, true]);
eq("people gauges", [Number(s.users_total), Number(s.merchants_total), Number(s.merchants_active), Number(s.merchants_transacting), Number(s.organizations_total), Number(s.terminals)], [2, 1, 1, 1, 1, 1]);
eq("lifetime starts from all history", [Number(s.lifetime_sends_count), Number(s.lifetime_in_app_volume), Number(s.lifetime_loads_volume), Number(s.lifetime_refunds_count), Number(s.lifetime_benefit_credited), Number(s.lifetime_benefit_runs_count)], [1, 3500, 150000, 1, 6000, 1]);
eq("the same day is never snapshotted twice", [await takeSnapshot(sqlc, y), (await q("select count(*)::int n from snapshots"))[0].n], [false, 1]);
eq("reconciliation is not part of taking the snapshot", s.reconciled, null);

// ---- the Overview: that snapshot plus today's estimate, no history scan
traced.length = 0;
const s0 = await stats();
eq("the Overview is the snapshot, labelled as an estimate", [s0.estimate.snapshot_date, s0.estimate.today, s0.scheme.balance, s0.payments.sent, s0.payments.in_app, s0.payments.refunds, s0.payments.loaded, s0.users.total, s0.merchants.total], [y, today, sumBal, { count: 1, volume: 1500 }, { count: 2, volume: 3500 }, { count: 1, volume: 400 }, { count: 2, volume: 150000 }, 2, 1]);
eq("and it scanned no transactions to say so", traced.filter((t) => t.includes("tap_n") || t.includes("sent_n")).length, 0);
eq("the ledger checks still exist beside it", [s0.reconciliation.ledger_balanced, s0.reconciliation.balances_match_ledger], [true, true]);

// today's events move the estimate
await fund(payer, 2000, "f2");
await call("POST", "/v1/transfers", { token: payer.session_token, key: "s2", body: { to_wallet_id: friendWallet, amount: 700 } });
await call("POST", "/v1/payments", { token: friend.session_token, key: "p3", body: { amount: 300, terminal_id: term.terminal.id } });
await sign("Newbie", "newbie@x.test");
const s1 = await stats();
eq("sends and in-app payments are added to lifetime and today", [s1.payments.sent, s1.payments.today.sent, s1.payments.in_app, s1.payments.today.in_app, s1.payments.total.count], [{ count: 2, volume: 2200 }, { count: 1, volume: 700 }, { count: 3, volume: 3800 }, { count: 1, volume: 300 }, 5]);
eq("loads move the money held; the estimate says so", [s1.scheme.balance, s1.payments.loaded], [sumBal + 2000, { count: 3, volume: 152000 }]);
eq("a new person shows today", [s1.users.new_today, s1.users.total, s1.users.new_7d], [1, 3, 3]);
eq("the estimate is exact as of the snapshot's midnight", s1.estimate.snapshot_date, y);

// ---- tomorrow's snapshot chains from yesterday's
await q(`update transactions set "timestamp" = ${noonOf(today)}, completed_at = ${noonOf(today)} where idempotency_key in ('f2', 's2', 'c:' || '${payer.account_id}' || ':p3') or (type in ('fund','send','pay') and completed_at > now() - interval '5 minutes')`);
const tomorrow = addDays(today, 1);
eq("the next snapshot", await takeSnapshot(sqlc, today), true);
const [s2] = await q("select * from snapshots where snapshot_date = $1::date", [today]);
const [full] = await q("select count(*) filter (where type='send')::int sends, coalesce(sum(amount) filter (where type='send'),0)::bigint sv, coalesce(sum(amount) filter (where type='pay' and tag_id is null),0)::bigint iv, coalesce(sum(amount) filter (where type='fund'),0)::bigint lv from transactions where status='completed' and completed_at < (($1::date + 1)::timestamp at time zone 'America/New_York')", [today]);
eq("lifetime is the previous day's plus the day, and equals a full recount", [Number(s2.lifetime_sends_count), Number(s2.lifetime_sends_volume), Number(s2.lifetime_in_app_volume), Number(s2.lifetime_loads_volume)], [full.sends, Number(full.sv), Number(full.iv), Number(full.lv)]);
eq("the day's own columns are only the day", [Number(s2.sends_count), Number(s2.sends_volume), Number(s2.loads_volume)], [1, 700, 2000]);

// ---- a missed cron is made up, oldest first
await wipe("delete from snapshots where snapshot_date = $1::date", [today]);
const made = await catchUpSnapshots(sqlc, addDays(today, 2));
eq("missing days are written in order", made, [today, addDays(today, 1), addDays(today, 2)]);

// ---- the nightly job: snapshot, ledger checks recorded on the day, old counters pruned
await wipe("delete from snapshots where snapshot_date > $1::date", [y]);
await fund(payer, 100, "f9");
const night = Date.parse(`${addDays(today, 1)}T05:00:00Z`);
const job: any = await dailyJobs(night, env);
const [rowToday] = await q("select reconciled, reconciliation is not null as has from snapshots where snapshot_date = $1::date", [today]);
eq("the nightly job snapshots the day that ended and records the books check on it", [job.snapshots.includes(today), rowToday.reconciled, rowToday.has], [true, true, true]);

// ---- no counter object bound: the estimate is just the snapshot
const bare: any = { ...env, STATS: undefined };
const s3 = (await call("GET", "/v1/admin/stats", { token: OP, e: bare })).json;
eq("without the counters the Overview still answers (estimate = zeros)", [typeof s3.scheme.balance, s3.payments.today.sent], ["number", { count: 0, volume: 0 }]);

// ---- several counter objects are summed
const shards: any = { ...env, STATS_SHARDS: "3" };
objects.clear();
for (let i = 0; i < 12; i++) await call("POST", "/v1/sandbox/fundings", { token: payer.session_token, key: `m${i}`, body: { amount: 10 }, e: shards });
const s4 = (await call("GET", "/v1/admin/stats", { token: OP, e: shards })).json;
eq("12 loads spread over three objects add up", [objects.size > 1, s4.payments.today.sent.count >= 0, [...objects.values()].reduce((a, o) => a + (o.days[today]?.loads_n ?? 0), 0)], [true, true, 12]);

// ---- the operator's throughput probe writes only to a throwaway day
objects.clear();
const probe = await call("POST", "/v1/admin/stats/loadtest", { token: OP, body: { events: 50, shards: 2 } });
eq("the probe fires its events and counts them", [probe.status, probe.json.ok, probe.json.failed], [200, 50, 0]);
eq("they are in the throwaway day only", [(await call("GET", "/v1/admin/stats/loadtest?shards=2", { token: OP })).json.probe_n, [...objects.values()].every((o) => Object.keys(o.days).every((d) => d === "loadtest"))], [50, true]);
await call("DELETE", "/v1/admin/stats/loadtest?shards=4", { token: OP });
eq("and are dropped afterwards", (await call("GET", "/v1/admin/stats/loadtest?shards=2", { token: OP })).json.probe_n, 0);
eq("the probe is for the operator token only, and bounded", [(await call("POST", "/v1/admin/stats/loadtest", { body: { events: 5 } })).status, (await call("POST", "/v1/admin/stats/loadtest", { token: OP, body: { events: 100000 } })).status], [401, 400]);

console.log(`\n${pass} passed, ${fail} failed`);
await sqlc.end(); await adm.end();
process.exit(fail ? 1 : 0);
