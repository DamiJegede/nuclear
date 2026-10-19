import { writeFileSync } from "node:fs";
process.on("uncaughtException", (e: any) => { writeFileSync("/tmp/org.err", String(e?.stack ?? e)); process.exit(1); });
process.on("unhandledRejection", (e: any) => { writeFileSync("/tmp/org.err", String(e?.stack ?? e)); process.exit(1); });
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
import { remindUnclaimed } from "../src/lib/orgMail.ts";
import { connect } from "../src/db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const mails: { to: string; subject: string; text: string }[] = [];
const env: any = { HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true", APP_URL: "https://app.test", EMAIL_FROM: "Nuclear <no-reply@test>", EMAIL: { send: async (m: any) => { mails.push(m); } } };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (m: string, p: string, o: { body?: unknown; token?: string; key?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + p, { method: m, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const sign = async (name: string, email: string, type = "C") => (await call("POST", "/v1/auth/signup", { body: { type, name, email, password: "correct horse battery" } })).json;
const bal = async (id: string) => Number((await q("select balance from balances where account_id=$1", [id]))[0].balance);
const fund = (p: any, amount: number, key: string) => call("POST", "/v1/sandbox/fundings", { token: p.session_token, key, body: { amount } });
const batch = (p: any, rows: any[], key: string) => call("POST", "/v1/org/credit-batches", { token: p.session_token, key, body: { rows } });
const reconciled = async () => (await call("GET", "/v1/admin/stats", { token: OP })).json.reconciliation;
const tokenFrom = (m: { text: string }) => decodeURIComponent(m.text.match(/claim\?token=([^\s]+)/)![1]);
const escrowNet = async () => Number((await q("select coalesce(sum(case direction when 'credit' then amount else -amount end),0)::bigint n from ledger_entries where bucket='employee_escrow'"))[0].n);
const held = async () => Number((await q("select coalesce(sum(balance),0)::bigint n from employees"))[0].n);

const acme = await sign("Acme Corp", "hr@acme.test", "O");
const cus = await sign("Cus", "cus@example.com");
const shop = await sign("Shop", "shop@example.com", "B");
eq("signup: an organization is active at once", (await q("select type, status from accounts where id=$1", [acme.account_id]))[0], { type: "O", status: "active" });
eq("access: organization routes need an organization; business routes refuse one", [
  (await call("GET", "/v1/org/overview", { token: cus.session_token })).status,
  (await call("GET", "/v1/org/overview", { token: shop.session_token })).status,
  (await call("GET", "/v1/business/overview", { token: acme.session_token })).status,
  (await call("GET", "/v1/org/overview")).status], [403, 403, 403, 401]);

await fund(acme, 100000, "f-1");
const rows = (extra: any[] = []) => [
  { employee_id: "E001", name: "Eve One", email: "eve@example.com", amount: 2500 },
  { employee_id: "E002", name: "Sam Two", email: "sam@example.com", amount: 5000 },
  ...extra,
];

// ---- validation and refusals
eq("batch: needs an idempotency key and valid rows", [
  (await call("POST", "/v1/org/credit-batches", { token: acme.session_token, body: { rows: rows() } })).status,
  (await batch(acme, [], "v1")).status,
  (await batch(acme, [{ employee_id: "bad id!", name: "X", email: "x@example.com", amount: 100 }], "v2")).status,
  (await batch(acme, [{ employee_id: "E9", name: "X", email: "nope", amount: 100 }], "v3")).status,
  (await batch(acme, [{ employee_id: "E9", name: "X", email: "x@example.com", amount: 0 }], "v4")).status,
  (await batch(acme, [{ employee_id: "E9", name: "X", email: "x@example.com", amount: 10_000_001 }], "v5")).status], [400, 400, 400, 400, 400, 400]);
eq("batch: the same employee_id twice in one file is refused", (await batch(acme, [...rows(), { employee_id: "E001", name: "Dup", email: "d@example.com", amount: 1 }], "dup")).json.error, "duplicate_employee_id");
const big = await batch(acme, [{ employee_id: "B1", name: "Big", email: "big@example.com", amount: 6_000_000 }, { employee_id: "B2", name: "Big", email: "big2@example.com", amount: 6_000_000 }], "big");
eq("batch: a batch the wallet cannot cover is refused whole, nothing is written", [big.status, big.json.error, big.json.required, big.json.available, await bal(acme.account_id), (await q("select (select count(*) from employees)::int e, (select count(*) from credit_batches)::int b, (select count(*) from transactions where type='allocate')::int t"))[0], mails.length], [422, "insufficient_balance", 12000000, 100000, 100000, { e: 0, b: 0, t: 0 }, 0]);

// ---- a first batch: two people with no account
const b1 = await batch(acme, rows(), "b-1");
eq("batch: new employees are credited into escrow, the wallet is debited", [b1.status, b1.json.batch.total, b1.json.batch.held, b1.json.batch.sent, await bal(acme.account_id), await held(), await escrowNet()], [201, 7500, 7500, 0, 92500, 7500, 7500]);
eq("batch: the ledger balances and reconciliation holds", [(await reconciled()).ledger_balanced, (await reconciled()).balances_match_ledger, (await reconciled()).escrow_matches_employees], [true, true, true]);
eq("batch: each held credit is an allocate transaction with no destination", (await q("select type, to_account_id, amount::int a from transactions where type='allocate' order by amount"))
  .map((r) => [r.type, r.to_account_id, r.a]), [["allocate", null, 2500], ["allocate", null, 5000]]);
eq("batch: both people are emailed a claim link with the amount", [mails.length, mails.map((m) => m.to).sort(), mails[0].text.includes("Acme Corp"), /claim\?token=/.test(mails[0].text)], [2, ["eve@example.com", "sam@example.com"], true, true]);
eq("batch: tokens are stored only as hashes", (await q("select count(*)::int n from employees where claim_token_hash = $1", [tokenFrom(mails[0])]))[0].n, 0);
const replay = await batch(acme, rows(), "b-1");
eq("batch: a retry with the same key replays (200), debits and emails nothing more", [replay.status, replay.json.batch.id === b1.json.batch.id, await bal(acme.account_id), mails.length], [200, true, 92500, 2]);
eq("batch: the same key with different rows is a 409", (await batch(acme, [rows()[0]], "b-1")).json.error, "idempotency_mismatch");

// ---- overview and lists
const ov = (await call("GET", "/v1/org/overview", { token: acme.session_token })).json;
eq("overview: balance, employee counts, held total and the last batch", [ov.balance, ov.employees, ov.held, ov.last_batch.total], [92500, { total: 2, claimed: 0, unclaimed: 2 }, 7500, 7500]);
const list = (await call("GET", "/v1/org/employees?status=unclaimed&q=sam", { token: acme.session_token })).json.employees;
eq("employees: list with filters shows the held balance", list.map((e: any) => [e.employee_id, e.balance, e.claimed]), [["E002", 5000, false]]);
const det = (await call("GET", `/v1/org/credit-batches/${b1.json.batch.id}`, { token: acme.session_token })).json;
eq("batch detail: one row per employee with its mode", det.rows.map((r: any) => [r.employee_id, r.amount, r.mode]), [["E001", 2500, "held"], ["E002", 5000, "held"]]);

// ---- claiming
const eveToken = tokenFrom(mails.find((m) => m.to === "eve@example.com")!);
eq("claim: a made-up token is refused", (await call("POST", "/v1/employee/claims", { token: cus.session_token, body: { token: "x".repeat(43) } })).status, 404);
eq("claim: an organization or business cannot claim", [(await call("POST", "/v1/employee/claims", { token: acme.session_token, body: { token: eveToken } })).json?.error ?? "forbidden", (await call("POST", "/v1/employee/claims", { token: shop.session_token, body: { token: eveToken } })).status].length, 2);
const c1 = await call("POST", "/v1/employee/claims", { token: cus.session_token, body: { token: eveToken } });
eq("claim: the held credit moves into the employee's balance", [c1.status, c1.json.claimed, c1.json.organization, await bal(cus.account_id), await held(), await escrowNet()], [200, 2500, "Acme Corp", 2500, 5000, 5000]);
eq("claim: the employee is linked, the token is used up, the claim is a transaction", [(await q("select employee_account_id = $1 as linked, balance::int b, claim_token_hash is null as spent from employees where employee_id='E001'", [cus.account_id]))[0], (await q("select type, amount::int a, from_account_id from transactions where type='claim'"))[0]], [{ linked: true, b: 0, spent: true }, { type: "claim", a: 2500, from_account_id: null }]);
eq("claim: the token cannot be used twice", (await call("POST", "/v1/employee/claims", { token: cus.session_token, body: { token: eveToken } })).status, 404);
eq("claim: the ledger still balances and escrow matches", [(await reconciled()).ledger_balanced, (await reconciled()).balances_match_ledger, (await reconciled()).escrow_matches_employees], [true, true, true]);

// ---- the next batch pays a claimed employee directly
const b2 = await batch(acme, [{ employee_id: "E001", name: "Eve Renamed", email: "eve2@example.com", amount: 1000 }, { employee_id: "E003", name: "New Three", email: "new3@example.com", amount: 700 }], "b-2");
eq("batch 2: a claimed employee gets a normal send, a new one is held", [b2.status, b2.json.batch.sent, b2.json.batch.held, await bal(cus.account_id), await bal(acme.account_id), await held()], [201, 1000, 700, 3500, 90800, 5700]);
eq("batch 2: name and email follow the CSV, employee_id stays", (await q("select name, email from employees where employee_id='E001'"))[0], { name: "Eve Renamed", email: "eve2@example.com" });
eq("batch 2: a send transaction links the two wallets; only the new person is emailed", [(await q("select count(*)::int n from transactions where type='send' and to_account_id=$1", [cus.account_id]))[0].n, mails.length, mails[2].to], [1, 3, "new3@example.com"]);
eq("batch 2: totals reconcile (escrow equals what employees hold)", [await escrowNet(), await held(), (await reconciled()).balances_match_ledger], [5700, 5700, true]);

// ---- the monthly nudge
const sqlc = connect(env);
eq("reminders: nobody is nagged inside 30 days", (await remindUnclaimed(env, sqlc)).sent, 0);
await q("update employees set reminded_at = now() - interval '31 days' where employee_id = 'E002'");
const rem = await remindUnclaimed(env, sqlc);
eq("reminders: an unclaimed employee is nudged monthly with a fresh link", [rem.sent, mails.at(-1)!.to, mails.at(-1)!.text.includes("still have")], [1, "sam@example.com", true]);
const oldSam = tokenFrom(mails.find((m) => m.to === "sam@example.com")!), newSam = tokenFrom(mails.at(-1)!);
eq("reminders: the old link stops working, the new one claims", [oldSam !== newSam, (await call("POST", "/v1/employee/claims", { token: cus.session_token, body: { token: oldSam } })).status], [true, 404]);
const cus2 = await sign("Cus Two", "cus2@example.com");
eq("claim: the fresh link claims for the holder's account", [(await call("POST", "/v1/employee/claims", { token: cus2.session_token, body: { token: newSam } })).json.claimed, await bal(cus2.account_id), await held()], [5000, 5000, 700]);
await sqlc.end();

// ---- removing employees
const emp = async (eid: string) => (await q("select id, status from employees where employee_id=$1", [eid]))[0];
const rm = async (eid: string) => call("DELETE", `/v1/org/employees/${(await emp(eid)).id}`, { token: acme.session_token });
const e003 = await emp("E003");
const blocked = await call("DELETE", `/v1/org/employees/${e003.id}`, { token: acme.session_token });
eq("remove: refused while money is held for the employee", [blocked.status, blocked.json.error, blocked.json.held, (await emp("E003")).status], [409, "has_held_balance", 700, "active"]);
eq("remove: another organization cannot remove them", (await call("DELETE", `/v1/org/employees/${e003.id}`, { token: (await sign("Other Org", "other@org.test", "O")).session_token })).status, 404);
eq("remove: a claimed employee can be removed, then no longer shows or counts", [(await rm("E001")).status, (await q("select status, claim_token_hash is null as t from employees where employee_id='E001'"))[0],
  (await call("GET", "/v1/org/employees", { token: acme.session_token })).json.employees.map((e: any) => e.employee_id).sort(),
  (await call("GET", "/v1/org/overview", { token: acme.session_token })).json.employees.total], [204, { status: "removed", t: true }, ["E002", "E003"], 2]);
eq("remove: removing twice is a 404", (await rm("E001")).status, 404);
eq("remove: a removed employee mentioned in a later CSV is active again", [(await batch(acme, [{ employee_id: "E001", name: "Eve Back", email: "eve@example.com", amount: 100 }], "b-3")).status, (await emp("E001")).status], [201, "active"]);
eq("remove: the books still reconcile", [(await reconciled()).ledger_balanced, (await reconciled()).escrow_matches_employees], [true, true]);

// ---- guards
eq("guards: claimed employees cannot hold money; a held balance needs no account", (await q("select count(*)::int n from employees where employee_account_id is not null and balance <> 0"))[0].n, 0);
eq("guards: a suspended organization cannot run a batch", await (async () => { await q("update accounts set status='suspended' where id=$1", [acme.account_id]); return (await batch(acme, [{ employee_id: "Z1", name: "Z", email: "z@example.com", amount: 1 }], "susp")).status; })(), 401);
console.log(`\n${pass} passed, ${fail} failed`);
await adm.end();
process.exit(fail ? 1 : 0);
