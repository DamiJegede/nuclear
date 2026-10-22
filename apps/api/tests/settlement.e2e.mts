import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { connect } from "../src/db.ts";
import { runSettlement, confirmSettlement, pollSubmittedSettlements } from "../src/lib/settlement.ts";
import { sandboxAch, type AchProvider } from "../src/lib/ach.ts";
import { dailyJobs } from "../src/lib/cron.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const env: any = { STATS_TTL_SECONDS: "0", HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true", BANK_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const live: any = { ...env, SANDBOX_FUNDING: undefined };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (m: string, p: string, o: { body?: unknown; token?: string; key?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + p, { method: m, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const sign = async (name: string, email: string, type = "C") => (await call("POST", "/v1/auth/signup", { body: { type, name, email, password: "correct horse battery" } })).json;
const sql = connect(env);

async function merchant(name: string, email: string, withBank = true) {
  const m = await sign(name, email, "B");
  await q("update accounts set status='active' where id=$1", [m.account_id]);
  if (withBank) {
    await call("PUT", "/v1/business/profile", { token: m.session_token, body: { legal_name: name + " LLC", display_name: name } });
    await call("PUT", "/v1/business/bank", { token: m.session_token, body: { routing_number: "110000000", account_number: "0001234567" + email.length } });
  }
  const term = (await call("POST", "/v1/terminals", { token: m.session_token, body: { name: "Counter" } })).json;
  return { ...m, term: term.terminal.id, termToken: term.session_token };
}
const payer = await sign("Payer", "payer@x.test");
await call("POST", "/v1/sandbox/fundings", { token: payer.session_token, key: "f1", body: { amount: 150000 } });
let n = 0;
const sale = async (m: any, amount: number) => (await call("POST", "/v1/payments", { token: payer.session_token, key: `sale-${n++}`, body: { amount, terminal_id: m.term } })).json.payment;
const bal = async (m: any) => Number((await q("select balance from balances where account_id=$1", [m.account_id]))[0].balance);
const settles = (m: any) => q("select amount::int amount, status, status_code, (to_bank_account_id is not null) payout, idempotency_key from transactions where type='settle' and from_account_id=$1 order by timestamp, id", [m.account_id]);
const recon = async () => (await call("GET", "/v1/admin/stats", { token: OP })).json.reconciliation;

const A = await merchant("Alpha Cafe", "alpha@x.test");
const B = await merchant("Beta Books", "beta@x.test", false);
const C = await merchant("Gamma Grill", "gamma@x.test");
const S = await merchant("Sigma Shop", "sigma@x.test");
await q("update accounts set status='suspended' where id=$1", [S.account_id]);
await sale(A, 1000); await sale(A, 500); await sale(B, 700); await sale(C, 900);
const saleA = (await q("select id from transactions where type='pay' and to_account_id=$1 order by timestamp limit 1", [A.account_id]))[0].id;
await q("update accounts set status='active' where id=$1", [S.account_id]); await sale(S, 300); await q("update accounts set status='suspended' where id=$1", [S.account_id]);

// ---- no bank rail configured: nothing happens, nothing is pretended
eq("without a payment provider the job does nothing", await runSettlement(live, sql, "2026-08-22"), { ran: false, reason: "no_provider" });
eq("and claims no date", (await q("select count(*)::int n from settlements"))[0].n, 0);

// ---- the first run: whole net of every active merchant that has a bank
const r1: any = await runSettlement(env, sql, "2026-08-22");
eq("the run settles the day before", [r1.ran, r1.cutoff_date, r1.status], [true, "2026-08-21", "completed"]);
eq("two payouts: Alpha 1500 and Gamma 900", [r1.payouts, r1.collections, r1.payout_total, r1.collection_total], [2, 0, 2400, 0]);
eq("Alpha is paid its whole balance and holds none", [await settles(A), await bal(A)], [[{ amount: 1500, status: "completed", status_code: null, payout: true, idempotency_key: "settle:2026-08-21" }], 0]);
eq("a merchant without a bank keeps its money, no transaction", [await bal(B), (await settles(B)).length], [700, 0]);
eq("a suspended merchant keeps its money too", [await bal(S), (await settles(S)).length], [300, 0]);
eq("the run is recorded with its totals", (await q("select status, merchants, payout_total::int p, collection_total::int c, completed_at is not null done from settlements"))[0], { status: "completed", merchants: 2, p: 2400, c: 0, done: true });
eq("every settle row points at the run and is posted to the ledger once", (await q("select count(*)::int n from transactions t where type='settle' and settlement_id is not null and (select count(*) from ledger_entries l where l.transaction_id=t.id and l.posting_key='settle')=2"))[0].n, 2);
eq("the books still reconcile", await recon().then((r: any) => [r.ledger_balanced, r.balances_match_ledger]), [true, true]);
eq("the merchant sees the payout", (await call("GET", "/v1/business/payouts", { token: A.session_token })).json.payouts.map((p: any) => [p.kind, p.amount, p.status]), [["payout", 1500, "completed"]]);

// ---- running again, or the second cron of the day, does nothing
eq("the same day again does nothing", await runSettlement(env, sql, "2026-08-22"), { ran: false, reason: "already_done" });
eq("no second payout", [(await settles(A)).length, (await q("select count(*)::int n from settlements"))[0].n], [1, 1]);

// ---- sales after the cutoff belong to the next day
await sale(A, 250);
const r2: any = await runSettlement(env, sql, "2026-08-23");
eq("the next day pays only what was earned since", [r2.cutoff_date, r2.payouts, r2.payout_total, await bal(A)], ["2026-08-22", 1, 250, 0]);
eq("a merchant with nothing to settle gets no row", (await settles(C)).length, 1);

// ---- a negative net is collected, and only the bank's confirmation clears it
await call("POST", "/v1/terminal/refunds", { token: A.termToken, key: "ref-1", body: { payment_id: saleA, mode: "partial", amount: 600 } });
eq("refunds took the merchant below zero", await bal(A), -600);
const hold: AchProvider = { name: "hold", submit: async (k) => ({ reference: `hold-${k}` }), outcomes: async () => [] };
const r3: any = await runSettlement(env, sql, "2026-08-24", hold);
eq("a collection is created and submitted", [r3.payouts, r3.collections, r3.collection_total, r3.status], [0, 1, 600, "submitted"]);
eq("submitting does not clear the debt", await bal(A), -600);
eq("no ledger lines until the bank confirms", (await q("select count(*)::int n from ledger_entries where transaction_id in (select id from transactions where type='settle' and from_bank_account_id is not null)"))[0].n, 0);
const r4: any = await runSettlement(env, sql, "2026-08-25", hold);
eq("the next day does not collect the same debt again", [r4.collections, (await settles(A)).filter((t: any) => !t.payout).length], [0, 1]);
const open = (await q("select id from settlements where status='submitted' order by cutoff_date"))[0].id;
eq("polling with an undecided bank leaves it submitted", (await confirmSettlement(sql, open, hold)).status, "submitted");
const done = await pollSubmittedSettlements(env, sql);
eq("the bank's confirmation collects it", [done.completed, await bal(A), (await settles(A)).at(-1)], [1, 0, { amount: 600, status: "completed", status_code: null, payout: false, idempotency_key: "settle:2026-08-23" }]);
eq("only then does the ledger move, and it reconciles", [(await q("select count(*)::int n from ledger_entries where transaction_id in (select id from transactions where type='settle' and from_bank_account_id is not null)"))[0].n, await recon().then((r: any) => [r.ledger_balanced, r.balances_match_ledger])], [2, [true, true]]);

// ---- a payout the bank returns goes back to the merchant
await sale(C, 400);
const bounce: AchProvider = { name: "bounce", submit: async (k) => ({ reference: `b-${k}` }), outcomes: async (_r, items) => items.map((i) => ({ transactionId: i.transactionId, outcome: "returned" as const, code: "account_closed" })) };
const r5: any = await runSettlement(env, sql, "2026-08-26", bounce);
eq("the returned payout is marked returned", [r5.status, (await settles(C)).at(-1)], ["completed", { amount: 400, status: "returned", status_code: "account_closed", payout: true, idempotency_key: "settle:2026-08-25" }]);
eq("the money is back in the balance, reversed in the ledger", [await bal(C), (await q("select count(*)::int n from ledger_entries where posting_key='settle_return'"))[0].n], [400, 2]);
eq("and the books reconcile", await recon().then((r: any) => [r.ledger_balanced, r.balances_match_ledger]), [true, true]);
const r6: any = await runSettlement(env, sql, "2026-08-27");
eq("the next run pays it", [r6.payouts, r6.payout_total, await bal(C)], [1, 400, 0]);

// ---- a refused batch gives everything back
await sale(A, 800); await sale(C, 450);
const refuse: AchProvider = { name: "refuse", submit: async () => { throw new Error("bank down"); }, outcomes: async () => [] };
const r7: any = await runSettlement(env, sql, "2026-08-28", refuse);
eq("a batch the bank refuses fails the run", [r7.status, (await q("select status, failure_code from settlements where cutoff_date='2026-08-27'"))[0]], ["failed", { status: "failed", failure_code: "submit_failed" }]);
eq("every payout is returned to its merchant", [await bal(A), await bal(C)], [800, 450]);
eq("and the day after, they are paid", (await runSettlement(env, sql, "2026-08-29") as any).payout_total, 1250);

// ---- a run that stopped half way is resumed
await sale(A, 120);
await q("insert into settlements (cutoff_date, cutoff_at) values ('2026-08-29', now())");
const r8: any = await runSettlement(env, sql, "2026-08-30");
eq("a run left running is finished, not repeated", [r8.status, r8.payout_total, await bal(A)], ["completed", 120, 0]);

// ---- balances never left negative by settlement, and one transaction per merchant per date
eq("one settle per merchant per date", (await q("select count(*)::int n from (select from_account_id, idempotency_key from transactions where type='settle' group by 1,2 having count(*)>1) x"))[0].n, 0);
eq("no merchant ended negative", (await q("select count(*)::int n from balances b join accounts a on a.id=b.account_id where a.type='B' and b.balance<0"))[0].n, 0);

// ---- the admin can read runs, and only an admin can run one
const list = (await call("GET", "/v1/admin/settlements", { token: OP })).json.settlements;
eq("the list shows runs newest first", [list.length >= 8, list[0].cutoff_date >= list.at(-1).cutoff_date], [true, true]);
const detail = (await call("GET", `/v1/admin/settlements/${list.find((s: any) => s.cutoff_date === "2026-08-21").id}`, { token: OP })).json;
eq("a run lists its payouts by merchant", detail.items.map((i: any) => [i.merchant, i.kind, i.amount, i.status, i.bank_last4 !== null]), [["Alpha Cafe", "payout", 1500, "completed", true], ["Gamma Grill", "payout", 900, "completed", true]]);
eq("an unknown run is 404", (await call("GET", `/v1/admin/settlements/00000000-0000-7000-8000-000000000000`, { token: OP })).status, 404);
async function person(role: string) {
  const made = (await call("POST", "/v1/admin/admins", { token: OP, body: { name: "P " + role, role } })).json;
  return made.credentials;
}
await sale(A, 90);
const run = await call("POST", "/v1/admin/settlements/run", { token: OP });
eq("the operator can run settlement now", [run.status, run.json.ran, run.json.payout_total], [200, true, 90]);
eq("running it again the same day does nothing", (await call("POST", "/v1/admin/settlements/run", { token: OP })).json, { ran: false, reason: "already_done" });
eq("it is logged", (await q("select count(*)::int n from logs where action='settlement.run'"))[0].n, 2);

// ---- the daily job runs it too
await sale(C, 55);
const job: any = await dailyJobs(Date.parse("2026-11-03T05:00:00Z"), env);
eq("the daily cron settles the day that just ended", [job.settlement.ran, job.settlement.cutoff_date, job.settlement.payout_total], [true, "2026-11-02", 55]);
eq("and a second cron the same night adds nothing", (await dailyJobs(Date.parse("2026-11-03T05:30:00Z"), env) as any).settlement, { ran: false, reason: "already_done" });

console.log(`\n${pass} passed, ${fail} failed`);
await sql.end(); await adm.end();
process.exit(fail ? 1 : 0);
