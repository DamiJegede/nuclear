import { writeFileSync } from "node:fs";
process.on("uncaughtException", (e: any) => { writeFileSync("/tmp/prog.err", String(e?.stack ?? e)); process.exit(1); });
process.on("unhandledRejection", (e: any) => { writeFileSync("/tmp/prog.err", String(e?.stack ?? e)); process.exit(1); });
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
import { connect } from "../src/db.ts";
import { addDays, nextRunAfter, nextWeekday, runDuePrograms, weekdayOf } from "../src/lib/programs.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const mails: { to: string; subject: string; text: string }[] = [];
const env: any = { STATS_TTL_SECONDS: "0", HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true", APP_URL: "https://app.test", EMAIL_FROM: "n <n@test>", EMAIL: { send: async (m: any) => { if (m.subject !== "Verify your email for Nuclear") mails.push(m); } } };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (m: string, p: string, o: { body?: unknown; token?: string; key?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + p, { method: m, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const sign = async (name: string, email: string, type = "C") => (await call("POST", "/v1/auth/signup", { body: { type, name, email, password: "correct horse battery" } })).json;
const reconciled = async () => (await call("GET", "/v1/admin/stats", { token: OP })).json.reconciliation;
const bankroll = async (accountId: string, cents: number) => q(`do $$ declare bank uuid; fid uuid; tid uuid; w uuid; begin
  insert into bank_accounts (account_id, routing_number, account_number, last4) values ('${accountId}', 'SANDBOX', 'SANDBOX', '0000') returning id into bank;
  insert into fundings (account_id, bank_account_id, amount, idempotency_key, status) values ('${accountId}', bank, ${cents}, 'bk-' || gen_random_uuid(), 'created') returning id into fid;
  select id into w from wallets where account_id = '${accountId}' and type = 'default';
  insert into transactions (type, status, from_wallet_id, to_wallet_id, amount, funding_id, account_id, idem) values ('fund', 'completed', '00000000-0000-7000-8000-000000000002', w, ${cents}, fid, '${accountId}', 'fund:' || 'bk-' || gen_random_uuid()) returning id into tid;
  update balances set balance = balance + ${cents} where account_id = '${accountId}';
  update fundings set status = 'completed', released_at = now(), transaction_id = tid where id = fid; end $$`);

// ---- schedule arithmetic (dates are program days, YYYY-MM-DD)
eq("dates: weekday of a known date and adding days", [weekdayOf("2026-10-20"), addDays("2026-10-31", 1), addDays("2026-12-31", 1)], [2, "2026-11-01", "2027-01-01"]);
eq("monthly: the next day-15 after a date, this month or next, across a year end", [nextRunAfter({ cadence: "monthly", day_of_month: 15, weekday: null, start_date: null }, "2026-10-14"), nextRunAfter({ cadence: "monthly", day_of_month: 15, weekday: null, start_date: null }, "2026-10-15"), nextRunAfter({ cadence: "monthly", day_of_month: 1, weekday: null, start_date: null }, "2026-12-31"), nextRunAfter({ cadence: "monthly", day_of_month: 28, weekday: null, start_date: null }, "2027-02-27")], ["2026-10-15", "2026-11-15", "2027-01-01", "2027-02-28"]);
eq("weekly: the next Friday strictly after a date", [nextWeekday(5, "2026-10-20"), nextWeekday(5, "2026-10-23"), nextRunAfter({ cadence: "weekly", day_of_month: null, weekday: 5, start_date: null }, "2026-10-23")], ["2026-10-23", "2026-10-30", "2026-10-30"]);
eq("biweekly: every 14 days from the first payment date, never off the anchor", [nextRunAfter({ cadence: "biweekly", day_of_month: null, weekday: 5, start_date: "2026-10-23" }, "2026-10-20"), nextRunAfter({ cadence: "biweekly", day_of_month: null, weekday: 5, start_date: "2026-10-23" }, "2026-10-23"), nextRunAfter({ cadence: "biweekly", day_of_month: null, weekday: 5, start_date: "2026-10-23" }, "2026-11-06"), nextRunAfter({ cadence: "biweekly", day_of_month: null, weekday: 5, start_date: "2026-10-23" }, "2026-11-10")], ["2026-10-23", "2026-11-06", "2026-11-20", "2026-11-20"]);

// ---- the program is created at sign-up
const acme = await sign("Acme", "hr@acme.test", "O");
const cus = await sign("Cus", "cus@x.test");
const prog = async () => (await call("GET", "/v1/org/program", { token: acme.session_token })).json.program;
eq("signup: an organization gets its program row at once: Flexible and not chosen yet", [(await q("select program_mode as mode, program_chosen_at is null as unchosen from businesses where account_id=$1", [acme.account_id]))[0], (await q("select count(*)::int n from businesses where account_id=$1", [cus.account_id]))[0].n], [{ mode: "flexible", unchosen: true }, 0]);
eq("program: starts Flexible, not chosen; only organizations read it", [(await prog()).mode, (await prog()).chosen, (await call("GET", "/v1/org/program", { token: cus.session_token })).status], ["flexible", false, 403]);
const today = new Date().toISOString().slice(0, 10);
eq("program: choosing Flexible marks it chosen and schedules nothing", [(await call("PUT", "/v1/org/program", { token: acme.session_token, body: { mode: "flexible" } })).json.program.chosen, (await prog()).next_run_date], [true, null]);
eq("program: bad schedules are refused (day 29, weekday 7, missing fields, unknown cadence)", [
  (await call("PUT", "/v1/org/program", { token: acme.session_token, body: { mode: "fixed", cadence: "monthly", day_of_month: 29 } })).status,
  (await call("PUT", "/v1/org/program", { token: acme.session_token, body: { mode: "fixed", cadence: "weekly", weekday: 7 } })).status,
  (await call("PUT", "/v1/org/program", { token: acme.session_token, body: { mode: "fixed", cadence: "monthly" } })).status,
  (await call("PUT", "/v1/org/program", { token: acme.session_token, body: { mode: "fixed", cadence: "daily", weekday: 1 } })).status], [400, 400, 400, 400]);
const fx = await call("PUT", "/v1/org/program", { token: acme.session_token, body: { mode: "fixed", cadence: "monthly", day_of_month: 15 } });
eq("program: Fixed monthly day 15 starts with the first 15th after today", [fx.status, fx.json.program.mode, fx.json.program.cadence, fx.json.program.day_of_month, fx.json.program.next_run_date > today, fx.json.program.next_run_date.endsWith("-15")], [200, "fixed", "monthly", 15, true, true]);
const bw = await call("PUT", "/v1/org/program", { token: acme.session_token, body: { mode: "fixed", cadence: "biweekly", weekday: 5 } });
eq("program: biweekly starts on the next chosen weekday and every 14 days from it", [weekdayOf(bw.json.program.start_date), bw.json.program.next_run_date === bw.json.program.start_date, bw.json.program.start_date > today], [5, true, true]);

// ---- fixed benefits on employees: portal upload, API, per-employee edit
await bankroll(acme.account_id, 1_000_000);
const rows = [{ employee_id: "E1", name: "Eve One", email: "eve@x.test", fixed_benefit: 5000 }, { employee_id: "E2", name: "Sam Two", email: "sam@x.test", fixed_benefit: 2500 }, { employee_id: "E3", name: "No Fixed", email: "nofixed@x.test", fixed_benefit: 0 }];
const up = await call("POST", "/v1/org/fixed-benefits", { token: acme.session_token, body: { rows } });
eq("fixed: a file sets fixed benefits (0 clears), creates the employees, and answers what the next payment is", [up.status, up.json.fixed, (await q("select employee_id, fixed_benefit::int f from employees order by employee_id")).map((r: any) => [r.employee_id, r.f])], [200, { employees: 2, total: 7500 }, [["E1", 5000], ["E2", 2500], ["E3", null]]]);
eq("fixed: bad rows refuse the whole file; duplicates too", [(await call("POST", "/v1/org/fixed-benefits", { token: acme.session_token, body: { rows: [rows[0], { employee_id: "bad id", name: "x", email: "x@x.co", fixed_benefit: 1 }] } })).status, (await call("POST", "/v1/org/fixed-benefits", { token: acme.session_token, body: { rows: [rows[0], rows[0]] } })).json.error, (await call("POST", "/v1/org/fixed-benefits", { token: acme.session_token, body: { rows: [{ ...rows[0], fixed_benefit: 10_000_001 }] } })).status], [400, "duplicate_employee_id", 400]);
const e3 = (await call("GET", "/v1/org/employees", { token: acme.session_token })).json.employees.find((e: any) => e.employee_id === "E3");
eq("fixed: the employee list shows each fixed benefit; one employee can be edited or cleared", [(await call("GET", "/v1/org/employees", { token: acme.session_token })).json.employees.map((e: any) => [e.employee_id, e.fixed_benefit]).sort(), (await call("PATCH", `/v1/org/employees/${e3.id}`, { token: acme.session_token, body: { fixed_benefit: 1000 } })).json.fixed_benefit, (await call("PATCH", `/v1/org/employees/${e3.id}`, { token: acme.session_token, body: { fixed_benefit: null } })).json.fixed_benefit], [[["E1", 5000], ["E2", 2500], ["E3", null]], 1000, null]);
// the Benefits API sets, clears and reads it too
const key = (await call("POST", "/v1/org/api-key", { token: acme.session_token })).json.token;
const capi = (m: string, p: string, body?: unknown) => call(m, `/v1/benefits-api${p}`, { token: key, body });
await capi("POST", "/employees", { employees: [{ employee_id: "E4", name: "Api Four", email: "four@x.test", fixed_benefit: 4000 }, { employee_id: "E2", name: "Sam Two", email: "sam@x.test" }] });
const g = (await capi("POST", "/employees/get", { employee_ids: ["E4", "E2", "E3"] })).json.employees;
eq("fixed: the Benefits API sets it, leaves it alone when omitted, and reads it back", g.map((e: any) => [e.employee_id, e.fixed_benefit]), [["E4", 4000], ["E2", 2500], ["E3", null]]);
await capi("POST", "/employees", { employees: [{ employee_id: "E4", name: "Api Four", email: "four@x.test", fixed_benefit: 0 }] });
eq("fixed: 0 through the API clears it", (await capi("POST", "/employees/get", { employee_ids: ["E4"] })).json.employees[0].fixed_benefit, null);

// ---- the scheduler
const cusToken = (await sign("Cus Bulk", "cusbulk@x.test")).session_token;
const sql = connect(env);
const release = () => q("update businesses set program_last_attempt_at = null");
const runDay = async (d: string) => { await release(); return runDuePrograms(env, sql, d); };
await call("PUT", "/v1/org/program", { token: acme.session_token, body: { mode: "fixed", cadence: "monthly", day_of_month: 15 } });
const due = (await prog()).next_run_date as string;
const balanceOf = async () => Number((await q("select shared_funds($1) as balance", [acme.account_id]))[0].balance);
eq("scheduler: nothing runs before the payment date", [await runDay(addDays(due, -10)), (await q("select count(*)::int n from benefit_runs where source='schedule'"))[0].n], [{ warned: 0, credited: 0, waiting: 0, missed: 0, skipped: 0 }, 0]);
const r1 = await runDay(due);
const run = (await q("select source, status, run_date::text d, row_count, total::int t, sent::int s, held::int h, attempts from benefit_runs where idempotency_key = $1", ["program:" + due]))[0];
eq("scheduler: on the date it credits every employee with a fixed benefit as one scheduled run", [r1.credited, run], [1, { source: "schedule", status: "credited", d: due, row_count: 2, t: 7500, s: 0, h: 7500, attempts: 1 }]);
eq("scheduler: money moved once; employees hold their credit in escrow; the books reconcile", [await balanceOf(), (await q("select employee_id, balance::int b from employees where fixed_benefit is not null order by employee_id")).map((r: any) => [r.employee_id, r.b]), (await reconciled()).ledger_balanced, (await reconciled()).escrow_matches_employees], [1_000_000 - 7500, [["E1", 5000], ["E2", 2500]], true, true]);
eq("scheduler: unclaimed employees were emailed a claim link on the first credit", [mails.filter((m) => /claim\?token/.test(m.text)).map((m) => m.to).sort()], [["eve@x.test", "sam@x.test"]]);
const next = (await prog()).next_run_date as string;
eq("scheduler: the program moves on to its next date (a month later)", [next > due, next.endsWith("-15"), (await q("select program_warned_for as warned_for from businesses where account_id=$1", [acme.account_id]))[0].warned_for], [true, true, null]);
eq("scheduler: running it again, even twice at once, credits nothing more", [await runDay(due), (await release().then(() => Promise.all([runDuePrograms(env, sql, due), runDuePrograms(env, sql, due)]))).map((x) => x.credited), await balanceOf()], [{ warned: 0, credited: 0, waiting: 0, missed: 0, skipped: 0 }, [0, 0], 1_000_000 - 7500]);

// next cycle: the already-told unclaimed employees get the money held but no new email and their old link still works
const mailsBefore = mails.length;
const tokenOf = (to: string) => decodeURIComponent(mails.filter((m) => m.to === to).at(-1)!.text.match(/claim\?token=([^\s]+)/)![1]);
const eveToken = tokenOf("eve@x.test");
const r2 = await runDay(next);
eq("cycle 2: credited again; unclaimed employees are not emailed every cycle", [r2.credited, mails.length - mailsBefore, (await q("select employee_id, balance::int b from employees where fixed_benefit is not null order by employee_id")).map((r: any) => [r.employee_id, r.b])], [1, 0, [["E1", 10000], ["E2", 5000]]]);
const eve = await sign("Eve", "eve@x.test");
const cl = await call("POST", "/v1/employee/claims", { token: eve.session_token, body: { token: eveToken } });
eq("cycle 2: the link from the first email still claims everything held so far into the Benefits wallet", [cl.status, cl.json.claimed, cl.json.wallet.balance], [200, 10000, 10000]);
const next2 = (await prog()).next_run_date as string;
const r3 = await runDay(next2);
eq("cycle 3: a claimed employee is credited straight into the Benefits wallet", [r3.credited, (await call("GET", "/v1/wallets", { token: eve.session_token })).json.wallets.find((w: any) => w.type === "benefits").balance, (await reconciled()).benefits_match_ledger], [1, 15000, true]);

// removed employees and employees without a fixed benefit are skipped
const e2 = (await call("GET", "/v1/org/employees", { token: acme.session_token })).json.employees.find((e: any) => e.employee_id === "E2");
await q("update employees set balance = 0 where id = $1", [e2.id]);      // (test shortcut so it can be removed)
await q("update accounts set name = name where id = $1", [acme.account_id]);
await capi("POST", "/employees/remove", { employee_ids: ["E2"] });
const next3 = (await prog()).next_run_date as string;
const r4 = await runDay(next3);
eq("scheduler: a removed employee is skipped; the run carries only who is active with a fixed benefit", [r4.credited, (await q("select row_count, total::int t from benefit_runs where idempotency_key=$1", ["program:" + next3]))[0]], [1, { row_count: 1, t: 5000 }]);

// ---- short funds: warn ahead, retry, then missed
const lowOrg = await sign("Lowfunds Inc", "low@org.test", "O");
const lkey = (await call("POST", "/v1/org/api-key", { token: lowOrg.session_token })).json.token;
await call("POST", "/v1/org/fixed-benefits", { token: lowOrg.session_token, body: { rows: [{ employee_id: "L1", name: "Lee", email: "lee@x.test", fixed_benefit: 50000 }] } });
await bankroll(lowOrg.account_id, 20000);
await call("PUT", "/v1/org/program", { token: lowOrg.session_token, body: { mode: "fixed", cadence: "weekly", weekday: 3 } });
const ldue = (await call("GET", "/v1/org/program", { token: lowOrg.session_token })).json.program.next_run_date as string;
const m0 = mails.length;
const w1 = await runDay(addDays(ldue, -2));
eq("short funds: a warning email goes to the organization when the wallet will not cover the payment", [w1.warned, mails.slice(m0).filter((m) => m.to === "low@org.test").length, /need/.test(mails.at(-1)!.subject)], [1, 1, true]);
eq("short funds: the warning is sent once per payment", [(await runDay(addDays(ldue, -1))).warned, mails.length - m0], [0, 1]);
const lrun = async () => (await q("select status, attempts, failure_code, total::int t from benefit_runs where org_account_id=$1 and source='schedule' order by run_date desc limit 1", [lowOrg.account_id]))[0];
eq("short funds: on the date the run is recorded as waiting for funds, nothing is credited", [(await runDay(ldue)).waiting, await lrun(), (await q("select count(*)::int n from employees where org_account_id=$1 and balance > 0", [lowOrg.account_id]))[0].n], [1, { status: "waiting_for_funds", attempts: 1, failure_code: "insufficient_balance", t: 50000 }, 0]);
eq("short funds: the next day it tries again and is still waiting", [(await runDay(addDays(ldue, 1))).waiting, (await lrun()).attempts], [1, 2]);
await bankroll(lowOrg.account_id, 40000);                       // funds arrive on day 3's morning
const m1 = mails.length;
const w3 = await runDay(addDays(ldue, 2));
eq("short funds: once funded within the window it is credited once, under the same run", [w3.credited, await lrun(), (await q("select count(*)::int n from benefit_runs where org_account_id=$1 and source='schedule'", [lowOrg.account_id]))[0].n], [1, { status: "credited", attempts: 3, failure_code: null, t: 50000 }, 1]);

const missOrg = await sign("Misses Ltd", "miss@org.test", "O");
await call("POST", "/v1/org/fixed-benefits", { token: missOrg.session_token, body: { rows: [{ employee_id: "M1", name: "Mo", email: "mo@x.test", fixed_benefit: 90000 }] } });
await call("PUT", "/v1/org/program", { token: missOrg.session_token, body: { mode: "fixed", cadence: "monthly", day_of_month: 10 } });
const mdue = (await call("GET", "/v1/org/program", { token: missOrg.session_token })).json.program.next_run_date as string;
for (let d = 0; d < 3; d++) { await runDay(addDays(mdue, d)); }
const mrun = (await q("select status, attempts, failure_code from benefit_runs where org_account_id=$1 and source='schedule'", [missOrg.account_id]))[0];
eq("short funds: after three tries the payment is missed, nothing is credited, the organization is emailed, and the program moves on", [mrun, mails.some((m) => m.to === "miss@org.test" && /missed/.test(m.subject)), (await call("GET", "/v1/org/program", { token: missOrg.session_token })).json.program.next_run_date > mdue], [{ status: "missed", attempts: 3, failure_code: "insufficient_balance" }, true, true]);

// two crons at once: a due program is claimed, so it is paid exactly once
const raceOrg = await sign("Race Co", "race@org.test", "O");
await call("POST", "/v1/org/fixed-benefits", { token: raceOrg.session_token, body: { rows: [{ employee_id: "R1", name: "Ray", email: "ray@x.test", fixed_benefit: 1000 }] } });
await bankroll(raceOrg.account_id, 50000);
await call("PUT", "/v1/org/program", { token: raceOrg.session_token, body: { mode: "fixed", cadence: "weekly", weekday: 2 } });
const rdue = (await call("GET", "/v1/org/program", { token: raceOrg.session_token })).json.program.next_run_date as string;
await release();
const race = await Promise.all([runDuePrograms(env, sql, rdue), runDuePrograms(env, sql, rdue), runDuePrograms(env, sql, rdue)]);
eq("scheduler: three simultaneous cron runs pay a due program exactly once", [race.reduce((t, x) => t + x.credited, 0), (await q("select count(*)::int n, coalesce(sum(total),0)::int t from benefit_runs where org_account_id=$1", [raceOrg.account_id]))[0], (await q("select shared_funds($1)::int b", [raceOrg.account_id]))[0].b], [1, { n: 1, t: 1000 }, 49000]);

// ---- mass edit: one action on many employees, all or nothing
const bulk = (token: string, body: unknown) => call("POST", "/v1/org/employees/bulk", { token, body });
const idOf = async (eid: string) => (await q("select id from employees where org_account_id=$1 and employee_id=$2", [acme.account_id, eid]))[0]?.id as string;
const bE1 = await idOf("E1"), bE3 = await idOf("E3"), bE4 = await idOf("E4");
const fixedOf = async (ids: string[]) => (await q("select employee_id, fixed_benefit from employees where id = any($1::uuid[]) order by employee_id", [ids])).map((r: any) => [r.employee_id, r.fixed_benefit === null ? null : Number(r.fixed_benefit)]);
eq("bulk: set a fixed benefit for several employees at once", [(await bulk(acme.session_token, { ids: [bE1, bE3, bE4], action: "set_fixed", amount: 3300 })).json, await fixedOf([bE1, bE3, bE4])], [{ action: "set_fixed", count: 3 }, [["E1", 3300], ["E3", 3300], ["E4", 3300]]]);
eq("bulk: clear fixed benefits for several at once", [(await bulk(acme.session_token, { ids: [bE1, bE3], action: "clear_fixed" })).json.count, await fixedOf([bE1, bE3, bE4])], [2, [["E1", null], ["E3", null], ["E4", 3300]]]);
await q("update employees set balance = 500 where id = $1", [bE4]);          // E4 has credit held (as an unclaimed employee after a payment would)
const rmBulk = await bulk(acme.session_token, { ids: [bE3, bE4], action: "remove" });
eq("bulk: removing people who still have credit held is allowed; the answer says how much stays theirs and the money is untouched", [rmBulk.json, (await q("select employee_id, status, balance::int b from employees where id = any($1::uuid[]) order by employee_id", [[bE3, bE4]])).map((r: any) => [r.employee_id, r.status, r.b])], [{ action: "remove", count: 2, held_total: 500 }, [["E3", "removed", 0], ["E4", "removed", 500]]]);
await q("update employees set status = 'active' where id = any($1::uuid[])", [[bE3, bE4]]);       // (back for the rest of this suite)
const freeIds = (await q("insert into employees (org_account_id, employee_id, name, email) values ($1,'F1','Free One','f1@x.test'), ($1,'F2','Free Two','f2@x.test') returning id", [acme.account_id])).map((r: any) => r.id);
eq("bulk: employees with nothing held are removed together, and vanish from the list", [(await bulk(acme.session_token, { ids: freeIds, action: "remove" })).json, (await call("GET", "/v1/org/employees", { token: acme.session_token })).json.employees.some((e: any) => ["F1", "F2"].includes(e.employee_id))], [{ action: "remove", count: 2, held_total: 0 }, false]);
eq("bulk: an unknown, removed or other organization's id is a 404 and changes nothing; bad bodies and strangers are refused", [(await bulk(acme.session_token, { ids: [bE4, freeIds[0]], action: "set_fixed", amount: 100 })).json, (await bulk(raceOrg.session_token, { ids: [bE4], action: "clear_fixed" })).status, (await fixedOf([bE4])), (await bulk(acme.session_token, { ids: [bE4], action: "set_fixed", amount: 0 })).status, (await bulk(acme.session_token, { ids: [], action: "remove" })).status, (await bulk(acme.session_token, { ids: [bE4, bE4], action: "clear_fixed" })).status, (await bulk(cusToken, { ids: [bE4], action: "clear_fixed" })).status], [{ error: "employee_not_found", ids: [freeIds[0]] }, 404, [["E4", 3300]], 400, 400, 422, 403]);
await q("update employees set balance = 0 where id = $1", [bE4]);

// ---- switching modes
eq("switching: Flexible stops the schedule and keeps the fixed amounts; Fixed again picks a new date", [(await call("PUT", "/v1/org/program", { token: acme.session_token, body: { mode: "flexible" } })).json.program.next_run_date, (await q("select count(*)::int n from employees where org_account_id=$1 and fixed_benefit is not null", [acme.account_id]))[0].n > 0, (await runDay(addDays(next3, 40))).credited], [null, true, 0]);
eq("switching: changing the schedule closes anything still waiting under the old one", await (async () => { await q("update businesses set program_last_attempt_at = null where account_id = $1", [missOrg.account_id]); await q("insert into benefit_runs (org_account_id, source, run_date, status, idempotency_key, row_count, total, failure_code) values ($1,'schedule',current_date,'waiting_for_funds','program:x',1,100,'insufficient_balance')", [missOrg.account_id]); await call("PUT", "/v1/org/program", { token: missOrg.session_token, body: { mode: "fixed", cadence: "weekly", weekday: 1 } }); return (await q("select status, failure_code from benefit_runs where idempotency_key='program:x'"))[0]; })(), { status: "missed", failure_code: "schedule_changed" });
eq("flexible: a Flexible organization is never touched by the scheduler, and one-off credits still work in Fixed mode", [(await runDay("2099-01-01")).credited, (await capi("POST", "/credits", { credits: [{ employee_id: "E1", amount: 1000 }] }).then(() => 0)) === 0], [0, true]);
await sql.end();
console.log(`\n${pass} passed, ${fail} failed`);
await adm.end();
process.exit(fail ? 1 : 0);
