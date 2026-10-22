import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { totp } from "../src/lib/totp.ts";
import { runDuePrograms } from "../src/lib/programs.ts";
import { connect } from "../src/db.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const files = new Map<string, { bytes: Uint8Array; httpMetadata?: any }>();
const UPLOADS = {
  put: async (k: string, v: Uint8Array, o?: any) => { files.set(k, { bytes: new Uint8Array(v), httpMetadata: o?.httpMetadata }); },
  get: async (k: string) => { const f = files.get(k); return f ? { httpMetadata: f.httpMetadata, arrayBuffer: async () => f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) } : null; },
};
const env: any = { HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, MFA_ENCRYPTION_KEY: randomBytes(32).toString("base64"), SANDBOX_FUNDING: "true", UPLOADS, APP_URL: "https://app.test" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const raw = (method: string, path: string, o: { body?: unknown; token?: string; key?: string; type?: string; bytes?: Uint8Array } = {}) =>
  app.fetch(new Request("http://x" + path, { method, headers: { "content-type": o.type ?? "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.bytes ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) }), env, ctx);
const call = async (m: string, p: string, o: any = {}) => { const r = await raw(m, p, o); const t = await r.text(); let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { /* binary */ } return { status: r.status, json: j, text: t, headers: r.headers }; };
const op = (m: string, p: string, body?: unknown) => call(m, p, { token: OP, body });
async function person(name: string, role: string) {
  const made = (await op("POST", "/v1/admin/admins", { name, role })).json;
  const signin = (await call("POST", "/v1/admin/login", { body: { access_id: made.credentials.access_id, access_token: made.credentials.access_token } })).json;
  const T = signin.session_token as string;
  const setup = (await call("POST", "/v1/admin/mfa/setup", { token: T })).json;
  await call("POST", "/v1/admin/mfa/enable", { token: T, body: { code: totp(setup.secret, Date.now()) } });
  return T;
}
const sign = async (name: string, email: string, type = "C") => (await call("POST", "/v1/auth/signup", { body: { type, name, email, password: "correct horse battery" } })).json;

const acme = await sign("Acme Corp", "hr@acme.test", "O");
const globex = await sign("Globex", "hr@globex.test", "O");
const cafe = await sign("Some Cafe", "cafe@x.test", "B");
const ada = await sign("Ada", "ada@x.test");
const AT = acme.session_token;
await call("PUT", "/v1/org/profile", { token: AT, body: { legal_name: "Acme Corporation Inc", display_name: "Acme Corp", city: "Brooklyn", state: "NY", country: "US", website: "https://acme.test" } });
await q("update balances set balance = 100000 where account_id = $1", [acme.account_id]);
await call("PUT", "/v1/org/program", { token: AT, body: { mode: "fixed", cadence: "monthly", day_of_month: 15 } });
await q("insert into employees (org_account_id, employee_id, name, email, balance, fixed_benefit) values ($1,'E1','Eve One','eve@example.com',2500,5000), ($1,'E2','Sam Two','sam@example.com',0,null)", [acme.account_id]);
await q("update employees set employee_account_id = $1 where employee_id = 'E2' and org_account_id = $2", [ada.account_id, acme.account_id]);
await q("insert into employees (org_account_id, employee_id, name, email, status) values ($1,'E3','Gone Gail','gail@example.com','removed')", [acme.account_id]);
await q("insert into benefit_runs (org_account_id, source, run_date, status, idempotency_key, row_count, total, sent, held) values ($1,'csv','2026-10-01','credited','k1',2,5000,2500,2500)", [acme.account_id]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 1, 2, 3]);
const up = await raw("POST", "/v1/account/documents", { token: AT, type: "application/pdf", bytes: PDF });
eq("the organization uploaded a document", up.status, 201);

// ---- list and detail
const list = (await op("GET", "/v1/admin/organizations")).json.organizations;
eq("the list holds organizations only, newest first", list.map((o: any) => o.name), ["Globex", "Acme Corp"]);
const row = list.find((o: any) => o.name === "Acme Corp");
eq("a row shows balance, mode, people and money held", [row.balance, row.mode, row.chosen, row.employees, row.claimed, row.held, row.runs, row.email_verified], [100000, "fixed", true, 2, 1, 2500, 1, false]);
eq("search by name or email", [(await op("GET", "/v1/admin/organizations?q=glob")).json.organizations.length, (await op("GET", "/v1/admin/organizations?q=acme.test")).json.organizations.length, (await op("GET", "/v1/admin/organizations?q=%25")).json.organizations.length], [1, 1, 0]);
const d = (await op("GET", `/v1/admin/organizations/${acme.account_id}`)).json.organization;
eq("detail: profile, balance and program", [d.name, d.legal_name, d.website, d.address.city, d.balance, d.program.mode, d.program.cadence, d.program.day_of_month, d.program.chosen, typeof d.program.next_run_date], ["Acme Corp", "Acme Corporation Inc", "https://acme.test", "Brooklyn", 100000, "fixed", "monthly", 15, true, "string"]);
eq("detail: employees, money held, runs, documents and key", [d.employees, d.runs.count, d.runs.credited, d.documents, d.api_key], [{ total: 2, claimed: 1, unclaimed: 1, removed: 1, held: 2500 }, 1, 5000, 1, null]);
eq("a merchant or a customer is not an organization", [(await op("GET", `/v1/admin/organizations/${cafe.account_id}`)).status, (await op("GET", `/v1/admin/organizations/${ada.account_id}`)).status, (await op("GET", "/v1/admin/organizations/not-a-uuid")).status], [404, 404, 404]);
eq("and an organization is not a merchant", (await op("GET", `/v1/admin/merchants/${acme.account_id}`)).status, 404);

// ---- employees and runs
const emps = (await op("GET", `/v1/admin/organizations/${acme.account_id}/employees`)).json.employees;
eq("employees: status, claim state and balance; no secrets", [emps.map((e: any) => [e.employee_id, e.status, e.claimed, e.balance, e.fixed_benefit]).sort(), JSON.stringify(emps).includes("claim_token")], [[["E1", "active", false, 2500, 5000], ["E2", "active", true, 0, null], ["E3", "removed", false, 0, null]], false]);
eq("employee search", (await op("GET", `/v1/admin/organizations/${acme.account_id}/employees?q=sam`)).json.employees.length, 1);
eq("runs", (await op("GET", `/v1/admin/organizations/${acme.account_id}/runs`)).json.runs.map((r: any) => [r.source, r.status, r.total, r.sent, r.held]), [["csv", "credited", 5000, 2500, 2500]]);

// ---- documents are listed, downloadable and the download is logged
const docs = (await op("GET", `/v1/admin/organizations/${acme.account_id}/documents`)).json.documents;
eq("the document is listed", [docs.length, docs[0].file], [1, "pdf"]);
const dl = await call("GET", `/v1/admin/organizations/${acme.account_id}/documents/${docs[0].id}`, { token: OP });
eq("and downloads as a private attachment", [dl.status, dl.headers.get("content-type"), dl.headers.get("content-disposition"), dl.headers.get("cache-control")], [200, "application/pdf", 'attachment; filename="organization-document.pdf"', "private, no-store"]);
eq("the download is logged", (await q("select count(*)::int n from logs where action='organization.document_downloaded'"))[0].n, 1);
eq("another organization's id cannot fetch it", (await call("GET", `/v1/admin/organizations/${globex.account_id}/documents/${docs[0].id}`, { token: OP })).status, 404);
eq("a merchant's id cannot be used on this route", (await call("GET", `/v1/admin/organizations/${cafe.account_id}/documents/${docs[0].id}`, { token: OP })).status, 404);

// ---- roles: who can see, who can change
const sales = await person("Sam Sales", "sales"), support = await person("Sue Support", "support"), accounting = await person("Al Acct", "accounting"), tags = await person("Tia Tags", "tags");
eq("sales and support can look", await Promise.all([sales, support].map(async (t) => (await call("GET", `/v1/admin/organizations/${acme.account_id}`, { token: t })).status)), [200, 200]);
eq("accounting and tags cannot", await Promise.all([accounting, tags].map(async (t) => (await call("GET", "/v1/admin/organizations", { token: t })).json.error)), ["forbidden_role", "forbidden_role"]);
eq("only an admin changes status", [(await call("PUT", `/v1/admin/organizations/${acme.account_id}/status`, { token: support, body: { status: "suspended" } })).json.error, (await call("PUT", `/v1/admin/organizations/${acme.account_id}/status`, { token: sales, body: { status: "suspended" } })).json.error], ["forbidden_role", "forbidden_role"]);

// ---- suspending an organization stops it at once
const key = (await call("POST", "/v1/org/api-key", { token: AT })).json;
eq("its API key works", (await call("GET", "/v1/benefits-api/balance", { token: key.token })).status, 200);
const sus = await op("PUT", `/v1/admin/organizations/${acme.account_id}/status`, { status: "suspended" });
eq("an admin suspends it", [sus.status, sus.json.organization.status], [200, "suspended"]);
eq("its sign-in session stops", (await call("GET", "/v1/account", { token: AT })).status, 401);
eq("and its API key", (await call("GET", "/v1/benefits-api/balance", { token: key.token })).status, 401);
eq("a suspended organization pays no scheduled benefits", await (async () => {
  const sql = connect(env);
  await q("update benefit_programs set next_run_date = '2026-10-01' where org_account_id = $1", [acme.account_id]);
  await runDuePrograms(env, sql, "2026-10-05");
  await sql.end();
  return (await q("select count(*)::int n from benefit_runs where org_account_id=$1 and source='schedule'", [acme.account_id]))[0].n;
})(), 0);
eq("its data is still readable by support", (await op("GET", `/v1/admin/organizations/${acme.account_id}`)).json.organization.status, "suspended");
eq("a merchant cannot be suspended here", (await op("PUT", `/v1/admin/organizations/${cafe.account_id}/status`, { status: "suspended" })).status, 404);
const back = await op("PUT", `/v1/admin/organizations/${acme.account_id}/status`, { status: "active" });
eq("reactivated: the same sign-in works again", [back.json.organization.status, (await call("GET", "/v1/account", { token: AT })).status], ["active", 200]);
eq("the key works again", (await call("GET", "/v1/benefits-api/balance", { token: key.token })).status, 200);
eq("both changes are logged and show in its activity", (await op("GET", `/v1/admin/organizations/${acme.account_id}/activity`)).json.logs.map((l: any) => l.action).filter((a: string) => a.startsWith("organization.")).sort(), ["organization.document_downloaded", "organization.reactivated", "organization.suspended"]);

console.log(`\n${pass} passed, ${fail} failed`);
await adm.end();
process.exit(fail ? 1 : 0);
