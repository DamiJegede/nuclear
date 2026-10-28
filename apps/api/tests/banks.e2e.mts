import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { connect } from "../src/db.ts";
import { ensureRouting, matchInstitution, refreshBank, refreshStaleBanks, signBankingBody, type BankingClient, type DirectoryAnswer } from "../src/lib/banks.ts";
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
  "110000000": { found: true, name: "TEST NATIONAL BANK, N.A.", instant: true, networks: ["RTP", "FedNow"] },
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
eq("adding a bank answers with the institution: the directory's name until an institution claims it, no logo yet, instant", [ra.status, ra.json.bank.institution.name, ra.json.bank.institution.icon, ra.json.bank.institution.instant], [201, "TEST NATIONAL BANK, N.A.", null, true]);
const rb = await addBank(B, "110000000", "0007654321");
eq("a second merchant at the same bank reuses the row and does not look it up again", [rb.json.bank.institution.id === ra.json.bank.institution.id, calls.filter((r) => r === "110000000").length, (await q("select count(*)::int n from routing_numbers"))[0].n], [true, 1, 1]);
eq("both accounts point at the bank; the row carries what the directory said", [(await q("select count(*)::int n from bank_accounts where routing_number_id = (select id from routing_numbers where routing_number = '110000000')"))[0].n, (await q("select directory_name, instant, networks, refreshed_at is not null as fresh from routing_numbers")).map((b: any) => [b.directory_name, b.instant, b.networks, b.fresh])], [2, [["TEST NATIONAL BANK, N.A.", true, ["RTP", "FedNow"], true]]]);
eq("GET /bank shows the same institution", (await call("GET", "/v1/business/bank", { token: A.session_token })).json.bank.institution.name, "TEST NATIONAL BANK, N.A.");

// ---- a rush of merchants adding one new bank causes one lookup
calls.length = 0;
const rush = await Promise.all(Array.from({ length: 12 }, async (_, i) => { const m = await merchant(`Rush ${i}`, `rush${i}@x.test`); return addBank(m, "021000021", "00012345" + (10 + i)); }));
eq("twelve merchants adding the same new bank at once: all saved, one lookup", [rush.every((r) => r.status === 201), calls.filter((r) => r === "021000021").length, (await q("select count(*)::int n from routing_numbers where routing_number = '021000021'"))[0].n], [true, 1, 1]);

// ---- a bank that is not on the instant networks
const rc = await addBank(C, "011000015");
eq("a bank the directory does not know is saved, marked not instant, with no name", [rc.status, rc.json.bank.institution.instant, rc.json.bank.institution.name], [201, false, null]);

// ---- failure never blocks the bank; the bank is tried again after an hour, not before
down = true; calls.length = 0;
const D = await merchant("Delta", "d@x.test");
const rd = await addBank(D, "121000358");
eq("an unreachable banking server: the bank is still saved, instant is unknown", [rd.status, rd.json.bank.institution.instant, (await q("select refreshed_at from routing_numbers where routing_number = '121000358'"))[0].refreshed_at], [201, null, null]);
const E = await merchant("Echo", "e@x.test"); await addBank(E, "121000358", "0000111122");
eq("another merchant a minute later does not hammer the server", calls.filter((r) => r === "121000358").length, 1);
down = false;
await q("update system set value = (now() - interval '2 hours')::text where key = 'bank_lookup:121000358'");
const F = await merchant("Foxtrot", "f@x.test"); const rf = await addBank(F, "121000358", "0000333344");
eq("after an hour the next merchant retries and the answer lands", [calls.filter((r) => r === "121000358").length, rf.json.bank.institution.instant, (await q("select refreshed_at is not null f from routing_numbers where routing_number = '121000358'"))[0].f], [2, false, true]);

// ---- refreshing: fresh answers are trusted, old ones are read again, an admin's name sticks
calls.length = 0;
let b = await ensureRouting(sql, "110000000");
await refreshBank(env, sql, b, client);
eq("a fresh answer is not read again", calls.length, 0);
await q("update routing_numbers set refreshed_at = now() - interval '31 days' where routing_number = '110000000'");
await q("delete from system where key = 'bank_lookup:110000000'");
b = await ensureRouting(sql, "110000000");
const again = await refreshBank(env, sql, b, client);
eq("an answer older than 30 days is read again", [calls.length, again.instant, again.refreshed_at !== null], [1, true, true]);

// ---- the nightly refresh covers banks in use only
await q("update routing_numbers set refreshed_at = null where routing_number in ('110000000','021000021')");
await q("delete from system where key like 'bank_lookup:%'");
await ensureRouting(sql, "026009593");                                              // seen but nobody uses it
calls.length = 0;
const nightly = await refreshStaleBanks(env, sql);
eq("the nightly job refreshes the banks in use whose answer is missing and skips unused ones", [nightly.refreshed, calls.sort(), calls.includes("026009593")], [2, ["021000021", "110000000"], false]);
eq("without a banking server it does nothing", await refreshStaleBanks({ ...env, BANKING_CLIENT: undefined }, sql), { checked: 0, refreshed: 0 });
eq("the signature the real client sends is t:<seconds>,v1:<hex hmac>", (await signBankingBody("secret", "{}", 1_700_000_000_000)).replace(/v1:[0-9a-f]{64}/, "v1:HMAC"), "t:1700000000,v1:HMAC");

// ---- institutions: one name and logo for every routing number that belongs to it
const person = async (name: string, role: string) => {
  const made = (await call("POST", "/v1/admin/admins", { token: OP, body: { name, role } })).json;
  const T = (await call("POST", "/v1/admin/login", { body: { access_id: made.credentials.access_id, access_token: made.credentials.access_token } })).json.session_token as string;
  const setup = (await call("POST", "/v1/admin/mfa/setup", { token: T })).json;
  await call("POST", "/v1/admin/mfa/enable", { token: T, body: { code: totp(setup.secret, Date.now()) } });
  return T;
};
const R: Record<string, string> = {}; for (const r of ["admin", "merchants", "sales", "accounting"]) R[r] = await person(r, r);
const get = (role: string, path: string) => call("GET", `/v1/admin/${path}`, { token: R[role] });
const attn = async () => (await get("admin", "banks/attention")).json;
eq("before any institution exists, the routing numbers in use are all unlinked", await attn(), { needs_logo: 0, unlinked: 4 });
eq("matching is by whole words, the longest name or alias wins", [await matchInstitution(sql, "TEST NATIONAL BANK, N.A."), (await q("select count(*)::int n from institutions"))[0].n], [null, 0]);

const created = await call("POST", "/v1/admin/institutions", { token: R.merchants, body: { name: "Test National", domain: "testnational.example", aliases: ["Test National Bank", "TNB"] } });
eq("an institution is created, and routing numbers whose directory name matches its aliases are linked at once", [created.status, created.json.linked, (await q("select i.name from routing_numbers r join institutions i on i.id = r.institution_id where r.routing_number = '110000000'")).map((x: any) => x.name)], [201, 1, ["Test National"]]);
const inst = created.json.institution.id;
eq("a merchant now sees the institution's name instead of the directory's spelling, and a logo comes with it once uploaded", await (async () => {
  const before = (await call("GET", "/v1/business/bank", { token: A.session_token })).json.bank.institution;
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const up = await call("PUT", `/v1/admin/institutions/${inst}/icon`, { token: R.merchants, bytes: PNG });
  const after = (await call("GET", "/v1/business/bank", { token: A.session_token })).json.bank.institution;
  return [before.name, before.icon, up.status, after.name, after.icon.includes("/v1/photos/institutions/"), (await call("GET", "/v1/business/overview", { token: A.session_token })).json.payout_bank.institution.name];
})(), ["Test National", null, 204, "Test National", true, "Test National"]);
eq("both merchants at that routing number share the one logo (an institution is uploaded once)", (await q("select count(*)::int n from institutions where icon is not null"))[0].n, 1);
eq("a second institution with the same name is refused", (await call("POST", "/v1/admin/institutions", { token: R.admin, body: { name: "Test National" } })).json.error, "institution_exists");
eq("an institution's name alone never matches a stray letter: aliases are read as a list", await matchInstitution(sql, "A B C N"), null);
eq("the institution list: routing numbers, live accounts, aliases", (await get("admin", "institutions")).json.institutions.map((i: any) => [i.name, i.routing_numbers, i.accounts, i.aliases, i.domain]), [["Test National", 1, 2, ["test national bank", "tnb"], "testnational.example"]]);

// an unlinked number is linked by an admin
const unl = (await get("admin", "routing-numbers?unlinked=1")).json;
eq("the Routing Numbers tab lists numbers in use that no institution claims", [unl.total, unl.routing_numbers.every((r: any) => r.institution_id === null && r.accounts > 0), unl.unlinked], [3, true, 3]);
const bigger = unl.routing_numbers.find((r: any) => r.routing_number === "021000021");
const second = (await call("POST", "/v1/admin/institutions", { token: R.admin, body: { name: "Bigger Bank", aliases: ["bigger bank"] } })).json;
eq("linking by name picked up the number the directory calls Bigger Bank", [second.linked, (await get("admin", "routing-numbers?unlinked=1")).json.total], [1, 2]);
const other = unl.routing_numbers.find((r: any) => r.routing_number === "011000015");
eq("an admin links a number by hand, and can unlink it", [
  (await call("PUT", `/v1/admin/routing-numbers/${other.id}/institution`, { token: R.merchants, body: { institution_id: inst } })).status,
  (await get("admin", "institutions")).json.institutions.find((i: any) => i.name === "Test National").routing_numbers,
  (await call("PUT", `/v1/admin/routing-numbers/${other.id}/institution`, { token: R.merchants, body: { institution_id: null } })).status,
  (await get("admin", "institutions")).json.institutions.find((i: any) => i.name === "Test National").routing_numbers], [204, 2, 204, 1]);
eq("an institution an admin chose is never replaced by a later lookup", await (async () => {
  await q("update routing_numbers set institution_id = $1, refreshed_at = null where routing_number = '021000021'", [inst]);
  await q("delete from system where key = 'bank_lookup:021000021'");
  const b = await refreshBank(env, sql, await ensureRouting(sql, "021000021"), client);
  return b.institution_id === inst;
})(), true);
eq("needs-logo: an institution in use without a logo is counted", await (async () => {
  const x = (await call("POST", "/v1/admin/institutions", { token: R.admin, body: { name: "Logoless Savings", aliases: ["logoless"] } })).json.institution.id;
  await q("update routing_numbers set institution_id = $1 where routing_number = '011000015'", [x]);
  const a = await attn();
  return [a.needs_logo, (await get("admin", "institutions?needs_logo=1")).json.institutions.map((i: any) => i.name)];
})(), [1, ["Logoless Savings"]]);
eq("adding a routing number by hand: checksum checked, duplicates refused, a new one starts unlinked", [
  (await call("POST", "/v1/admin/routing-numbers", { token: R.admin, body: { routing_number: "123456789" } })).status,
  (await call("POST", "/v1/admin/routing-numbers", { token: R.admin, body: { routing_number: "322271627" } })).status,
  (await call("POST", "/v1/admin/routing-numbers", { token: R.admin, body: { routing_number: "322271627" } })).status,
  (await call("POST", "/v1/admin/routing-numbers", { token: R.admin, body: { routing_number: "122105155", institution_id: inst } })).status], [422, 201, 409, 201]);
eq("search finds a routing number by prefix and an institution by name", [(await get("admin", "routing-numbers?q=3222")).json.total, (await get("admin", "institutions?q=logoless")).json.total, (await get("admin", "institutions?q=%25")).json.total], [1, 1, 0]);
const pg = (await get("admin", "routing-numbers?limit=2")).json;
eq("paged: a cursor walks the rest", [pg.routing_numbers.length, pg.next_cursor !== null, (await get("admin", `routing-numbers?limit=2&cursor=${encodeURIComponent(pg.next_cursor)}`)).json.routing_numbers.length], [2, true, 2]);
eq("bad cursor or limit is 400", [(await get("admin", "institutions?cursor=nope")).status, (await get("admin", "routing-numbers?limit=0")).status], [400, 400]);

// ---- logos
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const oldKey = (await q("select icon from institutions where id=$1", [inst]))[0].icon;
await call("PUT", `/v1/admin/institutions/${inst}/icon`, { token: R.admin, bytes: PNG });
eq("a new logo replaces the old object", [store.has(oldKey), (await q("select icon from institutions where id=$1", [inst]))[0].icon === oldKey], [false, false]);
eq("bad uploads: not PNG type, not a PNG, too big, empty", await Promise.all([
  call("PUT", `/v1/admin/institutions/${inst}/icon`, { token: R.admin, bytes: PNG, type: "image/jpeg" }).then((r) => r.status),
  call("PUT", `/v1/admin/institutions/${inst}/icon`, { token: R.admin, bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) }).then((r) => r.status),
  call("PUT", `/v1/admin/institutions/${inst}/icon`, { token: R.admin, bytes: new Uint8Array(300_000).fill(0x89) }).then((r) => r.status),
  call("PUT", `/v1/admin/institutions/${inst}/icon`, { token: R.admin, bytes: new Uint8Array(0) }).then((r) => r.status)]), [415, 400, 413, 400]);
eq("rename and re-alias an institution", [(await call("PATCH", `/v1/admin/institutions/${inst}`, { token: R.merchants, body: { name: "Test National Bank NA", aliases: ["tnb"] } })).status, (await q("select name, aliases from institutions where id=$1", [inst]))[0]], [200, { name: "Test National Bank NA", aliases: ["tnb"] }]);
eq("roles: sales and accounting have no Banks pages; an unknown id is 404; a bad body is 400", [
  (await get("sales", "institutions")).status, (await get("accounting", "routing-numbers")).status,
  (await call("PATCH", "/v1/admin/institutions/00000000-0000-7000-8000-00000000dead", { token: R.admin, body: { name: "x" } })).status,
  (await call("POST", "/v1/admin/institutions", { token: R.admin, body: { name: "" } })).status], [403, 403, 404, 400]);
eq("sales reading is forbidden, but writes also need the Merchants or Admin role", (await call("POST", "/v1/admin/institutions", { token: R.sales, body: { name: "Nope" } })).status, 403);
eq("logos, renames and links are in the audit log", (await q("select distinct action from logs where action like 'institution.%' or action like 'routing_number.%' order by action")).map((l: any) => l.action), ["institution.created", "institution.icon_uploaded", "institution.updated", "routing_number.added", "routing_number.linked"]);
eq("without the storage binding an upload is 503", (await call("PUT", `/v1/admin/institutions/${inst}/icon`, { token: R.admin, bytes: PNG, env: { ...env, IMAGES: undefined } })).status, 503);
eq("the icon column only accepts an institution key", await q("update institutions set icon = 'accounts/x.png' where id = $1", [inst]).then(() => "accepted", () => "refused"), "refused");

console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
