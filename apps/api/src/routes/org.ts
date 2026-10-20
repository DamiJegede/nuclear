import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { customerLog } from "../lib/audit";
import { n } from "../lib/money";
import { profileBody, profileJson, type ProfileRow } from "./business";
import { MAX_BATCH_ROWS, MAX_CREDIT, claimCredit, runCreditBatch } from "../lib/org";
import { sendCreditEmails } from "../lib/orgMail";
import { requireOwner, requireSession } from "../session";

/**
 * What an organization (account type O) does from the organization portal: see its employees and credit them from a CSV. The CSV is
 * parsed in the browser and posted as rows; see lib/org.ts for the money rules. Owner session of an active organization only.
 */
export const org = new Hono<AppContext>();
org.use("*", requireSession, requireOwner, async (c, next) => {
  const [a] = await c.get("sql")<{ type: string }[]>`select type from accounts where id = ${c.get("auth").accountId}`;
  if (a?.type !== "O") return c.json({ error: "organization_account_required" }, 403);
  await next();
});

const uuid = z.string().uuid();
const creditRow = z.object({
  employee_id: z.string().trim().regex(/^[A-Za-z0-9]{1,64}$/),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  amount: z.union([z.number().int(), z.string().regex(/^\d{1,12}$/)]).transform((v) => BigInt(v)).refine((v) => v > 0n && v <= MAX_CREDIT, { message: "amount_out_of_range" }),
});
const batchBody = z.object({ rows: z.array(creditRow).min(1).max(MAX_BATCH_ROWS) });

type BatchRow = { id: string; row_count: number; total: bigint; sent: bigint; held: bigint; created_at: Date };
const batchJson = (b: BatchRow) => ({ id: b.id, rows: b.row_count, total: n(b.total), sent: n(b.sent), held: n(b.held), created_at: b.created_at });

// ---- Overview ----
org.get("/overview", async (c) => {
  const sql = c.get("sql");
  const id = c.get("auth").accountId;
  const [bal, emp, last] = await Promise.all([
    sql<{ balance: bigint }[]>`select balance from balances where account_id = ${id}`,
    sql<{ total: number; claimed: number; unclaimed: number; held: bigint }[]>`
      select count(*)::int as total, (count(*) filter (where employee_account_id is not null))::int as claimed,
             (count(*) filter (where employee_account_id is null))::int as unclaimed, coalesce(sum(balance), 0) as held
        from employees where org_account_id = ${id} and status = 'active'`,
    sql<BatchRow[]>`select id, row_count, total, sent, held, created_at from credit_batches where org_account_id = ${id} order by created_at desc, id desc limit 1`,
  ]);
  const e = emp[0]!;
  return c.json({
    balance: n(bal[0]?.balance ?? 0n),
    employees: { total: e.total, claimed: e.claimed, unclaimed: e.unclaimed },
    held: n(e.held),
    last_batch: last[0] ? batchJson(last[0]) : null,
  });
});

// ---- Organization profile: legal name, tax ID, address and website, kept in the same table as a business profile ----
org.get("/profile", async (c) => {
  const [p] = await c.get("sql")<ProfileRow[]>`select legal_name, display_name, tax_id, address, city, state, post_code, country, website from businesses where account_id = ${c.get("auth").accountId}`;
  return c.json({ profile: profileJson(p) });
});

org.put("/profile", async (c) => {
  const b = profileBody.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: "invalid_request", issues: b.error.flatten() }, 400);
  const { accountId } = c.get("auth");
  const d = b.data;
  const [p] = await c.get("sql")<ProfileRow[]>`
    insert into businesses (account_id, account_type, legal_name, display_name, tax_id, address, city, state, post_code, country, website)
    values (${accountId}, 'O', ${d.legal_name}, ${d.display_name}, ${d.tax_id ?? null}, ${d.address}, ${d.city}, ${d.state}, ${d.post_code}, ${d.country}, ${d.website})
    on conflict (account_id) do update set legal_name = excluded.legal_name, display_name = excluded.display_name,
      tax_id = coalesce(excluded.tax_id, businesses.tax_id), address = excluded.address, city = excluded.city, state = excluded.state,
      post_code = excluded.post_code, country = excluded.country, website = excluded.website
    returning legal_name, display_name, tax_id, address, city, state, post_code, country, website`;
  await customerLog(c, accountId, null, "org.profile_saved", { fields: Object.keys(d) });
  return c.json({ profile: profileJson(p) });
});

// ---- Employees ----
org.get("/employees", async (c) => {
  const sql = c.get("sql");
  const id = c.get("auth").accountId;
  const q = (c.req.query("q") ?? "").trim().slice(0, 80);
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const status = c.req.query("status");
  if (status && !["claimed", "unclaimed"].includes(status)) return c.json({ error: "invalid_request" }, 400);
  const rows = await sql<{ id: string; employee_id: string; name: string; email: string; balance: bigint; claimed: boolean; reminded_at: Date | null; created_at: Date }[]>`
    select id, employee_id, name, email, balance, (employee_account_id is not null) as claimed, reminded_at, created_at
      from employees
     where org_account_id = ${id} and status = 'active'
       ${q ? sql`and (name ilike ${like} or email ilike ${like} or employee_id ilike ${like})` : sql``}
       ${status === "claimed" ? sql`and employee_account_id is not null` : status === "unclaimed" ? sql`and employee_account_id is null` : sql``}
     order by created_at desc, id desc limit 500`;
  return c.json({ employees: rows.map((r) => ({ ...r, balance: n(r.balance) })) });
});

// Removing an employee hides them. Refused while money is held for them (they must claim it first), so nothing is ever stranded.
org.delete("/employees/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const sql = c.get("sql");
  const orgId = c.get("auth").accountId;
  const out = await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string; balance: bigint; status: string; employee_id: string }[]>`
      select id, balance, status, employee_id from employees where id = ${id.data} and org_account_id = ${orgId} for no key update`;
    if (!e || e.status !== "active") return { status: 404 as const };
    if (e.balance > 0n) return { status: 409 as const, balance: Number(e.balance) };
    await tx`update employees set status = 'removed', claim_token_hash = null where id = ${e.id}`;
    return { status: 204 as const, employee_id: e.employee_id };
  });
  if (out.status === 404) return c.json({ error: "not_found" }, 404);
  if (out.status === 409) return c.json({ error: "has_held_balance", held: out.balance }, 409);
  await customerLog(c, orgId, null, "org.employee_removed", { employee_id: out.employee_id });
  return c.body(null, 204);
});

// ---- Credit batches ----
org.post("/credit-batches", async (c) => {
  const key = c.req.header("idempotency-key")?.trim();
  if (!key || key.length > 128) return c.json({ error: "idempotency_key_required" }, 400);
  const parsed = batchBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.flatten() }, 400);
  const seen = new Set<string>();
  for (const r of parsed.data.rows) {
    if (seen.has(r.employee_id)) return c.json({ error: "duplicate_employee_id", employee_id: r.employee_id }, 422);
    seen.add(r.employee_id);
  }
  const sql = c.get("sql");
  const orgId = c.get("auth").accountId;
  const out = await runCreditBatch(sql, { orgId, idempotencyKey: key, rows: parsed.data.rows });
  if (out.kind === "error") return c.json({ error: out.error, ...(out.extra ?? {}) }, out.status);

  let emails = { sent: 0, failed: 0, not_configured: 0 };
  if (!out.replayed) {
    const [o] = await sql<{ name: string }[]>`select name from accounts where id = ${orgId}`;
    emails = await sendCreditEmails(c.env, sql, o?.name ?? "Your employer", out.notices);
    await customerLog(c, orgId, null, "org.credit_batch", { batch_id: out.batch.id, rows: out.batch.row_count, total: Number(out.batch.total), held: Number(out.batch.held) });
  }
  return c.json({ batch: batchJson(out.batch), emails }, out.replayed ? 200 : 201);
});

org.get("/credit-batches", async (c) => {
  const rows = await c.get("sql")<BatchRow[]>`
    select id, row_count, total, sent, held, created_at from credit_batches
     where org_account_id = ${c.get("auth").accountId} order by created_at desc, id desc limit 100`;
  return c.json({ batches: rows.map(batchJson) });
});

org.get("/credit-batches/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const sql = c.get("sql");
  const [b] = await sql<BatchRow[]>`
    select id, row_count, total, sent, held, created_at from credit_batches where id = ${id.data} and org_account_id = ${c.get("auth").accountId}`;
  if (!b) return c.json({ error: "not_found" }, 404);
  // Each row carries the employee's CURRENT claim state (not their state when the batch ran), so the organization can follow up.
  const rows = await sql<{ employee_id: string; name: string; email: string; amount: bigint; mode: string; transaction_id: string; claimed: boolean; balance: bigint; reminded_at: Date | null; removed: boolean }[]>`
    select e.employee_id, e.name, e.email, r.amount, r.mode, r.transaction_id,
           (e.employee_account_id is not null) as claimed, e.balance, e.reminded_at, (e.status = 'removed') as removed
      from credit_batch_rows r join employees e on e.id = r.employee_ref
     where r.batch_id = ${b.id} order by e.employee_id`;
  return c.json({
    batch: batchJson(b),
    summary: { claimed: rows.filter((r) => r.claimed).length, unclaimed: rows.filter((r) => !r.claimed).length, still_held: n(rows.reduce((t, r) => t + r.balance, 0n)) },
    rows: rows.map((r) => ({ ...r, amount: n(r.amount), balance: n(r.balance) })),
  });
});

/** An employee (any consumer account) claims held credit with the token from the email. */
export const employeeClaims = new Hono<AppContext>();
employeeClaims.use("*", requireSession, requireOwner);
employeeClaims.post("/", async (c) => {
  const parsed = z.object({ token: z.string().min(20).max(200) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const { accountId } = c.get("auth");
  const out = await claimCredit(c.get("sql"), { accountId, token: parsed.data.token });
  if (out.kind === "error") return c.json({ error: out.error }, out.status);
  await customerLog(c, accountId, null, "employee.claimed", { amount: Number(out.amount), organization: out.org_name });
  return c.json({ claimed: n(out.amount), organization: out.org_name });
});
