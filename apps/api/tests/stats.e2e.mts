import { ROOT, applyMigration, migrate, psql, resetSchema } from "./db.ts";
import { createCipheriv, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import app from "../src/index.ts";

psql(["-c", "drop schema public cascade; create schema public;"]);
migrate();
const adm = postgres("postgres://postgres@127.0.0.1:54340/nuclear", { max: 2, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];

const tagKey = randomBytes(16);
const TOKEN = "op-" + randomBytes(24).toString("hex");
const env: any = {
  HYPERDRIVE: { connectionString: "postgres://postgres@127.0.0.1:54340/nuclear" },
  JWT_SECRET: "test-secret-test-secret-test-secret!",
  TAG_KEY_V1: tagKey.toString("hex"),
  ADMIN_API_TOKEN: TOKEN,
  SANDBOX_FUNDING: "true",
  ADMIN_ORIGINS: "https://admin.nuclear.example, http://localhost:5173",
};
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(ok ? "ok  " : "FAIL", label, ok ? "" : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};
const raw = async (method: string, path: string, o: { body?: unknown; token?: string; key?: string; headers?: Record<string, string>; env?: any } = {}) =>
  app.fetch(new Request("http://x" + path, {
    method,
    headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}), ...(o.headers ?? {}) },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  }), o.env ?? env, ctx);
const call = async (...a: Parameters<typeof raw>) => { const r = await raw(...a); const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null }; };
const signup = async (name: string, email: string, type = "C") => { const j = (await call("POST", "/v1/auth/signup", { body: { name, email, password: "correct horse battery", type } })).json; if (type === "B") await q("update accounts set status='active' where id=$1", [j.account_id]); return j; }; // businesses start pending; these suites need them live
const stats = async () => (await call("GET", "/v1/admin/stats", { token: TOKEN })).json;
const urlFor = (uid: string, counter: number) => {
  const pt = Buffer.alloc(16, 0x55);
  pt[0] = 0xc7; Buffer.from(uid, "hex").copy(pt, 1); pt.writeUIntLE(counter, 8, 3);
  const c = createCipheriv("aes-128-cbc", tagKey, Buffer.alloc(16)); c.setAutoPadding(false);
  return `https://tag.nclr.app/v1/${Buffer.concat([c.update(pt), c.final()]).toString("hex")}`;
};

// ---- access
eq("stats need the operator token", [(await call("GET", "/v1/admin/stats")).status, (await call("GET", "/v1/admin/stats", { token: "x" })).status], [401, 401]);
eq("with no operator token configured, the token opens nothing", (await call("GET", "/v1/admin/stats", { token: TOKEN, env: { ...env, ADMIN_API_TOKEN: undefined } })).status, 401);

// ---- empty system
const empty = await stats();
eq("empty system: everything zero and reconciled", [empty.scheme.balance, empty.users.total, empty.merchants.total, empty.payments.total, empty.reconciliation.balances_match_ledger, empty.reconciliation.ledger_balanced],
  [0, 0, 0, { count: 0, volume: 0 }, true, true]);

// ---- build a known scenario
const u1 = await signup("U1", "u1@example.com"), u2 = await signup("U2", "u2@example.com"), u3 = await signup("U3", "u3@example.com");
const m1 = await signup("M1", "m1@example.com", "B"), m2 = await signup("M2", "m2@example.com", "B");
await q("update accounts set status='suspended' where id=$1", [u3.account_id]);
await call("POST", "/v1/sandbox/fundings", { token: u1.session_token, key: "f1", body: { amount: 10000 } });
await call("POST", "/v1/sandbox/fundings", { token: u2.session_token, key: "f2", body: { amount: 5000 } });
await call("POST", "/v1/transfers", { token: u1.session_token, key: "s1", body: { to_wallet_id: u2.default_wallet_id, amount: 1500 } });
const term = (await call("POST", "/v1/terminals", { token: m1.session_token, body: { name: "T" } })).json;
const T = term.session_token;
const model = (await q("insert into tag_models(type,name,price,quantity) values('band','B',1,10) returning id"))[0].id;
const tag = async (wallet: string, uid: string) => (await q("insert into tags(uid,model_id,wallet_id) values($1,$2,$3) returning id", [uid, model, wallet]))[0].id;
await tag(u1.default_wallet_id, "04AA0000000001"); await tag(u2.default_wallet_id, "04AA0000000002");
const tap = (uid: string, amount: number, key: string) => call("POST", "/v1/terminal/payments", { token: T, key, body: { amount, credential: { type: "tag", url: urlFor(uid, 1) } } });
await tap("04AA0000000001", 2000, "p1");
await tap("04AA0000000002", 500, "p2");
const co = (await call("POST", "/v1/terminal/checkouts", { token: T, body: { amount: 700 } })).json.checkout.id;
await call("POST", "/v1/payments", { token: u2.session_token, key: "c1", body: { checkout_id: co } });
await call("PATCH", `/v1/terminals/${term.terminal.id}`, { token: m1.session_token, body: { allow_refunds: true } });
await call("POST", "/v1/terminal/refunds", { token: T, key: "r1", body: { attempt: "p1", mode: "partial", amount: 300 } });
// failed and pending operations must not be counted
await call("POST", "/v1/transfers", { token: u3.session_token, key: "bad", body: { to_wallet_id: u1.default_wallet_id, amount: 1 } });   // suspended sender: declined or refused
await call("POST", "/v1/transfers", { token: u1.session_token, key: "toobig", body: { to_wallet_id: u2.default_wallet_id, amount: 9999999 } }); // declined
await call("PATCH", `/v1/terminals/${term.terminal.id}`, { token: m1.session_token, body: { allow_refunds: false } });
await call("POST", "/v1/terminal/refunds", { token: T, key: "r2", body: { attempt: "p2", mode: "full" } });   // pending approval

const s = await stats();
eq("scheme balance = all money held (u1 6800 + u2 5300 + m1 2900)", [s.scheme.balance, s.scheme.consumer_balance, s.scheme.merchant_balance], [15000, 12100, 2900]);
eq("no pending, credit or merchant debt yet", [s.scheme.pending, s.scheme.credit_outstanding, s.scheme.credit_limit, s.scheme.merchant_debt], [0, 0, 0, 0]);
eq("users: consumers only, by status", [s.users.total, s.users.active, s.users.suspended, s.users.closed, s.users.new_today, s.users.new_7d, s.users.new_30d], [3, 2, 1, 0, 3, 3, 3]);
eq("users: wallets counts consumers' open wallets only", [s.users.wallets, (await q("select count(*)::int n from wallets w join accounts a on a.id=w.account_id where a.type='C' and w.status<>'closed'"))[0].n], [3, 3]);
eq("merchants: total, active, transacting, terminals", s.merchants, { total: 2, active: 2, transacting: 1, terminals: 1 });
eq("sent: one completed send of 1500 (declined ones excluded)", s.payments.sent, { count: 1, volume: 1500 });
eq("tapped: two taps, 2000 + 500", s.payments.tapped, { count: 2, volume: 2500 });
eq("in-app: one customer-confirmed payment of 700", s.payments.in_app, { count: 1, volume: 700 });
eq("merchant payments = tapped + in-app; total = + sent", [s.payments.merchant_payments, s.payments.total], [{ count: 3, volume: 3200 }, { count: 4, volume: 4700 }]);
eq("refunds count only completed ones (pending excluded)", s.payments.refunds, { count: 1, volume: 300 });
eq("loaded = completed funding", s.payments.loaded, { count: 2, volume: 15000 });
eq("today's figures equal lifetime on day one", s.payments.today, { sent: { count: 1, volume: 1500 }, tapped: { count: 2, volume: 2500 }, in_app: { count: 1, volume: 700 }, agents: { count: 0, volume: 0 } });
eq("books reconcile", s.reconciliation, { balances_match_ledger: true, balance_difference: 0, credit_matches_ledger: true, credit_difference: 0, ledger_balanced: true, earmarks_within_balances: true, escrow_matches_employees: true, benefits_match_ledger: true });
eq("scheme balance equals total ever loaded (no credit, no fees)", s.scheme.balance, s.payments.loaded.volume);

// older activity is lifetime but not "today"
await q("update transactions set completed_at = completed_at - interval '3 days' where type='send'");
const s2 = await stats();
eq("a send from three days ago is lifetime, not today", [s2.payments.sent, s2.payments.today.sent], [{ count: 1, volume: 1500 }, { count: 0, volume: 0 }]);

// credit: balance grows by what the merchant received; credit outstanding tracks the draw
await q("update accounts set status='active' where id=$1", [u3.account_id]);
await q("update balances set credit_limit = 1000 where account_id=$1", [u3.account_id]);
await tag(u3.default_wallet_id, "04AA0000000003");
await tap("04AA0000000003", 400, "p3");
const s3 = await stats();
eq("credit-funded payment: merchant +400, credit outstanding 400, still reconciled", [s3.scheme.balance, s3.scheme.merchant_balance, s3.scheme.credit_outstanding, s3.scheme.credit_limit, s3.reconciliation.balances_match_ledger, s3.reconciliation.credit_matches_ledger], [15400, 3300, 400, 1000, true, true]);
eq("tapped now three", s3.payments.tapped, { count: 3, volume: 2900 });

// tampering is visible
await q("update balances set balance = balance + 7 where account_id=$1", [u1.account_id]);
await q("update balances set credit_spent = credit_spent + 5 where account_id=$1", [u3.account_id]);
const s4 = await stats();
eq("a balance that disagrees with the ledger is flagged with the gap", [s4.reconciliation.balances_match_ledger, s4.reconciliation.balance_difference, s4.reconciliation.credit_matches_ledger, s4.reconciliation.credit_difference], [false, 7, false, 5]);
await q("update balances set balance = balance - 7 where account_id=$1", [u1.account_id]);
await q("update balances set credit_spent = credit_spent - 5 where account_id=$1", [u3.account_id]);
await q("update balances set balance = -250 where account_id=$1", [m2.account_id]);
const s5 = await stats();
eq("a merchant in debt is reported (positive amount) and lowers the scheme balance", [s5.scheme.merchant_debt, s5.scheme.balance, s5.scheme.merchant_balance], [250, 15150, 3050]);
await q("update balances set balance = 0 where account_id=$1", [m2.account_id]);
await q("update balances set balance_pending = 900 where account_id=$1", [u2.account_id]);
eq("pending loads are summed separately, not in the scheme balance", [(await stats()).scheme.pending, (await stats()).scheme.balance], [900, 15400]);

// ---- CORS for the browser portal
const pre = await raw("OPTIONS", "/v1/admin/stats", { headers: { origin: "https://admin.nuclear.example", "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
eq("preflight from an allowed origin succeeds without a token", [pre.status < 300, pre.headers.get("access-control-allow-origin"), /authorization/i.test(pre.headers.get("access-control-allow-headers") ?? "")], [true, "https://admin.nuclear.example", true]);
const okOrigin = await raw("GET", "/v1/admin/stats", { token: TOKEN, headers: { origin: "http://localhost:5173" } });
eq("actual request from an allowed origin carries the CORS header", [okOrigin.status, okOrigin.headers.get("access-control-allow-origin")], [200, "http://localhost:5173"]);
const badOrigin = await raw("GET", "/v1/admin/stats", { token: TOKEN, headers: { origin: "https://evil.example" } });
eq("a foreign origin gets no CORS header", badOrigin.headers.get("access-control-allow-origin"), null);
const badPre = await raw("OPTIONS", "/v1/admin/stats", { headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
eq("preflight from a foreign origin is not granted", badPre.headers.get("access-control-allow-origin"), null);
const noList = await raw("GET", "/v1/admin/stats", { token: TOKEN, headers: { origin: "https://admin.nuclear.example" }, env: { ...env, ADMIN_ORIGINS: undefined } });
eq("no origins configured: no CORS at all", noList.headers.get("access-control-allow-origin"), null);
eq("other API areas send no CORS headers", (await raw("GET", "/health", { headers: { origin: "https://admin.nuclear.example" } })).headers.get("access-control-allow-origin"), null);
eq("responses are never cached", (await raw("GET", "/v1/admin/stats", { token: TOKEN })).headers.get("cache-control"), "no-store");

console.log(`\n${pass} passed, ${fail} failed`);
await adm.end();
process.exit(fail ? 1 : 0);
