import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { totp } from "../src/lib/totp.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
// Fakes: a private R2 bucket and the email binding.
const files = new Map<string, { bytes: Uint8Array; httpMetadata?: any }>();
const UPLOADS = {
  put: async (k: string, v: Uint8Array, o?: any) => { files.set(k, { bytes: new Uint8Array(v), httpMetadata: o?.httpMetadata }); },
  get: async (k: string) => { const f = files.get(k); return f ? { httpMetadata: f.httpMetadata, arrayBuffer: async () => f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) } : null; },
};
const sent: any[] = [];
const EMAIL = { send: async (m: any) => { sent.push(m); } };
const env: any = { HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, MFA_ENCRYPTION_KEY: randomBytes(32).toString("base64"), SANDBOX_FUNDING: "true", UPLOADS, EMAIL, EMAIL_FROM: "Nuclear <no-reply@example.com>" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const raw = (method: string, path: string, o: { body?: unknown; token?: string; type?: string; bytes?: Uint8Array; e?: any } = {}) =>
  app.fetch(new Request("http://x" + path, { method, headers: { "content-type": o.type ?? "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, body: o.bytes ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) }), o.e ?? env, ctx);
const call = async (m: string, p: string, o: any = {}) => { const r = await raw(m, p, o); const t = await r.text(); let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { /* binary */ } return { status: r.status, json: j, headers: r.headers, text: t }; };
const op = (m: string, p: string, body?: unknown) => call(m, p, { token: OP, body });

async function person(name: string, role: string) {
  const made = (await op("POST", "/v1/admin/admins", { name, role })).json;
  const signin = (await call("POST", "/v1/admin/login", { body: { access_id: made.credentials.access_id, access_token: made.credentials.access_token } })).json;
  const T = signin.session_token as string;
  const setup = (await call("POST", "/v1/admin/mfa/setup", { token: T })).json;
  await call("POST", "/v1/admin/mfa/enable", { token: T, body: { code: totp(setup.secret, Date.now()) } });
  return T;
}
const sales = await person("Sam Sales", "sales"), merchantsRole = await person("Mia Merchants", "merchants");

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 1, 2, 3]);
const signupB = await call("POST", "/v1/auth/signup", { body: { type: "B", name: "Blue Door Bakery", email: "owner@bluedoor.test", password: "correct horse battery" } });
const B = signupB.json.session_token, BID = signupB.json.account_id;
eq("a new business starts pending", (await q("select status from accounts where id=$1", [BID]))[0].status, "pending");
const ada = (await call("POST", "/v1/auth/signup", { body: { name: "Ada", email: "ada@example.com", password: "correct horse battery" } })).json;
eq("a new customer is active", (await q("select status from accounts where id=$1", [ada.account_id]))[0].status, "active");

// ---- a pending business can sign in, see its status and upload; nothing else
const login = await call("POST", "/v1/auth/login", { body: { email: "owner@bluedoor.test", password: "correct horse battery" } });
eq("a pending business can sign in", login.status, 200);
eq("it sees its status", (await call("GET", "/v1/account", { token: B })).json.status, "pending");
eq("everything else is refused until approved", [(await call("GET", "/v1/balance", { token: B })), (await call("POST", "/v1/sandbox/fundings", { token: B, body: { amount: 100 } }))].map((r) => [r.status, r.json.error, r.json.status]), [[403, "account_not_approved", "pending"], [403, "account_not_approved", "pending"]]);

// ---- uploading the document
eq("only a business uploads documents", (await call("POST", "/v1/account/documents", { token: ada.session_token, type: "application/pdf", bytes: PDF })).status, 403);
eq("wrong type, wrong bytes, empty and oversize are refused", [
  (await call("POST", "/v1/account/documents", { token: B, type: "text/plain", bytes: PDF })).status,
  (await call("POST", "/v1/account/documents", { token: B, type: "application/pdf", bytes: new Uint8Array([1, 2, 3, 4, 5]) })).status,
  (await call("POST", "/v1/account/documents", { token: B, type: "application/pdf", bytes: new Uint8Array(0) })).status,
  (await call("POST", "/v1/account/documents", { token: B, type: "application/pdf", bytes: new Uint8Array(5 * 1024 * 1024 + 1).fill(0x25) })).status], [415, 415, 400, 413]);
const up = await call("POST", "/v1/account/documents", { token: B, type: "application/pdf", bytes: PDF });
const row = (await q("select id, type, path from uploads where account_id=$1", [BID]))[0];
eq("a PDF is stored in the private bucket at <account>/<upload>.pdf and recorded", [up.status, row.type, row.path === `${BID}/${row.id}.pdf`, files.has(row.path), files.get(row.path)!.httpMetadata.contentType], [201, "business_document", true, true, "application/pdf"]);
eq("the business lists its own documents", (await call("GET", "/v1/account/documents", { token: B })).json.documents.length, 1);

// ---- the admin's side
eq("the document list is for Admin and Merchants, not Sales", [(await call("GET", `/v1/admin/merchants/${BID}/documents`, { token: sales })).status, (await call("GET", `/v1/admin/merchants/${BID}/documents`, { token: merchantsRole })).json.documents.length], [403, 1]);
const dl = await raw("GET", `/v1/admin/merchants/${BID}/documents/${row.id}`, { token: merchantsRole });
eq("the document downloads as the same bytes with a private attachment response", [dl.status, dl.headers.get("content-type"), dl.headers.get("content-disposition"), dl.headers.get("cache-control"), Array.from(new Uint8Array(await dl.arrayBuffer()))], [200, "application/pdf", 'attachment; filename="business-document.pdf"', "private, no-store", Array.from(PDF)]);
eq("Sales cannot download; another merchant's id or an unknown upload is 404", [(await call("GET", `/v1/admin/merchants/${BID}/documents/${row.id}`, { token: sales })).status, (await call("GET", `/v1/admin/merchants/${BID}/documents/00000000-0000-7000-8000-000000000000`, { token: OP })).status], [403, 404]);
eq("the merchant page shows the pending status", (await op("GET", `/v1/admin/merchants/${BID}`)).json.merchant.status, "pending");

// ---- decline
eq("declining needs a real reason and the right role", [(await op("POST", `/v1/admin/merchants/${BID}/decline`, {})).json.error, (await op("POST", `/v1/admin/merchants/${BID}/decline`, { reason: "no" })).status, (await call("POST", `/v1/admin/merchants/${BID}/decline`, { token: sales, body: { reason: "Blurry document" } })).status], ["reason_required", 400, 403]);
const dec = await call("POST", `/v1/admin/merchants/${BID}/decline`, { token: merchantsRole, body: { reason: "The document is blurry; upload a clear copy of your registration certificate." } });
eq("declining sets declined and emails the business the reason and what to do", [dec.status, dec.json.merchant.status, dec.json.email, sent.length, sent[0].to, sent[0].from, /blurry/.test(sent[0].text), /upload a corrected business document/.test(sent[0].text)], [200, "declined", "sent", 1, "owner@bluedoor.test", "Nuclear <no-reply@example.com>", true, true]);
eq("declining twice is refused (not pending)", (await op("POST", `/v1/admin/merchants/${BID}/decline`, { reason: "Still blurry" })).status, 409);
eq("a declined business can still sign in and sees why it is declined", [(await call("POST", "/v1/auth/login", { body: { email: "owner@bluedoor.test", password: "correct horse battery" } })).status, (await call("GET", "/v1/account", { token: B })).json.status], [200, "declined"]);
eq("Reactivate cannot bypass approval", (await op("PUT", `/v1/admin/merchants/${BID}/status`, { status: "active" })).status, 404);
const again = await call("POST", "/v1/account/documents", { token: B, type: "application/pdf", bytes: PDF });
eq("uploading again puts a declined business back to pending", [again.status, again.json.status, (await q("select status from accounts where id=$1", [BID]))[0].status], [201, "pending", "pending"]);

// ---- approve
const ap = await call("POST", `/v1/admin/merchants/${BID}/approve`, { token: merchantsRole });
eq("approving activates the business and emails it", [ap.status, ap.json.merchant.status, ap.json.email, sent.length, sent[1].subject], [200, "active", "sent", 2, "Your Nuclear business account is approved"]);
eq("approving twice is refused; the business can now use the API", [(await op("POST", `/v1/admin/merchants/${BID}/approve`)).status, (await call("GET", "/v1/balance", { token: B })).status], [409, 200]);
eq("a customer is not a business to approve", (await op("POST", `/v1/admin/merchants/${ada.account_id}/approve`)).status, 409);

// ---- email not configured: the text is kept in the log
const bob = (await call("POST", "/v1/auth/signup", { body: { type: "B", name: "Cafe Bob", email: "bob@cafe.test", password: "correct horse battery" } })).json;
const noMail = await call("POST", `/v1/admin/merchants/${bob.account_id}/decline`, { token: OP, body: { reason: "Please send your tax certificate." }, e: { ...env, EMAIL: undefined } });
eq("without email configured the decline still works and says so", [noMail.status, noMail.json.email], [200, "not_configured"]);
const logs = (await op("GET", "/v1/admin/logs?limit=100")).json.logs;
const declined = logs.find((l: any) => l.action === "merchant.declined" && l.target_label === "Cafe Bob");
eq("the log keeps the reason and the unsent email text", [declined.details.reason, declined.details.email, /tax certificate/.test(declined.details.email_text)], ["Please send your tax certificate.", "not_configured", true]);
eq("downloads, uploads, approvals and declines are all logged", ["merchant.document_downloaded", "business.document_uploaded", "merchant.approved", "merchant.declined"].every((a) => logs.some((l: any) => l.action === a)), true);

// ---- the schema
eq("business_doc is gone and uploads has the five columns", [(await q("select count(*)::int n from information_schema.columns where table_name='businesses' and column_name='business_doc'"))[0].n, (await q("select column_name from information_schema.columns where table_name='uploads' order by ordinal_position")).map((r: any) => r.column_name)], [0, ["id", "account_id", "type", "path", "created_at"]]);
console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
