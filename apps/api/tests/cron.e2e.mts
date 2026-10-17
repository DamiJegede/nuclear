import postgres from "postgres";
import app from "../src/index.ts";
import { dailyJobs } from "../src/lib/cron.ts";
import { easternDate, ensureDay } from "../src/lib/dailyReset.ts";
import { connect } from "../src/db.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 8, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const env: any = { HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), SANDBOX_FUNDING: "true" };
const ctx: any = { waitUntil() {}, passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const at = (y: number, m: number, d: number, h: number, min = 0) => Date.UTC(y, m - 1, d, h, min);
const local = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
const sql = connect(env);
const setDay = (d: string) => q("update system set value = $1 where key = 'daily_reset_day'", [d]);
const day = async () => (await q("select value d from system where key = 'daily_reset_day'"))[0].d as string;

// ---- program dates around daylight saving
eq("04:00 UTC is the start of the New York day in summer, 05:00 UTC in winter", [easternDate(new Date(at(2026, 7, 15, 4))), easternDate(new Date(at(2026, 7, 15, 3, 59))), easternDate(new Date(at(2026, 1, 15, 5))), easternDate(new Date(at(2026, 1, 15, 4, 59)))], ["2026-07-15", "2026-07-14", "2026-01-15", "2026-01-14"]);
eq("spring forward (8 March 2026): 04:00 UTC is still 7 March, 05:00 UTC is 8 March; 04:00 UTC on the 9th is the 9th", [easternDate(new Date(at(2026, 3, 8, 4))), easternDate(new Date(at(2026, 3, 8, 5))), easternDate(new Date(at(2026, 3, 9, 4)))], ["2026-03-07", "2026-03-08", "2026-03-09"]);
eq("fall back (1 November 2026): 04:00 and 05:00 UTC are both 1 November; 05:00 UTC on the 2nd is the 2nd", [easternDate(new Date(at(2026, 11, 1, 4))), easternDate(new Date(at(2026, 11, 1, 5))), easternDate(new Date(at(2026, 11, 2, 4))), easternDate(new Date(at(2026, 11, 2, 5)))], ["2026-11-01", "2026-11-01", "2026-11-01", "2026-11-02"]);

// ---- both cron runs, every day of 2026 and 2027, against the real table: each New York date is reset exactly once, by the run at local midnight
await q("insert into wallets (account_id, display_name, type) select id, 'x', 'person' from accounts limit 0");
const acc = (await (await app.fetch(new Request("http://x/v1/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "A", email: "a@example.com", password: "correct horse battery" }) }), env, ctx)).json()) as any;
await setDay("2025-12-31");
const resetsPerDate = new Map<string, number>(); let notAtMidnight = 0;
for (let t = at(2026, 1, 1, 0); t < at(2027, 12, 31, 0); t += 86_400_000) {
  for (const ms of [t + 4 * 3600_000, t + 5 * 3600_000]) {
    await q("update wallets set spent_today = 100 where id=$1", [acc.default_wallet_id]);
    const r = await ensureDay(sql, easternDate(new Date(ms)));
    if (r.reset) { const d = easternDate(new Date(ms)); resetsPerDate.set(d, (resetsPerDate.get(d) ?? 0) + 1); if (!local(ms).endsWith("00:00")) notAtMidnight++; }
  }
}
eq("across 2026 and 2027 every New York date is reset exactly once, by the cron run that lands on 00:00 (no skipped or doubled day)", [resetsPerDate.size, [...resetsPerDate.values()].every((n) => n === 1), notAtMidnight], [729, true, 0]);

// ---- the job itself
await setDay("2026-07-14");
await q("update wallets set spent_today = 4200, daily_limit = 5000 where id=$1", [acc.default_wallet_id]);
const spent = async () => (await q("select spent_today::int s from wallets where id=$1", [acc.default_wallet_id]))[0].s;
const early = await dailyJobs(at(2026, 7, 15, 3, 30), env);          // 23:30 EDT on the 14th: the day is already done
eq("a run before midnight changes nothing", [early.reset, await spent(), await day()], [false, 4200, "2026-07-14"]);
const mid = await dailyJobs(at(2026, 7, 15, 4), env);                // 00:00 EDT
eq("the midnight run zeroes the counters and records the day", [mid.reset, (mid as any).wallets, await spent(), await day()], [true, 1, 0, "2026-07-15"]);
await q("update wallets set spent_today = 300 where id=$1", [acc.default_wallet_id]);
const second = await dailyJobs(at(2026, 7, 15, 5), env);             // the second cron of the day
eq("the second cron of the day does nothing and never wipes spend made after midnight", [second.reset, await spent()], [false, 300]);

// ---- a missed cron: the first money request after midnight catches up
const wallet = acc.default_wallet_id, A = acc.session_token;
const bob = (await (await app.fetch(new Request("http://x/v1/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "B", email: "b@example.com", password: "correct horse battery" }) }), env, ctx)).json()) as any;
const call = async (method: string, path: string, token: string, body?: unknown, key?: string) => { const r = await app.fetch(new Request("http://x" + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(key ? { "idempotency-key": key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx); const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null }; };
await call("POST", "/v1/sandbox/fundings", A, { amount: 100000 }, "f1");
const send = (key: string, amount = 100) => call("POST", "/v1/transfers", A, { to_wallet_id: bob.default_wallet_id, amount }, key);
const today = easternDate(new Date());
await q("update wallets set daily_limit = 1000, spent_today = 1000 where id=$1", [wallet]);
await setDay(today);
eq("on the same day a wallet at its limit is declined (the flag says today is done)", (await send("m1")).json.status_code, "spend_limit_exceeded");
await setDay("2020-01-01");                                           // the cron has not run for years
const caught = await send("m2");
eq("the cron was missed: the first send of the new day resets the counters, then goes through", [caught.status, await spent(), await day() === today], [201, 100, true]);
eq("the next send the same day counts normally and is not reset again", [(await send("m3")).status, await spent()], [201, 200]);
const lateCron = await dailyJobs(Date.now(), env);
eq("a cron that fires after the catch-up finds the day done and keeps today's spend", [lateCron.reset, await spent()], [false, 200]);
eq("reading a wallet also catches up (the limit shown is today's)", await (async () => { await q("update wallets set spent_today = 900 where id=$1", [wallet]); await setDay("2020-01-01"); const w = (await call("GET", "/v1/wallets", A)).json.wallets[0]; return [w.spent_today, w.remaining_today]; })(), [0, 1000]);
eq("products' sold_today is caught up as well (terminal catalogue, payments)", await (async () => {
  const shop = (await (await app.fetch(new Request("http://x/v1/auth/signup", { method: "POST", headers: { "content-type": "application/json", authorization: "" }, body: JSON.stringify({ type: "B", name: "S", email: "s@example.com", password: "correct horse battery" }) }), env, ctx)).json()) as any;
  await q("update accounts set status='active' where id=$1", [shop.account_id]);
  const t = (await call("POST", "/v1/terminals", shop.session_token, { name: "T" })).json;
  const p = await q("insert into products (account_id, name, price, stock, sold_today, total_sold) values ($1, 'Coffee', 300, 50, 7, 7) returning id", [shop.account_id]);
  await setDay("2020-01-01");
  const list = await app.fetch(new Request("http://x/v1/terminal/products", { headers: { authorization: `Bearer ${t.session_token}` } }), env, ctx);
  return [list.status, (await q("select sold_today::int s from products where id=$1", [p[0].id]))[0].s];
})(), [200, 0]);
eq("several days missed is one reset, not several", await (async () => { await q("update wallets set spent_today = 50 where id=$1", [wallet]); await setDay("2026-01-01"); const r = await ensureDay(sql, "2026-01-09"); const r2 = await ensureDay(sql, "2026-01-09"); return [r.reset, r2.reset, await day()]; })(), [true, false, "2026-01-09"]);

// ---- concurrency at the rollover: one reset, no lost spend
await q("update wallets set daily_limit = null, spent_today = 5000 where id=$1", [wallet]);
await setDay("2020-01-01");
const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => send("burst" + i, 10)));
eq("ten simultaneous sends across the rollover: all succeed, the day is reset once, and spent_today is exactly what was sent since", [burst.every((r) => r.status === 201), await spent(), await day() === today], [true, 100, true]);

// ---- the heartbeat and the table
eq("the system table holds the reset day and, after any cron run, when the cron last ran; daily_reset is gone", [(await q("select key from system order by key")).map((r) => r.key), (await q("select to_regclass('daily_reset') as t"))[0].t], [["cron_last_run", "daily_reset_day"], null]);

// ---- the entry point Cloudflare calls
const worker = (await import("../src/index.ts")).default as any;
await setDay("2026-03-07"); await q("update wallets set spent_today = 777 where id=$1", [wallet]);
let pending: Promise<unknown>[] = [];
await worker.scheduled({ scheduledTime: at(2026, 3, 8, 4), cron: "0 4 * * *" }, env, { waitUntil: (p: Promise<unknown>) => pending.push(p) });
await Promise.all(pending);
eq("scheduled(): the 04:00 UTC run on 8 March is still 7 March in New York: nothing to do", [await spent(), await day()], [777, "2026-03-07"]);
pending = [];
await worker.scheduled({ scheduledTime: at(2026, 3, 8, 5), cron: "0 5 * * *" }, env, { waitUntil: (p: Promise<unknown>) => pending.push(p) });
await Promise.all(pending);
eq("scheduled(): the 05:00 UTC run (00:00 EST) resets", [await spent(), await day()], [0, "2026-03-08"]);
eq("scheduled() records the run time it was given", (await q("select value v from system where key = 'cron_last_run'"))[0].v, new Date(at(2026, 3, 8, 5)).toISOString());
await sql.end();
console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
