import { randomBytes } from "node:crypto";
import postgres from "postgres";
import app from "../src/index.ts";
import { migrate, resetSchema, PG_URL } from "./db.ts";
resetSchema(); migrate();
const adm = postgres(PG_URL, { max: 3, onnotice: () => {} });
const q = async (s: string, p: unknown[] = []) => (await adm.unsafe(s, p as any)) as any[];
const OP = "op-" + randomBytes(16).toString("hex");
const env: any = { HYPERDRIVE: { connectionString: PG_URL }, JWT_SECRET: "x".repeat(40), ADMIN_API_TOKEN: OP, SANDBOX_FUNDING: "true", STATS_TTL_SECONDS: "0" };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };
let pass = 0, fail = 0;
const eq = (l: string, g: unknown, w: unknown) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? pass++ : fail++; console.log(ok ? "ok  " : "FAIL", l, ok ? "" : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`); };
const call = async (m: string, p: string, o: { body?: unknown; token?: string; key?: string } = {}) => {
  const r = await app.fetch(new Request("http://x" + p, { method: m, headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.key ? { "idempotency-key": o.key } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, ctx);
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const sign = async (name: string, email: string, type = "C") => (await call("POST", "/v1/auth/signup", { body: { type, name, email, password: "correct horse battery" } })).json;
/** Walks every page of a list and returns the ids in order. */
async function walk(path: string, token: string, key: string, limit?: number) {
  const ids: string[] = []; let cursor: string | null = null; let pages = 0; let total: number | null = null; let first = true;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const r: any = await call("GET", `${path}${sep}${limit ? `limit=${limit}&` : ""}${cursor ? `cursor=${encodeURIComponent(cursor)}` : ""}`, { token });
    if (r.status !== 200) return { ids, pages, total, status: r.status };
    if (first) { total = r.json.total ?? null; first = false; }
    ids.push(...r.json[key].map((x: any) => x.id)); cursor = r.json.next_cursor; pages++;
  } while (cursor && pages < 100);
  return { ids, pages, total, status: 200 };
}

// ---- employees (the organization's own list)
const org = await sign("Acme", "hr@acme.test", "O");
await q(`insert into employees (org_account_id, employee_id, name, email, created_at)
         select $1, 'E' || g, 'Employee ' || lpad(g::text, 3, '0'), 'e' || g || '@x.test', now() - (g || ' minutes')::interval from generate_series(1, 45) g`, [org.account_id]);
await q(`insert into employees (org_account_id, employee_id, name, email, created_at)       -- 30 people created at the very same instant
         select $1, 'S' || g, 'Same ' || g, 's' || g || '@x.test', timestamptz '2026-01-01 12:00:00.123456' from generate_series(1, 30) g`, [org.account_id]);
const first = (await call("GET", "/v1/org/employees", { token: org.session_token })).json;
eq("the first page is 20 by default, with the total and a cursor", [first.employees.length, first.total, typeof first.next_cursor], [20, 75, "string"]);
const all = await walk("/v1/org/employees", org.session_token, "employees");
eq("walking the pages returns every employee once, newest first", [all.ids.length, new Set(all.ids).size, all.pages, all.total], [75, 75, 4, 75]);
const sameInstant = await q("select id from employees where org_account_id = $1 order by created_at desc, id desc", [org.account_id]);
eq("in exactly that order, even for people created at the same microsecond", all.ids, sameInstant.map((r: any) => r.id));
const tiny = await walk("/v1/org/employees", org.session_token, "employees", 7);
eq("any page size gives the same walk", tiny.ids, all.ids);
eq("a search keeps the total and paging", await (async () => { const r = (await call("GET", "/v1/org/employees?q=Same&limit=10", { token: org.session_token })).json; return [r.employees.length, r.total, typeof r.next_cursor]; })(), [10, 30, "string"]);
await q("update employees set employee_account_id = (select id from accounts where type='O' limit 1), balance = 0 where employee_id in ('E1','E2','E3')");
eq("the claimed filter counts only claimed", (await call("GET", "/v1/org/employees?status=claimed", { token: org.session_token })).json.total, 3);
eq("bad limits and cursors are refused", [(await call("GET", "/v1/org/employees?limit=0", { token: org.session_token })).status, (await call("GET", "/v1/org/employees?limit=101", { token: org.session_token })).status, (await call("GET", "/v1/org/employees?cursor=garbage", { token: org.session_token })).status, (await call("GET", "/v1/org/employees?limit=100", { token: org.session_token })).json.employees.length], [400, 400, 400, 75]);
eq("one organization never sees another's pages", (await call("GET", `/v1/org/employees?cursor=${encodeURIComponent((first.next_cursor as string))}`, { token: (await sign("Other", "o@x.test", "O")).session_token })).json.employees.length, 0);

// ---- products (the merchant's catalog)
const shop = await sign("Cafe", "cafe@x.test", "B"); await q("update accounts set status='active' where id=$1", [shop.account_id]);
const cat = (await call("POST", "/v1/business/categories", { token: shop.session_token, body: { name: "Drinks" } })).json.category;
const names = ["Latte", "latte | iced", "Café crème", "Zebra bar", "Apple|Pie", ...Array.from({ length: 40 }, (_, i) => `Item ${String(i).padStart(2, "0")}`)];
for (const n of names) await call("POST", "/v1/business/products", { token: shop.session_token, body: { name: n, price: 300, category_id: cat.id } });
const p1 = (await call("GET", "/v1/business/products", { token: shop.session_token })).json;
eq("products: the first page is 20, with total", [p1.products.length, p1.total, typeof p1.next_cursor], [20, 45, "string"]);
const pAll = await walk("/v1/business/products", shop.session_token, "products");
const dbOrder = await q("select id from products where account_id = $1 order by name, id", [shop.account_id]);
eq("walking returns every product once, in name order (names with | and accents included)", [pAll.ids.length, new Set(pAll.ids).size, pAll.ids], [45, 45, dbOrder.map((r: any) => r.id)]);
eq("a search and a category filter page too", [(await call("GET", "/v1/business/products?q=Item&limit=15", { token: shop.session_token })).json.total, (await call("GET", `/v1/business/products?category_id=${cat.id}&limit=5`, { token: shop.session_token })).json.total], [40, 45]);
eq("a bad cursor is refused", (await call("GET", "/v1/business/products?cursor=%%%", { token: shop.session_token })).status, 400);

// ---- transactions default to 20 (merchant's own list and the admin lists)
const payer = await sign("Payer", "p@x.test");
await call("POST", "/v1/sandbox/fundings", { token: payer.session_token, key: "f", body: { amount: 100000 } });
const term = (await call("POST", "/v1/terminals", { token: shop.session_token, body: { name: "T" } })).json;
for (let i = 0; i < 25; i++) await call("POST", "/v1/payments", { token: payer.session_token, key: `p${i}`, body: { amount: 100 + i, terminal_id: term.terminal.id } });
const mine = (await call("GET", "/v1/business/transactions", { token: shop.session_token })).json;
eq("the merchant's transactions: 20 per page and a cursor", [mine.transactions.length, typeof mine.next_cursor], [20, "string"]);
const mineAll = await walk("/v1/business/transactions", shop.session_token, "transactions");
eq("and the walk returns all 25 once", [mineAll.ids.length, new Set(mineAll.ids).size], [25, 25]);
const adminTx = (await call("GET", "/v1/admin/transactions", { token: OP })).json;
eq("the admin transactions list: 20 per page", [adminTx.transactions.length, typeof adminTx.next_cursor], [20, "string"]);
eq("the admin merchant and user transaction tabs: 20 per page", [(await call("GET", `/v1/admin/merchants/${shop.account_id}/transactions`, { token: OP })).json.transactions.length, (await call("GET", `/v1/admin/users/${payer.account_id}/transactions`, { token: OP })).json.transactions.length], [20, 20]);

// ---- the admin's views of an organization's employees and a merchant's products
const ae = (await call("GET", `/v1/admin/organizations/${org.account_id}/employees`, { token: OP })).json;
eq("admin: an organization's employees are paged, with total", [ae.employees.length, ae.total, typeof ae.next_cursor], [20, 75, "string"]);
const aeAll = await walk(`/v1/admin/organizations/${org.account_id}/employees`, OP, "employees");
eq("and walk to the end once each", [aeAll.ids.length, new Set(aeAll.ids).size], [75, 75]);
const ap = (await call("GET", `/v1/admin/merchants/${shop.account_id}/products`, { token: OP })).json;
const apAll = await walk(`/v1/admin/merchants/${shop.account_id}/products`, OP, "products");
eq("admin: a merchant's products are paged", [ap.products.length, ap.total, apAll.ids.length, new Set(apAll.ids).size], [20, 45, 45, 45]);

console.log(`\n${pass} passed, ${fail} failed`);
await adm.end();
process.exit(fail ? 1 : 0);
