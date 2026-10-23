import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { memoryLimiter } from "../src/lib/throttle.ts";
import mcp from "../../mcp/src/index.ts";
import { dailyJobs } from "../src/lib/cron.ts";
import { migrate, psql, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 4, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const env: any = { HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true", DAILY_VALUE_CAP_CENTS: "50000000" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (method: string, path: string, o: { body?: unknown; token?: string; key?: string; ip?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + path, { method, headers: { "content-type": "application/json", ...(o.ip ? { "cf-connecting-ip": o.ip } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null, retryHeader: r.headers.get("retry-after") };
};
const signup = async (name: string, email: string, ip?: string) => (await call("POST", "/v1/auth/signup", { ip, body: { name, email, password: "correct horse battery" } })).json;
const login = (email: string, password: string, ip?: string) => call("POST", "/v1/auth/login", { ip, body: { email, password } });
const expire = async (prefix: string) => memoryLimiter.windows.age(prefix, 2 * 86_400_000);
const GOOD = "correct horse battery", BAD = "wrong horse battery staple";

// ---- customer login: five wrong passwords lock the email
const ada = await signup("Ada", "ada@example.com"); await signup("Bob", "bob@example.com");
const wrong = []; for (let i = 0; i < 5; i++) wrong.push((await login("ada@example.com", BAD)).status);
eq("five wrong passwords are five ordinary refusals", wrong, [401, 401, 401, 401, 401]);
const locked = await login("ada@example.com", GOOD);
eq("then the email is locked, even for the right password, with a retry hint", [locked.status, locked.json.error, locked.json.retry_after > 0 && locked.json.retry_after <= 900, Number(locked.retryHeader) === locked.json.retry_after], [429, "rate_limited", true, true]);
eq("other emails are not affected; the locked one stays locked on further tries", [(await login("bob@example.com", GOOD)).status, (await login("ada@example.com", GOOD)).status], [200, 429]);
await expire("login:ada");
eq("when the window ends the right password works again and clears the count", [(await login("ada@example.com", GOOD)).status, memoryLimiter.windows.get("login:ada@example.com")?.count ?? 0], [200, 0]);
for (let i = 0; i < 3; i++) await login("ada@example.com", BAD);
await login("ada@example.com", GOOD);
const more = []; for (let i = 0; i < 4; i++) more.push((await login("ada@example.com", BAD)).status);
eq("a good login resets the count: three wrong, one right, then four wrong are still plain refusals", more, [401, 401, 401, 401]);
const ghost = []; for (let i = 0; i < 6; i++) ghost.push((await login("nobody@example.com", BAD)).status);
eq("an email that does not exist is limited the same way, so the answer reveals nothing", ghost, [401, 401, 401, 401, 401, 429]);
eq("a refused login is not an invalid-request or a crash: bad bodies are still 400 and are not counted", [(await call("POST", "/v1/auth/login", { body: {} })).status, memoryLimiter.windows.keys().filter((k) => k.startsWith("login:") && !["login:ada@example.com", "login:nobody@example.com"].includes(k)).length], [400, 0]);

// ---- per-IP limits (Cloudflare sends cf-connecting-ip; without it the IP limits are skipped)
eq("signups: ten per IP per hour, the eleventh is refused, another IP is fine", await (async () => {
  const rs = []; for (let i = 0; i < 11; i++) rs.push((await call("POST", "/v1/auth/signup", { ip: "203.0.113.7", body: { name: "N", email: `ip${i}@example.com`, password: GOOD } })).status);
  return [rs.slice(0, 10).every((s) => s === 201), rs[10], (await call("POST", "/v1/auth/signup", { ip: "203.0.113.8", body: { name: "N", email: "other-ip@example.com", password: GOOD } })).status];
})(), [true, 429, 201]);
eq("without a cf-connecting-ip header there is no IP limit (local runs, tests)", await (async () => { let ok = 0; for (let i = 0; i < 12; i++) ok += (await call("POST", "/v1/auth/signup", { body: { name: "N", email: `noip${i}@example.com`, password: GOOD } })).status === 201 ? 1 : 0; return ok; })(), 12);
eq("logins: thirty attempts per IP per minute, then 429 before any password is checked", await (async () => {
  const rs = []; for (let i = 0; i < 32; i++) rs.push((await login(`spray${i}@example.com`, BAD, "198.51.100.1")).status);
  return [rs.slice(0, 30).every((s) => s === 401), rs[30], rs[31]];
})(), [true, 429, 429]);
eq("admin sign-in: twenty attempts per IP per minute (bad bodies count too)", await (async () => {
  const rs = []; for (let i = 0; i < 22; i++) rs.push((await call("POST", "/v1/admin/login", { ip: "192.0.2.50", body: { access_id: "X", access_token: "x".repeat(32) } })).status);
  return [rs.slice(0, 20).every((s) => s === 401), rs[20], rs[21]];
})(), [true, 429, 429]);
eq("magic-link redeem: twenty tries per IP per minute", await (async () => {
  const rs = []; for (let i = 0; i < 22; i++) rs.push((await call("POST", "/v1/devices/redeem", { ip: "192.0.2.60", body: { token: "bad" + i } })).status);
  return [rs.slice(0, 20).every((s) => s === 400 || s === 401), rs[20], rs[21]];
})(), [true, 429, 429]);

// ---- per-account limits
const bob = await login("bob@example.com", GOOD); const B = bob.json.session_token;
const carol = await login("ip0@example.com", GOOD); const C = carol.json.session_token;
eq("recipient lookup by email: thirty per hour per account (stops harvesting), other accounts unaffected", await (async () => {
  const rs = []; for (let i = 0; i < 32; i++) rs.push((await call("POST", "/v1/recipients/lookup", { token: B, body: { email: `probe${i}@example.com` } })).status);
  return [rs.slice(0, 30).every((s) => s === 404), rs[30], (await call("POST", "/v1/recipients/lookup", { token: C, body: { email: "probe@example.com" } })).status];
})(), [true, 429, 404]);
eq("handle lookup: sixty per minute per account", await (async () => {
  const rs = []; for (let i = 0; i < 62; i++) rs.push((await call("GET", `/v1/handles/nobody${i % 9}`, { token: B })).status);
  return [rs.slice(0, 60).every((s) => s === 404), rs[60], rs[61]];
})(), [true, 429, 429]);
eq("shop orders: ten per minute per account", await (async () => {
  const rs = []; for (let i = 0; i < 12; i++) rs.push((await call("POST", "/v1/shop/orders", { token: B, key: "k" + i, body: { model_id: "00000000-0000-7000-8000-000000000000", quantity: 1, shipping: { name: "a", line1: "b", city: "c", region: "d", postal_code: "1", country: "us" } } })).status);
  return [rs.slice(0, 10).every((s) => s === 404), rs[10], rs[11]];
})(), [true, 429, 429]);
eq("tag claims: twenty per hour per account", await (async () => {
  const rs = []; for (let i = 0; i < 22; i++) rs.push((await call("POST", "/v1/tags/claim", { token: B, body: { url: "https://tag.nclr.app/v1/" + "ab".repeat(16) } })).status);
  return [rs.slice(0, 20).every((s) => s !== 429), rs[20], rs[21]];
})(), [true, 429, 429]);

// ---- agent keys
await call("POST", "/v1/sandbox/fundings", { token: B, key: "fb", body: { amount: 100000 } });
const mkAgent = async (n: string) => (await call("POST", "/v1/wallets", { token: B, body: { display_name: n, type: "agent", allow_send: true, balance: 20000 } })).json;
const a1 = await mkAgent("Agent A"), a2 = await mkAgent("Agent B"), a3 = await mkAgent("Agent C");
const carolWallet = (await call("GET", "/v1/wallets", { token: C })).json.wallets[0].id;
eq("an agent key may make 120 requests a minute; the 121st is slowed with a retry hint; another key and the owner are unaffected", await (async () => {
  const rs = []; for (let i = 0; i < 121; i++) rs.push(await call("GET", "/v1/balance", { token: a1.key }));
  const last = rs[120]!;
  return [rs.slice(0, 120).every((r) => r.status === 200), last.status, last.json.error, last.json.retry_after >= 1 && last.json.retry_after <= 60, (await call("GET", "/v1/balance", { token: a2.key })).status, (await call("GET", "/v1/balance", { token: B })).status];
})(), [true, 429, "rate_limited", true, 200, 200]);
await expire("agent:");
eq("when the minute is over the key works again", (await call("GET", "/v1/balance", { token: a1.key })).status, 200);
eq("an agent's sends: thirty a minute, the thirty-first is refused before any money logic runs", await (async () => {
  const rs = []; for (let i = 0; i < 31; i++) rs.push((await call("POST", "/v1/transfers", { token: a2.key, key: "m" + i, body: { to_wallet_id: carolWallet, amount: 1 } })).status);
  return [rs.slice(0, 30).every((s) => s === 201), rs[30], (await q("select count(*)::int n from transactions where idem like '%:m30'"))[0].n];
})(), [true, 429, 0]);
eq("payments by an agent key share the same money limit; the owner's own sends are not limited", await (async () => {
  const term = (await call("POST", "/v1/auth/signup", { body: { type: "B", name: "Shop", email: "shop@example.com", password: GOOD } })).json;
  await q("update accounts set status='active' where id=$1", [term.account_id]);
  const t = (await call("POST", "/v1/terminals", { token: term.session_token, body: { name: "T" } })).json.terminal.id;
  const p = await call("POST", "/v1/payments", { token: a2.key, key: "pay-a2", body: { amount: 1, terminal_id: t } });
  const ownerSends = []; for (let i = 0; i < 35; i++) ownerSends.push((await call("POST", "/v1/transfers", { token: B, key: "o" + i, body: { to_wallet_id: carolWallet, amount: 1 } })).status);
  const fresh = await call("POST", "/v1/payments", { token: a3.key, key: "pay-a3", body: { amount: 1, terminal_id: t } });
  return [p.status, ownerSends.every((s) => s === 201), fresh.status];
})(), [429, true, 201]);
eq("the MCP server shows the agent a clear rate-limit error with how long to wait", await (async () => {
  const mcpEnv: any = { API: { fetch: (req: Request) => app.fetch(req, env, ctx) } };
  const r = await mcp.fetch(new Request("http://mcp/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${a2.key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_money", arguments: { to_wallet_id: carolWallet, amount_cents: 1, idempotency_key: "mcp-limited-1" } } }) }), mcpEnv);
  const res = (await r.json()).result; const d = JSON.parse(res.content[0].text);
  return [res.isError, d.error, d.retry_after_seconds >= 1, typeof d.message];
})(), [true, "rate_limited", true, "string"]);

// ---- housekeeping
memoryLimiter.windows.age("login:", 3 * 86_400_000);
memoryLimiter.windows.set("fresh-key", { count: 1, start: Date.now() });
const before = memoryLimiter.windows.size();
const job = await dailyJobs(Date.UTC(2026, 6, 1, 6, 0), env);   // 06:00 UTC: not midnight in New York, but the sweep always runs
eq("the daily job removes counters older than a day and keeps recent ones, even on a run that does not reset", [job.swept > 0, memoryLimiter.windows.get("fresh-key")?.count ?? 0, memoryLimiter.windows.size() === before - job.swept], [true, 1, true]);
console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
