import { writeFileSync } from "node:fs";
process.on("uncaughtException", (e: any) => { writeFileSync("/tmp/caps.err", String(e?.stack ?? e)); process.exit(1); });
process.on("unhandledRejection", (e: any) => { writeFileSync("/tmp/caps.err", String(e?.stack ?? e)); process.exit(1); });
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
import { connect } from "../src/db.ts";
import { ensureDay } from "../src/lib/dailyReset.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 4, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const mails: { to: string; text: string }[] = [];
const env: any = { STATS_TTL_SECONDS: "0", HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true", APP_URL: "https://app.test", EMAIL_FROM: "n <n@test>", EMAIL: { send: async (m: any) => { if (m.subject !== "Verify your email for Nuclear") mails.push(m); } } };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (m: string, p: string, o: { body?: unknown; token?: string; key?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + p, { method: m, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const sign = async (name: string, email: string, type = "C") => (await call("POST", "/v1/auth/signup", { body: { type, name, email, password: "correct horse battery" } })).json;
const fund = (p: any, amount: number, key: string) => call("POST", "/v1/sandbox/fundings", { token: p.session_token, key, body: { amount } });
const wallet = async (p: any) => (await call("GET", "/v1/wallets", { token: p.session_token })).json.wallets.find((w: any) => w.type === "default").id as string;
const send = (p: any, to: string, amount: number, key: string) => call("POST", "/v1/transfers", { token: p.session_token, key, body: { to_wallet_id: to, amount, from_wallet_id: undefined } });
const cols = async (p: any) => (await q("select ordinary_opening::int o, added_today::int a, opening_day::text d from balances where account_id=$1", [p.account_id]))[0];
const room = async (p: any) => (await call("GET", "/v1/balance", { token: p.session_token })).json.daily_headroom;
const rec = async () => (await call("GET", "/v1/admin/stats", { token: OP })).json.reconciliation;
const todayNY = (await q("select (now() at time zone 'America/New_York')::date::text d"))[0].d as string;
const tomorrow = (await q("select ((now() at time zone 'America/New_York')::date + 1)::text d"))[0].d as string;
const sql = connect(env);

// ---- 1. the numbers live on the balances row
const ada = await sign("Ada", "ada@x.test"), bob = await sign("Bob", "bob@x.test");
eq("columns: a new consumer starts today with nothing opened and nothing added", [await cols(ada), await room(ada)], [{ o: 0, a: 0, d: todayNY }, 200_000]);
// ---- 2. loads count what is added today
eq("loads: each one adds to today's total; the room shrinks", [(await fund(ada, 150_000, "l1")).status, await cols(ada), await room(ada)], [201, { o: 0, a: 150_000, d: todayNY }, 50_000]);
eq("loads: one cent over the room is declined (recorded), the exact room passes, then nothing fits", [(await fund(ada, 50_001, "l2")).json.status_code, (await fund(ada, 50_000, "l3")).status, (await fund(ada, 1, "l4")).json.status_code, await room(ada)], ["daily_value_limit_exceeded", 201, "daily_value_limit_exceeded", 0]);
const wa = await wallet(ada), wb = await wallet(bob);
eq("spending and sending never give room back", [(await send(ada, wb, 100_000, "s1")).status, (await cols(ada)).a, await room(ada)], [201, 200_000, 0]);
eq("incoming sends count for the recipient, not the sender", [(await cols(bob)).a, await room(bob)], [100_000, 100_000]);

// ---- 3. a new program day: what you hold is the opening value, and it uses up room
await ensureDay(sql, tomorrow);
eq("daily roll: every consumer's opening value becomes what it actually holds and added-today restarts", [await cols(ada), await cols(bob)], [{ o: 100_000, a: 0, d: tomorrow }, { o: 100_000, a: 0, d: tomorrow }]);
eq("uniform rule: a load is held to cap - opening: with $1,000 held, $1,000 of room", [await room(ada), (await fund(ada, 100_001, "m1")).json.status_code, (await fund(ada, 100_000, "m2")).status, await room(ada)], [100_000, "daily_value_limit_exceeded", 201, 0]);
const cy = await sign("Cy", "cy@x.test");
await fund(cy, 190_000, "cy-load");
await ensureDay(sql, addDay(tomorrow));
function addDay(d: string) { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); }
eq("uniform rule: an incoming send is held to the same rule (recipient holds $1,900 -> $100 of room)", [(await send(bob, await wallet(cy), 10_001, "in1")).json.status_code, (await send(bob, await wallet(cy), 10_000, "in2")).status, (await send(bob, await wallet(cy), 1, "in3")).json.status_code, await room(cy)], ["recipient_limit_exceeded", 201, "recipient_limit_exceeded", 0]);

// ---- 4. what is never counted
const org = await sign("Org", "org@x.test", "O");
const shop = await sign("Shop", "shop@x.test", "B");
await q("update accounts set status='active' where id=$1", [shop.account_id]);
const term = (await call("POST", "/v1/terminals", { token: shop.session_token, body: { name: "T", allow_refunds: true } })).json;
const dee = await sign("Dee", "dee@x.test");
const ddw = await wallet(dee);
await fund(dee, 100_000, "dee-load");
const before = await cols(dee);
const pay = await call("POST", "/v1/payments", { token: dee.session_token, key: "dee-pay", body: { terminal_id: term.terminal.id, amount: 30_000, from_wallet_id: ddw } });
const rf = await call("POST", "/v1/terminal/refunds", { token: term.session_token, key: "dee-rf", body: { payment_id: pay.json.payment.id, mode: "full" } });
eq("refunds are never counted and never limited: spending then a refund leaves added-today where the load put it", [pay.status, rf.status, (await cols(dee)).a, before.a], [201, 201, before.a, 100_000]);
// an employer credit into a Benefits wallet and the claim are not additions
await q(`do $$ declare bank uuid; fid uuid; tid uuid; begin
  insert into bank_accounts (account_id, routing_number, account_number, last4) values ('${org.account_id}', 'SANDBOX', 'SANDBOX', '0000') returning id into bank;
  insert into fundings (account_id, bank_account_id, amount, idempotency_key, status) values ('${org.account_id}', bank, 500000, 'org-bk', 'created') returning id into fid;
  insert into transactions (type, from_account_id, to_account_id, from_bank_account_id, amount, status, idempotency_key, completed_at) values ('fund', '${org.account_id}', '${org.account_id}', bank, 500000, 'completed', 'org-bk', now()) returning id into tid;
  update balances set balance = balance + 500000 where account_id = '${org.account_id}';
  insert into ledger_entries (funding_id, posting_key, line_no, account_id, bucket, direction, amount) values (fid, 'release', 1, null, 'bank_settlement', 'debit', 500000), (fid, 'release', 2, '${org.account_id}', 'funded_balance', 'credit', 500000);
  update fundings set status = 'completed', released_at = now(), transaction_id = tid where id = fid; end $$`);
const key = (await call("POST", "/v1/org/api-key", { token: org.session_token })).json.token;
const eve = await sign("Eve", "eve@x.test");
await call("POST", "/v1/benefits-api/credits", { token: key, key: "c1", body: { credits: [{ employee_id: "E1", name: "Eve", email: "eve@x.test", amount: 400_000 }] } });
const tok = decodeURIComponent(mails.at(-1)!.text.match(/claim\?token=([^\s]+)/)![1]);
const cl = await call("POST", "/v1/employee/claims", { token: eve.session_token, body: { token: tok } });
eq("employer credits and claims are not additions: $4,000 of Benefits leaves the ordinary room untouched", [cl.status, cl.json.wallet.balance, await cols(eve), await room(eve)], [200, 400_000, { o: 0, a: 0, d: todayNY }, 200_000]);

// ---- 5. organizations and businesses are exempt
eq("exempt: an organization can load far more than $2,000 in a day and has no daily headroom", [(await fund(org, 1_500_000, "org-l1")).status, (await fund(org, 1_500_000, "org-l2")).status, await room(org), (await cols(org)).a], [201, 201, null, 0]);
eq("exempt: a business is not capped either", [(await fund(shop, 900_000, "shop-l1")).status, await room(shop)], [201, null]);

// ---- 6. races: the balances lock keeps the room honest
const fay = await sign("Fay", "fay@x.test"), gus = await sign("Gus", "gus@x.test");
await fund(gus, 100_000, "gus-load");
const race = await Promise.all([fund(fay, 120_000, "r1"), fund(fay, 120_000, "r2"), send(gus, await wallet(fay), 70_000, "r3")]);
eq("race: simultaneous loads and an incoming send cannot together pass $2,000 of room", [race.filter((r) => r.status === 201).length >= 1, race.filter((r) => r.status === 201 && true).length <= 2, (await cols(fay)).a <= 200_000, (await cols(fay)).a === race.reduce((t, r, i) => t + (r.status === 201 ? [120_000, 120_000, 70_000][i]! : 0), 0)], [true, true, true, true]);

eq("reconciliation: the counters on balances match the ledger for today (and a tampered counter is caught)", await (async () => {
  const ok = (await rec()).daily_caps_match_ledger;
  await q("update balances set added_today = added_today + 7 where account_id=$1", [fay.account_id]);
  const bad = (await rec()).daily_caps_match_ledger;
  await q("update balances set added_today = added_today - 7 where account_id=$1", [fay.account_id]);
  return [ok, bad, (await rec()).daily_caps_match_ledger];
})(), [true, false, true]);

// ---- 7. a row that missed its roll rolls itself, and the books agree
const hal = await sign("Hal", "hal@x.test");
await fund(hal, 60_000, "hal-1");
await q("update balances set opening_day = (now() at time zone 'America/New_York')::date - 1, added_today = 199_999, ordinary_opening = 5 where account_id=$1", [hal.account_id]);
eq("stale row: a missed roll is repaired on the next money movement (opening = what is held, added restarts)", [(await fund(hal, 10_000, "hal-2")).status, await cols(hal)], [201, { o: 60_000, a: 10_000, d: todayNY }]);
await sql.end();
console.log(`\n${pass} passed, ${fail} failed`);
await adm.end();
process.exit(fail ? 1 : 0);
