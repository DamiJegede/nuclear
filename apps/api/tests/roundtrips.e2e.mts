import { randomBytes } from "node:crypto";
import app from "../src/index.ts";
import postgres from "postgres";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 2, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const env: any = { HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true", STATS_TTL_SECONDS: "0" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let log: string[] = [];
(globalThis as any).__sqlTrace = (s: string) => log.push(s.replace(/\s+/g, " ").slice(0, 70));
const call = async (m: string, p: string, o: any = {}) => { const r = await app.fetch(new Request("http://x" + p, { method: m, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx); const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null }; };
const a = (await call("POST", "/v1/auth/signup", { body: { name: "A", email: "a@x.test", password: "correct horse battery" } })).json;
const b = (await call("POST", "/v1/auth/signup", { body: { name: "B", email: "b@x.test", password: "correct horse battery" } })).json;
const m = (await call("POST", "/v1/auth/signup", { body: { type: "B", name: "M", email: "m@x.test", password: "correct horse battery" } })).json;
await call("POST", "/v1/sandbox/fundings", { token: a.session_token, key: "f1", body: { amount: 100000 } });
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
// Statements per request. A signed session token needs no database read, so each money move is ONE function call and nothing else.
const moneyStatements = () => log.filter((l) => /app_(send|pay_app|pay_tap|refund|refund_resolve|purchase)\(/.test(l)).length;
const statements = async (f: () => Promise<{ status: number }>) => { log = []; const r = await f(); return { status: r.status, total: log.length, money: moneyStatements() }; };

const t1 = await statements(() => call("POST", "/v1/transfers", { token: a.session_token, key: "s1", body: { to_wallet_id: b.default_wallet_id, amount: 100 } }));
eq("a send is one statement (the session token is checked without the database)", t1, { status: 201, total: 1, money: 1 });
const t1d = await statements(() => call("POST", "/v1/transfers", { token: a.session_token, key: "s2", body: { to_wallet_id: b.default_wallet_id, amount: 999999999 } }));
eq("so is a declined send (the decline is written by the same call)", [t1d.status, t1d.total, t1d.money], [422, 1, 1]);
const t1r = await statements(() => call("POST", "/v1/transfers", { token: a.session_token, key: "s1", body: { to_wallet_id: b.default_wallet_id, amount: 100 } }));
eq("and a replay", [t1r.status, t1r.total, t1r.money], [200, 1, 1]);

await q("update accounts set status='active' where id=$1", [m.account_id]);
const term = (await call("POST", "/v1/terminals", { token: m.session_token, body: { name: "T" } })).json;
const t2 = await statements(() => call("POST", "/v1/payments", { token: a.session_token, key: "p1", body: { terminal_id: term.terminal.id, amount: 250 } }));
eq("a payment confirmed in the app is one statement", [t2.status, t2.total, t2.money], [201, 1, 1]);
const pay = (await q("select id from transactions where type = 'pay' limit 1"))[0].id;
const t3 = await statements(() => call("POST", "/v1/terminal/refunds", { token: term.session_token, key: "r1", body: { payment_id: pay, mode: "partial", amount: 50 } }));
eq("a refund is one statement plus the terminal check", [t3.status, t3.money], [201, 1]);
console.log("terminal refund statements:", t3.total);

console.log(`\n${pass} passed, ${fail} failed`);
await adm.end();
process.exit(fail ? 1 : 0);
