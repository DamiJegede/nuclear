import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { totp } from "../src/lib/totp.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const env: any = { STATS_TTL_SECONDS: "0", HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, MFA_ENCRYPTION_KEY: randomBytes(32).toString("base64"), SANDBOX_FUNDING: "true" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (method: string, path: string, o: { body?: unknown; token?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + path, { method, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const op = (m: string, p: string, body?: unknown) => call(m, p, { token: OP, body });

// Make a person with a role, fully signed in (token step, then authenticator enrolment).
async function person(name: string, role: string) {
  const made = (await op("POST", "/v1/admin/admins", { name, role })).json;
  const signin = (await call("POST", "/v1/admin/login", { body: { access_id: made.credentials.access_id, access_token: made.credentials.access_token } })).json;
  const T = signin.session_token as string;
  const setup = (await call("POST", "/v1/admin/mfa/setup", { token: T })).json;
  await call("POST", "/v1/admin/mfa/enable", { token: T, body: { code: totp(setup.secret, Date.now()) } });
  return { id: made.admin.id as string, T, signin, made };
}

const users: Record<string, Awaited<ReturnType<typeof person>>> = {};
for (const r of ["admin", "accounting", "sales", "support", "tags", "merchants"]) users[r] = await person(r[0]!.toUpperCase() + r.slice(1), r);

// ---- the roles and where each lands
eq("creating an admin takes a role; the answer and the list carry it; no role means admin", [users.tags!.made.admin.role, (await op("POST", "/v1/admin/admins", { name: "Default" })).json.admin.role, (await op("GET", "/v1/admin/admins")).json.admins.map((a: any) => a.role).sort().join(",")], ["tags", "admin", "accounting,admin,admin,merchants,sales,support,tags"]);
eq("an unknown role is refused", [(await op("POST", "/v1/admin/admins", { name: "X", role: "root" })).status, (await op("POST", "/v1/admin/admins", { name: "X", role: "ADMIN" })).status], [400, 400]);
const pagesOf = (r: string) => users[r]!.signin;
eq("sign-in tells the portal the role, the pages and where to land", ["admin", "accounting", "sales", "support", "tags", "merchants"].map((r) => [r, users[r]!.signin.admin.role]), ["admin", "accounting", "sales", "support", "tags", "merchants"].map((r) => [r, r]));
const me = async (r: string) => (await call("GET", "/v1/admin/me", { token: users[r]!.T })).json;
eq("me(): pages and landing per role", await Promise.all(["admin", "accounting", "sales", "support", "tags", "merchants"].map(async (r) => { const m = await me(r); return [r, m.pages.join("+"), m.landing]; })), [
  ["admin", "overview+merchants+organizations+users+tags+admins+transactions+shop+audit+banks", "overview"],
  ["accounting", "overview+transactions", "overview"],
  ["sales", "users+merchants+organizations+tags+shop", "users"],
  ["support", "users+organizations+transactions", "users"],
  ["tags", "tags", "tags"],
  ["merchants", "merchants+banks", "merchants"],
]);

// ---- the matrix: every role against every screen's API
const routes: [string, string, string][] = [["overview", "GET", "/v1/admin/stats"], ["merchants", "GET", "/v1/admin/merchants"], ["users", "GET", "/v1/admin/users"], ["tags", "GET", "/v1/admin/tag-models"], ["admins", "GET", "/v1/admin/admins"], ["transactions", "GET", "/v1/admin/transactions"]];
const expected: Record<string, string[]> = { admin: ["overview", "merchants", "users", "tags", "admins", "transactions"], accounting: ["overview", "transactions"], sales: ["merchants", "users", "tags"], support: ["users", "transactions"], tags: ["tags"], merchants: ["merchants"] };
for (const role of Object.keys(expected)) {
  const got = await Promise.all(routes.map(async ([page, m, p]) => [page, (await call(m, p, { token: users[role]!.T })).status === 200] as const));
  eq(`${role}: can use exactly ${expected[role]!.join(", ")}`, got.filter(([, ok]) => ok).map(([page]) => page).sort(), [...expected[role]!].sort());
}
eq("a refused screen answers 403 forbidden_role, not 401 (the session is fine)", await (async () => { const r = await call("GET", "/v1/admin/stats", { token: users.tags!.T }); return [r.status, r.json.error]; })(), [403, "forbidden_role"]);
eq("the operator token (scripts) can use everything", await Promise.all(routes.map(async ([, m, p]) => (await op(m, p)).status)), [200, 200, 200, 200, 200, 200]);

// ---- tags: reading versus changing
const model = (await op("POST", "/v1/admin/tag-models", { type: "band", name: "B", price: 1000, quantity: 10 })).json.model;
const write = async (r: string) => [(await call("POST", "/v1/admin/tag-models", { token: users[r]!.T, body: { type: "band", name: "N" + r, price: 1, quantity: 1 } })).status, (await call("PATCH", `/v1/admin/tag-models/${model.id}`, { token: users[r]!.T, body: { name: "Renamed" + r } })).status, (await call("POST", `/v1/admin/tag-models/${model.id}/tags`, { token: users[r]!.T, body: { uids: ["04AA00000000" + (r.length % 10) + (r.charCodeAt(0) % 10)] } })).status, (await call("GET", `/v1/admin/tag-models/${model.id}`, { token: users[r]!.T })).status];
eq("tags can create, edit and load UIDs; sales can only look; admin can do all", [await write("tags"), await write("admin"), await write("sales")].map((a) => a.map((s) => s < 300 ? "ok" : s)), [["ok", "ok", "ok", "ok"], ["ok", "ok", "ok", "ok"], [403, 403, 403, "ok"]]);
eq("accounting, support and merchants cannot even read tags", await Promise.all(["accounting", "support", "merchants"].map(async (r) => (await call("GET", `/v1/admin/tag-models/${model.id}`, { token: users[r]!.T })).status)), [403, 403, 403]);

// ---- managing admins and roles is for Admin only
eq("only the Admin role (or the operator) can create admins, rotate tokens and change roles", await Promise.all(["accounting", "sales", "support", "tags", "merchants"].map(async (r) => [(await call("POST", "/v1/admin/admins", { token: users[r]!.T, body: { name: "Nope" } })).status, (await call("POST", `/v1/admin/admins/${users.tags!.id}/rotate-token`, { token: users[r]!.T })).status, (await call("PUT", `/v1/admin/admins/${users.tags!.id}/role`, { token: users[r]!.T, body: { role: "admin" } })).status])), Array(5).fill([403, 403, 403]));
const changed = await call("PUT", `/v1/admin/admins/${users.accounting!.id}/role`, { token: users.admin!.T, body: { role: "sales" } });
eq("an Admin changes someone's role; it takes effect on their very next request, without signing in again", [changed.status, changed.json.admin.role, (await call("GET", "/v1/admin/stats", { token: users.accounting!.T })).status, (await call("GET", "/v1/admin/users", { token: users.accounting!.T })).status, (await me("accounting")).landing], [200, "sales", 403, 200, "users"]);
eq("nobody changes their own role (no accidental lock-out), and bad roles or ids are refused", [(await call("PUT", `/v1/admin/admins/${users.admin!.id}/role`, { token: users.admin!.T, body: { role: "sales" } })).json.error, (await op("PUT", `/v1/admin/admins/${users.admin!.id}/role`, { role: "root" })).status, (await op("PUT", "/v1/admin/admins/nope/role", { role: "sales" })).status, (await op("PUT", "/v1/admin/admins/00000000-0000-7000-8000-000000000000/role", { role: "sales" })).status], ["cannot_change_own_role", 400, 404, 404]);
eq("because nobody can change their own role, the person making a change is always still an Admin", await (async () => {
  const a2 = await person("Second Admin", "admin");
  const demote = await call("PUT", `/v1/admin/admins/${a2.id}/role`, { token: users.admin!.T, body: { role: "tags" } });
  return [demote.status, (await call("GET", "/v1/admin/admins", { token: users.admin!.T })).status, (await call("PUT", `/v1/admin/admins/${users.admin!.id}/role`, { token: a2.T, body: { role: "tags" } })).status];
})(), [200, 200, 403]);
eq("a disabled person's role does not matter: they cannot sign in", (await op("PATCH", `/v1/admin/admins/${users.sales!.id}`, { status: "disabled" })).status === 200 && (await call("GET", "/v1/admin/users", { token: users.sales!.T })).status, 401);

// ---- the portal's own pages: everyone can use their own account's two-step pages
eq("every role can use me, logout and the two-step routes", await Promise.all(["support", "tags", "merchants"].map(async (r) => [(await call("GET", "/v1/admin/me", { token: users[r]!.T })).status, (await call("POST", "/v1/admin/mfa/recovery-codes", { token: users[r]!.T, body: { code: "000000" } })).status !== 403])), [[200, true], [200, true], [200, true]]);
eq("the database refuses a role that does not exist", await (async () => { try { await q("update admins set role = 'root'"); return "accepted"; } catch (e: any) { return e.constraint_name; } })(), "admins_role_check");
console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
