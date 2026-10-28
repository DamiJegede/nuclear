import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { connect } from "../src/db.ts";
import { ensureBank, refreshBank, refreshStaleBanks, signBankingBody, type BankingClient, type DirectoryAnswer } from "../src/lib/banks.ts";
import { totp } from "../src/lib/totp.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const store = new Map<string, Uint8Array>();
const IMAGES = { put: async (k: string, v: Uint8Array) => { store.set(k, new Uint8Array(v)); }, delete: async (k: string) => { store.delete(k); }, get: async () => null };

// A fake banking server: answers per routing number, counts calls, can fail.
const calls: string[] = [];
let down = false;
const directory: Record<string, DirectoryAnswer> = {
  "110000000": { found: true, name: "Test National Bank", instant: true, networks: ["RTP", "FedNow"] },
  "021000021": { found: true, name: "Bigger Bank", instant: true, networks: ["FedNow"] },
  "011000015": { found: false, name: null, instant: false, networks: [] },
};
const client: BankingClient = { lookupBank: async (r) => { calls.push(r); if (down) throw new Error("banking server unreachable"); return directory[r] ?? { found: false, name: null, instant: false, networks: [] }; } };
const env: any = { STATS_TTL_SECONDS: "0", HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true", BANK_ENCRYPTION_KEY: randomBytes(32).toString("base64"), MFA_ENCRYPTION_KEY: randomBytes(32).toString("base64"), BANKING_CLIENT: client, IMAGES };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (m: string, p: string, o: { body?: unknown; token?: string; bytes?: Uint8Array; type?: string; env?: any } = {}) => {
  const r = await app.fetch(new Request("http://x" + p, { method: m, headers: { ...(o.bytes ? { "content-type": o.type ?? "image/png" } : { "content-type": "application/json" }), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, body: o.bytes ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) }), o.env ?? env, ctx);
  const t = await r.text(); return { status: r.status, json: t && t[0] === "{" ? JSON.parse(t) : null };
};
const sql = connect(env);
const sign = async (name: string, email: string) => (await call("POST", "/v1/auth/signup", { body: { type: "B", name, email, password: "correct horse battery" } })).json;
async function merchant(name: string, email: string) {
  const m = await sign(name, email);
  await q("update accounts set status='active' where id=$1", [m.account_id]);
  await call("PUT", "/v1/business/profile", { token: m.session_token, body: { legal_name: name + " LLC", display_name: name } });
  return m;
}
const addBank = (m: any, routing: string, acct = "0001234567", e?: any) => call("PUT", "/v1/business/bank", { token: m.session_token, body: { routing_number: routing, account_number: acct }, env: e });

// ---- one row per routing number, one lookup for everyone
const A = await merchant("Alpha", "a@x.test"), B = await merchant("Beta", "b@x.test"), C = await merchant("Gamma", "c@x.test");
const ra = await addBank(A, "110000000");
eq("adding a bank answers with the institution: name, no logo yet, instant", [ra.status, ra.json.bank.institution.name, ra.json.bank.institution.icon, ra.json.bank.institution.instant], [201, "Test National Bank", null, true]);
const rb = await addBank(B, "110000000", "0007654321");
eq("a second merchant at the same bank reuses the row and does not look it up again", [rb.json.bank.institution.id === ra.json.bank.institution.id, calls.filter((r) => r === "110000000").length, (await q("select count(*)::int n from banks"))[0].n], [true, 1, 1]);
eq("both accounts point at the bank; the row carries what the directory said", [(await q("select count(*)::int n from bank_accounts where bank_id = (select id from banks where routing_number = '110000000')"))[0].n, (await q("select name, instant, networks, refreshed_at is not null as fresh from banks")).map((b: any) => [b.name, b.instant, b.networks, b.fresh])], [2, [["Test National Bank", true, ["RTP", "FedNow"], true]]]);
eq("GET /bank shows the same institution", (await call("GET", "/v1/business/bank", { token: A.session_token })).json.bank.institution.name, "Test National Bank");

// ---- a rush of merchants adding one new bank causes one lookup
calls.length = 0;
const rush = await Promise.all(Array.from({ length: 12 }, async (_, i) => { const m = await merchant(`Rush ${i}`, `rush${i}@x.test`); return addBank(m, "021000021", "00012345" + (10 + i)); }));
eq("twelve merchants adding the same new bank at once: all saved, one lookup", [rush.every((r) => r.status === 201), calls.filter((r) => r === "021000021").length, (await q("select count(*)::int n from banks where routing_number = '021000021'"))[0].n], [true, 1, 1]);

// ---- a bank that is not on the instant networks
const rc = await addBank(C, "011000015");
eq("a bank the directory does not know is saved, marked not instant, with no name", [rc.status, rc.json.bank.institution.instant, rc.json.bank.institution.name], [201, false, null]);

// ---- failure never blocks the bank; the bank is tried again after an hour, not before
down = true; calls.length = 0;
const D = await merchant("Delta", "d@x.test");
const rd = await addBank(D, "121000358");
eq("an unreachable banking server: the bank is still saved, instant is unknown", [rd.status, rd.json.bank.institution.instant, (await q("select refreshed_at from banks where routing_number = '121000358'"))[0].refreshed_at], [201, null, null]);
const E = await merchant("Echo", "e@x.test"); await addBank(E, "121000358", "0000111122");
eq("another merchant a minute later does not hammer the server", calls.filter((r) => r === "121000358").length, 1);
down = false;
await q("update system set value = (now() - interval '2 hours')::text where key = 'bank_lookup:121000358'");
const F = await merchant("Foxtrot", "f@x.test"); const rf = await addBank(F, "121000358", "0000333344");
eq("after an hour the next merchant retries and the answer lands", [calls.filter((r) => r === "121000358").length, rf.json.bank.institution.instant, (await q("select refreshed_at is not null f from banks where routing_number = '121000358'"))[0].f], [2, false, true]);

// ---- refreshing: fresh answers are trusted, old ones are read again, an admin's name sticks
calls.length = 0;
let b = await ensureBank(sql, "110000000");
await refreshBank(env, sql, b, client);
eq("a fresh answer is not read again", calls.length, 0);
await q("update banks set refreshed_at = now() - interval '31 days', name = 'Renamed By Admin' where routing_number = '110000000'");
await q("delete from system where key = 'bank_lookup:110000000'");
b = await ensureBank(sql, "110000000");
const again = await refreshBank(env, sql, b, client);
eq("an answer older than 30 days is read again, and the admin's name is kept", [calls.length, again.name, again.instant, again.refreshed_at !== null], [1, "Renamed By Admin", true, true]);

// ---- the nightly refresh covers banks in use only
await q("update banks set refreshed_at = null where routing_number in ('110000000','021000021')");
await q("delete from system where key like 'bank_lookup:%'");
await ensureBank(sql, "026009593");                                              // seen but nobody uses it
calls.length = 0;
const nightly = await refreshStaleBanks(env, sql);
eq("the nightly job refreshes the banks in use whose answer is missing and skips unused ones", [nightly.refreshed, calls.sort(), calls.includes("026009593")], [2, ["021000021", "110000000"], false]);
eq("without a banking server it does nothing", await refreshStaleBanks({ ...env, BANKING_CLIENT: undefined }, sql), { checked: 0, refreshed: 0 });
eq("the signature the real client sends is t:<seconds>,v1:<hex hmac>", (await signBankingBody("secret", "{}", 1_700_000_000_000)).replace(/v1:[0-9a-f]{64}/, "v1:HMAC"), "t:1700000000,v1:HMAC");

// ---- the admin Banks page
const person = async (name: string, role: string) => {
  const made = (await call("POST", "/v1/admin/admins", { token: OP, body: { name, role } })).json;
  const T = (await call("POST", "/v1/admin/login", { body: { access_id: made.credentials.access_id, access_token: made.credentials.access_token } })).json.session_token as string;
  const setup = (await call("POST", "/v1/admin/mfa/setup", { token: T })).json;
  await call("POST", "/v1/admin/mfa/enable", { token: T, body: { code: totp(setup.secret, Date.now()) } });
  return T;
};
const R: Record<string, string> = {}; for (const r of ["admin", "merchants", "sales", "accounting"]) R[r] = await person(r, r);
const list = (role: string, qs = "") => call("GET", `/v1/admin/banks${qs}`, { token: R[role] });
const all = (await list("admin")).json;
eq("banks list: every routing number with its accounts, newest first, and how many need a logo", [all.total, all.needs_logo, all.banks.map((x: any) => [x.routing_number, x.accounts])], [5, 4, [["026009593", 0], ["121000358", 3], ["011000015", 1], ["021000021", 12], ["110000000", 2]]]);
eq("a bank nobody uses is listed but is not 'needs logo'", [all.banks.some((x: any) => x.routing_number === "026009593"), (await list("admin", "?needs_logo=1")).json.banks.some((x: any) => x.routing_number === "026009593")], [true, false]);
const page1 = (await list("admin", "?limit=2")).json;
eq("paged: a cursor walks the rest", [page1.banks.length, page1.next_cursor !== null, (await list("admin", `?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`)).json.banks.length], [2, true, all.total - 2 > 2 ? 2 : all.total - 2]);
eq("search by name and by routing prefix", [(await list("admin", "?q=bigger")).json.total, (await list("admin", "?q=0210")).json.total, (await list("admin", "?q=%25")).json.total], [1, 1, 0]);
const id = all.banks.find((x: any) => x.routing_number === "021000021").id;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const up = await call("PUT", `/v1/admin/banks/${id}/icon`, { token: R.merchants, bytes: PNG });
const after = (await list("admin", "?q=0210")).json.banks[0];
eq("the Merchants role uploads a logo: stored under banks/, served as a full URL, no longer needs one", [up.status, (await q("select icon from banks where id=$1", [id]))[0].icon.startsWith("banks/"), after.icon.includes("/v1/photos/banks/"), (await list("admin")).json.needs_logo], [204, true, true, 3]);
const oldKey = (await q("select icon from banks where id=$1", [id]))[0].icon;
await call("PUT", `/v1/admin/banks/${id}/icon`, { token: R.admin, bytes: PNG });
eq("a new logo replaces the old object", [store.has(oldKey), (await q("select icon from banks where id=$1", [id]))[0].icon === oldKey], [false, false]);
eq("bad uploads: not PNG type, not a PNG, too big, empty", await Promise.all([
  call("PUT", `/v1/admin/banks/${id}/icon`, { token: R.admin, bytes: PNG, type: "image/jpeg" }).then((r) => r.status),
  call("PUT", `/v1/admin/banks/${id}/icon`, { token: R.admin, bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) }).then((r) => r.status),
  call("PUT", `/v1/admin/banks/${id}/icon`, { token: R.admin, bytes: new Uint8Array(300_000).fill(0x89) }).then((r) => r.status),
  call("PUT", `/v1/admin/banks/${id}/icon`, { token: R.admin, bytes: new Uint8Array(0) }).then((r) => r.status)]), [415, 400, 413, 400]);
eq("rename: Admin and Merchants may, the name shows in the merchant's own view", [(await call("PATCH", `/v1/admin/banks/${id}`, { token: R.merchants, body: { name: "Bigger Bank NA" } })).status, (await call("GET", "/v1/business/bank", { token: rush[0]!.status === 201 ? (await call("POST", "/v1/auth/login", { body: { email: "rush0@x.test", password: "correct horse battery" } })).json.session_token : "" })).json.bank.institution.name], [204, "Bigger Bank NA"]);
eq("sales has no Banks page; accounting neither; unknown id is 404; bad name is 400", [(await list("sales")).status, (await list("accounting")).status, (await call("PATCH", `/v1/admin/banks/${randomBytes(16).toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5")}`, { token: R.admin, body: { name: "x" } })).status, (await call("PATCH", `/v1/admin/banks/${id}`, { token: R.admin, body: { name: "" } })).status], [403, 403, 404, 400]);
eq("logos and renames are in the audit log", (await q("select action from logs where action like 'bank.%' order by created_at")).map((l: any) => l.action), ["bank.icon_uploaded", "bank.icon_uploaded", "bank.renamed"]);
eq("without the storage binding an upload is 503", (await call("PUT", `/v1/admin/banks/${id}/icon`, { token: R.admin, bytes: PNG, env: { ...env, IMAGES: undefined } })).status, 503);
eq("the icon column only accepts a bank key", await q("update banks set icon = 'accounts/x.png' where id = $1", [id]).then(() => "accepted", () => "refused"), "refused");

console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
