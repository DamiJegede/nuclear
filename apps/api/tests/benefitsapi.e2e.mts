import { writeFileSync } from "node:fs";
process.on("uncaughtException", (e: any) => { writeFileSync("/tmp/bapi.err", String(e?.stack ?? e)); process.exit(1); });
process.on("unhandledRejection", (e: any) => { writeFileSync("/tmp/bapi.err", String(e?.stack ?? e)); process.exit(1); });
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { memoryLimiter } from "../src/lib/throttle.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
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
const reconciled = async () => (await call("GET", "/v1/admin/stats", { token: OP })).json.reconciliation;

const acme = await sign("Acme", "hr@acme.test", "O");
const cus = await sign("Cus", "cus@x.test");
const shop = await sign("Shop", "shop@x.test", "B");
await q(`do $$ declare bank uuid; fid uuid; tid uuid; begin
  insert into bank_accounts (account_id, routing_number, account_number, last4) values ('${acme.account_id}', 'SANDBOX', 'SANDBOX', '0000') returning id into bank;
  insert into fundings (account_id, bank_account_id, amount, idempotency_key, status) values ('${acme.account_id}', bank, 1000000, 'bankroll', 'created') returning id into fid;
  insert into transactions (type, from_account_id, to_account_id, from_bank_account_id, amount, status, idempotency_key, completed_at) values ('fund', '${acme.account_id}', '${acme.account_id}', bank, 1000000, 'completed', 'bankroll', now()) returning id into tid;
  update balances set balance = balance + 1000000 where account_id = '${acme.account_id}';
  insert into ledger_entries (funding_id, posting_key, line_no, account_id, bucket, direction, amount) values (fid, 'release', 1, null, 'bank_settlement', 'debit', 1000000), (fid, 'release', 2, '${acme.account_id}', 'funded_balance', 'credit', 1000000);
  update fundings set status = 'completed', released_at = now(), transaction_id = tid where id = fid; end $$`);

// ---- the key: shown once, one live key, rotating kills the old one
eq("key: none yet; only an organization manages it", [(await call("GET", "/v1/org/api-key", { token: acme.session_token })).json.key, (await call("GET", "/v1/org/api-key", { token: cus.session_token })).status, (await call("POST", "/v1/org/api-key", { token: shop.session_token })).status], [null, 403, 403]);
const k1 = await call("POST", "/v1/org/api-key", { token: acme.session_token });
const T1 = k1.json.token as string;
eq("key: generated with a one-time token and a hint", [k1.status, /^nk_org_[A-Za-z0-9_-]{43}$/.test(T1), k1.json.key.hint === T1.slice(-4)], [201, true, true]);
eq("key: afterwards only the hint and dates are visible, never the token; only a hash is stored", [Object.keys((await call("GET", "/v1/org/api-key", { token: acme.session_token })).json.key).sort(), (await q("select count(*)::int n from businesses where api_key_hash = $1", [T1]))[0].n, (await q("select length(api_key_hash)::int l from businesses where api_key_hash is not null"))[0].l], [["created_at", "hint", "last_used_at", "name"], 0, 64]);
const post = (token: string | undefined, path: string, body: unknown, key?: string) => call("POST", `/v1/benefits-api${path}`, { token, body, key });
eq("auth: no key, a wrong key, a session token and an agent-style key are all 401", [(await post(undefined, "/employees", {})).status, (await post("nk_org_" + "x".repeat(43), "/employees", {})).status, (await post(acme.session_token, "/employees", {})).status, (await post("nk_agent_" + "x".repeat(43), "/employees", {})).status], [401, 401, 401, 401]);
const k2 = await call("POST", "/v1/org/api-key", { token: acme.session_token });
const T2 = k2.json.token as string;
eq("key: generating a new key kills the old one at once; one live key", [(await post(T1, "/employees", { employees: [] })).status, (await post(T2, "/employees", { employees: [] })).status, (await q("select count(*)::int n from businesses where api_key_hash is not null"))[0].n], [401, 400, 1]);
const KEY = T2;

// ---- create / update employees (arrays)
const E = (id: string, nm = `Person ${id}`, em = `${id.toLowerCase()}@x.test`) => ({ employee_id: id, name: nm, email: em });
const c1 = await post(KEY, "/employees", { employees: [E("A1"), E("A2")] });
eq("employees: one call creates many", [c1.status, c1.json.employees], [200, [{ employee_id: "A1", result: "created" }, { employee_id: "A2", result: "created" }]]);
const c2 = await post(KEY, "/employees", { employees: [E("A1", "Renamed", "renamed@x.test")] });
eq("employees: a single employee is the same call; a known id is updated (name and email follow, id is the key)", [c2.json.employees, (await q("select name, email from employees where employee_id='A1'"))[0]], [[{ employee_id: "A1", result: "updated" }], { name: "Renamed", email: "renamed@x.test" }]);
eq("employees: nothing is credited and nobody is emailed by creating", [(await q("select count(*)::int n from transactions where type in ('allocate','send')"))[0].n, mails.length], [0, 0]);
eq("employees: a bad row refuses the whole request, nothing is written", [(await post(KEY, "/employees", { employees: [E("A3"), { employee_id: "bad id", name: "x", email: "x@x.co" }] })).status, (await q("select count(*)::int n from employees where employee_id='A3'"))[0].n], [400, 0]);
eq("employees: duplicate ids, empty arrays and the wrong shape are refused", [(await post(KEY, "/employees", { employees: [E("D1"), E("D1")] })).json.error, (await post(KEY, "/employees", { employees: [] })).status, (await post(KEY, "/employees", E("A9"))).status], ["duplicate_employee_id", 400, 400]);

// ---- credits
const cr = await post(KEY, "/credits", { credits: [{ employee_id: "A1", amount: 2500 }, { employee_id: "A2", amount: 5000 }, { employee_id: "N1", name: "New One", email: "new1@x.test", amount: 1000 }] }, "cr-1");
eq("credits: known employees need only an amount; a new one needs name and email; one call credits all", [cr.status, cr.json.run.count, cr.json.run.total, cr.json.run.held, cr.json.credits.map((x: any) => [x.employee_id, x.amount, x.credited_as])], [201, 3, 8500, 8500, [["A1", 2500, "held_until_claimed"], ["A2", 5000, "held_until_claimed"], ["N1", 1000, "held_until_claimed"]]]);
eq("credits: each credit has a transaction id and employees are emailed a claim link", [cr.json.credits.every((x: any) => typeof x.transaction_id === "string"), cr.json.emails.sent, mails.length], [true, 3, 3]);
eq("credits: a retry with the same key replays (200), credits and emails nothing more", [(await post(KEY, "/credits", { credits: [{ employee_id: "A1", amount: 2500 }, { employee_id: "A2", amount: 5000 }, { employee_id: "N1", amount: 1000 }] }, "cr-1")).status, mails.length, (await q("select balance::int b from balances where account_id=$1", [acme.account_id]))[0].b], [200, 3, 1000000 - 8500]);
eq("credits: the same key with different credits is a mismatch; a key is required", [(await post(KEY, "/credits", { credits: [{ employee_id: "A1", amount: 1 }] }, "cr-1")).json.error, (await post(KEY, "/credits", { credits: [{ employee_id: "A1", amount: 1 }] })).status], ["idempotency_mismatch", 400]);
eq("credits: an unknown employee without name and email is refused whole, nothing credited", [(await post(KEY, "/credits", { credits: [{ employee_id: "A1", amount: 100 }, { employee_id: "ZZ", amount: 100 }] }, "cr-2")).json, (await q("select count(*)::int n from benefit_runs"))[0].n], [{ error: "employee_details_required", employee_ids: ["ZZ"] }, 1]);
eq("credits: bad amounts and duplicates are refused", [(await post(KEY, "/credits", { credits: [{ employee_id: "A1", amount: 0 }] }, "cr-3")).status, (await post(KEY, "/credits", { credits: [{ employee_id: "A1", amount: 10_000_001 }] }, "cr-4")).status, (await post(KEY, "/credits", { credits: [{ employee_id: "A1", amount: 5 }, { employee_id: "A1", amount: 5 }] }, "cr-5")).json.error], [400, 400, "duplicate_employee_id"]);
const big = await post(KEY, "/credits", { credits: [{ employee_id: "A1", amount: 9_000_000 }, { employee_id: "A2", amount: 9_000_000 }] }, "cr-6");
eq("credits: more than the wallet holds is refused whole with what is needed and available", [big.status, big.json.error, big.json.required, big.json.available], [422, "insufficient_balance", 18_000_000, 991_500]);
eq("credits: books reconcile (escrow equals what employees hold)", [(await reconciled()).ledger_balanced, (await reconciled()).escrow_matches_employees, (await reconciled()).benefits_match_ledger], [true, true, true]);

// a claimed employee is credited into their Benefits wallet
const nora = await sign("Nora", "a1@x.test");
const tokenOf = (to: string) => decodeURIComponent(mails.filter((m) => m.to === to).at(-1)!.text.match(/claim\?token=([^\s]+)/)![1]);
await call("POST", "/v1/employee/claims", { token: nora.session_token, body: { token: tokenOf("renamed@x.test") } });
const cr2 = await post(KEY, "/credits", { credits: [{ employee_id: "A1", amount: 700 }] }, "cr-7");
eq("credits: a claimed employee is credited into their Benefits wallet", [cr2.json.credits[0].credited_as, ((await call("GET", "/v1/wallets", { token: nora.session_token })).json.wallets.find((w: any) => w.type === "benefits")).balance], ["benefits_wallet", 3200]);

eq("runs: an API credit is a benefit run with source api, credited, dated by program day", (await q("select source, status, run_date::text d, (run_date = (now() at time zone 'America/New_York')::date) as today from benefit_runs where idempotency_key = 'cr-1'"))[0] && (await q("select source, status from benefit_runs where idempotency_key = 'cr-1'"))[0], { source: "api", status: "credited" });

// ---- balance
const bl = await call("GET", "/v1/benefits-api/balance", { token: KEY });
eq("balance: what is available to credit, what is held for unclaimed employees, and the active employee count", [bl.status, bl.json], [200, { currency: "USD", balance: 1000000 - 8500 - 700, held_for_unclaimed: 8500 - 2500, employees: 3 }]);
eq("balance: needs the key", (await call("GET", "/v1/benefits-api/balance")).status, 401);

// ---- get
const g = await post(KEY, "/employees/get", { employee_ids: ["N1", "NOPE", "A1"] });
eq("get: an array in, an array back in the same order; unknown ids are found:false", [g.status, g.json.employees.map((e: any) => [e.employee_id, e.found])], [200, [["N1", true], ["NOPE", false], ["A1", true]]]);
const n1 = g.json.employees[0], a1 = g.json.employees[2];
eq("get: details, claim state and what is still held (a claimed employee's balance is never shown)", [[n1.name, n1.email, n1.status, n1.claimed, n1.held], [a1.claimed, a1.held], Object.keys(a1).sort()], [["New One", "new1@x.test", "active", false, 1000], [true, 0], ["claimed", "created_at", "email", "employee_id", "fixed_benefit", "found", "held", "name", "status", "updated_at"]]);
eq("get: nothing changes; duplicates and bad bodies are refused; another organization's employees are not visible", [(await post(KEY, "/employees/get", { employee_ids: ["A1", "A1"] })).json.error, (await post(KEY, "/employees/get", { employee_ids: [] })).status, (await post(KEY, "/employees/get", { employee_ids: ["bad id"] })).status, (await post(undefined, "/employees/get", { employee_ids: ["A1"] })).status], ["duplicate_employee_id", 400, 400, 401]);

// ---- remove
const capi2 = (m: string, p: string, body?: unknown) => call(m, `/v1/benefits-api${p}`, { token: KEY, body });
const rm = (ids: string[]) => post(KEY, "/employees/remove", { employee_ids: ids });
const rmHeld = await rm(["A2", "N1"]);
eq("remove: credit held for an employee does not block removal; the answer says how much stays theirs, and the money is untouched", [rmHeld.status, rmHeld.json.employees, (await q("select employee_id, balance::int b from employees where employee_id in ('A2','N1') order by employee_id")).map((r: any) => [r.employee_id, r.b])], [200, [{ employee_id: "A2", result: "removed", held: 5000 }, { employee_id: "N1", result: "removed", held: 1000 }], [["A2", 5000], ["N1", 1000]]]);
eq("remove: the held credit still shows in the balance (held_for_unclaimed includes removed employees), but they leave the employee count", [(await call("GET", "/v1/benefits-api/balance", { token: KEY })).json.held_for_unclaimed, (await call("GET", "/v1/benefits-api/balance", { token: KEY })).json.employees], [6000, 1]);
await capi2("POST", "/employees", { employees: [{ employee_id: "A2", name: "Sam Two", email: "sam@x.test" }, { employee_id: "N1", name: "New One", email: "new1@x.test" }] });        // saving them again brings them back, balance intact
eq("remove: an unknown id is a 404 and removes nobody", [(await rm(["A1", "NOPE"])).json, (await q("select status from employees where employee_id='A1'"))[0].status], [{ error: "employee_not_found", employee_ids: ["NOPE"] }, "active"]);
eq("get: removed employees are still found, marked removed", (await post(KEY, "/employees/get", { employee_ids: ["A1"] })).json.employees[0].status, "active");
eq("remove: doing it twice is fine; removed employees vanish from the portal list", [(await rm(["A1"])).json.employees.map((e: any) => [e.employee_id, e.result]), (await rm(["A1"])).json.employees.map((e: any) => [e.employee_id, e.result]), (await call("GET", "/v1/org/employees", { token: acme.session_token })).json.employees.map((e: any) => e.employee_id).sort()], [[["A1", "removed"]], [["A1", "already_removed"]], ["A2", "N1"]]);
eq("remove: crediting or saving a removed employee brings them back", [(await post(KEY, "/employees", { employees: [E("A1")] })).json.employees[0].result, (await q("select status from employees where employee_id='A1'"))[0].status], ["reactivated", "active"]);

// ---- guards
const before = (await q("select api_key_last_used_at as last_used_at from businesses where api_key_hash is not null"))[0].last_used_at;
eq("guards: using the key stamps its last use", [before !== null, (await call("GET", "/v1/org/api-key", { token: acme.session_token })).json.key.last_used_at !== null], [true, true]);
eq("guards: a key is rate limited per minute", await (async () => { let last = 0; for (let n = 0; n < 125; n++) last = (await post(KEY, "/employees", { employees: [] })).status; return last; })(), 429);
memoryLimiter.windows.clear();
eq("guards: revoking the key stops it; a suspended organization's key stops too", [(await call("DELETE", "/v1/org/api-key", { token: acme.session_token })).status, (await post(KEY, "/employees", { employees: [E("Q1")] })).status], [204, 401]);
const k3 = (await call("POST", "/v1/org/api-key", { token: acme.session_token })).json.token;
await q("update accounts set status='suspended' where id=$1", [acme.account_id]);
eq("guards: a suspended organization's key is refused", (await post(k3, "/employees", { employees: [E("Q2")] })).status, 401);
console.log(`\n${pass} passed, ${fail} failed`);
await adm.end();
process.exit(fail ? 1 : 0);
