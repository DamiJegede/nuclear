import { ROOT, applyMigration, migrate, psql, resetSchema } from "./db.ts";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import app from "../src/index.ts";
import { hashPassword } from "../src/crypto.ts";

psql(["-c", "drop schema public cascade; create schema public;"]);
// the live database today: 0001-0007 applied, one admin created with the OLD column names and a lowercase id
for (const f of ["0001_init.sql", "0002_terminals_orbs.sql", "0003_payments_refunds_staff.sql", "0004_products.sql", "0005_checkouts.sql", "0006_orb_uid.sql", "0007_admins.sql"]) psql(["-f", ROOT + "migrations/" + f]);
const adm = postgres("postgres://postgres@127.0.0.1:54340/nuclear", { max: 2, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OLD_PW = "pDsPBd_grow3mazW";   // the 16-character temporary password given out earlier
await q("insert into admins (access_id, name, password_hash) values ('nlinf8q0kaz4', 'Nuclear Admin', $1)", [await hashPassword(OLD_PW)]);
const before = (await q("select id, access_id, must_change_password from admins"))[0];

psql(["-f", ROOT + "migrations/0008_admin_access_tokens.sql"]);
const newCodeOnOldSchema = true; // 0008 applied, 0009 not yet: the new API must already work against the old schema


let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const after = (await q("select id, access_id, created_by from admins"))[0];
eq("the existing admin keeps its row, its Access ID is now uppercase, ", [after.id === before.id, after.access_id, after.created_by], [true, "NLINF8Q0KAZ4", null]);
eq("the columns were renamed (data preserved)", (await q("select column_name from information_schema.columns where table_name='admins' and column_name in ('password_hash','access_token_hash','must_change_password','must_change_access_token','created_by') order by 1")).map((r: any) => r.column_name), ["access_token_hash", "created_by", "must_change_access_token"]);
let lower = "none"; try { await q("insert into admins (access_id, name, access_token_hash) values ('lower', 'x', 'h')"); } catch (e: any) { lower = e.constraint_name; }
eq("lowercase IDs are now refused by the database", lower, "admins_access_id_check");

const env: any = { HYPERDRIVE: { connectionString: "postgres://postgres@127.0.0.1:54340/nuclear" }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: "op-" + randomBytes(16).toString("hex"), MFA_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
const call = async (method: string, path: string, o: { body?: unknown; token?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + path, { method, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const li0 = await call("POST", "/v1/admin/login", { body: { access_id: "nlinf8q0kaz4", access_token: OLD_PW } });
eq("a 16-character Access Token is no longer accepted at sign-in (32 characters are enforced)", [li0.status, li0.json.error], [400, "invalid_request"]);
psql(["-f", ROOT + "migrations/0009_drop_must_change_access_token.sql"]);
eq("0009 drops the flag column and keeps the row", (await q("select access_id, (select count(*)::int from information_schema.columns where table_name='admins' and column_name='must_change_access_token') as c from admins")), [{ access_id: "NLINF8Q0KAZ4", c: 0 }]);
const adminId = (await q("select id from admins"))[0].id;
const reset = await call("PATCH", `/v1/admin/admins/${adminId}`, { token: env.ADMIN_API_TOKEN, body: { reset_access_token: true } });
const li = await call("POST", "/v1/admin/login", { body: { access_id: "nlinf8q0kaz4", access_token: reset.json.credentials.access_token } });
eq("the operator issues a fresh 32-character token for the existing admin, who signs in with it", [reset.json.credentials.access_token.length, li.status, li.json.admin], [32, 200, { access_id: "NLINF8Q0KAZ4", name: "Nuclear Admin" }]);
eq("and is taken straight to two-step enrollment (no forced token change)", (await call("GET", "/v1/admin/stats", { token: li.json.session_token })).json.error, "mfa_setup_required");
console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
