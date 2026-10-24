import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { sign } from "hono/jwt";
import app from "../src/index.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 2, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const JWT_SECRET = "x".repeat(40);
const env: any = { STATS_TTL_SECONDS: "0", HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET, ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let log: string[] = [];
(globalThis as any).__sqlTrace = (s: string) => log.push(s.replace(/\s+/g, " "));
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (m: string, p: string, o: { body?: unknown; token?: string; key?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + p, { method: m, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const signup = async (name: string, email: string, type = "C") => (await call("POST", "/v1/auth/signup", { body: { type, name, email, password: "correct horse battery" } })).json;
const claimsOf = (t: string) => JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString());
const touchesDevices = (f: () => Promise<unknown>) => (async () => { log = []; await f(); return log.filter((l) => /\bdevices\b/.test(l)).length; })();

const ada = await signup("Ada", "ada@example.com"), bob = await signup("Bob", "bob@example.com");
const A = ada.session_token as string;
await call("POST", "/v1/sandbox/fundings", { token: A, key: "f1", body: { amount: 50000 } });

// ---- the token is a signed session, 90 days
const c = claimsOf(A);
eq("a session token is signed and carries the account, the device, the kind and the account type", [c.sub === ada.account_id, c.sid === ada.device_id, c.kind, c.typ, c.wid], [true, true, "owner", "C", null]);
eq("it lasts 90 days", Math.round((c.exp - c.iat) / 86400), 90);
eq("a forged, a foreign-audience and an expired token are all 401", [
  (await call("GET", "/v1/balance", { token: A.slice(0, -3) + "abc" })).status,
  (await call("GET", "/v1/balance", { token: await sign({ iss: "nuclear", aud: "nuclear:terminal", sub: ada.account_id, sid: ada.device_id, kind: "owner", typ: "C", exp: Math.floor(Date.now() / 1000) + 600 }, JWT_SECRET, "HS256") })).status,
  (await call("GET", "/v1/balance", { token: await sign({ iss: "nuclear", aud: "nuclear:session", sub: ada.account_id, sid: ada.device_id, kind: "owner", typ: "C", wid: null, exp: Math.floor(Date.now() / 1000) - 10 }, JWT_SECRET, "HS256") })).status,
  (await call("GET", "/v1/balance", { token: "not-a-token" })).status,
], [401, 401, 401, 401]);

// ---- hot paths read no row at all; the rest read the device
eq("the balance, the activity, a send and a payment never touch the devices table", [
  await touchesDevices(() => call("GET", "/v1/balance", { token: A })),
  await touchesDevices(() => call("GET", "/v1/activity", { token: A })),
  await touchesDevices(() => call("POST", "/v1/transfers", { token: A, key: "h1", body: { to_wallet_id: bob.default_wallet_id, amount: 100 } })),
], [0, 0, 0]);
eq("the money call itself checks the device row inside the same statement (one statement in all)", await (async () => { log = []; await call("POST", "/v1/transfers", { token: A, key: "h2", body: { to_wallet_id: bob.default_wallet_id, amount: 100 } }); return log.length; })(), 1);
eq("everything else reads the device (one statement, no write)", [await touchesDevices(() => call("GET", "/v1/account", { token: A })), (await call("GET", "/v1/account", { token: A })).status], [1, 200]);

// ---- refresh: a new token, the old one is not invalidated, and the first screen in one answer
await call("POST", "/v1/wallets", { token: A, body: { display_name: "Kid", type: "person" } });
await q("update devices set session_expires_at = now() + interval '10 days' where id = $1", [ada.device_id]);
log = [];
const r1 = await call("POST", "/v1/auth/refresh", { token: A });
eq("refresh answers 200 with a new token, a rolled expiry and the first screen: account, balance, wallets, tags", [
  r1.status, r1.json.session_token !== A, claimsOf(r1.json.session_token).sid === ada.device_id,
  (await q("select (session_expires_at > now() + interval '89 days') ok from devices where id = $1", [ada.device_id]))[0].ok,
  r1.json.account.account_id === ada.account_id, r1.json.balance.balance, r1.json.wallets.map((w: any) => w.type), Array.isArray(r1.json.tags),
], [200, true, true, true, true, 49800, ["default", "person"], true]);
eq("the old token keeps working until its own expiry; the new one works too", [(await call("GET", "/v1/balance", { token: A })).status, (await call("GET", "/v1/balance", { token: r1.json.session_token })).status], [200, 200]);
eq("an old route for extending is gone", (await call("POST", "/v1/devices/session/extend", { token: A })).status, 404);

// ---- revoke the device: reads on the signed token run to its expiry, but money and everything else stop at once
await call("POST", `/v1/devices/${ada.device_id}/revoke`, { token: r1.json.session_token });
eq("after a revoke: the device-checked routes and the money moves refuse (401)", [
  (await call("GET", "/v1/account", { token: A })).status,
  (await call("POST", "/v1/transfers", { token: A, key: "rv1", body: { to_wallet_id: bob.default_wallet_id, amount: 100 } })).status,
  (await call("POST", "/v1/auth/refresh", { token: A })).status,
], [401, 401, 401]);
eq("accepted: reads of the signed token (balance, activity) still work until the token expires", [(await call("GET", "/v1/balance", { token: A })).status, (await call("GET", "/v1/activity", { token: A })).status], [200, 200]);
eq("and nothing moved", (await q("select count(*)::int n from transactions where idem like 'send:%:rv1'"))[0].n, 0);

// ---- a new sign-in is a new device
const again = (await call("POST", "/v1/auth/login", { body: { email: "ada@example.com", password: "correct horse battery" } })).json;
eq("signing in again is a new device and a new token", [again.device_id !== ada.device_id, (await call("GET", "/v1/account", { token: again.session_token })).status], [true, 200]);

// ---- a suspended account cannot refresh, and cannot move money
await q("update accounts set status='suspended' where id=$1", [ada.account_id]);
eq("a suspended account: refresh is 401, a payment is refused", [(await call("POST", "/v1/auth/refresh", { token: again.session_token })).status, (await call("POST", "/v1/transfers", { token: again.session_token, key: "sp1", body: { to_wallet_id: bob.default_wallet_id, amount: 100 } })).json.status_code], [401, "sender_unavailable"]);
await q("update accounts set status='active' where id=$1", [ada.account_id]);

// ---- a delegated wallet device: always read through the database, sees only its wallet, refresh has no account
const kid = (await call("GET", "/v1/wallets", { token: again.session_token })).json.wallets.find((w: any) => w.type === "person");
const link = await call("POST", `/v1/wallets/${kid.id}/links`, { token: again.session_token });
const red = await call("POST", "/v1/devices/redeem", { body: { token: link.json.url.split("/magic-link/")[1] } });
const K = red.json.session_token as string;
eq("a redeemed wallet session is a signed token of kind wallet", [claimsOf(K).kind, claimsOf(K).wid === kid.id, (await call("POST", "/v1/devices/redeem", { body: { token: link.json.url.split("/magic-link/")[1] } })).status], ["wallet", true, 400]);
eq("a wallet device is checked against the database on every request", await touchesDevices(() => call("GET", "/v1/balance", { token: K })), 1);
const kr = await call("POST", "/v1/auth/refresh", { token: K });
eq("its refresh gives no account and only its own wallet", [kr.status, kr.json.account, kr.json.wallets.map((w: any) => w.id)], [200, null, [kid.id]]);
await call("PATCH", `/v1/wallets/${kid.id}`, { token: again.session_token, body: { status: "suspended" } });
eq("suspending the wallet stops its device at once", (await call("GET", "/v1/balance", { token: K })).status, 401);

// ---- businesses and organizations always read the account: a pending business gets nothing but its status
const biz = await signup("Cafe", "cafe@example.com", "B");
eq("a pending business is refused on a hot route (403) and can read its status", [(await call("GET", "/v1/balance", { token: biz.session_token })).status, (await call("GET", "/v1/account", { token: biz.session_token })).json.status], [403, "pending"]);
await q("update accounts set status='active' where id=$1", [biz.account_id]);
eq("approved, the same token works at once (no new token needed)", (await call("GET", "/v1/balance", { token: biz.session_token })).status, 200);
eq("refresh for a business gives its account and no consumer pieces", await call("POST", "/v1/auth/refresh", { token: biz.session_token }).then((r) => [r.status, r.json.account.type, r.json.balance, r.json.wallets]), [200, "B", null, []]);


// ---- the device model: sent at sign-in, updated by the launch call, bounded, never an error
const mdl = async (token: string) => (await call("GET", "/v1/devices", { token })).json.devices.map((d: any) => d.model);
const withModel = (await call("POST", "/v1/auth/login", { body: { email: "ada@example.com", password: "correct horse battery", platform: "ios", model: "iPhone15,3" } })).json;
eq("model: sign-in stores it, the owner's device list shows it", (await mdl(withModel.session_token))[0], "iPhone15,3");
eq("model: the launch call updates it", await (async () => { await call("POST", "/v1/auth/refresh", { token: withModel.session_token, body: { model: "iPhone16,2" } }); return (await mdl(withModel.session_token))[0]; })(), "iPhone16,2");
eq("model: a launch call with no model or a bad one keeps the stored model and still succeeds", await (async () => {
  const a = (await call("POST", "/v1/auth/refresh", { token: withModel.session_token })).status;
  const b = (await call("POST", "/v1/auth/refresh", { token: withModel.session_token, body: { model: "x".repeat(65) } })).status;
  return [a, b, (await mdl(withModel.session_token))[0]];
})(), [200, 200, "iPhone16,2"]);
eq("model: more than 64 characters at sign-in is a 400", (await call("POST", "/v1/auth/login", { body: { email: "ada@example.com", password: "correct horse battery", model: "x".repeat(65) } })).status, 400);

console.log(`\n${pass} passed, ${fail} failed`);
await adm.end();
process.exit(fail ? 1 : 0);
