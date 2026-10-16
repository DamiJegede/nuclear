import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { totp } from "../src/lib/totp.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const env: any = { HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, MFA_ENCRYPTION_KEY: randomBytes(32).toString("base64"), SANDBOX_FUNDING: "true", DAILY_VALUE_CAP_CENTS: "50000000" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (method: string, path: string, o: { body?: unknown; token?: string; key?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + path, { method, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const op = (p: string) => call("GET", p, { token: OP });
const signup = async (name: string, email: string, type = "C") => (await call("POST", "/v1/auth/signup", { body: { name, email, password: "correct horse battery", type } })).json;

// ---- a merchant with terminals, an Orb, staff, a catalogue and a history
const shop = await signup("Cafe Nero", "cafe@example.com", "B"); const other = await signup("Other Shop", "other@example.com", "B");
const S = shop.session_token, M = shop.account_id;
await q("insert into businesses (account_id, legal_name, display_name, city, state, post_code, country, website) values ($1, 'Nero Holdings LLC', 'Cafe Nero', 'Springfield', 'NY', '10001', 'US', 'https://nero.example')", [M]);
await q("insert into bank_accounts (account_id, routing_number, account_number, last4) values ($1, '021000021', '123456789', '4321')", [M]);
await q("update businesses set bank_account_id = (select id from bank_accounts where account_id=$1) where account_id=$1", [M]);
await call("PUT", "/v1/account/handle", { token: S, body: { handle: "nero" } });
const t1 = (await call("POST", "/v1/terminals", { token: S, body: { name: "Counter" } })).json, t2 = (await call("POST", "/v1/terminals", { token: S, body: { name: "Bar", allow_refunds: false } })).json;
await call("PUT", "/v1/terminal/orb", { token: t1.session_token, body: { uid: "AA:BB:CC:00:00:01", model: "Orb 2", software: "1.4.2" } });
const oT = (await call("POST", "/v1/terminals", { token: other.session_token, body: { name: "Elsewhere" } })).json;
const sam = await signup("Sam Staff", "sam@example.com");
await call("POST", "/v1/staff", { token: S, body: { staff_account_id: sam.account_id, role: "write" } });
await q("insert into categories (account_id, name) values ($1, 'Drinks')", [M]);
await q("insert into products (account_id, category_id, name, price, stock, total_sold, sold_today) select $1, id, 'Latte', 450, 12, 30, 4 from categories where account_id=$1", [M]);
await q("insert into products (account_id, name, price, stock, status, active) values ($1, 'Muffin', 300, 0, 'sold_out', false)", [M]);
const ada = await signup("Ada", "ada@example.com"), bob = await signup("Bob", "bob@example.com"), poor = await signup("Poor", "poor@example.com");
for (const u of [ada, bob]) await call("POST", "/v1/sandbox/fundings", { token: u.session_token, key: "f", body: { amount: 50000 } });
const pay = (u: any, key: string, terminal: string, amount: number) => call("POST", "/v1/payments", { token: u.session_token, key, body: { amount, terminal_id: terminal } });
const p1 = await pay(ada, "p1", t1.terminal.id, 1000), p2 = await pay(bob, "p2", t1.terminal.id, 2500), p3 = await pay(ada, "p3", t2.terminal.id, 700);
await pay(poor, "p4", t1.terminal.id, 900);                                         // declined: no money
await pay(ada, "po", oT.terminal.id, 5000);                                         // another merchant's payment: must not leak
await call("POST", "/v1/terminal/refunds", { token: t1.session_token, key: "r1", body: { payment_id: p1.json.payment.id, mode: "partial", amount: 400 } });   // done
await call("POST", "/v1/terminal/refunds", { token: t2.session_token, key: "r2", body: { payment_id: p3.json.payment.id, mode: "full" } });                       // awaiting approval

// ---- people with roles
async function person(name: string, role: string) {
  const made = (await call("POST", "/v1/admin/admins", { token: OP, body: { name, role } })).json;
  const T = (await call("POST", "/v1/admin/login", { body: { access_id: made.credentials.access_id, access_token: made.credentials.access_token } })).json.session_token as string;
  const setup = (await call("POST", "/v1/admin/mfa/setup", { token: T })).json;
  await call("POST", "/v1/admin/mfa/enable", { token: T, body: { code: totp(setup.secret, Date.now()) } });
  return T;
}
const R: Record<string, string> = {}; for (const r of ["admin", "sales", "merchants", "accounting", "tags", "support"]) R[r] = await person(r, r);

// ---- the merchant's profile and numbers
const d = (await op(`/v1/admin/merchants/${M}`)).json.merchant;
eq("profile: name, legal name, handle, contact, address, website, bank (last four only), status", [d.name, d.legal_name, d.handle, d.email, d.address, d.website, d.bank, d.status], ["Cafe Nero", "Nero Holdings LLC", "nero", "cafe@example.com", { line: null, city: "Springfield", state: "NY", post_code: "10001", country: "US" }, "https://nero.example", { last4: "4321", status: "active" }, "active"]);
eq("numbers: balance, completed payments (lifetime and today), declined, refunds, pending refunds, customers, counts", [d.balance, d.stats.payments, d.stats.refunds, d.stats.pending_refunds, d.stats.customers, d.stats.terminals, d.stats.staff, d.stats.products, d.stats.last_payment_at !== null], [4200 - 400, { count: 3, volume: 4200, today: { count: 3, volume: 4200 }, declined: 1 }, { count: 1, volume: 400 }, { count: 1, volume: 700 }, 2, 2, 1, 2, true]);
eq("the profile never carries bank numbers, routing numbers or hashes", JSON.stringify(d).match(/021000021|123456789|hash/i), null);
eq("only business accounts: a consumer id, an unknown id and a bad id are all 404", [(await op(`/v1/admin/merchants/${ada.account_id}`)).status, (await op("/v1/admin/merchants/00000000-0000-7000-8000-000000000000")).status, (await op("/v1/admin/merchants/nope")).status], [404, 404, 404]);

// ---- terminals, staff, products
const terms = (await op(`/v1/admin/merchants/${M}/terminals`)).json.terminals;
eq("terminals: name, refund permission, signed in, Orb, payments, volume, last payment", terms.map((t: any) => [t.name, t.allow_refunds, t.signed_in, t.orb?.uid ?? null, t.orb?.model ?? null, t.orb?.software ?? null, t.payments, t.volume, t.last_payment_at !== null]), [["Counter", true, true, "AABBCC000001", "Orb 2", "1.4.2", 2, 3500, true], ["Bar", false, true, null, null, null, 1, 700, true]]);
eq("only this merchant's terminals are listed", terms.some((t: any) => t.name === "Elsewhere"), false);
eq("staff: name, email, role, when added", (await op(`/v1/admin/merchants/${M}/staff`)).json.staff.map((s: any) => [s.name, s.email, s.role]), [["Sam Staff", "sam@example.com", "write"]]);
eq("products: category, price, stock, status, sold counts, active flag", (await op(`/v1/admin/merchants/${M}/products`)).json.products.map((p: any) => [p.name, p.category, p.price, p.stock, p.status, p.total_sold, p.sold_today, p.active]), [["Latte", "Drinks", 450, 12, "available", 30, 4, true], ["Muffin", null, 300, 0, "sold_out", 0, 0, false]]);
for (const sub of ["terminals", "staff", "products", "transactions"]) eq(`${sub}: a consumer or unknown merchant is 404`, [(await op(`/v1/admin/merchants/${ada.account_id}/${sub}`)).status, (await op(`/v1/admin/merchants/00000000-0000-7000-8000-000000000000/${sub}`)).status], [404, 404]);

// ---- payments and refunds
const all = (await op(`/v1/admin/merchants/${M}/transactions`)).json;
eq("transactions: this merchant's payments (including the declined one) and refunds only, with counts per filter", [all.transactions.length, all.counts, all.transactions.some((t: any) => t.amount === 5000)], [6, { all: 6, payments: 4, refunds: 1, pending: 1 }, false]);
eq("each row says who, where, how and why: customer, terminal, via, reference, status code", all.transactions.map((t: any) => [t.type, t.status, t.status_code, t.customer, t.terminal, t.via, t.amount]).sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [["pay", "completed", null, "Ada", "Bar", "app", 700], ["pay", "completed", null, "Ada", "Counter", "app", 1000], ["pay", "completed", null, "Bob", "Counter", "app", 2500], ["pay", "failed", "insufficient_balance", "Poor", "Counter", "app", 900], ["refund", "completed", null, "Ada", "Counter", null, 400], ["refund", "pending", "awaiting_approval", "Ada", "Bar", null, 700]].sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
const kinds = await Promise.all(["payments", "refunds", "pending"].map(async (k) => (await op(`/v1/admin/merchants/${M}/transactions?kind=${k}`)).json.transactions.map((t: any) => `${t.type}:${t.status}`).sort().join(",")));
eq("kinds: payments, refunds (done) and refunds awaiting approval", kinds, ["pay:completed,pay:completed,pay:completed,pay:failed", "refund:completed", "refund:pending"]);
eq("completed totals are only money that moved", all.totals, { payments: { count: 3, volume: 4200 }, refunds: { count: 1, volume: 400 } });
eq("period filters work here too (today has all of it, a past period none) and bad dates are refused", [(await op(`/v1/admin/merchants/${M}/transactions?from=2020-01-01&to=2020-01-31`)).json.counts.all, (await op(`/v1/admin/merchants/${M}/transactions?from=${new Date().toISOString().slice(0, 10)}`)).json.counts.all >= 1, (await op(`/v1/admin/merchants/${M}/transactions?from=bad`)).status, (await op(`/v1/admin/merchants/${M}/transactions?kind=nope`)).status], [0, true, 400, 400]);
eq("paging by cursor returns every row once", await (async () => { const a = (await op(`/v1/admin/merchants/${M}/transactions?limit=4`)).json; const b = (await op(`/v1/admin/merchants/${M}/transactions?limit=4&cursor=${encodeURIComponent(a.next_cursor)}`)).json; return [a.transactions.length, b.transactions.length, b.next_cursor, new Set([...a.transactions, ...b.transactions].map((t: any) => t.id)).size]; })(), [4, 2, null, 6]);

// ---- who can look, who can act
const get = (r: string, p: string) => call("GET", p, { token: R[r] }).then((x) => x.status);
eq("looking at a merchant: Admin, Sales and Merchants may; Accounting, Support and Tags may not", await Promise.all(["admin", "sales", "merchants", "accounting", "support", "tags"].map(async (r) => [r, (await Promise.all([`/v1/admin/merchants/${M}`, `/v1/admin/merchants/${M}/terminals`, `/v1/admin/merchants/${M}/transactions`].map((p) => get(r, p)))).join("/")])), [["admin", "200/200/200"], ["sales", "200/200/200"], ["merchants", "200/200/200"], ["accounting", "403/403/403"], ["support", "403/403/403"], ["tags", "403/403/403"]]);
eq("signing a terminal out: Admin and Merchants may; Sales (read-only), Accounting, Support and Tags may not", await Promise.all(["sales", "accounting", "support", "tags"].map((r) => call("POST", `/v1/admin/terminals/${t2.terminal.id}/sign-out`, { token: R[r] }).then((x) => x.status))), [403, 403, 403, 403]);
const stillIn = (await op(`/v1/admin/merchants/${M}/terminals`)).json.terminals.find((t: any) => t.id === t2.terminal.id).signed_in;
const out = await call("POST", `/v1/admin/terminals/${t2.terminal.id}/sign-out`, { token: R.merchants });
const after = (await op(`/v1/admin/merchants/${M}/terminals`)).json.terminals;
const reuse = await call("GET", "/v1/terminal/products", { token: t2.session_token });
eq("a signed-out terminal's token stops working at once, the other terminals are untouched, and signing out again is harmless", [stillIn, out.status, after.find((t: any) => t.id === t2.terminal.id).signed_in, after.find((t: any) => t.id === t1.terminal.id).signed_in, reuse.status, (await call("POST", `/v1/admin/terminals/${t2.terminal.id}/sign-out`, { token: R.admin })).status, (await call("POST", "/v1/admin/terminals/00000000-0000-7000-8000-000000000000/sign-out", { token: R.admin })).status, (await call("POST", "/v1/admin/terminals/nope/sign-out", { token: R.admin })).status], [true, 204, false, true, 401, 204, 404, 404]);
eq("the merchant signs the terminal in again and it works", await (async () => { const again = await call("POST", `/v1/terminals/${t2.terminal.id}/session`, { token: S }); return [again.status, (await call("GET", "/v1/terminal/products", { token: again.json.session_token })).status]; })(), [201, 200]);
eq("the operator token (scripts) can do all of it", [(await op(`/v1/admin/merchants/${M}`)).status, (await call("POST", `/v1/admin/terminals/${t1.terminal.id}/sign-out`, { token: OP })).status], [200, 204]);
// ---- admin actions: resolve a pending refund, suspend the merchant
const adminId = (await q("select access_id from admins where role = 'admin' and name = 'admin'"))[0].access_id as string;
const pendingRow = (await op(`/v1/admin/merchants/${M}/transactions?kind=pending`)).json.transactions[0];
const adaBefore = (await call("GET", "/v1/balance", { token: ada.session_token })).json.balance, merchBefore = (await q("select balance::int b from balances where account_id=$1", [M]))[0].b;
const act = (role: string, path: string, method = "POST", body?: unknown) => call(method, path, { token: role === "operator" ? OP : R[role], body });
eq("approving or rejecting a pending refund: only Admin (and the operator); Merchants, Sales, Accounting, Support and Tags get 403", await Promise.all(["merchants", "sales", "accounting", "support", "tags"].map((r) => act(r, `/v1/admin/merchants/${M}/refunds/${pendingRow.id}/approve`).then((x) => x.status))), [403, 403, 403, 403, 403]);
eq("nothing moved while they were refused", [(await q("select status from transactions where id=$1", [pendingRow.id]))[0].status, (await call("GET", "/v1/balance", { token: ada.session_token })).json.balance === adaBefore], ["pending", true]);
const appr = await act("admin", `/v1/admin/merchants/${M}/refunds/${pendingRow.id}/approve`);
eq("an Admin approves it: the refund completes and the money moves from the merchant to the customer", [appr.status, appr.json.refund.status, (await call("GET", "/v1/balance", { token: ada.session_token })).json.balance - adaBefore, merchBefore - (await q("select balance::int b from balances where account_id=$1", [M]))[0].b], [200, "completed", 700, 700]);
eq("it is recorded as approved by that admin (no new columns: the reference carries it) and shown that way", [(await q("select provider_reference r from transactions where id=$1", [pendingRow.id]))[0].r === `admin:${adminId}`, (await op(`/v1/admin/merchants/${M}/transactions?kind=refunds`)).json.transactions.find((t: any) => t.id === pendingRow.id).approved_by === `Admin ${adminId}`], [true, true]);
const again = await act("admin", `/v1/admin/merchants/${M}/refunds/${pendingRow.id}/approve`);
eq("approving again is harmless: same answer, no second payout", [again.status, again.json.refund.status, (await call("GET", "/v1/balance", { token: ada.session_token })).json.balance - adaBefore], [200, "completed", 700]);
// a second pending refund, to reject
const p5 = await pay(bob, "p5", t2.terminal.id, 1200);
const pend2 = await call("POST", "/v1/terminal/refunds", { token: (await call("POST", `/v1/terminals/${t2.terminal.id}/session`, { token: S })).json.session_token, key: "r5", body: { payment_id: p5.json.payment.id, mode: "full" } });
const bobBefore = (await call("GET", "/v1/balance", { token: bob.session_token })).json.balance;
const rej = await act("operator", `/v1/admin/merchants/${M}/refunds/${pend2.json.refund.id}/reject`);
eq("rejecting releases the request and moves nothing (the operator may do it too)", [rej.status, rej.json.refund.status, rej.json.refund.status_code, (await call("GET", "/v1/balance", { token: bob.session_token })).json.balance === bobBefore, (await q("select provider_reference r from transactions where id=$1", [pend2.json.refund.id]))[0].r], [200, "failed", "rejected", true, "operator"]);
eq("refunds that are not pending, belong to another merchant or do not exist are refused", [(await act("admin", `/v1/admin/merchants/${M}/refunds/${rej.json.refund.id}/approve`)).json.error, (await act("admin", `/v1/admin/merchants/${other.account_id}/refunds/${pendingRow.id}/approve`)).status, (await act("admin", `/v1/admin/merchants/${M}/refunds/00000000-0000-7000-8000-000000000000/reject`)).status, (await act("admin", `/v1/admin/merchants/${M}/refunds/nope/approve`)).status], ["refund_not_pending", 404, 404, 404]);

const T1b = (await call("POST", `/v1/terminals/${t1.terminal.id}/session`, { token: S })).json.session_token as string;   // signed out above, sign it in again
const terminalOk = async () => (await call("GET", "/v1/terminal/products", { token: T1b })).status;
const ownerOk = async () => (await call("GET", "/v1/balance", { token: S })).status;
eq("suspending a merchant is Admin-only; bad statuses, consumers and unknown ids are refused", [await Promise.all(["merchants", "sales", "accounting"].map((r) => act(r, `/v1/admin/merchants/${M}/status`, "PUT", { status: "suspended" }).then((x) => x.status))), (await act("admin", `/v1/admin/merchants/${M}/status`, "PUT", { status: "closed" })).status, (await act("admin", `/v1/admin/merchants/${ada.account_id}/status`, "PUT", { status: "suspended" })).status, (await act("admin", "/v1/admin/merchants/00000000-0000-7000-8000-000000000000/status", "PUT", { status: "suspended" })).status], [[403, 403, 403], 400, 404, 404]);
eq("before suspension: the terminal, the owner and payments all work", [await terminalOk(), await ownerOk(), (await pay(ada, "pre", t1.terminal.id, 100)).status], [200, 200, 201]);
const susp = await act("admin", `/v1/admin/merchants/${M}/status`, "PUT", { status: "suspended" });
eq("suspended: the merchant shows as suspended and can do nothing: no payments, owner and terminals refused at once", [susp.status, susp.json.merchant.status, (await op(`/v1/admin/merchants/${M}`)).json.merchant.status, await terminalOk(), await ownerOk(), (await pay(ada, "during", t1.terminal.id, 100)).status], [200, "suspended", "suspended", 401, 401, 404]);
eq("customers' money is untouched and the page still shows the history", [(await op(`/v1/admin/merchants/${M}/transactions`)).json.counts.all > 0, (await call("GET", "/v1/balance", { token: ada.session_token })).status], [true, 200]);
const react = await act("admin", `/v1/admin/merchants/${M}/status`, "PUT", { status: "active" });
eq("reactivated: everything resumes with the same terminals and sessions", [react.status, await terminalOk(), await ownerOk(), (await pay(ada, "after", t1.terminal.id, 100)).status], [200, 200, 200, 201]);
console.log(`\n${pass} passed, ${fail} failed`); await adm.end(); process.exit(fail ? 1 : 0);
