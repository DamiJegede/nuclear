import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { connect } from "../src/db.ts";
import { dailyJobs } from "../src/lib/cron.ts";
import { addDays, takeSnapshot } from "../src/lib/snapshots.ts";
import { migrate, psql, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
psql(["-c", "alter table transactions disable trigger transactions_no_update"]);   // this suite places a day's transactions on that day by hand
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const env: any = { HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (m: string, p: string, o: { body?: unknown; token?: string; key?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + p, { method: m, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const sign = async (name: string, email: string, type = "C") => (await call("POST", "/v1/auth/signup", { body: { type, name, email, password: "correct horse battery" } })).json;
const sql = connect(env);
const today = (await q("select (now() at time zone 'America/New_York')::date::text d"))[0].d as string;
const D = (n: number) => addDays(today, n);
const noon = (d: string) => `(('${d}'::date)::timestamp + interval '12 hours') at time zone 'America/New_York'`;
// everything made so far (still dated now) belongs to day `d`
const place = (d: string) => q(`update transactions set created_at = ${noon(d)} where created_at > now() - interval '10 minutes'`);
const night = async (d: string) => { await takeSnapshot(sql, d); return (await q("select reconciled, drift::int drift, drift_credit::int dc, drift_wallets::int dw, drift_conservation::int dcons, effects_delta::int ed, edge_flows::int ef, balance_midnight::int bm, reconciliation from snapshots where snapshot_date = $1::date", [d]))[0]; };

const ada = await sign("Ada", "ada@x.test"), bob = await sign("Bob", "bob@x.test"), shop = await sign("Shop", "shop@x.test", "B");
await q("update accounts set status='active' where id=$1", [shop.account_id]);
const term = (await call("POST", "/v1/terminals", { token: shop.session_token, body: { name: "T" } })).json.terminal.id;

// ---- the first night is the baseline: nothing to compare with, so the drift starts at 0
const n0 = await night(D(-4));
eq("first night: green, drift 0, balances were 0 at that midnight", [n0.reconciled, n0.drift, n0.bm], [true, 0, 0]);

// ---- a day of loads, sends and payments: the change in balances is exactly what the transactions did
await call("POST", "/v1/sandbox/fundings", { token: ada.session_token, key: "f1", body: { amount: 50000 } });
await call("POST", "/v1/transfers", { token: ada.session_token, key: "s1", body: { to_wallet_id: bob.default_wallet_id, amount: 12000 } });
await call("POST", "/v1/payments", { token: bob.session_token, key: "p1", body: { terminal_id: term, amount: 3000 } });
await call("POST", "/v1/payments", { token: ada.session_token, key: "p2", body: { terminal_id: term, amount: 999999999 } });   // declined: no effect
await place(D(-3));
const n1 = await night(D(-3));
eq("a normal day reconciles: balances rose by the load, exactly", [n1.reconciled, n1.drift, n1.dc, n1.dcons, n1.ed, n1.ef, n1.bm], [true, 0, 0, 0, 50000, 50000, 50000]);
eq("and the Overview's stored result is this night's", (await q("select value from system where key='reconciliation_snapshot'"))[0].value.includes('"balances_match_ledger":true'), true);

// ---- a purchase and a payment with credit, on the next day
await q("update balances set credit_limit = 20000 where account_id=$1", [bob.account_id]);
await call("POST", "/v1/payments", { token: bob.session_token, key: "p3", body: { terminal_id: term, amount: 15000 } });
await place(D(-2));
const n2 = await night(D(-2));
eq("a payment that used credit still reconciles (credit drawn is checked beside balances)", [n2.reconciled, n2.drift, n2.dc, n2.dcons], [true, 0, 0, 0]);

// ---- a balance that changed with no transaction: red, with the gap, and it STAYS red on the quiet nights after
await q("update balances set balance = balance + 7 where account_id=$1", [ada.account_id]);
const n3 = await night(D(-1));
eq("a balance 7 too high is flagged with the gap", [n3.reconciled, n3.drift, n3.reconciliation.balances_match_ledger, n3.reconciliation.balance_difference], [false, 7, false, 7]);
eq("the Overview shows it", (await call("GET", "/v1/admin/stats", { token: OP })).json.reconciliation.balance_difference, 7);
const n4 = await night(today);
eq("a quiet night after it is still red (the drift is carried, not forgotten)", [n4.reconciled, n4.drift], [false, 7]);

// ---- fixing it: undo the balance change; the correcting night brings the drift back to 0
await q("update balances set balance = balance - 7 where account_id=$1", [ada.account_id]);
const n5 = await night(D(1));
eq("correcting the balance clears the drift", [n5.reconciled, n5.drift], [true, 0]);

// ---- the other fix: the transaction that was missing, written as an adjustment (the balance is right, the books were short)
await q("update balances set balance = balance + 9 where account_id=$1", [ada.account_id]);
const n6 = await night(D(2));
eq("9 unexplained: red", [n6.reconciled, n6.drift], [false, 9]);
await q("insert into transactions (type, status, from_wallet_id, to_wallet_id, amount, account_id, idem, meta, created_at) values ('adjustment','completed','00000000-0000-7000-8000-000000000002',$1,9,'00000000-0000-7000-8000-000000000001','adj-9','{\"reason\":\"missing load\"}', " + noon(D(3)) + ")", [ada.default_wallet_id]);
const n7 = await night(D(3));
eq("an adjustment that records it brings the books to the balance: drift 0 (conservation too, as the bank wallet is the edge)", [n7.reconciled, n7.drift, n7.ed, n7.ef], [true, 0, 9, 9]);

// ---- the job order: the snapshot (with its check) is made BEFORE settlement and the schedule create the new day's transactions
const job: any = await dailyJobs(Date.parse(`${D(6)}T05:01:00Z`), env);
eq("the nightly job reports the check it just ran", [job.snapshots.length > 0, typeof job.reconciled], [true, "boolean"]);
console.log(`\n${pass} passed, ${fail} failed`);
await sql.end(); await adm.end();
process.exit(fail ? 1 : 0);
