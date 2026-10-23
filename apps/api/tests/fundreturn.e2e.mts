import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const env: any = { STATS_TTL_SECONDS: "0", HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (m: string, p: string, o: { body?: unknown; token?: string; key?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + p, { method: m, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const sign = async (name: string, email: string, type = "C") => (await call("POST", "/v1/auth/signup", { body: { type, name, email, password: "correct horse battery" } })).json;
const op = (m: string, p: string, body?: unknown) => call(m, p, { token: OP, body });
const bal = async (a: any) => (await q("select balance::int b, credit_spent::int c from balances where account_id=$1", [a.account_id]))[0];
const recon = async () => (await op("GET", "/v1/admin/stats")).json.reconciliation;

const ada = await sign("Ada", "ada@x.test"), bob = await sign("Bob", "bob@x.test");
const shop = await sign("Shop", "shop@x.test", "B");
await q("update accounts set status='active' where id=$1", [shop.account_id]);
const term = (await call("POST", "/v1/terminals", { token: shop.session_token, body: { name: "T" } })).json.terminal.id;

// ---- a plain load, spent, then returned by the bank
await call("POST", "/v1/sandbox/fundings", { token: ada.session_token, key: "f1", body: { amount: 10000 } });
await call("POST", "/v1/payments", { token: ada.session_token, key: "p1", body: { terminal_id: term, amount: 4000 } });
const fid = (await q("select id from fundings where account_id=$1", [ada.account_id]))[0].id;
eq("only an admin can return a load", [(await call("POST", `/v1/admin/fundings/${fid}/return`, { token: ada.session_token })).status, (await op("POST", `/v1/admin/fundings/00000000-0000-7000-8000-00000000dead/return`, {})).status], [401, 404]);
const r1 = await op("POST", `/v1/admin/fundings/${fid}/return`, { code: "account_closed" });
eq("the return is recorded: the funding is returned with the bank's code", [r1.status, r1.json.funding.status, r1.json.funding.failure_code], [201, "returned", "account_closed"]);
eq("the balance goes below zero by what was spent (a debt, not clamped): 10,000 loaded, 4,000 spent, 10,000 taken back", await bal(ada), { b: -4000, c: 0 });
eq("the original fund transaction stays; a fund_return mirrors it to the bank wallet, pointing at it", (await q("select r.type, r.amount::int a, r.related_id = f.id as rel, r.to_wallet_id = '00000000-0000-7000-8000-000000000002' as to_bank, f.type ft from transactions r join transactions f on f.id = r.related_id where r.type = 'fund_return'"))[0], { type: "fund_return", a: 10000, rel: true, to_bank: true, ft: "fund" });
eq("the person is restricted: nothing goes out until the debt is cleared", [(await call("POST", "/v1/transfers", { token: ada.session_token, key: "s1", body: { to_wallet_id: bob.default_wallet_id, amount: 100 } })).json.status_code, (await call("POST", "/v1/payments", { token: ada.session_token, key: "p2", body: { terminal_id: term, amount: 100 } })).json.status_code, (await call("GET", "/v1/balance", { token: ada.session_token })).json.restricted], ["account_restricted", "account_restricted", true]);
eq("repeating the return changes nothing", [(await op("POST", `/v1/admin/fundings/${fid}/return`, {})).status, (await bal(ada)).b, (await q("select count(*)::int n from transactions where type='fund_return'"))[0].n], [200, -4000, 1]);
eq("the books reconcile with the return in them", await recon().then((r: any) => [r.ledger_balanced, r.balances_match_ledger, r.credit_matches_ledger]), [true, true, true]);
eq("it is in the audit log", (await q("select count(*)::int n from logs where action='funding.returned'"))[0].n, 1);
eq("paying it back (a new load) clears the debt and the restriction", await (async () => { await call("POST", "/v1/sandbox/fundings", { token: ada.session_token, key: "f2", body: { amount: 6000 } }); return [(await bal(ada)).b, (await call("GET", "/v1/balance", { token: ada.session_token })).json.restricted]; })(), [2000, false]);

// ---- a load that repaid credit: the return draws the credit principal again
await q("update balances set credit_limit = 5000 where account_id=$1", [bob.account_id]);
await call("POST", "/v1/payments", { token: bob.session_token, key: "bp1", body: { terminal_id: term, amount: 3000 } });    // 3,000 on credit
eq("bob owes 3,000 of credit", await bal(bob), { b: 0, c: 3000 });
await call("POST", "/v1/sandbox/fundings", { token: bob.session_token, key: "bf1", body: { amount: 5000 } });               // 3,000 repays credit, 2,000 to balance
const bfid = (await q("select id from fundings where account_id=$1", [bob.account_id]))[0].id;
eq("the load repaid the credit first", await bal(bob), { b: 2000, c: 0 });
await op("POST", `/v1/admin/fundings/${bfid}/return`, {});
eq("the return takes back the 2,000 and draws the 3,000 of credit again", await bal(bob), { b: 0, c: 3000 });
eq("the return transaction carries the credit part, and the books (balances and credit) still reconcile", [(await q("select credit_amount::int c from transactions where type='fund_return' and funding_id=$1", [bfid]))[0].c, await recon().then((r: any) => [r.ledger_balanced, r.balances_match_ledger, r.credit_matches_ledger])], [3000, [true, true, true]]);

// ---- what cannot be returned
const pend = await sign("Cy", "cy@x.test");
await q("insert into bank_accounts (account_id, routing_number, account_number, last4) values ($1,'SANDBOX','SANDBOX','0000')", [pend.account_id]);
await q("insert into fundings (account_id, bank_account_id, amount, idempotency_key, status) select $1, id, 500, 'k', 'pending' from bank_accounts where account_id=$1", [pend.account_id]);
eq("a load that was never released cannot be returned (409)", (await op("POST", `/v1/admin/fundings/${(await q("select id from fundings where account_id=$1", [pend.account_id]))[0].id}/return`, {})).json.error, "funding_not_released");
eq("a return code must be a short lowercase code", (await op("POST", `/v1/admin/fundings/${fid}/return`, { code: "Bad Code!" })).status, 400);
console.log(`\n${pass} passed, ${fail} failed`);
await adm.end();
process.exit(fail ? 1 : 0);
