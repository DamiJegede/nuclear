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

// Several payers, two merchants, everyone funded: then payments and sends fly in all directions at once.
const payers = [] as any[];
for (let i = 0; i < 6; i++) { const p = await sign(`P${i}`, `p${i}@example.com`); await call("POST", "/v1/sandbox/fundings", { token: p.session_token, key: `f${i}`, body: { amount: 20000 } }); payers.push(p); }
const shops = [] as any[];
for (let i = 0; i < 2; i++) { const s = await sign(`Shop${i}`, `s${i}@example.com`, "B"); await q("update accounts set status='active' where id=$1", [s.account_id]); shops.push({ ...s, term: (await call("POST", "/v1/terminals", { token: s.session_token, body: { name: "T" } })).json.terminal.id }); }
const walletOf = async (p: any) => (await call("GET", "/v1/wallets", { token: p.session_token })).json.wallets[0].id;
const wallets = await Promise.all(payers.map(walletOf));
const total0 = Number((await q("select sum(balance)::bigint t from balances"))[0].t);

const jobs: Promise<any>[] = [];
for (let n = 0; n < 40; n++) {
  const a = n % 6, b = (n * 5 + 1) % 6;
  jobs.push(call("POST", "/v1/payments", { token: payers[a].session_token, key: `pay-${n}`, body: { amount: 100 + n, terminal_id: shops[n % 2].term } }));
  if (a !== b) jobs.push(call("POST", "/v1/transfers", { token: payers[a].session_token, key: `send-${n}`, body: { to_wallet_id: wallets[b], amount: 50 + n } }));
}
const res = await Promise.all(jobs);
eq("every concurrent payment and send finishes (no deadlock, no 5xx)", res.filter((r) => r.status >= 500).length, 0);
eq("most succeed (these payers are well funded)", res.filter((r) => r.status === 201 || r.status === 200).length >= res.length - 2, true);
eq("money is conserved: the sum of all balances is unchanged", Number((await q("select sum(balance)::bigint t from balances"))[0].t), total0);
eq("no balance went negative and the ledger balances", [(await q("select count(*)::int n from balances where balance < 0"))[0].n, (await call("GET", "/v1/admin/stats", { token: OP })).json.reconciliation.ledger_balanced, (await call("GET", "/v1/admin/stats", { token: OP })).json.reconciliation.balances_match_ledger], [0, true, true]);
const dup = await Promise.all([1, 2, 3, 4, 5].map(() => call("POST", "/v1/payments", { token: payers[0].session_token, key: "same-key", body: { amount: 777, terminal_id: shops[0].term } })));
eq("five simultaneous retries of one payment charge it once", [dup.filter((r) => r.status === 201).length >= 1, Number((await q("select count(*) n from transactions where idem like '%same-key'"))[0].n)], [true, 1]);
console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
