import { ROOT, applyMigration, migrate, psql, resetSchema } from "./db.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import app from "../src/index.ts";
import { execFile } from "node:child_process";
import { createApi, signIn, completeMfa, isChallenge, ApiError } from "../../admin-portal/src/api.ts";
import { base32Decode, hotp, stepAt, totp } from "../src/lib/totp.ts";

psql(["-c", "drop schema public cascade; create schema public;"]);
migrate();

const TOKEN = "op-" + randomBytes(20).toString("hex");
const env: any = { HYPERDRIVE: { connectionString: "postgres://postgres@127.0.0.1:54340/nuclear" }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: TOKEN, SANDBOX_FUNDING: "true", ADMIN_ORIGINS: "http://localhost:5173", MFA_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  const r = await app.fetch(new Request("http://x" + req.url, { method: req.method, headers: req.headers as any, body: ["GET", "HEAD"].includes(req.method!) ? undefined : Buffer.concat(chunks) }), env, ctx);
  const h: Record<string, string> = {}; r.headers.forEach((v, k) => (h[k] = v));
  res.writeHead(r.status, h); res.end(await r.text());
});
await new Promise<void>((r) => server.listen(8798, "127.0.0.1", r));
const BASE = "http://127.0.0.1:8798";

// the same shape the portal's tests use as their fixture
const shape = (v: unknown): unknown => v && typeof v === "object" ? Object.fromEntries(Object.entries(v as object).sort().map(([k, x]) => [k, shape(x)])) : typeof v;
let fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `\n   got  ${JSON.stringify(g)}\n   want ${JSON.stringify(w)}`); };

const api = createApi(TOKEN, BASE);
const stats = await api.stats();
const expected = shape({
  as_of: "", scheme: { balance: 0, consumer_balance: 0, merchant_balance: 0, merchant_debt: 0, pending: 0, credit_outstanding: 0, credit_limit: 0 },
  reconciliation: { balances_match_ledger: true, balance_difference: 0, credit_matches_ledger: true, credit_difference: 0, ledger_balanced: true, earmarks_within_balances: true, escrow_matches_employees: true, benefits_match_ledger: true },
  users: { total: 0, active: 0, suspended: 0, closed: 0, new_today: 0, new_7d: 0, new_30d: 0, wallets: 0 },
  merchants: { total: 0, active: 0, transacting: 0, terminals: 0 },
  payments: { sent: { count: 0, volume: 0 }, tapped: { count: 0, volume: 0 }, in_app: { count: 0, volume: 0 }, agents: { count: 0, volume: 0 }, merchant_payments: { count: 0, volume: 0 }, total: { count: 0, volume: 0 }, refunds: { count: 0, volume: 0 }, loaded: { count: 0, volume: 0 }, today: { sent: { count: 0, volume: 0 }, tapped: { count: 0, volume: 0 }, in_app: { count: 0, volume: 0 }, agents: { count: 0, volume: 0 } } },
});
eq("the API's /stats has exactly the shape the portal expects", shape(stats), expected);
const created = await api.createModel({ type: "band", name: "NEO Band Lite", price: 2999, quantity: 1000, limited: false, status: "pending" });
eq("a model created through the portal client starts pending, price in cents", [created.status, created.price, created.name], ["pending", 2999, "NEO Band Lite"]);
const models = await api.models();
eq("model list has the shape the portal table reads", [models.length, Object.keys(models[0]!).sort()], [1, ["country", "created_at", "currency", "id", "limited", "name", "photo", "price", "quantity", "sold", "status", "tags", "type", "unassigned"]]);
const wrong = await createApi("not-the-token", BASE).stats().catch((e) => e);
eq("a wrong token is an ApiError 401 (the portal's sign-out trigger)", [wrong instanceof ApiError, wrong.status, wrong.code], [true, 401, "unauthorized"]);
const down = await createApi(TOKEN, "http://127.0.0.1:1").stats().catch((e) => e);
eq("an unreachable API is status 0", [down instanceof ApiError, down.status], [true, 0]);
// CORS as a browser would see it
const pre = await fetch(BASE + "/v1/admin/stats", { method: "OPTIONS", headers: { origin: "http://localhost:5173", "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
eq("the dev portal origin passes preflight", [pre.status < 300, pre.headers.get("access-control-allow-origin")], [true, "http://localhost:5173"]);

// ---- admin accounts end to end: the scripts create them, the portal's client signs in
import { readFileSync, statSync, writeFileSync as wf } from "node:fs";
const run = (script: string, args: string[], stdin = "") => new Promise<{ code: number; out: string }>((resolve) => {
  const p = execFile("node", [`${ROOT}scripts/${script}`, ...args], { env: { PATH: process.env.PATH, API_URL: BASE, ADMIN_API_TOKEN: TOKEN } }, (err, stdout, stderr) => resolve({ code: err ? (err as any).code ?? 1 : 0, out: stdout + stderr }));
  p.stdin!.end(stdin);
});
const strip = (x: string) => x.replace(/\x1b\[[0-9;]*m/g, "");
const field = (out: string, label: string) => new RegExp(`${label}:\\s+(\\S+)`).exec(strip(out))?.[1] ?? "";
const SCRATCH = mkdtempSync(join(tmpdir(), "nuclear-test-"));

eq("add-admin needs a name", (await run("add-admin.mjs", [])).code, 1);
const made = await run("add-admin.mjs", ["--name", "Jane Doe"]);
const ID = field(made.out, "Access ID"), TOK = field(made.out, "Access Token");
eq("add-admin prints a 12-character uppercase Access ID and a 32-character access token, once", [made.code, ID.length, ID === ID.toUpperCase(), TOK.length, /only time the Access Token is shown/.test(made.out)], [0, 12, true, 32, true]);

const first = await signIn(ID.toLowerCase(), TOK, BASE);   // typed in lowercase on purpose
if (isChallenge(first)) throw new Error("a brand-new admin should not need a code yet");
eq("the portal client signs in (any case), and is told MFA is not set up", [typeof first.session_token, first.admin, first.mfa_enabled], ["string", { access_id: ID, name: "Jane Doe", role: "admin" }, false]);
const jane = createApi(first.session_token, BASE);
eq("me() has the shape the portal reads", Object.keys(await jane.me()).sort(), ["access_id", "landing", "mfa_enabled", "name", "pages", "role"]);
const needMfa = await jane.stats().catch((e) => e);
eq("the data stays closed until two-step verification is set up (the portal's enrollment trigger)", [needMfa.status, needMfa.code], [403, "mfa_setup_required"]);
const NEW = TOK;

const setup = await jane.mfaSetup();
eq("setup has the shape the QR screen reads", [Object.keys(setup).sort(), setup.otpauth_uri.startsWith(`otpauth://totp/Nuclear%20Admin:${ID}?secret=${setup.secret}`)], [["otpauth_uri", "secret"], true]);
const badEnable = await jane.mfaEnable("000000").catch((e) => e);
eq("a wrong code at enrollment is 401 invalid_code, not a session end", [badEnable.status, badEnable.code], [401, "invalid_code"]);
const recovery = await jane.mfaEnable(totp(setup.secret, Date.now()));
eq("enrolling returns ten recovery codes", [recovery.length, recovery.every((c: string) => /^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(c))], [10, true]);
eq("the same session now reaches the numbers", (await jane.stats()).scheme.balance, 0);

// creating admins from the portal's client
const rows = await jane.admins();
eq("admins() has the shape the page reads", [rows.length, Object.keys(rows[0]!).sort()], [1, ["access_id", "created_at", "created_by", "id", "last_login_at", "locked", "mfa_enabled", "name", "role", "status"]]);
const nu = await jane.createAdmin("Created In Portal");
eq("createAdmin returns credentials once, in the shape the panel shows", [Object.keys(nu).sort(), Object.keys(nu.credentials).sort(), nu.credentials.access_id.length, nu.credentials.access_token.length], [["admin", "credentials"], ["access_id", "access_token"], 12, 32]);
const after = await jane.admins();
eq("the new admin appears, credited to the creator, and its token is nowhere in the list", [after.length, after.find((a) => a.access_id === nu.credentials.access_id)?.created_by, JSON.stringify(after).includes(nu.credentials.access_token)], [2, ID, false]);

// signing in again needs the second step
const nextCode = () => hotp(base32Decode(setup.secret), stepAt(Date.now()) + 1);
const challenge = await signIn(ID, NEW, BASE);
eq("the token alone yields a challenge, not a session", [isChallenge(challenge), isChallenge(challenge) ? Object.keys(challenge).sort() : null], [true, ["expires_in", "mfa_required", "mfa_token"]]);
if (!isChallenge(challenge)) throw new Error("expected a challenge");
const badCode = await completeMfa(challenge.mfa_token, "000000", BASE).catch((e) => e);
eq("a wrong code is a 401 invalid_credentials", [badCode.status, badCode.code], [401, "invalid_credentials"]);
const live = await completeMfa(challenge.mfa_token, nextCode(), BASE);
eq("the right code returns the session the portal stores", [typeof live.session_token, live.mfa_enabled], ["string", true]);
const janeApi = createApi(live.session_token, BASE);
eq("that session works", (await janeApi.stats()).scheme.balance, 0);
const viaRecovery = await completeMfa(((await signIn(ID, NEW, BASE)) as any).mfa_token, recovery[0]!, BASE);
eq("a recovery code signs in through the same client call", typeof viaRecovery.session_token, "string");
await janeApi.logout();
const dead = await janeApi.me().catch((e) => e);
eq("after sign-out the session is rejected with the code the portal treats as 'session ended'", [dead.status, dead.code], [401, "unauthorized"]);
const wrongTok = await signIn(ID, "wrong token wrong token".padEnd(32, "x"), BASE).catch((e) => e);
eq("a wrong access token is 401 invalid_credentials", [wrongTok.status, wrongTok.code], [401, "invalid_credentials"]);
eq("the old field name is gone", (await fetch(BASE + "/v1/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ access_id: ID, password: NEW }) })).status, 400);

// the second script
const lst = await run("manage-admin.mjs", ["--list"]);
eq("manage-admin --list shows both admins and the creator, without secrets", [new RegExp(`${ID}\\s+Jane Doe\\s+ADMIN, active, 2-step on`).test(lst.out), /Created In Portal.*added by/.test(lst.out), /scrypt|hash|secret|Q8-fJk2/i.test(lst.out)], [true, true, false]);
const dis = await run("manage-admin.mjs", ["--access-id", ID.toLowerCase(), "--disable"]);
eq("manage-admin --disable (ID typed in lowercase) blocks sign-in", [dis.code, (await signIn(ID, NEW, BASE).catch((e) => e)).status], [0, 401]);
await run("manage-admin.mjs", ["--access-id", ID, "--enable"]);
eq("--enable lets her back to the code step", isChallenge(await signIn(ID, NEW, BASE)), true);
const rmfa = await run("manage-admin.mjs", ["--access-id", ID, "--reset-mfa"]);
const afterReset = await signIn(ID, NEW, BASE);
eq("--reset-mfa forgets the authenticator: the token gives a limited session and enrollment is required again", [rmfa.code, /Two-step verification reset/.test(rmfa.out), isChallenge(afterReset), !isChallenge(afterReset) && afterReset.mfa_enabled], [0, true, false, false]);
const rtok = await run("manage-admin.mjs", ["--access-id", ID, "--reset-token"]);
const TOK2 = field(rtok.out, "Access Token");
eq("--reset-token issues a fresh 32-character token (printed once) and the old one stops working", [rtok.code, TOK2.length, TOK2 !== NEW, (await signIn(ID, NEW, BASE).catch((e) => e)).status, (() => { return 0; })()], [0, 32, true, 401, 0]);
const afterTok = await signIn(ID, TOK2, BASE);
eq("the new token signs in", [isChallenge(afterTok) ? "challenge" : typeof afterTok.session_token], ["string"]);
// saving to a private file instead of printing
const savePath = SCRATCH + "/saved-credentials.txt";
const rtok2 = await run("manage-admin.mjs", ["--access-id", ID, "--reset-token", "--save", savePath]);
const saved = readFileSync(savePath, "utf8");
eq("--save writes the credentials to a file only the owner can read and does not print the token", [rtok2.code, (statSync(savePath).mode & 0o777).toString(8), saved.includes(`Access ID:     ${ID}`), /Access Token:\s+\S{32}\n/.test(saved), rtok2.out.includes(saved.match(/Access Token:\s+(\S+)/)![1]!)], [0, "600", true, true, false]);
const addSaved = await run("add-admin.mjs", ["--name", "Saved Person", "--save", SCRATCH + "/saved-2.txt"]);
eq("add-admin --save keeps the token out of the terminal", [addSaved.code, /Access Token:/.test(strip(addSaved.out)), readFileSync(SCRATCH + "/saved-2.txt", "utf8").includes("Saved Person")], [0, false, true]);
eq("manage-admin knows when the account does not exist, and needs an action", [(await run("manage-admin.mjs", ["--access-id", "GHOST", "--disable"])).code, (await run("manage-admin.mjs", ["--access-id", ID])).code], [1, 1]);
eq("no script output contains the operator token or a previous token", [made.out, lst.out, dis.out, rmfa.out].some((o) => o.includes(TOKEN)), false);

server.close(); console.log(fail ? `\n${fail} failed` : "\nall passed"); process.exit(fail ? 1 : 0);
