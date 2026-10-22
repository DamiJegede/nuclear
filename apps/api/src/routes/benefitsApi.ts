import { track } from "../lib/tracker";
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { customerLog } from "../lib/audit";
import { n } from "../lib/money";
import { MAX_BATCH_ROWS, MAX_CREDIT, getEmployees, removeEmployees, runBenefitRun, upsertEmployees } from "../lib/org";
import { requireOrgKey } from "../lib/orgApiKey";
import { sendCreditEmails } from "../lib/orgMail";

/**
 * The Benefits API: an organization's own systems create, remove and credit employees with a bearer key (`nk_org_...`, generated in the
 * organization portal). Every endpoint takes an ARRAY, so one employee or a whole run is the same call, and each is all-or-nothing.
 * Amounts are integer cents. The key is the organization (no session, no browser): there is no CORS here.
 */
export const benefitsApi = new Hono<AppContext>();
benefitsApi.use("*", requireOrgKey);

const employeeId = z.string().trim().regex(/^[A-Za-z0-9]{1,64}$/);
const name = z.string().trim().min(1).max(120);
const email = z.string().trim().toLowerCase().email().max(254);
const cents = z.union([z.number().int(), z.string().regex(/^\d{1,12}$/)]).transform((v) => BigInt(v)).refine((v) => v > 0n && v <= MAX_CREDIT, { message: "amount_out_of_range" });

const noDuplicates = (rows: { employee_id: string }[]) => {
  const seen = new Set<string>();
  for (const r of rows) { if (seen.has(r.employee_id)) return r.employee_id; seen.add(r.employee_id); }
  return null;
};

// The organization's wallet: what is available to credit, and what is held for employees who have not claimed yet. Read only.
benefitsApi.get("/balance", async (c) => {
  const sql = c.get("sql");
  const { accountId } = c.get("orgKey");
  const [[b], [h]] = await Promise.all([
    sql<{ balance: bigint }[]>`select balance from balances where account_id = ${accountId}`,
    // held_for_unclaimed is ALL credit still held, including for removed employees (it is still theirs); employees counts the active ones.
    sql<{ held: bigint; employees: number }[]>`select coalesce(sum(balance), 0)::bigint as held, (count(*) filter (where status = 'active'))::int as employees from employees where org_account_id = ${accountId}`,
  ]);
  const avail = b && b.balance > 0n ? b.balance : 0n;
  return c.json({ currency: "USD", balance: n(avail), held_for_unclaimed: n(h!.held), employees: h!.employees });
});

// Create employees, or update the name and email of ones that exist. No money moves and nobody is emailed.
benefitsApi.post("/employees", async (c) => {
  const fixed = z.number().int().min(0).max(Number(MAX_CREDIT)).nullable().optional();   // omitted = unchanged; null or 0 clears
  const b = z.object({ employees: z.array(z.object({ employee_id: employeeId, name, email, fixed_benefit: fixed })).min(1).max(MAX_BATCH_ROWS) }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: "invalid_request", issues: b.error.flatten() }, 400);
  const dup = noDuplicates(b.data.employees);
  if (dup) return c.json({ error: "duplicate_employee_id", employee_id: dup }, 422);
  const { accountId } = c.get("orgKey");
  const results = await upsertEmployees(c.get("sql"), accountId, b.data.employees);
  await customerLog(c, accountId, null, "org.api_employees_saved", { count: results.length, via: "api" });
  return c.json({ employees: results });
});

// Look employees up by employee_id: an array in, an array back in the same order (unknown ids come back as found: false). Read only.
benefitsApi.post("/employees/get", async (c) => {
  const b = z.object({ employee_ids: z.array(employeeId).min(1).max(MAX_BATCH_ROWS) }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: "invalid_request", issues: b.error.flatten() }, 400);
  if (new Set(b.data.employee_ids).size !== b.data.employee_ids.length) return c.json({ error: "duplicate_employee_id" }, 422);
  return c.json({ employees: await getEmployees(c.get("sql"), c.get("orgKey").accountId, b.data.employee_ids) });
});

// Remove (hide) employees. All or none: an unknown id is a 404; removing someone twice is fine. Credit held for them stays theirs (`held` says how much).
benefitsApi.post("/employees/remove", async (c) => {
  const b = z.object({ employee_ids: z.array(employeeId).min(1).max(MAX_BATCH_ROWS) }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: "invalid_request", issues: b.error.flatten() }, 400);
  if (new Set(b.data.employee_ids).size !== b.data.employee_ids.length) return c.json({ error: "duplicate_employee_id" }, 422);
  const { accountId } = c.get("orgKey");
  const out = await removeEmployees(c.get("sql"), accountId, b.data.employee_ids);
  if (out.kind === "error") return c.json({ error: out.error, employee_ids: out.employee_ids }, out.status);
  await customerLog(c, accountId, null, "org.api_employees_removed", { count: out.results.length, via: "api" });
  return c.json({ employees: out.results });
});

// Credit benefits. All or nothing, safe to retry with the same Idempotency-Key. `name` and `email` are needed only for an employee the
// organization has not created or credited before. Employees who have not claimed are emailed a link; their credit is held for them.
benefitsApi.post("/credits", async (c) => {
  const key = c.req.header("idempotency-key")?.trim();
  if (!key || key.length > 128) return c.json({ error: "idempotency_key_required" }, 400);
  const b = z.object({ credits: z.array(z.object({ employee_id: employeeId, name: name.optional(), email: email.optional(), amount: cents })).min(1).max(MAX_BATCH_ROWS) }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: "invalid_request", issues: b.error.flatten() }, 400);
  const dup = noDuplicates(b.data.credits);
  if (dup) return c.json({ error: "duplicate_employee_id", employee_id: dup }, 422);
  const sql = c.get("sql");
  const { accountId } = c.get("orgKey");
  const out = await runBenefitRun(sql, { orgId: accountId, idempotencyKey: key, source: "api", rows: b.data.credits });
  if (out.kind === "error") return c.json({ error: out.error, ...(out.extra ?? {}) }, out.status);

  let emails = { sent: 0, failed: 0, not_configured: 0 };
  if (!out.replayed) {
    const [o] = await sql<{ name: string }[]>`select name from accounts where id = ${accountId}`;
    emails = await sendCreditEmails(c.env, sql, o?.name ?? "Your employer", out.notices);
    await customerLog(c, accountId, null, "org.benefit_run", { run_id: out.run.id, rows: out.run.row_count, total: Number(out.run.total), held: Number(out.run.held), via: "api" });
    track(c, { benefit_runs_n: 1, benefit_credited_v: Number(out.run.total), benefit_sent_v: Number(out.run.sent), benefit_held_v: Number(out.run.held) });   // today's running estimate
  }
  const rows = await sql<{ employee_id: string; amount: bigint; mode: string; transaction_id: string }[]>`
    select e.employee_id, r.amount, r.mode, r.transaction_id
      from benefit_run_rows r join employees e on e.id = r.employee_ref where r.run_id = ${out.run.id} order by e.employee_id`;
  const bt = out.run;
  return c.json({
    run: { id: bt.id, count: bt.row_count, total: n(bt.total), sent: n(bt.sent), held: n(bt.held), source: bt.source, status: bt.status, run_date: bt.run_date, created_at: bt.created_at },
    credits: rows.map((r) => ({ employee_id: r.employee_id, amount: n(r.amount), credited_as: r.mode === "sent" ? "benefits_wallet" : "held_until_claimed", transaction_id: r.transaction_id })),
    emails,
  }, out.replayed ? 200 : 201);
});
