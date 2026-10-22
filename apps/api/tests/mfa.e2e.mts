import { ROOT, applyMigration, migrate, psql, resetSchema } from "./db.ts";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sign } from "hono/utils/jwt/jwt";
import postgres from "postgres";
import app from "../src/index.ts";
import { hashPassword } from "../src/crypto.ts";
import { base32Decode, hotp, stepAt, totp } from "../src/lib/totp.ts";

psql(["-c", "drop schema public cascade; create schema public;"]);
migrate();
const adm = postgres("postgres://postgres@127.0.0.1:54340/nuclear", { max: 2, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];

const OP = "op-" + randomBytes(24).toString("hex");
const JWT_SECRET = "test-secret-test-secret-test-secret!";
const KEY = randomBytes(32).toString("base64");
const env: any = { STATS_TTL_SECONDS: "0", HYPERDRIVE: { connectionString: "postgres://postgres@127.0.0.1:54340/nuclear" }, JWT_SECRET, ADMIN_API_TOKEN: OP, MFA_ENCRYPTION_KEY: KEY, ADMIN_ORIGINS: "https://admin.nuclear.example" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(ok ? "ok  " : "FAIL", label, ok ? "" : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};
const raw = (method: string, path: string, o: { body?: unknown; token?: string; headers?: Record<string, string>; env?: any } = {}) =>
  app.fetch(new Request("http://x" + path, { method, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.headers ?? {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), o.env ?? env, ctx);
const call = async (...a: Parameters<typeof raw>) => { const r = await raw(...a); const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null, text: t }; };
const op = (m: string, p: string, body?: unknown) => call(m, p, { token: OP, body });

// fake clock: each step jumps to a new 30 s window
const realNow = Date.now.bind(Date); let skew = 0; Date.now = () => realNow() + skew;
const tick = (s = 31) => { skew += s * 1000; };
const PW = "Tk7-mQ4.vT7+xR2_bN5=cH8-wL3.jF6+";
const seed = async (accessId: string, name: string, token: string) =>
  (await q("insert into admins (access_id, name, access_token_hash) values ($1,$2,$3) returning id", [accessId, name, await hashPassword(token)]))[0].id as string;
const step1 = (a: string, pw = PW) => call("POST", "/v1/admin/login", { body: { access_id: a, access_token: pw } });
const step2 = (mfa_token: string, code: string) => call("POST", "/v1/admin/login/mfa", { body: { mfa_token, code } });
const stored = async (a: string) => (await q("select mfa_secret, mfa_enabled_at, mfa_last_step, mfa_recovery, failed_attempts, locked_until from admins where access_id=$1", [a]))[0];

// ---- a fresh admin: password session only
await seed("MIA", "Mia", PW);
const first = (await step1("MIA")).json;
const P = PW;
const T0 = first.session_token;
eq("before enrolling: data is closed with mfa_setup_required, /me and /logout are open", [(await call("GET", "/v1/admin/stats", { token: T0 })).json.error, (await call("GET", "/v1/admin/me", { token: T0 })).json.mfa_enabled], ["mfa_setup_required", false]);
eq("setup/enable are the only other doors", [(await call("GET", "/v1/admin/tag-models", { token: T0 })).status, (await call("POST", "/v1/admin/mfa/recovery-codes", { token: T0, body: { code: "123456" } })).json.error], [403, "mfa_setup_required"]);
eq("setup needs a person, not the operator token", (await call("POST", "/v1/admin/mfa/setup", { token: OP })).status, 403);
eq("setup needs a session", (await call("POST", "/v1/admin/mfa/setup")).status, 401);
eq("without the encryption key, MFA is unavailable (503), not silently skipped", [(await call("POST", "/v1/admin/mfa/setup", { token: T0, env: { ...env, MFA_ENCRYPTION_KEY: undefined } })).status], [503]);

// ---- enrollment
eq("enable before setup is refused", (await call("POST", "/v1/admin/mfa/enable", { token: T0, body: { code: "123456" } })).json.error, "setup_first");
const setup = await call("POST", "/v1/admin/mfa/setup", { token: T0 });
const SECRET = setup.json.secret as string;
eq("setup returns the key for manual entry and the otpauth URI for the QR code", [/^[A-Z2-7]{32}$/.test(SECRET), setup.json.otpauth_uri], [true, `otpauth://totp/Nuclear%20Admin:MIA?secret=${SECRET}&issuer=Nuclear%20Admin&algorithm=SHA1&digits=6&period=30`]);
const st1 = await stored("MIA");
eq("the secret is stored encrypted and pending (not active yet)", [st1.mfa_secret.startsWith("v1."), st1.mfa_secret.includes(SECRET), st1.mfa_enabled_at], [true, false, null]);
eq("a new setup call replaces the pending secret", await (async () => { const again = await call("POST", "/v1/admin/mfa/setup", { token: T0 }); const changed = again.json.secret !== SECRET; return [changed]; })(), [true]);
const S2 = (await call("POST", "/v1/admin/mfa/setup", { token: T0 })).json.secret as string;
eq("a wrong code does not enroll", [(await call("POST", "/v1/admin/mfa/enable", { token: T0, body: { code: "000000" } })).status, (await stored("MIA")).mfa_enabled_at], [401, null]);
eq("a code from the previous (replaced) secret does not enroll", (await call("POST", "/v1/admin/mfa/enable", { token: T0, body: { code: totp(SECRET, Date.now()) } })).status, 401);
eq("garbage codes are refused", [(await call("POST", "/v1/admin/mfa/enable", { token: T0, body: { code: "abc" } })).status, (await call("POST", "/v1/admin/mfa/enable", { token: T0, body: {} })).status], [400, 400]);
const enabled = await call("POST", "/v1/admin/mfa/enable", { token: T0, body: { code: totp(S2, Date.now()) } });
const RECOVERY = enabled.json.recovery_codes as string[];
eq("the right code enrolls and returns ten recovery codes once", [enabled.status, RECOVERY.length, new Set(RECOVERY).size, RECOVERY.every((c) => /^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(c))], [200, 10, 10, true]);
const st2 = await stored("MIA");
eq("recovery codes are stored only as hashes", [st2.mfa_recovery.length, RECOVERY.some((c) => JSON.stringify(st2.mfa_recovery).includes(c)), st2.mfa_recovery.every((h: string) => /^[0-9a-f]{64}$/.test(h))], [10, false, true]);
eq("enrollment is recorded and the enrolling code is spent", [st2.mfa_enabled_at !== null, Number(st2.mfa_last_step) === stepAt(Date.now())], [true, true]);
eq("the session now reaches the data", (await call("GET", "/v1/admin/stats", { token: T0 })).status, 200);
eq("already enrolled: setup and enable are refused", [(await call("POST", "/v1/admin/mfa/setup", { token: T0 })).status, (await call("POST", "/v1/admin/mfa/enable", { token: T0, body: { code: totp(S2, Date.now() + 31000) } })).status], [409, 409]);
eq("the admin list shows who has MFA", (await op("GET", "/v1/admin/admins")).json.admins.map((a: any) => [a.access_id, a.mfa_enabled]), [["MIA", true]]);

// ---- signing in with MFA
tick();
const c1 = await step1("MIA", P);
eq("the access token alone no longer gives a session", [c1.status, c1.json.mfa_required, typeof c1.json.mfa_token, c1.json.session_token, c1.json.expires_in], [200, true, "string", undefined, 300]);
eq("a wrong access token still looks like any other failure", (await step1("MIA", "wrong wrong wrong".padEnd(32, "x"))).json.error, "invalid_credentials");
eq("the challenge is not a session anywhere", [(await call("GET", "/v1/admin/me", { token: c1.json.mfa_token })).status, (await call("GET", "/v1/admin/stats", { token: c1.json.mfa_token })).status], [401, 401]);
const wrong = await step2(c1.json.mfa_token, "000000");
eq("a wrong code is refused with the generic answer", [wrong.status, wrong.json.error], [401, "invalid_credentials"]);
tick();
const ok1 = await step2(c1.json.mfa_token, totp(S2, Date.now()));
eq("the right code opens a session", [ok1.status, typeof ok1.json.session_token, ok1.json.mfa_enabled, ok1.json.must_change_access_token, ok1.json.admin], [200, "string", true, undefined, { access_id: "MIA", name: "Mia", role: "admin" }]);
eq("that session is fully open", (await call("GET", "/v1/admin/stats", { token: ok1.json.session_token })).status, 200);
eq("a successful sign-in clears earlier failures", (await stored("MIA")).failed_attempts, 0);

// replay and drift
const used = totp(S2, Date.now());
eq("the code that just worked cannot be used again", (await step2(c1.json.mfa_token, used)).status, 401);
const next = hotp(base32Decode(S2), stepAt(Date.now()) + 1);
eq("the next 30 s code is accepted (clock drift allowed), once", [(await step2(c1.json.mfa_token, next)).status, (await step2(c1.json.mfa_token, next)).status], [200, 401]);
eq("a code from three minutes ago is refused", (await step2(c1.json.mfa_token, hotp(base32Decode(S2), stepAt(Date.now()) - 6))).status, 401);
await q("update admins set failed_attempts = 0, locked_until = null where access_id='MIA'");

// challenge token handling
const forge = async (claims: object, secret = JWT_SECRET) => sign({ iss: "nuclear", iat: Math.floor(Date.now() / 1000), ...claims } as any, secret, "HS256");
const adminId = (await q("select id from admins where access_id='MIA'"))[0].id;
tick(65);   // past the step we just accepted one ahead
const good = () => ({ aud: "nuclear:admin-mfa", sub: adminId, exp: Math.floor(Date.now() / 1000) + 300 });
const codeNow = () => totp(S2, Date.now());
eq("challenge tokens signed with the wrong secret, wrong audience, expired or for no one are refused", await Promise.all([
  forge(good(), "not-the-secret-not-the-secret-123456"),
  forge({ ...good(), aud: "nuclear:wallet-link" }),
  forge({ ...good(), aud: "nuclear:terminal" }),
  forge({ ...good(), exp: Math.floor(Date.now() / 1000) - 5 }),
  forge({ ...good(), sub: "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee" }),
  Promise.resolve(ok1.json.session_token),
  Promise.resolve("this.is.not.a.valid.jwt.at.all"),
]).then((ts) => Promise.all(ts.map(async (t) => (await step2(t, codeNow())).status))), [401, 401, 401, 401, 401, 401, 401]);
eq("a challenge forged correctly (control) works", (await step2(await forge(good()), codeNow())).status, 200);
tick(301);
const stale = await step1("MIA", P);   // fresh challenge at the new time
tick(301);
eq("a challenge older than five minutes is refused", (await step2(stale.json.mfa_token, codeNow())).status, 401);

// ---- recovery codes
tick();
const rc1 = RECOVERY[0]!;
const r1 = await step1("MIA", P);
const viaRecovery = await step2(r1.json.mfa_token, rc1.toLowerCase().replace("-", " "));
eq("a recovery code signs in (case, dash and spaces don't matter)", [viaRecovery.status, (await stored("MIA")).mfa_recovery.length], [200, 9]);
eq("a recovery code works once", (await step2((await step1("MIA", P)).json.mfa_token, rc1)).status, 401);
eq("a second recovery code still works", (await step2((await step1("MIA", P)).json.mfa_token, RECOVERY[1]!)).status, 200);
eq("a made-up recovery code is refused", (await step2((await step1("MIA", P)).json.mfa_token, "AAAAA-BBBBB")).status, 401);
await q("update admins set failed_attempts = 0, locked_until = null where access_id='MIA'");

// new recovery codes need a live code
tick();
const sess = (await step2((await step1("MIA", P)).json.mfa_token, codeNow())).json.session_token;
eq("regenerating needs a valid authenticator code", [(await call("POST", "/v1/admin/mfa/recovery-codes", { token: sess, body: { code: "111111" } })).status, (await call("POST", "/v1/admin/mfa/recovery-codes", { token: sess, body: {} })).status], [401, 400]);
tick();
const regen = await call("POST", "/v1/admin/mfa/recovery-codes", { token: sess, body: { code: codeNow() } });
eq("new recovery codes: ten, and the old ones are dead", [regen.status, regen.json.recovery_codes.length, regen.json.recovery_codes.some((c: string) => RECOVERY.includes(c))], [200, 10, false]);
eq("an old recovery code no longer signs in", (await step2((await step1("MIA", P)).json.mfa_token, RECOVERY[2]!)).status, 401);
eq("a new recovery code does", (await step2((await step1("MIA", P)).json.mfa_token, regen.json.recovery_codes[0])).status, 200);
await q("update admins set failed_attempts = 0, locked_until = null where access_id='MIA'");

// ---- lock-out counts wrong codes, and password-then-guess cycles do not reset it
tick();
for (let i = 0; i < 3; i++) await step2((await step1("MIA", P)).json.mfa_token, "00000" + i);
eq("three wrong codes are counted even though the access-token step succeeded each time", (await stored("MIA")).failed_attempts, 3);
await step2((await step1("MIA", P)).json.mfa_token, "000010");
const fifth = await step2((await step1("MIA", P)).json.mfa_token, "000011");
eq("the fifth wrong code locks the account", [fifth.status, (await stored("MIA")).locked_until !== null, (await stored("MIA")).failed_attempts], [401, true, 0]);
tick();
eq("while locked, even the right access token and right code are refused", [(await step1("MIA", P)).status, (await step2(await forge(good()), codeNow())).status], [401, 401]);
await q("update admins set locked_until = now() - interval '1 minute' where access_id='MIA'");
tick();
eq("after the lock lapses the right code works again", (await step2((await step1("MIA", P)).json.mfa_token, codeNow())).status, 200);

// ---- parallel use of one code
tick();
const par = await Promise.all(Array.from({ length: 6 }, async () => step2((await step1("MIA", P)).json.mfa_token, codeNow())));
eq("the same code submitted in parallel opens exactly one session", par.filter((r) => r.status === 200).length, 1);
await q("update admins set failed_attempts = 0, locked_until = null where access_id='MIA'");

// ---- disabled / reset
tick();
const pending = (await step1("MIA", P)).json.mfa_token;
await op("PATCH", `/v1/admin/admins/${adminId}`, { status: "disabled" });
tick();
eq("a disabled account cannot finish a challenge it already holds", (await step2(pending, codeNow())).status, 401);
await op("PATCH", `/v1/admin/admins/${adminId}`, { status: "active" });
tick();
const live = (await step2((await step1("MIA", P)).json.mfa_token, codeNow())).json.session_token;
const reset = await op("PATCH", `/v1/admin/admins/${adminId}`, { reset_mfa: true });
const st3 = await stored("MIA");
eq("operator reset clears the enrollment and signs the person out", [reset.status, st3.mfa_secret, st3.mfa_enabled_at, st3.mfa_recovery, (await call("GET", "/v1/admin/me", { token: live })).status], [200, null, null, [], 401]);
const after = await step1("MIA", P);
eq("after a reset the access token gives a limited session again", [after.json.mfa_required, after.json.mfa_enabled, (await call("GET", "/v1/admin/stats", { token: after.json.session_token })).json.error], [undefined, false, "mfa_setup_required"]);
eq("old authenticator codes and recovery codes are dead", [(await op("GET", "/v1/admin/admins")).json.admins[0].mfa_enabled], [false]);
const setup2 = await call("POST", "/v1/admin/mfa/setup", { token: after.json.session_token });
tick();
eq("re-enrollment works with a new secret", [setup2.json.secret !== S2, (await call("POST", "/v1/admin/mfa/enable", { token: after.json.session_token, body: { code: totp(setup2.json.secret, Date.now()) } })).status], [true, 200]);
tick();
const relogin = await step1("MIA", P);
eq("the old authenticator no longer signs in; the new one does", [(await step2(relogin.json.mfa_token, totp(S2, Date.now()))).status, (await step2(relogin.json.mfa_token, totp(setup2.json.secret, Date.now()))).status], [401, 200]);

// ---- misc
eq("MFA sign-in without the encryption key is a clear 503", (await call("POST", "/v1/admin/login/mfa", { body: { mfa_token: await forge(good()), code: "123456" }, env: { ...env, MFA_ENCRYPTION_KEY: undefined } })).status, 503);
eq("step-two body is validated", [(await call("POST", "/v1/admin/login/mfa", { body: {} })).status, (await call("POST", "/v1/admin/login/mfa", { body: { mfa_token: "x".repeat(30), code: "1" } })).status], [400, 400]);
const pre = await raw("OPTIONS", "/v1/admin/login/mfa", { headers: { origin: "https://admin.nuclear.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
eq("step-two preflight works from the portal origin only", [pre.headers.get("access-control-allow-origin"), (await raw("OPTIONS", "/v1/admin/login/mfa", { headers: { origin: "https://evil.example", "access-control-request-method": "POST" } })).headers.get("access-control-allow-origin")], ["https://admin.nuclear.example", null]);
eq("the operator token still opens the data endpoints for scripts, with no MFA", [(await op("GET", "/v1/admin/stats")).status, (await op("GET", "/v1/admin/me")).json], [200, { operator: true, role: "admin", pages: ["overview", "merchants", "organizations", "users", "tags", "admins", "transactions", "shop", "audit"], landing: "overview" }]);
eq("nothing secret leaks: no response or list contains the secret, key or a recovery code", ![setup.text, enabled.text, (await op("GET", "/v1/admin/admins")).text, regen.text.replace(/"recovery_codes":\[[^\]]*\]/, "")].some((t) => t.includes(S2) && t !== setup.text) && !(await op("GET", "/v1/admin/admins")).text.includes("mfa_secret"), true);

console.log(`\n${pass} passed, ${fail} failed`);
await adm.end();
process.exit(fail ? 1 : 0);
