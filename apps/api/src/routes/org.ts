import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { customerLog } from "../lib/audit";
import { n } from "../lib/money";
import { profileBody, profileJson, type ProfileRow } from "./business";
import { MAX_BATCH_ROWS, MAX_CREDIT, claimCredit, runBenefitRun } from "../lib/org";
import { sendCreditEmails } from "../lib/orgMail";
import { keyStatus, revokeKey, rotateKey } from "../lib/orgApiKey";
import { fixedTotals, getProgram, setProgram, type ProgramInput } from "../lib/programs";
import { easternDate } from "../lib/dailyReset";
import { bulkEmployees, upsertEmployees } from "../lib/org";
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
const runBody = z.object({ rows: z.array(creditRow).min(1).max(MAX_BATCH_ROWS) });

type RunRow = { id: string; row_count: number; total: bigint; sent: bigint; held: bigint; source: string; status: string; run_date: string; created_at: Date };
const RUN_COLS = "id, row_count, total, sent, held, source, status, run_date::text as run_date, created_at";
const runJson = (b: RunRow) => ({ id: b.id, rows: b.row_count, total: n(b.total), sent: n(b.sent), held: n(b.held), source: b.source, status: b.status, run_date: b.run_date, created_at: b.created_at });

// ---- Overview ----
org.get("/overview", async (c) => {
  const sql = c.get("sql");
  const id = c.get("auth").accountId;
  const [bal, emp, last] = await Promise.all([
    sql<{ balance: bigint }[]>`select balance from balances where account_id = ${id}`,
    // Counts are for active employees; `held` is ALL credit still held, including for employees who were removed (it is still theirs).
    sql<{ total: number; claimed: number; unclaimed: number; held: bigint }[]>`
      select (count(*) filter (where status = 'active'))::int as total,
             (count(*) filter (where status = 'active' and employee_account_id is not null))::int as claimed,
             (count(*) filter (where status = 'active' and employee_account_id is null))::int as unclaimed, coalesce(sum(balance), 0) as held
        from employees where org_account_id = ${id}`,
    sql<RunRow[]>`select ${sql.unsafe(RUN_COLS)} from benefit_runs where org_account_id = ${id} order by created_at desc, id desc limit 1`,
  ]);
  const e = emp[0]!;
  return c.json({
    balance: n(bal[0]?.balance ?? 0n),
    employees: { total: e.total, claimed: e.claimed, unclaimed: e.unclaimed },
    held: n(e.held),
    last_run: last[0] ? runJson(last[0]) : null,
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

// ---- The Benefits API key (see routes/benefitsApi.ts): one live key, shown once when generated ----
org.get("/api-key", async (c) => c.json({ key: await keyStatus(c.get("sql"), c.get("auth").accountId) }));

org.post("/api-key", async (c) => {
  const { accountId } = c.get("auth");
  const k = await rotateKey(c.get("sql"), accountId);
  await customerLog(c, accountId, null, "org.api_key_generated", { hint: k.hint });
  return c.json({ key: { hint: k.hint, name: "Default", created_at: k.created_at, last_used_at: null }, token: k.key }, 201);
});

org.delete("/api-key", async (c) => {
  const { accountId } = c.get("auth");
  const had = await revokeKey(c.get("sql"), accountId);
  if (had) await customerLog(c, accountId, null, "org.api_key_revoked", {});
  return c.body(null, 204);
});

// ---- Employees ----
org.get("/employees", async (c) => {
  const sql = c.get("sql");
  const id = c.get("auth").accountId;
  const q = (c.req.query("q") ?? "").trim().slice(0, 80);
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const status = c.req.query("status");
  if (status && !["claimed", "unclaimed"].includes(status)) return c.json({ error: "invalid_request" }, 400);
  const rows = await sql<{ id: string; employee_id: string; name: string; email: string; balance: bigint; claimed: boolean; reminded_at: Date | null; created_at: Date; benefits_wallet_id: string | null; fixed_benefit: bigint | null }[]>`
    select e.id, e.employee_id, e.name, e.email, e.balance, (e.employee_account_id is not null) as claimed, e.reminded_at, e.created_at,
           e.fixed_benefit, (select w.id from wallets w where w.account_id = e.employee_account_id and w.org_account_id = e.org_account_id and w.type = 'benefits' and w.status <> 'closed') as benefits_wallet_id
      from employees e
     where e.org_account_id = ${id} and e.status = 'active'
       ${q ? sql`and (e.name ilike ${like} or e.email ilike ${like} or e.employee_id ilike ${like})` : sql``}
       ${status === "claimed" ? sql`and e.employee_account_id is not null` : status === "unclaimed" ? sql`and e.employee_account_id is null` : sql``}
     order by e.created_at desc, e.id desc limit 500`;
  return c.json({ employees: rows.map((r) => ({ ...r, balance: n(r.balance), fixed_benefit: n(r.fixed_benefit) })) });
});

// ---- The benefit program: Fixed Benefits (a schedule) or Flexible Benefits (credit when you choose) ----
const programBody = z.union([
  z.object({ mode: z.literal("flexible") }),
  z.object({ mode: z.literal("fixed"), cadence: z.literal("monthly"), day_of_month: z.number().int().min(1).max(28) }),
  z.object({ mode: z.literal("fixed"), cadence: z.enum(["weekly", "biweekly"]), weekday: z.number().int().min(0).max(6) }),
]);

async function programAnswer(c: { get: (k: "sql") => import("../db").Sql }, orgId: string) {
  const sql = c.get("sql");
  const [p, f, [b]] = await Promise.all([getProgram(sql, orgId), fixedTotals(sql, orgId), sql<{ balance: bigint }[]>`select balance from balances where account_id = ${orgId}`]);
  const bal = b && b.balance > 0n ? b.balance : 0n;
  return {
    program: {
      mode: p.mode, chosen: p.chosen_at !== null, cadence: p.cadence, day_of_month: p.day_of_month, weekday: p.weekday, start_date: p.start_date, next_run_date: p.next_run_date,
      fixed: { employees: f.employees, total: n(f.total) }, balance: n(bal), funded: f.total <= bal,
    },
  };
}

org.get("/program", async (c) => c.json(await programAnswer(c, c.get("auth").accountId)));

org.put("/program", async (c) => {
  const b = programBody.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: "invalid_request", issues: b.error.flatten() }, 400);
  const { accountId } = c.get("auth");
  await setProgram(c.get("sql"), accountId, b.data as ProgramInput, easternDate(new Date()));
  await customerLog(c, accountId, null, "org.program_set", b.data as Record<string, unknown>);
  return c.json(await programAnswer(c, accountId));
});

// Set (or clear) fixed benefits for employees from a file: creates new employees, updates names and emails, sets fixed_benefit (0 or null clears). All or nothing.
const fixedRow = z.object({
  employee_id: z.string().trim().regex(/^[A-Za-z0-9]{1,64}$/),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  fixed_benefit: z.union([z.number().int(), z.string().regex(/^\d{1,12}$/)]).transform((v) => Number(v)).refine((v) => v >= 0 && v <= Number(MAX_CREDIT), { message: "amount_out_of_range" }),
});
org.post("/fixed-benefits", async (c) => {
  const b = z.object({ rows: z.array(fixedRow).min(1).max(MAX_BATCH_ROWS) }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: "invalid_request", issues: b.error.flatten() }, 400);
  const seen = new Set<string>();
  for (const r of b.data.rows) { if (seen.has(r.employee_id)) return c.json({ error: "duplicate_employee_id", employee_id: r.employee_id }, 422); seen.add(r.employee_id); }
  const { accountId } = c.get("auth");
  const results = await upsertEmployees(c.get("sql"), accountId, b.data.rows);
  await customerLog(c, accountId, null, "org.fixed_benefits_set", { count: results.length, via: "portal" });
  return c.json({ employees: results, fixed: await fixedTotals(c.get("sql"), accountId).then((f) => ({ employees: f.employees, total: n(f.total) })) });
});

// Mass edit: one action on many employees (their row ids) at once, all or nothing. Remove, set a fixed benefit, or clear it.
const bulkIds = z.array(z.string().uuid()).min(1).max(MAX_BATCH_ROWS);
const bulkBody = z.union([
  z.object({ ids: bulkIds, action: z.literal("remove") }),
  z.object({ ids: bulkIds, action: z.literal("clear_fixed") }),
  z.object({ ids: bulkIds, action: z.literal("set_fixed"), amount: z.number().int().min(1).max(Number(MAX_CREDIT)) }),
]);
org.post("/employees/bulk", async (c) => {
  const b = bulkBody.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: "invalid_request", issues: b.error.flatten() }, 400);
  if (new Set(b.data.ids).size !== b.data.ids.length) return c.json({ error: "duplicate_id" }, 422);
  const { accountId } = c.get("auth");
  const op = b.data.action === "set_fixed" ? { action: "set_fixed" as const, amount: b.data.amount } : { action: b.data.action };
  const out = await bulkEmployees(c.get("sql"), accountId, b.data.ids, op);
  if (out.kind === "error") return c.json({ error: out.error, ids: out.ids }, out.status);
  await customerLog(c, accountId, null, "org.employees_bulk", { action: b.data.action, count: out.count, ...(b.data.action === "set_fixed" ? { amount: b.data.amount } : {}) });
  return c.json({ action: b.data.action, count: out.count, ...(b.data.action === "remove" ? { held_total: out.held_total } : {}) });
});

// One employee's fixed benefit (null or 0 clears it).
org.patch("/employees/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  const b = z.object({ fixed_benefit: z.number().int().min(0).max(Number(MAX_CREDIT)).nullable() }).safeParse(await c.req.json().catch(() => null));
  if (!id.success || !b.success) return c.json({ error: id.success ? "invalid_request" : "not_found" }, id.success ? 400 : 404);
  const { accountId } = c.get("auth");
  const v = b.data.fixed_benefit && b.data.fixed_benefit > 0 ? b.data.fixed_benefit : null;
  const rows = await c.get("sql")`update employees set fixed_benefit = ${v} where id = ${id.data} and org_account_id = ${accountId} and status = 'active' returning id, fixed_benefit`;
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  await customerLog(c, accountId, null, "org.fixed_benefit_set", { employee: id.data, amount: v });
  return c.json({ id: id.data, fixed_benefit: n(rows[0].fixed_benefit) });
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
    await tx`update employees set status = 'removed' where id = ${e.id}`;          // hides them; credit held for them stays theirs
    return { status: 204 as const, employee_id: e.employee_id, held: Number(e.balance) };
  });
  if (out.status === 404) return c.json({ error: "not_found" }, 404);
  await customerLog(c, orgId, null, "org.employee_removed", { employee_id: out.employee_id, held: out.held });
  return c.body(null, 204);
});

// ---- Benefit runs: every credit run, whoever started it (this portal's CSV, the Benefits API, later the scheduler) ----
org.post("/benefit-runs", async (c) => {
  const key = c.req.header("idempotency-key")?.trim();
  if (!key || key.length > 128) return c.json({ error: "idempotency_key_required" }, 400);
  const parsed = runBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.flatten() }, 400);
  const seen = new Set<string>();
  for (const r of parsed.data.rows) {
    if (seen.has(r.employee_id)) return c.json({ error: "duplicate_employee_id", employee_id: r.employee_id }, 422);
    seen.add(r.employee_id);
  }
  const sql = c.get("sql");
  const orgId = c.get("auth").accountId;
  const out = await runBenefitRun(sql, { orgId, idempotencyKey: key, source: "csv", rows: parsed.data.rows });
  if (out.kind === "error") return c.json({ error: out.error, ...(out.extra ?? {}) }, out.status);

  let emails = { sent: 0, failed: 0, not_configured: 0 };
  if (!out.replayed) {
    const [o] = await sql<{ name: string }[]>`select name from accounts where id = ${orgId}`;
    emails = await sendCreditEmails(c.env, sql, o?.name ?? "Your employer", out.notices);
    await customerLog(c, orgId, null, "org.benefit_run", { run_id: out.run.id, rows: out.run.row_count, total: Number(out.run.total), held: Number(out.run.held), via: "csv" });
  }
  return c.json({ run: runJson(out.run as RunRow), emails }, out.replayed ? 200 : 201);
});

org.get("/benefit-runs", async (c) => {
  const sql = c.get("sql");
  const rows = await sql<RunRow[]>`
    select ${sql.unsafe(RUN_COLS)} from benefit_runs
     where org_account_id = ${c.get("auth").accountId} order by created_at desc, id desc limit 100`;
  return c.json({ runs: rows.map(runJson) });
});

org.get("/benefit-runs/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const sql = c.get("sql");
  const [b] = await sql<RunRow[]>`
    select ${sql.unsafe(RUN_COLS)} from benefit_runs where id = ${id.data} and org_account_id = ${c.get("auth").accountId}`;
  if (!b) return c.json({ error: "not_found" }, 404);
  // Each row carries the employee's CURRENT claim state (not their state when the run happened), so the organization can follow up.
  const rows = await sql<{ employee_id: string; name: string; email: string; amount: bigint; mode: string; transaction_id: string; claimed: boolean; balance: bigint; reminded_at: Date | null; removed: boolean }[]>`
    select e.employee_id, e.name, e.email, r.amount, r.mode, r.transaction_id,
           (e.employee_account_id is not null) as claimed, e.balance, e.reminded_at, (e.status = 'removed') as removed
      from benefit_run_rows r join employees e on e.id = r.employee_ref
     where r.run_id = ${b.id} order by e.employee_id`;
  return c.json({
    run: runJson(b),
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
  return c.json({ claimed: n(out.amount), organization: out.org_name, wallet: { id: out.wallet.id, display_name: out.wallet.display_name, type: "benefits", balance: n(out.wallet.balance) } });
});
