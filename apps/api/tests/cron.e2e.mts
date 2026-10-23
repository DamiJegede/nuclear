import postgres from "postgres";
import app from "../src/index.ts";
import { dailyJobs } from "../src/lib/cron.ts";
import { easternDate } from "../src/lib/dates.ts";
import { connect } from "../src/db.ts";
import { migrate, newDay, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 8, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const env: any = { HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), SANDBOX_FUNDING: "true" };
const ctx: any = { waitUntil() {}, passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const at = (y: number, m: number, d: number, h: number, min = 0) => Date.UTC(y, m - 1, d, h, min);
const sql = connect(env);

// ---- program dates around daylight saving
eq("04:00 UTC is the start of the New York day in summer, 05:00 UTC in winter", [easternDate(new Date(at(2026, 7, 15, 4))), easternDate(new Date(at(2026, 7, 15, 3, 59))), easternDate(new Date(at(2026, 1, 15, 5))), easternDate(new Date(at(2026, 1, 15, 4, 59)))], ["2026-07-15", "2026-07-14", "2026-01-15", "2026-01-14"]);
eq("spring forward (8 March 2026): 04:00 UTC is still 7 March, 05:00 UTC is 8 March; 04:00 UTC on the 9th is the 9th", [easternDate(new Date(at(2026, 3, 8, 4))), easternDate(new Date(at(2026, 3, 8, 5))), easternDate(new Date(at(2026, 3, 9, 4)))], ["2026-03-07", "2026-03-08", "2026-03-09"]);
eq("fall back (1 November 2026): 04:00 and 05:00 UTC are both 1 November; 05:00 UTC on the 2nd is the 2nd", [easternDate(new Date(at(2026, 11, 1, 4))), easternDate(new Date(at(2026, 11, 1, 5))), easternDate(new Date(at(2026, 11, 2, 4))), easternDate(new Date(at(2026, 11, 2, 5)))], ["2026-11-01", "2026-11-01", "2026-11-01", "2026-11-02"]);
eq("the database's program day is the New York calendar day", (await q("select (program_today() = (now() at time zone 'America/New_York')::date) ok"))[0].ok, true);

const call = async (method: string, path: string, token: string, body?: unknown, key?: string) => {
  const r = await app.fetch(new Request("http://x" + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(key ? { "idempotency-key": key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const signup = async (name: string, email: string, type = "C") => (await (await app.fetch(new Request("http://x/v1/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type, name, email, password: "correct horse battery" }) }), env, ctx)).json()) as any;
const A = await signup("A", "a@example.com"), bob = await signup("B", "b@example.com");
const wallet = A.default_wallet_id;
await call("POST", "/v1/sandbox/fundings", A.session_token, { amount: 100000 }, "f1");
const send = (key: string, amount = 100) => call("POST", "/v1/transfers", A.session_token, { to_wallet_id: bob.default_wallet_id, amount }, key);
const spentApi = async () => (await call("GET", "/v1/wallets", A.session_token)).json.wallets.find((w: any) => w.id === wallet).spent_today as number;

// ---- the counters roll themselves: no job resets them
await q("update wallets set daily_limit = 1000, spent_today = 1000 where id=$1", [wallet]);
eq("on the same day a wallet at its limit is declined", (await send("m1")).json.status_code, "spend_limit_exceeded");
await newDay(adm);                                        // midnight passes; nothing runs
eq("after midnight the wallet reads as spending nothing yet", await spentApi(), 0);
const first = await send("m2");
eq("the first send of the new day goes through and starts today's count", [first.status, await spentApi(), (await q("select spent_day = program_today() as today from wallets where id=$1", [wallet]))[0].today], [201, 100, true]);
eq("the next send the same day counts normally and is not reset again", [(await send("m3")).status, await spentApi()], [201, 200]);
await q("update wallets set spent_today = 900 where id=$1", [wallet]); await newDay(adm);
eq("reading a wallet after midnight shows today's limit remaining, not yesterday's spend", (await call("GET", "/v1/wallets", A.session_token)).json.wallets.find((w: any) => w.id === wallet).remaining_today, 1000);
eq("products' sold_today rolls the same way (terminal catalogue)", await (async () => {
  const shop = await signup("S", "s@example.com", "B");
  await q("update accounts set status='active' where id=$1", [shop.account_id]);
  const t = (await call("POST", "/v1/terminals", shop.session_token, { name: "T" })).json;
  const p = await q("insert into products (account_id, name, price, stock, sold_today, total_sold) values ($1, 'Coffee', 300, 50, 7, 7) returning id", [shop.account_id]);
  const before = (await (await app.fetch(new Request("http://x/v1/terminal/products", { headers: { authorization: `Bearer ${t.session_token}` } }), env, ctx)).json()) as any;
  await newDay(adm);
  const after = (await (await app.fetch(new Request("http://x/v1/terminal/products", { headers: { authorization: `Bearer ${t.session_token}` } }), env, ctx)).json()) as any;
  return [before.products[0].sold_today, after.products[0].sold_today, (await q("select total_sold::int s from products where id=$1", [p[0].id]))[0].s];
})(), [7, 0, 7]);

// ---- concurrency at the rollover: no lost spend
await q("update wallets set daily_limit = null, spent_today = 5000 where id=$1", [wallet]);
await newDay(adm);
const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => send("burst" + i, 10)));
eq("ten simultaneous sends across the rollover: all succeed and spent_today is exactly what was sent since", [burst.every((r) => r.status === 201), await spentApi()], [true, 100]);

// ---- the job and the table
const job = await dailyJobs(at(2026, 7, 15, 4), env);
eq("the daily job has no counter reset to do; it records its heartbeat", [(job as any).reset, (await q("select value v from system where key = 'cron_last_run'"))[0].v], [undefined, new Date(at(2026, 7, 15, 4)).toISOString()]);
eq("the system table holds only the cron heartbeat and the jobs' own markers; daily_reset is gone", [(await q("select key from system where key like 'daily%' or key = 'cron_last_run' order by key")).map((r) => r.key), (await q("select to_regclass('daily_reset') as t"))[0].t], [["cron_last_run"], null]);

// ---- the entry point Cloudflare calls
const worker = (await import("../src/index.ts")).default as any;
let pending: Promise<unknown>[] = [];
await worker.scheduled({ scheduledTime: at(2026, 3, 8, 5), cron: "0 5 * * *" }, env, { waitUntil: (p: Promise<unknown>) => pending.push(p) });
await Promise.all(pending);
eq("scheduled() records the run time it was given", (await q("select value v from system where key = 'cron_last_run'"))[0].v, new Date(at(2026, 3, 8, 5)).toISOString());
await sql.end();
console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
