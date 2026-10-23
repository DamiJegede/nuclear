import { writeFileSync } from "node:fs";
process.on("uncaughtException", (e: any) => { writeFileSync("/tmp/journey.err", String(e?.stack ?? e)); process.exit(1); });
process.on("unhandledRejection", (e: any) => { writeFileSync("/tmp/journey.err", String(e?.stack ?? e)); process.exit(1); });
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
import { connect } from "../src/db.ts";
import { addDays, runDuePrograms } from "../src/lib/programs.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const mails: { to: string; subject: string; text: string }[] = [];
const env: any = { STATS_TTL_SECONDS: "0", HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true", APP_URL: "https://app.test", EMAIL_FROM: "n <n@test>", EMAIL: { send: async (m: any) => { if (m.subject !== "Verify your email for Nuclear") mails.push(m); } }, UPLOADS: { put: async () => ({}) } };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (m: string, p: string, o: { body?: unknown; token?: string; key?: string; raw?: BodyInit; ctype?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + p, { method: m, headers: { "content-type": o.ctype ?? "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const sign = async (name: string, email: string, type = "C") => (await call("POST", "/v1/auth/signup", { body: { type, name, email, password: "correct horse battery" } })).json;
const stats = async () => (await call("GET", "/v1/admin/stats", { token: OP })).json;
const bankroll = async (accountId: string, cents: number) => q(`do $$ declare bank uuid; fid uuid; tid uuid; w uuid; begin
  insert into bank_accounts (account_id, routing_number, account_number, last4) values ('${accountId}', 'SANDBOX', 'SANDBOX', '0000') returning id into bank;
  insert into fundings (account_id, bank_account_id, amount, idempotency_key, status) values ('${accountId}', bank, ${cents}, 'bk-' || gen_random_uuid(), 'created') returning id into fid;
  select id into w from wallets where account_id = '${accountId}' and type = 'default';
  insert into transactions (type, status, from_wallet_id, to_wallet_id, amount, funding_id, account_id, idem) values ('fund', 'completed', '00000000-0000-7000-8000-000000000002', w, ${cents}, fid, '${accountId}', 'fund:' || 'bk-' || gen_random_uuid()) returning id into tid;
  update balances set balance = balance + ${cents} where account_id = '${accountId}';
  update fundings set status = 'completed', released_at = now(), transaction_id = tid where id = fid; end $$`);
const tokenOf = (to: string) => decodeURIComponent(mails.filter((m) => m.to === to).at(-1)!.text.match(/claim\?token=([^\s]+)/)![1]);
const sql = connect(env);
const release = () => q("update businesses set program_last_attempt_at = null");

// ===== 1. an organization signs up and sets itself up
const org = await sign("Northwind Foods", "hr@northwind.test", "O");
eq("1. signup: active at once, with a Flexible program waiting to be chosen", [(await call("GET", "/v1/account", { token: org.session_token })).json.status, (await call("GET", "/v1/org/program", { token: org.session_token })).json.program.chosen], ["active", false]);
const pr = await call("PUT", "/v1/org/profile", { token: org.session_token, body: { legal_name: "Northwind Foods Inc", display_name: "Northwind", tax_id: "98-7654321", address: "1 Dock St", city: "Brooklyn", state: "NY", post_code: "11201", country: "US", website: "https://northwind.test" } });
const doc = await call("POST", "/v1/account/documents", { token: org.session_token, raw: new Blob(["%PDF-1.4\n%x\n"]), ctype: "application/pdf" });
eq("1. profile and documents: details saved (tax ID last four only) and a document uploaded", [pr.status, pr.json.profile.tax_id_last4, doc.status, (await call("GET", "/v1/account/documents", { token: org.session_token })).json.documents.length], [200, "4321", 201, 1]);
await bankroll(org.account_id, 2_000_000);                              // $20,000 in its wallet
eq("1. wallet: funded; the overview shows it", (await call("GET", "/v1/org/overview", { token: org.session_token })).json.balance, 2_000_000);

// ===== 2. it chooses Fixed Benefits and loads its people
const fx = await call("PUT", "/v1/org/program", { token: org.session_token, body: { mode: "fixed", cadence: "biweekly", weekday: 5 } });
eq("2. program: Fixed, every other Friday, with the first payment date shown", [fx.json.program.mode, fx.json.program.chosen, fx.json.program.cadence, new Date(fx.json.program.next_run_date + "T12:00:00Z").getUTCDay()], ["fixed", true, "biweekly", 5]);
const people = [["E1", "Ana Alvarez", "ana@northwind.test", 6000], ["E2", "Ben Brooks", "ben@northwind.test", 6000], ["E3", "Cleo Chen", "cleo@northwind.test", 4000], ["E4", "Dev Diaz", "dev@northwind.test", 0]] as const;
const up = await call("POST", "/v1/org/fixed-benefits", { token: org.session_token, body: { rows: people.map(([employee_id, name, email, fixed_benefit]) => ({ employee_id, name, email, fixed_benefit })) } });
eq("2. fixed benefits: uploaded for four employees (one with none); $160 per payment", [up.status, up.json.fixed], [200, { employees: 3, total: 16000 }]);
const key = (await call("POST", "/v1/org/api-key", { token: org.session_token })).json.token;
const api = (m: string, p: string, body?: unknown, k?: string) => call(m, `/v1/benefits-api${p}`, { token: key, body, key: k });
await api("POST", "/employees", { employees: [{ employee_id: "E5", name: "Eli Evans", email: "eli@northwind.test", fixed_benefit: 5000 }] });
eq("2. api: a new hire added with a fixed benefit; balance and lookup agree with the portal", [(await api("GET", "/balance")).json, (await api("POST", "/employees/get", { employee_ids: ["E5", "ZZ"] })).json.employees.map((e: any) => [e.employee_id, e.found, e.fixed_benefit ?? null])], [{ currency: "USD", balance: 2_000_000, held_for_unclaimed: 0, employees: 5 }, [["E5", true, 5000], ["ZZ", false, null]]]);

// ===== 3. payment day: the scheduler pays everyone
const due = (await call("GET", "/v1/org/program", { token: org.session_token })).json.program.next_run_date as string;
await release();
const cron = await runDuePrograms(env, sql, due);
const run1 = (await q("select source, status, row_count, total::int t, held::int h from benefit_runs where org_account_id=$1", [org.account_id]))[0];
eq("3. payday: one scheduled run credits the four employees with a fixed benefit ($210), held for those who have not joined", [cron.credited, run1], [1, { source: "schedule", status: "credited", row_count: 4, t: 21000, h: 21000 }]);
eq("3. payday: each unclaimed employee is emailed a claim link once", mails.filter((m) => /claim\?token/.test(m.text)).map((m) => m.to).sort(), ["ana@northwind.test", "ben@northwind.test", "cleo@northwind.test", "eli@northwind.test"]);
const hist = (await call("GET", "/v1/org/benefit-runs", { token: org.session_token })).json.runs;
eq("3. history: the run shows in the portal list with its source", [hist.length, hist[0].source, hist[0].status, hist[0].run_date], [1, "schedule", "credited", due]);

// ===== 4. employees claim: a brand-new user and an existing one
const ana = await sign("Ana Alvarez", "ana@northwind.test");
const ben = await sign("Ben Brooks", "ben@northwind.test");
await call("POST", "/v1/sandbox/fundings", { token: ben.session_token, key: "ben-load", body: { amount: 100_000 } });
const ca = await call("POST", "/v1/employee/claims", { token: ana.session_token, body: { token: tokenOf("ana@northwind.test") } });
const cb = await call("POST", "/v1/employee/claims", { token: ben.session_token, body: { token: tokenOf("ben@northwind.test") } });
eq("4. claims: both get a Northwind Benefits wallet holding their $60", [ca.json.wallet.display_name, ca.json.wallet.balance, cb.json.wallet.balance], ["Northwind Foods Benefits", 6000, 6000]);
eq("4. balances: Ben has $1,000 ordinary plus $60 Benefits; Ana has $60 Benefits only", [(await call("GET", "/v1/balance", { token: ben.session_token })).json, (await call("GET", "/v1/balance", { token: ana.session_token })).json.benefits].map((x: any) => x.balance !== undefined ? [x.balance, x.benefits, x.ordinary] : x), [[106_000, 6000, 100_000], 6000]);

// ===== 5. they spend: a merchant, then a refund
const shop = await sign("Corner Cafe", "cafe@x.test", "B");
await q("update accounts set status='active' where id=$1", [shop.account_id]);
const term = (await call("POST", "/v1/terminals", { token: shop.session_token, body: { name: "T", allow_refunds: true } })).json;
const anaBen = (await call("GET", "/v1/wallets", { token: ana.session_token })).json.wallets.find((w: any) => w.type === "benefits");
const pay = await call("POST", "/v1/payments", { token: ana.session_token, key: "ana-coffee", body: { terminal_id: term.terminal.id, amount: 1500, from_wallet_id: anaBen.id } });
eq("5. spending: Ana pays the cafe $15 from her Benefits wallet", [pay.status, (await call("GET", "/v1/wallets", { token: ana.session_token })).json.wallets.find((w: any) => w.type === "benefits").balance], [201, 4500]);
const rf = await call("POST", "/v1/terminal/refunds", { token: term.session_token, key: "ana-refund", body: { payment_id: pay.json.payment.id, mode: "full" } });
eq("5. refund: it goes back into her Benefits wallet", [rf.status, (await call("GET", "/v1/wallets", { token: ana.session_token })).json.wallets.find((w: any) => w.type === "benefits").balance], [201, 6000]);
const benBen = (await call("GET", "/v1/wallets", { token: ben.session_token })).json.wallets.find((w: any) => w.type === "benefits");
const benDefault = (await call("GET", "/v1/wallets", { token: ben.session_token })).json.wallets.find((w: any) => w.type === "default");
const mv = await call("POST", "/v1/wallets/move", { token: ben.session_token, key: "ben-move", body: { from_wallet_id: benBen.id, to_wallet_id: benDefault.id, amount: 1000 } });
eq("5. move: Ben moves $10 of his Benefits to his own wallet within the daily headroom; Ana cannot send hers to Ben", [mv.status, (await call("POST", "/v1/transfers", { token: ana.session_token, key: "ana-send", body: { to_wallet_id: benDefault.id, amount: 100, from_wallet_id: anaBen.id } })).json.error], [201, "benefits_wallet_not_transferable"]);

// ===== 6. the organization follows up
const runId = hist[0].id;
const detail = (await call("GET", `/v1/org/benefit-runs/${runId}`, { token: org.session_token })).json;
eq("6. follow-up: the run shows who has claimed (Ana, Ben) and who has not (Cleo, Eli), with $90 still held", [detail.rows.map((r: any) => [r.employee_id, r.claimed]).filter((r: any[]) => r[0] !== "E4"), detail.summary], [[["E1", true], ["E2", true], ["E3", false], ["E5", false]], { claimed: 2, unclaimed: 2, still_held: 9000 }]);
eq("6. follow-up: the employee list shows fixed benefits and the Benefits wallet only for claimed people", (await call("GET", "/v1/org/employees", { token: org.session_token })).json.employees.map((e: any) => [e.employee_id, e.fixed_benefit, e.benefits_wallet_id !== null]).sort(), [["E1", 6000, true], ["E2", 6000, true], ["E3", 4000, false], ["E4", null, false], ["E5", 5000, false]]);

// ===== 7. a one-off credit in Fixed mode, a removal, and the next payday
const bonus = await api("POST", "/credits", { credits: [{ employee_id: "E1", amount: 2500 }] }, "bonus-1");
eq("7. one-off: a bonus through the API works in Fixed mode and lands in Ana's Benefits wallet", [bonus.status, bonus.json.credits[0].credited_as, bonus.json.run.source, (await call("GET", "/v1/wallets", { token: ana.session_token })).json.wallets.find((w: any) => w.type === "benefits").balance], [201, "benefits_wallet", "api", 8500]);
const eliHeld = (await call("GET", "/v1/org/overview", { token: org.session_token })).json.held;
const rem = await api("POST", "/employees/remove", { employee_ids: ["E5", "E4"] });
eq("7. removal: Eli still has a credit held and Dev has none; both can be removed, and the answer says how much stays held", [rem.status, rem.json.employees], [200, [{ employee_id: "E5", result: "removed", held: 5000 }, { employee_id: "E4", result: "removed", held: 0 }]]);
eq("7. removal: they leave the list and the counts, but Eli's held credit still shows as held", [(await call("GET", "/v1/org/employees", { token: org.session_token })).json.employees.map((e: any) => e.employee_id).sort(), (await call("GET", "/v1/org/overview", { token: org.session_token })).json.held === eliHeld], [["E1", "E2", "E3"], true]);
const eli = await sign("Eli Evans", "eli@northwind.test");
const ce = await call("POST", "/v1/employee/claims", { token: eli.session_token, body: { token: tokenOf("eli@northwind.test") } });
eq("7. removal: the removed employee still has access to the money: his claim link works and the credit lands in his Benefits wallet", [ce.status, ce.json.claimed, ce.json.wallet.balance], [200, 5000, 5000]);
const due2 = (await call("GET", "/v1/org/program", { token: org.session_token })).json.program.next_run_date as string;
await release();
await runDuePrograms(env, sql, due2);
const run2 = (await q("select row_count, total::int t, sent::int s, held::int h from benefit_runs where idempotency_key=$1", ["program:" + due2]))[0];
eq("7. second payday: only active employees with a fixed benefit (the removed ones are skipped); claimed ones are paid into their Benefits wallets", [due2 === addDays(due, 14), run2], [true, { row_count: 3, t: 16000, s: 12000, h: 4000 }]);
const emailsAfter = mails.filter((m) => /claim\?token/.test(m.text)).length;
eq("7. second payday: nobody already told is emailed again", emailsAfter, 4);

// ===== 8. switch to Flexible; everything still reconciles
eq("8. switch: Flexible stops the schedule, fixed amounts stay on file", [(await call("PUT", "/v1/org/program", { token: org.session_token, body: { mode: "flexible" } })).json.program.next_run_date, (await q("select count(*)::int n from employees where org_account_id=$1 and fixed_benefit is not null", [org.account_id]))[0].n], [null, 4]);
await release();
eq("8. switch: nothing is paid on later days", (await runDuePrograms(env, sql, addDays(due2, 30))).credited, 0);
const rec = (await stats()).reconciliation;
eq("8. books: ledger balanced, balances match the ledger, escrow matches held employees, Benefits wallets match the ledger", [rec.ledger_balanced, rec.balances_match_ledger, rec.escrow_matches_employees, rec.benefits_match_ledger], [true, true, true, true]);
eq("8. money: the organization paid out exactly what its runs say", [(await q("select shared_funds($1)::int b", [org.account_id]))[0].b, (await q("select sum(total)::int t from benefit_runs where org_account_id=$1 and status='credited'", [org.account_id]))[0].t], [2_000_000 - 21000 - 2500 - 16000, 21000 + 2500 + 16000]);
await sql.end();
console.log(`\n${pass} passed, ${fail} failed`);
await adm.end();
process.exit(fail ? 1 : 0);
