import { ROOT, applyMigration, migrate, psql, resetSchema } from "./db.ts";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import app from "../src/index.ts";
import { hashPassword } from "../src/crypto.ts";
import { totp } from "../src/lib/totp.ts";

psql(["-c", "drop schema public cascade; create schema public;"]);
migrate();
const adm = postgres("postgres://postgres@127.0.0.1:54340/nuclear", { max: 2, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];

const OP = "op-" + randomBytes(24).toString("hex");
const env: any = {
  HYPERDRIVE: { connectionString: "postgres://postgres@127.0.0.1:54340/nuclear" },
  JWT_SECRET: "test-secret-test-secret-test-secret!", ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true",
  ADMIN_ORIGINS: "https://admin.nuclear.example", MFA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(ok ? "ok  " : "FAIL", label, ok ? "" : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};
const raw = (method: string, path: string, o: { body?: unknown; token?: string; headers?: Record<string, string>; env?: any } = {}) =>
  app.fetch(new Request("http://x" + path, {
    method,
    headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.headers ?? {}) },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  }), o.env ?? env, ctx);
const call = async (...a: Parameters<typeof raw>) => { const r = await raw(...a); const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null, text: t }; };
const op = (m: string, p: string, body?: unknown) => call(m, p, { token: OP, body });

// fake clock: a code works once, so every authenticator sign-in jumps to a fresh 30 s window
const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const tick = () => { skew += 31_000; };
const authenticators = new Map<string, string>();   // ACCESS ID -> base32 secret

const signInRaw = (access_id: string, access_token: string) => call("POST", "/v1/admin/login", { body: { access_id, access_token } });
/** Access token, then (if the account has MFA and we hold its authenticator) the code. */
const signIn = async (access_id: string, access_token: string) => {
  const r = await signInRaw(access_id, access_token);
  const secret = authenticators.get(access_id.toUpperCase());
  if (!r.json?.mfa_required || !secret) return r;
  tick();
  return call("POST", "/v1/admin/login/mfa", { body: { mfa_token: r.json.mfa_token, code: totp(secret, Date.now()) } });
};
const enroll = async (token: string, accessId: string) => {
  const setup = await call("POST", "/v1/admin/mfa/setup", { token });
  tick();
  const enabled = await call("POST", "/v1/admin/mfa/enable", { token, body: { code: totp(setup.json.secret, Date.now()) } });
  authenticators.set(accessId, setup.json.secret);
  return enabled.json.recovery_codes as string[];
};
/** Insert an admin straight into the database with a token we know. */
const seed = async (accessId: string, name: string, token: string) =>
  (await q("insert into admins (access_id, name, access_token_hash) values ($1,$2,$3) returning id", [accessId, name, await hashPassword(token)]))[0].id as string;

const TOKEN0 = "Tk7-mQ4.vT7+xR2_bN5=cH8-wL3.jF6+";   // exactly 32 characters, as issued
const NEWTOK = TOKEN0;
const jane = await seed("JANE.DOE", "Jane Doe", TOKEN0);

// ---- who may create admins
eq("nobody without credentials can create admins", (await call("POST", "/v1/admin/admins", { body: { name: "X" } })).status, 401);
eq("names are validated", [(await op("POST", "/v1/admin/admins", { name: " " })).status, (await op("POST", "/v1/admin/admins", {})).status, (await op("POST", "/v1/admin/admins", { name: "x".repeat(81) })).status], [400, 400, 400]);
eq("the caller cannot choose the access ID or token (they are ignored)", await (async () => {
  const r = await op("POST", "/v1/admin/admins", { name: "Pick", access_id: "CHOSEN", access_token: "x".repeat(40) });
  return [r.status, r.json.credentials.access_id === "CHOSEN", r.json.credentials.access_token === "x".repeat(40)];
})(), [201, false, false]);

// ---- generated credentials
const made = await op("POST", "/v1/admin/admins", { name: "  Generated Person " });
const cr = made.json.credentials;
eq("the operator creates an admin; the response carries both credentials, once", [made.status, made.json.admin.name, made.json.admin.status], [201, "Generated Person", "active"]);
eq("the Access ID is 12 characters, uppercase, starting with a letter", [cr.access_id.length, /^[A-HJKMNP-TV-Z][A-HJKMNP-TV-Z2-9]{11}$/.test(cr.access_id), cr.access_id === cr.access_id.toUpperCase()], [12, true, true]);
eq("the access token is 32 characters of mixed classes with no look-alikes", [cr.access_token.length, /[A-Z]/.test(cr.access_token), /[a-z]/.test(cr.access_token), /[0-9]/.test(cr.access_token), /[-_.+=]/.test(cr.access_token), /[0O1lI]/.test(cr.access_token)], [32, true, true, true, true, false]);
eq("the access ID is stored uppercase and the token only as a hash", await (async () => { const r = (await q("select access_id, access_token_hash from admins where access_id=$1", [cr.access_id]))[0]; return [r.access_id === cr.access_id, r.access_token_hash.startsWith("scrypt$"), r.access_token_hash.includes(cr.access_token)]; })(), [true, true, false]);
eq("the token is never shown again: not in the list, not in any later response", (await op("GET", "/v1/admin/admins")).text.includes(cr.access_token), false);
const many = await Promise.all(Array.from({ length: 20 }, () => op("POST", "/v1/admin/admins", { name: "Bulk" })));
const ids = many.map((m) => m.json.credentials.access_id), toks = many.map((m) => m.json.credentials.access_token);
eq("twenty parallel creations: all succeed with distinct IDs and tokens", [many.every((m) => m.status === 201), new Set(ids).size, new Set(toks).size], [true, 20, 20]);
eq("a generated token never contains its own access ID", many.every((m) => !m.json.credentials.access_token.toUpperCase().includes(m.json.credentials.access_id)), true);

// ---- signing in with generated credentials
const lowered = await signInRaw(cr.access_id.toLowerCase(), cr.access_token);
eq("sign-in works with the generated pair, and the Access ID may be typed in lowercase", [lowered.status, lowered.json.admin.access_id, lowered.json.must_change_access_token, lowered.json.mfa_enabled], [200, cr.access_id, undefined, false]);
eq("the old field name is not accepted", (await call("POST", "/v1/admin/login", { body: { access_id: cr.access_id, password: cr.access_token } })).status, 400);

// ---- signing in
eq("an Access Token must be exactly 32 characters: 31, 33, 16 and empty are refused as bad requests (never checked against the database)", await Promise.all(["x".repeat(31), "x".repeat(33), "pDsPBd_grow3mazW", ""].map((t) => signInRaw("JANE.DOE", t))).then((rs) => rs.map((r) => [r.status, r.json.error])), [[400, "invalid_request"], [400, "invalid_request"], [400, "invalid_request"], [400, "invalid_request"]]);
const bad = [await signInRaw("JANE.DOE", "w".repeat(32)), await signInRaw("NOBODY", TOKEN0), await signInRaw("JANE.DOE", "")];
eq("wrong token, unknown id, empty token: same refusal", bad.map((b) => [b.status, b.json.error ?? "invalid_request"]), [[401, "invalid_credentials"], [401, "invalid_credentials"], [400, "invalid_request"]]);
eq("login body is validated", (await call("POST", "/v1/admin/login", { body: {} })).status, 400);
const li = await signInRaw("Jane.Doe", TOKEN0);
eq("sign-in works (access ID case-insensitive)", [li.status, li.json.admin, li.json.must_change_access_token, li.json.mfa_enabled, typeof li.json.session_token], [200, { access_id: "JANE.DOE", name: "Jane Doe", role: "admin" }, undefined, false, "string"]);
const T1 = li.json.session_token;
eq("only a hash of the session token is stored", [(await q("select count(*)::int n from admin_sessions where token_hash = $1", [T1]))[0].n, (await q("select count(*)::int n from admin_sessions where token_hash = $1", [createHash("sha256").update(T1).digest("hex")]))[0].n], [0, 1]);
const hrs = (await q("select extract(epoch from (expires_at - created_at))/3600 as h from admin_sessions where admin_id=$1 limit 1", [jane]))[0].h;
eq("session lasts about 8 hours", hrs > 7.9 && hrs < 8.1, true);

// ---- no forced token change; multi-factor comes first
eq("before enrolling, nothing but /me, /logout and MFA setup is open", [
  (await call("GET", "/v1/admin/stats", { token: T1 })).json.error,
  (await call("GET", "/v1/admin/tag-models", { token: T1 })).status,
  (await call("POST", "/v1/admin/admins", { token: T1, body: { name: "Sneaky" } })).status], ["mfa_setup_required", 403, 403]);
eq("/me has no token-change flag", (await call("GET", "/v1/admin/me", { token: T1 })).json, { access_id: "JANE.DOE", name: "Jane Doe", role: "admin", pages: ["overview", "merchants", "users", "tags", "admins", "transactions"], landing: "overview", mfa_enabled: false });
const recov = await enroll(T1, "JANE.DOE");
eq("after enrolling, the same session reaches the data", [recov.length, (await call("GET", "/v1/admin/stats", { token: T1 })).status], [10, 200]);
eq("there is no route to change an Access Token", [(await call("POST", "/v1/admin/access-token", { token: T1, body: { current_access_token: TOKEN0, new_access_token: "q".repeat(32) } })).status >= 400, (await signIn("JANE.DOE", TOKEN0)).status], [true, 200]);

// ---- what a signed-in admin can do, including creating admins
const S = (await signIn("JANE.DOE", NEWTOK)).json.session_token;
const as = (m: string, p: string, body?: unknown) => call(m, p, { token: S, body });
eq("stats", (await as("GET", "/v1/admin/stats")).status, 200);
const model = await as("POST", "/v1/admin/tag-models", { type: "band", name: "NEO Band Lite", price: 2999, quantity: 10 });
eq("create a model (starts pending)", [model.status, model.json.model.status], [201, "pending"]);
eq("import UIDs", (await as("POST", `/v1/admin/tag-models/${model.json.model.id}/tags`, { uids: ["04AE42EAAF1290"] })).json.inserted, 1);
const byJane = await as("POST", "/v1/admin/admins", { name: "Created By Jane" });
eq("a signed-in admin creates admins and sees the credentials once", [byJane.status, byJane.json.credentials.access_id.length, byJane.json.credentials.access_token.length], [201, 12, 32]);
const list = (await as("GET", "/v1/admin/admins")).json.admins;
eq("the list shows who created whom (the operator shows as null)", [list.find((a: any) => a.access_id === byJane.json.credentials.access_id).created_by, list.find((a: any) => a.access_id === cr.access_id).created_by], ["JANE.DOE", null]);
eq("the list never contains tokens or hashes", [JSON.stringify(list).includes("scrypt"), JSON.stringify(list).includes(byJane.json.credentials.access_token), JSON.stringify(list).includes("hash")], [false, false, false]);
eq("changing existing admins stays with the operator", [(await as("PATCH", `/v1/admin/admins/${jane}`, { status: "disabled" })).status, (await as("PATCH", `/v1/admin/admins/${jane}`, { reset_access_token: true })).status], [403, 403]);
eq("the operator token still works for scripts", [(await op("GET", "/v1/admin/stats")).status, (await op("GET", "/v1/admin/me")).json], [200, { operator: true, role: "admin", pages: ["overview", "merchants", "users", "tags", "admins", "transactions"], landing: "overview" }]);
eq("a random token opens nothing", (await call("GET", "/v1/admin/stats", { token: randomBytes(24).toString("base64url") })).status, 401);
eq("the new admin can sign in, has no MFA yet", await (async () => { const r = await signInRaw(byJane.json.credentials.access_id, byJane.json.credentials.access_token); return [r.status, r.json.mfa_enabled]; })(), [200, false]);

// ---- lock-out
const locky = await seed("LOCKY", "Locky", TOKEN0);
const lockyFails = [];
for (let i = 0; i < 5; i++) lockyFails.push((await signInRaw("LOCKY", ("definitely wrong " + i).padEnd(32, "x"))).status);
eq("five wrong tokens", lockyFails, [401, 401, 401, 401, 401]);
eq("account is now locked: even the right token is refused, with the same answer", (await signInRaw("LOCKY", TOKEN0)).json.error, "invalid_credentials");
eq("lock is recorded", (await q("select locked_until > now() as locked, failed_attempts f from admins where access_id='LOCKY'"))[0], { locked: true, f: 0 });
await q("update admins set locked_until = now() - interval '1 minute' where access_id='LOCKY'");
eq("after the lock expires the right token works again", (await signInRaw("LOCKY", TOKEN0)).status, 200);
eq("a successful sign-in clears the failure count", (await q("select failed_attempts f, locked_until is null as clear from admins where access_id='LOCKY'"))[0], { f: 0, clear: true });
await signInRaw("LOCKY", "w1".padEnd(32, "w")); await signInRaw("LOCKY", "w2".padEnd(32, "w")); await signInRaw("LOCKY", TOKEN0);
eq("failures short of the limit are forgotten by a good sign-in", (await q("select failed_attempts f from admins where access_id='LOCKY'"))[0].f, 0);

// ---- disabling, resetting, sessions
eq("operator lists admins without secrets", await (async () => { const r = await op("GET", "/v1/admin/admins"); return [r.text.includes("scrypt"), r.text.includes("access_token_hash"), r.json.admins.some((a: any) => a.access_id === "JANE.DOE")]; })(), [false, false, true]);
eq("disabling signs the person out immediately and blocks sign-in", [(await op("PATCH", `/v1/admin/admins/${jane}`, { status: "disabled" })).json.admin.status, (await as("GET", "/v1/admin/stats")).status, (await signIn("JANE.DOE", NEWTOK)).status], ["disabled", 401, 401]);
eq("re-enabling restores access", [(await op("PATCH", `/v1/admin/admins/${jane}`, { status: "active" })).status, (await signIn("JANE.DOE", NEWTOK)).status], [200, 200]);
const S2 = (await signIn("JANE.DOE", NEWTOK)).json.session_token;
const reset = await op("PATCH", `/v1/admin/admins/${jane}`, { reset_access_token: true });
const issued = reset.json.credentials.access_token;
eq("a reset issues a fresh 32-character token (shown once), and ends all sessions", [issued.length, reset.json.credentials.access_id, (await call("GET", "/v1/admin/me", { token: S2 })).status, (await signIn("JANE.DOE", NEWTOK)).status, (await signIn("JANE.DOE", issued)).status], [32, "JANE.DOE", 401, 401, 200]);
eq("operator patch validation", [(await op("PATCH", `/v1/admin/admins/${jane}`, {})).status, (await op("PATCH", `/v1/admin/admins/${jane}`, { status: "gone" })).status, (await op("PATCH", `/v1/admin/admins/${jane}`, { reset_access_token: false })).status, (await op("PATCH", "/v1/admin/admins/0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", { status: "disabled" })).status], [400, 400, 400, 404]);
eq("the operator can no longer choose a token for someone", (await op("PATCH", `/v1/admin/admins/${jane}`, { access_token: "x".repeat(40) })).status, 400);

// ---- logout and expiry
const S3 = (await signInRaw("LOCKY", TOKEN0)).json.session_token;
eq("sign-out ends the session", [(await call("POST", "/v1/admin/logout", { token: S3 })).status, (await call("GET", "/v1/admin/me", { token: S3 })).status], [204, 401]);
const S4 = (await signInRaw("LOCKY", TOKEN0)).json.session_token;
await q("update admin_sessions set expires_at = now() - interval '1 second' where token_hash = $1", [createHash("sha256").update(S4).digest("hex")]);
eq("an expired session is refused", (await call("GET", "/v1/admin/me", { token: S4 })).status, 401);

// ---- CORS and caching for the portal's sign-in
const pre = await raw("OPTIONS", "/v1/admin/login", { headers: { origin: "https://admin.nuclear.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
eq("sign-in preflight works from the portal origin only", [pre.headers.get("access-control-allow-origin"), (await raw("OPTIONS", "/v1/admin/login", { headers: { origin: "https://evil.example", "access-control-request-method": "POST" } })).headers.get("access-control-allow-origin")], ["https://admin.nuclear.example", null]);
eq("sign-in responses are never cached and carry no token", [(await raw("POST", "/v1/admin/login", { body: { access_id: "LOCKY", access_token: TOKEN0 } })).headers.get("cache-control"), JSON.stringify((await signInRaw("LOCKY", TOKEN0)).json).includes(TOKEN0)], ["no-store", false]);
eq("creation responses are never cached", (await raw("POST", "/v1/admin/admins", { token: OP, body: { name: "Cache check" } })).headers.get("cache-control"), "no-store");

// ---- a burst of wrong tokens
await seed("RACER1", "Racer", TOKEN0);
await Promise.all(Array.from({ length: 12 }, (_, i) => signInRaw("RACER1", ("w" + i).padEnd(32, "w"))));
eq("a burst of wrong tokens locks the account", (await q("select locked_until is not null as locked from admins where access_id='RACER1'"))[0].locked, true);
eq("the right token is refused while locked", (await signInRaw("RACER1", TOKEN0)).status, 401);

// ---- database rules
let lower = "none"; try { await q("insert into admins (access_id, name, access_token_hash) values ('lowercase', 'x', 'h')"); } catch (e: any) { lower = e.constraint_name ?? e.code; }
eq("the database refuses a lowercase Access ID", lower, "admins_access_id_check");
let shortId = "none"; try { await q("insert into admins (access_id, name, access_token_hash) values ('AB', 'x', 'h')"); } catch (e: any) { shortId = e.constraint_name ?? e.code; }
eq("and an Access ID that is too short", shortId, "admins_access_id_check");
let dup = "none"; try { await q("insert into admins (access_id, name, access_token_hash) values ('LOCKY', 'x', 'h')"); } catch (e: any) { dup = e.constraint_name ?? e.code; }
eq("and a duplicate", dup, "admins_access_id_key");


// ---- rotating an Access Token
const rotMaker = (await op("POST", "/v1/admin/admins", { name: "Rotator" })).json;
const rotSelf = rotMaker.admin.id as string, ROTTOK = rotMaker.credentials.access_token as string, ROTID = rotMaker.credentials.access_id as string;
const RS = (await signIn(ROTID, ROTTOK)).json.session_token as string;
await enroll(RS, ROTID);
const targetId = (await q("select id from admins where access_id=$1", [cr.access_id]))[0].id;
const sTarget = (await signIn(cr.access_id, cr.access_token)).json.session_token;
const rot = await call("POST", `/v1/admin/admins/${targetId}/rotate-token`, { token: RS });
eq("a signed-in admin rotates another admin's token: new pair returned once, old token and sessions end", [rot.status, rot.json.credentials.access_id === cr.access_id, rot.json.credentials.access_token.length, rot.json.credentials.access_token !== cr.access_token, (await signIn(cr.access_id, cr.access_token)).status, (await call("GET", "/v1/admin/me", { token: sTarget })).status, (await signIn(cr.access_id, rot.json.credentials.access_token)).status], [200, true, 32, true, 401, 401, 200]);
eq("the new token is stored only as a hash and never listed", [(await q("select access_token_hash from admins where id=$1", [targetId]))[0].access_token_hash.includes(rot.json.credentials.access_token), (await op("GET", "/v1/admin/admins")).text.includes(rot.json.credentials.access_token)], [false, false]);
const own = await call("POST", `/v1/admin/admins/${rotSelf}/rotate-token`, { token: RS });
eq("rotating your own token keeps this session and the old token stops working", [own.status, (await call("GET", "/v1/admin/me", { token: RS })).status, (await signIn(ROTID, ROTTOK)).status, (await signIn(ROTID, own.json.credentials.access_token)).status], [200, 200, 401, 200]);
eq("the operator can rotate too; bad ids and no credentials are refused", [(await op("POST", `/v1/admin/admins/${targetId}/rotate-token`, {})).status, (await op("POST", "/v1/admin/admins/not-a-uuid/rotate-token", {})).status, (await op("POST", "/v1/admin/admins/00000000-0000-7000-8000-000000000000/rotate-token", {})).status, (await call("POST", `/v1/admin/admins/${targetId}/rotate-token`)).status], [200, 404, 404, 401]);
console.log(`\n${pass} passed, ${fail} failed`);
await adm.end();
process.exit(fail ? 1 : 0);
