import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { connect } from "../src/db.ts";
import { purge } from "../src/lib/retention.ts";
import { takeSnapshot, saveReconciliation } from "../src/lib/snapshots.ts";
import { dailyJobs } from "../src/lib/cron.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const env: any = { HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true", STATS_TTL_SECONDS: "0" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (m: string, p: string, o: { body?: unknown; token?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + p, { method: m, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const sign = async (name: string, email: string, type = "C") => (await call("POST", "/v1/auth/signup", { body: { type, name, email, password: "correct horse battery" } })).json;
const sql = connect(env);
const tryq = async (s: string, p: unknown[] = []) => { try { await q(s, p); return "ok"; } catch (e: any) { return String(e.message); } };

const ada = await sign("Ada", "ada@x.test");
const old = (days: number) => `now() - interval '${days} days'`;

// ---- sessions
for (let i = 0; i < 3; i++) await call("POST", "/v1/auth/login", { body: { email: "ada@x.test", password: "correct horse battery" } });
const devs = await q("select id from devices where account_id = $1 order by created_at, id", [ada.account_id]);   // signup + 3 logins
await q(`update devices set revoked_at = ${old(40)} where id = $1`, [devs[1].id]);                       // revoked long ago: goes
await q(`update devices set session_expires_at = ${old(40)} where id = $1`, [devs[2].id]);               // expired long ago: goes
await q(`update devices set revoked_at = ${old(5)} where id = $1`, [devs[3].id]);                        // revoked recently: stays
await q("insert into devices (account_id, platform) values ($1, 'web')", [ada.account_id]);              // a magic link that was never opened...
await q("insert into devices (account_id, platform, created_at) values ($1, 'web', now() - interval '3 days')", [ada.account_id]);   // ...for three days
const before = (await q("select count(*)::int n from devices"))[0].n;
const r = await purge(sql);
eq("old revoked, old expired and old unopened sessions are purged; the rest stay", [r.devices, before - (await q("select count(*)::int n from devices"))[0].n], [3, 3]);
eq("the signup session and a recently revoked one are still there", (await call("GET", "/v1/account", { token: ada.session_token })).status, 200);   // signup session = devs[0]

// ---- admin sessions
const made = (await call("POST", "/v1/admin/admins", { token: OP, body: { name: "Old Admin" } })).json;
await q(`insert into admin_sessions (admin_id, token_hash, expires_at, revoked_at) values ($1,'s1', ${old(40)}, null), ($1,'s2', now() + interval '1 hour', ${old(40)}), ($1,'s3', now() + interval '1 hour', null), ($1,'s4', ${old(3)}, null)`, [made.admin.id]);
const r2 = await purge(sql);
eq("admin sessions expired or revoked over 30 days ago go; the rest stay", [r2.admin_sessions, (await q("select token_hash from admin_sessions order by 1")).map((x: any) => x.token_hash)], [2, ["s3", "s4"]]);

// ---- a snapshot is final
const day = "2026-01-10";
await takeSnapshot(sql, day);
eq("a snapshot cannot be deleted", (await tryq("delete from snapshots")).includes("final"), true);
eq("or changed", (await tryq("update snapshots set sends_count = 99")).includes("final"), true);
eq("its ledger-check result can be written once", [await saveReconciliation(sql, day, { ledger_balanced: true }, true).then(() => "ok"), (await q("select reconciled from snapshots"))[0].reconciled], ["ok", true]);
await saveReconciliation(sql, day, { ledger_balanced: false }, false);
eq("and never rewritten (a second write changes nothing)", [(await q("select reconciled from snapshots"))[0].reconciled, (await tryq("update snapshots set reconciled = false")).includes("written once")], [true, true]);

// ---- the nightly job runs the purge
await q(`insert into admin_sessions (admin_id, token_hash, expires_at) values ($1,'s9', ${old(45)})`, [made.admin.id]);
const job: any = await dailyJobs(Date.parse("2026-11-03T05:00:00Z"), env);
eq("the daily job purges and reports it", [job.purged.admin_sessions, (await q("select count(*)::int n from admin_sessions where token_hash = 's9'"))[0].n], [1, 0]);
eq("audit logs are not purged", [job.purged.logs, (await q("select count(*)::int n from logs"))[0].n > 0], [undefined, true]);

console.log(`\n${pass} passed, ${fail} failed`);
await sql.end(); await adm.end();
process.exit(fail ? 1 : 0);
