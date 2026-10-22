import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { customerLog } from "../lib/audit";
import { encryptBankField } from "../lib/bankCrypto";
import { checkoutJson, getCheckout, getItems, listCheckouts } from "../lib/checkout";
import { imageUrl } from "../lib/images";
import { MERCHANT_TX_KINDS, merchantTransactions, type MerchantTxKind } from "../lib/merchantSupport";
import { saveProfilePhoto } from "../lib/profilePhoto";
import { PROGRAM_TZ } from "../lib/ledger";
import { n } from "../lib/money";
import { requireOwner, requireSession } from "../session";

/**
 * Everything a business owner manages from the merchant portal that is not a terminal, staff or refund (those have their own routes):
 * its payments and refunds, the product catalogue, its profile and payout bank, and the orders (checkouts) made at its terminals.
 * Business accounts only; the owner's own session.
 */
export const business = new Hono<AppContext>();
business.use("*", requireSession, requireOwner, async (c, next) => {
  const [a] = await c.get("sql")<{ type: string }[]>`select type from accounts where id = ${c.get("auth").accountId}`;
  if (a?.type !== "B") return c.json({ error: "business_account_required" }, 403);
  await next();
});

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ---- Overview: every number the portal's first page shows, in one request (they were ten, each repeating sign-in checks) ----
business.get("/overview", async (c) => {
  const sql = c.get("sql");
  const id = c.get("auth").accountId;
  const [bal, term, pend, staff, orders, prof, cats, prods, best, tx] = await Promise.all([
    sql<{ balance: bigint; balance_pending: bigint }[]>`select balance, balance_pending from balances where account_id = ${id}`,
    sql<{ n: number; paired: number }[]>`select count(*)::int as n, (count(*) filter (where exists (select 1 from orbs o where o.terminal_id = t.id)))::int as paired from terminals t where t.account_id = ${id}`,
    sql<{ n: number; v: bigint }[]>`select count(*)::int as n, coalesce(sum(amount), 0) as v from transactions where type = 'refund' and status = 'pending' and from_account_id = ${id}`,
    sql<{ n: number; writers: number }[]>`select count(*)::int as n, (count(*) filter (where role = 'write'))::int as writers from staff where account_id = ${id}`,
    sql<{ n: number }[]>`select count(*)::int as n from checkouts where account_id = ${id} and status = 'open'`,
    sql<{ city: string | null; state: string | null }[]>`select city, state from businesses where account_id = ${id}`,
    sql<{ n: number }[]>`select count(*)::int as n from categories where account_id = ${id}`,
    sql<{ n: number }[]>`select count(*)::int as n from products where account_id = ${id}`,
    // Today's best seller: the product with the most units sold today (the counter resets at 00:00 New York); ties go to the bigger lifetime seller.
    sql<{ name: string; sold_today: number }[]>`select name, sold_today from products where account_id = ${id} and sold_today > 0 order by sold_today desc, total_sold desc, name limit 1`,
    // Today (since 00:00 New York) and yesterday, from the account's payments and refunds, read once.
    sql<{ today_n: number; y_pay: bigint; y_ref: bigint }[]>`
      with d as (select ((now() at time zone ${PROGRAM_TZ})::date)::timestamp at time zone ${PROGRAM_TZ} as t0,
                        (((now() at time zone ${PROGRAM_TZ})::date - 1)::timestamp at time zone ${PROGRAM_TZ}) as y0)
      select (count(*) filter (where x."timestamp" >= d.t0))::int as today_n,
             coalesce(sum(x.amount) filter (where x.type = 'pay' and x.status = 'completed' and x."timestamp" >= d.y0 and x."timestamp" < d.t0), 0) as y_pay,
             coalesce(sum(x.amount) filter (where x.type = 'refund' and x.status = 'completed' and x."timestamp" >= d.y0 and x."timestamp" < d.t0), 0) as y_ref
        from transactions x, d
       where ((x.to_account_id = ${id} and x.type = 'pay') or (x.from_account_id = ${id} and x.type = 'refund')) and x."timestamp" >= d.y0`,
  ]);
  return c.json({
    balance: Number(bal[0]?.balance ?? 0n), balance_pending: Number(bal[0]?.balance_pending ?? 0n),
    terminals: { count: term[0]!.n, paired: term[0]!.paired },
    pending_refunds: { count: pend[0]!.n, amount: Number(pend[0]!.v) },
    staff: { count: staff[0]!.n, writers: staff[0]!.writers },
    open_orders: orders[0]!.n,
    city: prof[0]?.city ?? null, state: prof[0]?.state ?? null,
    categories: cats[0]!.n, products: prods[0]!.n,
    best_seller: best[0] ? { name: best[0].name, sold_today: best[0].sold_today } : null,
    today: { transactions: tx[0]!.today_n },
    yesterday: { net: Number(tx[0]!.y_pay) - Number(tx[0]!.y_ref) },
  });
});

// ---- Transactions: this business's payments and refunds -----------------------------------------
const txQuery = z.object({
  kind: z.enum(MERCHANT_TX_KINDS as [MerchantTxKind, ...MerchantTxKind[]]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(100).optional(),
  from: date.optional(),
  to: date.optional(),
}).refine((q) => [q.from, q.to].every((d) => d === undefined || (!Number.isNaN(Date.parse(d)) && new Date(d).toISOString().startsWith(d))), { message: "invalid_date" })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, { message: "from_after_to" });

business.get("/transactions", async (c) => {
  const q = txQuery.safeParse(c.req.query());
  if (!q.success) return c.json({ error: "invalid_request" }, 400);
  let cursor: { ts: string; id: string } | null = null;
  if (q.data.cursor) {
    const [ts, id] = q.data.cursor.split("|");
    if (!ts || !id || Number.isNaN(Date.parse(ts)) || !uuid.safeParse(id).success) return c.json({ error: "invalid_request" }, 400);
    cursor = { ts, id };
  }
  const page = await merchantTransactions(c.get("sql"), c.get("auth").accountId, q.data.kind, q.data.limit, cursor, { from: q.data.from ?? null, to: q.data.to ?? null });
  // A merchant sees its customers' names, never their account ids.
  return c.json({ ...page, transactions: page.transactions.map((t) => ({ ...t, from_party: null, to_party: null })) });
});

// ---- Profile --------------------------------------------------------------------------------------
export type ProfileRow = { legal_name: string; display_name: string; tax_id: string | null; address: string | null; city: string | null; state: string | null; post_code: string | null; country: string | null; website: string | null };
export const profileJson = (p: ProfileRow | undefined) => p ? {
  legal_name: p.legal_name, display_name: p.display_name, tax_id_last4: p.tax_id ? p.tax_id.replace(/[^0-9A-Za-z]/g, "").slice(-4) : null,
  address: p.address, city: p.city, state: p.state, post_code: p.post_code, country: p.country, website: p.website,
} : null;

business.get("/profile", async (c) => {
  const [p] = await c.get("sql")<ProfileRow[]>`select legal_name, display_name, tax_id, address, city, state, post_code, country, website from businesses where account_id = ${c.get("auth").accountId}`;
  return c.json({ profile: profileJson(p) });
});

const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
export const profileBody = z.object({
  legal_name: z.string().trim().min(1).max(160),
  display_name: z.string().trim().min(1).max(120),
  tax_id: z.string().trim().regex(/^[0-9A-Za-z-]{4,20}$/).optional(),   // omitted = keep the saved one
  address: optText(300), city: optText(100), state: optText(100), post_code: optText(20),
  country: z.string().trim().toUpperCase().length(2).nullish().transform((v) => v ?? null),
  website: z.string().trim().url().max(200).refine((u) => /^https?:\/\//.test(u)).nullish().transform((v) => v ?? null),
});

business.put("/profile", async (c) => {
  const b = profileBody.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: "invalid_request", issues: b.error.flatten() }, 400);
  const { accountId } = c.get("auth");
  const sql = c.get("sql");
  const d = b.data;
  const [p] = await sql<ProfileRow[]>`
    insert into businesses (account_id, legal_name, display_name, tax_id, address, city, state, post_code, country, website)
    values (${accountId}, ${d.legal_name}, ${d.display_name}, ${d.tax_id ?? null}, ${d.address}, ${d.city}, ${d.state}, ${d.post_code}, ${d.country}, ${d.website})
    on conflict (account_id) do update set legal_name = excluded.legal_name, display_name = excluded.display_name,
      tax_id = coalesce(excluded.tax_id, businesses.tax_id), address = excluded.address, city = excluded.city, state = excluded.state,
      post_code = excluded.post_code, country = excluded.country, website = excluded.website
    returning legal_name, display_name, tax_id, address, city, state, post_code, country, website`;
  await customerLog(c, accountId, null, "business.profile_saved", { fields: Object.keys(d) });
  return c.json({ profile: profileJson(p) });
});

// ---- Payout bank (where settlements will go; settlement itself is not built) ----------------------------
const bankJson = (r: { id: string; last4: string; status: string; created_at: Date } | undefined) => (r ? { id: r.id, last4: r.last4, status: r.status, created_at: r.created_at } : null);
const abaOk = (r: string) => { const d = [...r].map(Number); return (3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!)) % 10 === 0; };

business.get("/bank", async (c) => {
  const [r] = await c.get("sql")<{ id: string; last4: string; status: string; created_at: Date }[]>`
    select ba.id, ba.last4, ba.status, ba.created_at from businesses b join bank_accounts ba on ba.id = b.bank_account_id and ba.account_id = b.account_id
     where b.account_id = ${c.get("auth").accountId} and ba.status = 'active'`;
  return c.json({ bank: bankJson(r) });
});

// Set or replace the payout bank: the previous one is marked removed. Needs the business profile first.
business.put("/bank", async (c) => {
  const b = z.object({ routing_number: z.string().trim().regex(/^\d{9}$/), account_number: z.string().trim().regex(/^\d{4,17}$/) }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: "invalid_request" }, 400);
  if (!abaOk(b.data.routing_number)) return c.json({ error: "invalid_routing_number" }, 422);
  const { accountId } = c.get("auth");
  // The account number is stored encrypted, bound to this account; only its last four digits stay readable. The routing number is public
  // (it identifies the bank), so it is stored as plain digits: that keeps it usable for bank names, batching and checks.
  if (!c.env.BANK_ENCRYPTION_KEY) return c.json({ error: "encryption_unavailable" }, 503);
  const routing = b.data.routing_number;
  const account = encryptBankField(c.env.BANK_ENCRYPTION_KEY, accountId, "account", b.data.account_number);
  const out = await c.get("sql").begin(async (tx) => {
    const [p] = await tx<{ bank_account_id: string | null }[]>`select bank_account_id from businesses where account_id = ${accountId} for no key update`;
    if (!p) return { error: "profile_required" as const };
    const [n] = await tx<{ id: string; last4: string; status: string; created_at: Date }[]>`
      insert into bank_accounts (account_id, routing_number, account_number, last4)
      values (${accountId}, ${routing}, ${account}, ${b.data.account_number.slice(-4)}) returning id, last4, status, created_at`;
    await tx`update businesses set bank_account_id = ${n!.id} where account_id = ${accountId}`;
    if (p.bank_account_id) await tx`update bank_accounts set status = 'removed' where id = ${p.bank_account_id} and account_id = ${accountId}`;
    return { bank: n! };
  });
  if ("error" in out) return c.json({ error: out.error }, 409);
  await customerLog(c, accountId, null, "business.bank_saved", { last4: out.bank.last4 });
  return c.json({ bank: bankJson(out.bank) }, 201);
});

// Settlements to and from the payout bank: type 'settle' transactions (a positive daily net is a payout to the bank, a negative one a collection
// from it). Written by the daily settlement job (lib/settlement.ts); the table is the transactions table, no separate payouts table.
business.get("/payouts", async (c) => {
  const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).safeParse(c.req.query());
  if (!q.success) return c.json({ error: "invalid_request" }, 400);
  const id = c.get("auth").accountId;
  const rows = await c.get("sql")<{ id: string; amount: bigint; status: string; status_code: string | null; ts: Date; completed_at: Date | null; payout: boolean; last4: string | null }[]>`
    select t.id, t.amount, t.status, t.status_code, t."timestamp" as ts, t.completed_at, (t.to_bank_account_id is not null) as payout, ba.last4
      from transactions t left join bank_accounts ba on ba.id = coalesce(t.to_bank_account_id, t.from_bank_account_id)
     where t.type = 'settle' and (t.from_account_id = ${id} or t.to_account_id = ${id})
     order by t."timestamp" desc, t.id desc limit ${q.data.limit}`;
  return c.json({ payouts: rows.map((r) => ({ id: r.id, kind: r.payout ? "payout" : "collection", amount: Number(r.amount), status: r.status, status_code: r.status_code, timestamp: r.ts, completed_at: r.completed_at, bank_last4: r.last4 })) });
});

business.delete("/bank", async (c) => {
  const { accountId } = c.get("auth");
  await c.get("sql").begin(async (tx) => {
    const [p] = await tx<{ bank_account_id: string | null }[]>`select bank_account_id from businesses where account_id = ${accountId} for no key update`;
    if (p?.bank_account_id) {
      await tx`update businesses set bank_account_id = null where account_id = ${accountId}`;
      await tx`update bank_accounts set status = 'removed' where id = ${p.bank_account_id} and account_id = ${accountId}`;
    }
  });
  await customerLog(c, accountId, null, "business.bank_removed", {});
  return c.body(null, 204);
});

// ---- Catalogue: categories and products -----------------------------------------------------------------
type CategoryRow = { id: string; name: string; active: boolean; products: number; created_at: Date };
const categoryJson = (r: CategoryRow) => ({ id: r.id, name: r.name, active: r.active, products: r.products, created_at: r.created_at });
const catName = z.string().trim().min(1).max(120);

business.get("/categories", async (c) => {
  const rows = await c.get("sql")<CategoryRow[]>`
    select c.id, c.name, c.active, c.created_at, (select count(*) from products p where p.category_id = c.id)::int as products
      from categories c where c.account_id = ${c.get("auth").accountId} order by c.name, c.id`;
  return c.json({ categories: rows.map(categoryJson) });
});

business.post("/categories", async (c) => {
  const b = z.object({ name: catName }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: "invalid_request" }, 400);
  const [r] = await c.get("sql")<CategoryRow[]>`insert into categories (account_id, name) values (${c.get("auth").accountId}, ${b.data.name}) returning id, name, active, created_at, 0 as products`;
  return c.json({ category: categoryJson(r!) }, 201);
});

business.patch("/categories/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  const b = z.object({ name: catName, active: z.boolean() }).partial().refine((o) => Object.keys(o).length > 0).safeParse(await c.req.json().catch(() => null));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  if (!b.success) return c.json({ error: "invalid_request" }, 400);
  const sql = c.get("sql");
  const [r] = await sql<CategoryRow[]>`
    update categories set ${sql(b.data, ...(Object.keys(b.data) as (keyof typeof b.data)[]))} where id = ${id.data} and account_id = ${c.get("auth").accountId}
    returning id, name, active, created_at, (select count(*) from products p where p.category_id = categories.id)::int as products`;
  return r ? c.json({ category: categoryJson(r) }) : c.json({ error: "not_found" }, 404);
});

// A category with products cannot be deleted (move or delete the products first).
business.delete("/categories/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const { accountId } = c.get("auth");
  const sql = c.get("sql");
  const [cat] = await sql<{ n: number }[]>`select (select count(*) from products where category_id = ${id.data})::int as n from categories where id = ${id.data} and account_id = ${accountId}`;
  if (!cat) return c.json({ error: "not_found" }, 404);
  if (cat.n > 0) return c.json({ error: "category_has_products" }, 409);
  await sql`delete from categories where id = ${id.data} and account_id = ${accountId}`;
  return c.body(null, 204);
});

type ProductRow = {
  id: string; category_id: string | null; name: string; currency: string; price: bigint; photo: string | null; stock: number | null; active: boolean;
  status: string; total_sold: bigint; sold_today: number; discount: bigint; created_at: Date;
};
const PCOLS = "id, category_id, name, currency, price, photo, stock, active, status, total_sold, sold_today, discount, created_at";
const productJson = (p: ProductRow) => ({
  id: p.id, category_id: p.category_id, name: p.name, currency: p.currency, price: Number(p.price), discount: Number(p.discount), effective_price: Number(p.price - p.discount),
  photo: imageUrl(p.photo), stock: p.stock, active: p.active, status: p.status, total_sold: Number(p.total_sold), sold_today: p.sold_today, created_at: p.created_at,
});

business.get("/products", async (c) => {
  const q = z.object({ category_id: uuid.optional(), q: z.string().trim().max(80).optional() }).safeParse(c.req.query());
  if (!q.success) return c.json({ error: "invalid_request" }, 400);
  const sql = c.get("sql");
  const term = (q.data.q ?? "").replace(/[\\%_]/g, "\\$&");
  const rows = await sql<ProductRow[]>`
    select ${sql.unsafe(PCOLS)} from products where account_id = ${c.get("auth").accountId}
      ${q.data.category_id ? sql`and category_id = ${q.data.category_id}` : sql``}
      ${term ? sql`and name ilike ${"%" + term + "%"}` : sql``}
    order by name, id limit 500`;
  return c.json({ products: rows.map(productJson) });
});

const productBody = z.object({
  name: z.string().trim().min(1).max(120),
  price: z.number().int().min(0).max(100_000_000),
  discount: z.number().int().min(0).max(100_000_000),
  category_id: uuid.nullable(),
  stock: z.number().int().min(0).max(10_000_000).nullable(),   // null = not tracked
  active: z.boolean(),
}).strict();

// The category must be this business's own (404 otherwise); a discount cannot exceed the price.
async function checkCategory(c: any, categoryId: string | null | undefined): Promise<Response | null> {
  if (!categoryId) return null;
  const [r] = await c.get("sql")`select 1 as ok from categories where id = ${categoryId} and account_id = ${c.get("auth").accountId}`;
  return r ? null : c.json({ error: "category_not_found" }, 404);
}

business.post("/products", async (c) => {
  const b = productBody.partial({ discount: true, category_id: true, stock: true, active: true }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: "invalid_request", issues: b.error.flatten() }, 400);
  const d = b.data;
  if ((d.discount ?? 0) > d.price) return c.json({ error: "discount_exceeds_price" }, 422);
  const bad = await checkCategory(c, d.category_id); if (bad) return bad;
  const sql = c.get("sql");
  const [p] = await sql<ProductRow[]>`
    insert into products (account_id, category_id, name, price, discount, stock, active)
    values (${c.get("auth").accountId}, ${d.category_id ?? null}, ${d.name}, ${d.price}, ${d.discount ?? 0}, ${d.stock ?? null}, ${d.active ?? true})
    returning ${sql.unsafe(PCOLS)}`;
  return c.json({ product: productJson(p!) }, 201);
});

business.patch("/products/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const b = productBody.partial().refine((o) => Object.keys(o).length > 0).safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: "invalid_request" }, 400);
  const sql = c.get("sql");
  const { accountId } = c.get("auth");
  const [cur] = await sql<ProductRow[]>`select ${sql.unsafe(PCOLS)} from products where id = ${id.data} and account_id = ${accountId}`;
  if (!cur) return c.json({ error: "not_found" }, 404);
  const d = b.data;
  const price = d.price ?? Number(cur.price), discount = d.discount ?? Number(cur.discount);
  if (discount > price) return c.json({ error: "discount_exceeds_price" }, 422);
  const bad = d.category_id !== undefined ? await checkCategory(c, d.category_id) : null; if (bad) return bad;
  const [p] = await sql<ProductRow[]>`
    update products set name = ${d.name ?? cur.name}, price = ${price}, discount = ${discount},
      category_id = ${d.category_id === undefined ? cur.category_id : d.category_id}, stock = ${d.stock === undefined ? cur.stock : d.stock}, active = ${d.active ?? cur.active}
     where id = ${id.data} and account_id = ${accountId} returning ${sql.unsafe(PCOLS)}`;
  return c.json({ product: productJson(p!) });
});

// A product that was ever in an order cannot be deleted (history keeps pointing at it); deactivate it instead.
business.delete("/products/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const { accountId } = c.get("auth");
  const sql = c.get("sql");
  const [p] = await sql<{ used: boolean }[]>`select exists (select 1 from checkout_items where product_id = ${id.data}) as used from products where id = ${id.data} and account_id = ${accountId}`;
  if (!p) return c.json({ error: "not_found" }, 404);
  if (p.used) return c.json({ error: "product_in_use" }, 409);
  await sql`delete from products where id = ${id.data} and account_id = ${accountId}`;
  return c.body(null, 204);
});

// A product's picture: any PNG, JPEG or WebP (8 MB at most), cropped to 256 x 256 JPEG, saved as products/<id>-<ms>.jpg.
business.put("/products/:id/photo", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const { accountId } = c.get("auth");
  const sql = c.get("sql");
  const [p] = await sql<{ photo: string | null }[]>`select photo from products where id = ${id.data} and account_id = ${accountId}`;
  if (!p) return c.json({ error: "not_found" }, 404);
  const r = await saveProfilePhoto(c, "products", id.data, p.photo);
  if (r instanceof Response) return r;
  await sql`update products set photo = ${r.key} where id = ${id.data} and account_id = ${accountId}`;
  return c.json({ photo: imageUrl(r.key) });
});

// ---- Orders (checkouts made at the business's terminals) ---------------------------------------------------------
business.get("/checkouts", async (c) => {
  const q = z.object({ status: z.enum(["open", "paid", "canceled", "expired"]).default("open"), limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(c.req.query());
  if (!q.success) return c.json({ error: "invalid_request" }, 400);
  return c.json({ checkouts: await listCheckouts(c.get("sql"), c.get("auth").accountId, q.data.status, q.data.limit) });
});

// Cancel an order that is still open (a paid one cannot be cancelled: refund it instead).
business.post("/checkouts/:id/cancel", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const sql = c.get("sql");
  const { accountId } = c.get("auth");
  const result = await sql.begin(async (tx) => {
    const [co] = await tx<{ status: string }[]>`select status from checkouts where id = ${id.data} and account_id = ${accountId} for no key update`;
    if (!co) return "not_found" as const;
    if (co.status === "paid") return "paid" as const;
    if (co.status === "open") await tx`update checkouts set status = 'canceled' where id = ${id.data}`;
    return "ok" as const;
  });
  if (result === "not_found") return c.json({ error: "not_found" }, 404);
  if (result === "paid") return c.json({ error: "checkout_paid" }, 409);
  return c.json({ checkout: checkoutJson((await getCheckout(sql, accountId, id.data))!, await getItems(sql, id.data)) });
});
