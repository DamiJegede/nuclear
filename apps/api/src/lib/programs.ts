import type { Sql } from "../db";
import type { Env } from "../env";
import { lowFundsEmail, runMissedEmail, sendMail } from "./email";
import { easternDate } from "./dailyReset";
import { runBenefitRun } from "./org";
import { sendCreditEmails } from "./orgMail";

/**
 * Benefit programs (docs/ORGANIZATIONS.md). Fixed Benefits: on each payment date the scheduler credits every active employee that has a
 * fixed_benefit, as one benefit run (source schedule, key `program:<date>`), with the same engine as the CSV and the API. Flexible Benefits:
 * nothing is scheduled. Dates are America/New_York program days as YYYY-MM-DD.
 */

export type Cadence = "monthly" | "weekly" | "biweekly";
export type Schedule = { cadence: Cadence; day_of_month: number | null; weekday: number | null; start_date: string | null };

/** How many days a payment is retried after its date (the date itself, then two more), and the warning lead time. */
export const RETRY_DAYS = 3;
export const WARN_DAYS = 3;

const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => fmt(new Date(toDate(s).getTime() + n * 86_400_000));
export const weekdayOf = (s: string) => toDate(s).getUTCDay();
export const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);

/** The first date strictly after `today` that falls on `weekday` (0 = Sunday). */
export function nextWeekday(weekday: number, today: string): string {
  let d = addDays(today, 1);
  while (weekdayOf(d) !== weekday) d = addDays(d, 1);
  return d;
}

/** The next payment date strictly after `after`. Monthly days are 1 to 28, so every month has them. */
export function nextRunAfter(s: Schedule, after: string): string {
  if (s.cadence === "monthly") {
    const day = String(s.day_of_month!).padStart(2, "0");
    const [y, m] = after.split("-").map(Number) as [number, number];
    const here = `${y}-${String(m).padStart(2, "0")}-${day}`;
    if (here > after) return here;
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    return `${ny}-${String(nm).padStart(2, "0")}-${day}`;
  }
  if (s.cadence === "weekly") return nextWeekday(s.weekday!, after);
  const anchor = s.start_date!;                                   // biweekly: every 14 days from the first payment date
  if (after < anchor) return anchor;
  return addDays(anchor, 14 * (Math.floor(daysBetween(anchor, after) / 14) + 1));
}

export type ProgramRow = {
  org_account_id: string; mode: "fixed" | "flexible"; cadence: Cadence | null; day_of_month: number | null; weekday: number | null;
  start_date: string | null; next_run_date: string | null; warned_for: string | null; chosen_at: Date | null;
};
const P_COLS = `org_account_id, mode, cadence, day_of_month, weekday, start_date::text as start_date, next_run_date::text as next_run_date, warned_for::text as warned_for, chosen_at`;

export async function getProgram(sql: Sql, orgId: string): Promise<ProgramRow> {
  const [p] = await sql<ProgramRow[]>`select ${sql.unsafe(P_COLS)} from benefit_programs where org_account_id = ${orgId}`;
  if (p) return p;
  // An organization created before programs existed (or any gap): create its row now, Flexible and not chosen.
  const [made] = await sql<ProgramRow[]>`insert into benefit_programs (org_account_id) values (${orgId}) on conflict (org_account_id) do update set org_account_id = excluded.org_account_id returning ${sql.unsafe(P_COLS)}`;
  return made!;
}

/** What the next fixed payment would be: how many employees have a fixed benefit and what they add up to. */
export async function fixedTotals(sql: Sql, orgId: string): Promise<{ employees: number; total: bigint }> {
  const [r] = await sql<{ n: number; total: bigint }[]>`
    select count(*)::int as n, coalesce(sum(fixed_benefit), 0)::bigint as total from employees where org_account_id = ${orgId} and status = 'active' and fixed_benefit is not null`;
  return { employees: r!.n, total: r!.total };
}

export type ProgramInput =
  | { mode: "flexible" }
  | { mode: "fixed"; cadence: "monthly"; day_of_month: number }
  | { mode: "fixed"; cadence: "weekly" | "biweekly"; weekday: number };

/** Chooses or changes the program. Fixed starts with the first payment date after today. Anything waiting under the old schedule is closed. */
export async function setProgram(sql: Sql, orgId: string, input: ProgramInput, today: string): Promise<ProgramRow> {
  return sql.begin(async (tx) => {
    await tx`insert into benefit_programs (org_account_id) values (${orgId}) on conflict (org_account_id) do nothing`;
    await tx`select 1 from benefit_programs where org_account_id = ${orgId} for no key update`;
    await tx`update benefit_runs set status = 'missed', failure_code = 'schedule_changed' where org_account_id = ${orgId} and source = 'schedule' and status = 'waiting_for_funds'`;
    if (input.mode === "flexible") {
      await tx`update benefit_programs set mode = 'flexible', cadence = null, day_of_month = null, weekday = null, start_date = null, next_run_date = null, warned_for = null, chosen_at = coalesce(chosen_at, now()) where org_account_id = ${orgId}`;
    } else {
      const day = input.cadence === "monthly" ? input.day_of_month : null;
      const wd = input.cadence === "monthly" ? null : input.weekday;
      const start = input.cadence === "biweekly" ? nextWeekday(wd!, today) : null;
      const next = nextRunAfter({ cadence: input.cadence, day_of_month: day, weekday: wd, start_date: start }, today);
      await tx`update benefit_programs set mode = 'fixed', cadence = ${input.cadence}, day_of_month = ${day}, weekday = ${wd}, start_date = ${start}, next_run_date = ${next}, warned_for = null, chosen_at = coalesce(chosen_at, now()) where org_account_id = ${orgId}`;
    }
    const [p] = await tx<ProgramRow[]>`select ${tx.unsafe(P_COLS)} from benefit_programs where org_account_id = ${orgId}`;
    return p!;
  });
}

type Due = { org_account_id: string } & ProgramRow;

/**
 * The scheduler (the daily cron calls it). `today` is the New York program date. For every Fixed program:
 *  - a few days before the payment date, if the wallet cannot cover the payment, email the organization once;
 *  - on the payment date (and the next two days if it could not be made) credit every active employee that has a fixed benefit as one run;
 *    a payment the wallet cannot cover is recorded as waiting_for_funds and retried, and after the third try it is missed (nothing is
 *    credited, the organization is emailed) and the program moves on to its next date.
 * Safe to run twice and from two crons: a program is claimed for half an hour, and a run is unique per (organization, date).
 */
export async function runDuePrograms(env: Env, sql: Sql, today: string = easternDate(new Date())) {
  const out = { warned: 0, credited: 0, waiting: 0, missed: 0, skipped: 0 };

  // 1. Warn ahead.
  const soon = await sql<Due[]>`
    select ${sql.unsafe(P_COLS)} from benefit_programs
     where mode = 'fixed' and next_run_date > ${today}::date and next_run_date <= ${addDays(today, WARN_DAYS)}::date and warned_for is distinct from next_run_date`;
  for (const p of soon) {
    const f = await fixedTotals(sql, p.org_account_id);
    const [o] = await sql<{ name: string; email: string | null; balance: bigint }[]>`select a.name, a.email, b.balance from accounts a join balances b on b.account_id = a.id where a.id = ${p.org_account_id}`;
    if (f.total > 0n && o && o.balance < f.total && o.email) {
      await sendMail(env, { to: o.email, ...lowFundsEmail(o.name, p.next_run_date!, f.total, o.balance < 0n ? 0n : o.balance) });
      out.warned += 1;
    }
    await sql`update benefit_programs set warned_for = next_run_date where org_account_id = ${p.org_account_id}`;
  }

  // 2. Run what is due.
  const due = await sql<Due[]>`
    select ${sql.unsafe(P_COLS)} from benefit_programs where mode = 'fixed' and next_run_date <= ${today}::date order by next_run_date, org_account_id limit 100`;
  for (const p of due) {
    const claimed = await sql`
      update benefit_programs set last_attempt_at = now()
       where org_account_id = ${p.org_account_id} and next_run_date = ${p.next_run_date}::date and (last_attempt_at is null or last_attempt_at < now() - interval '30 minutes')
      returning org_account_id`;
    if (claimed.length === 0) { out.skipped += 1; continue; }
    const r = await processProgram(env, sql, p, today);
    out[r] += 1;
  }
  return out;
}

async function processProgram(env: Env, sql: Sql, p: Due, today: string): Promise<"credited" | "waiting" | "missed" | "skipped"> {
  const orgId = p.org_account_id;
  const date = p.next_run_date!;
  const key = `program:${date}`;
  const advance = async () => {
    const next = nextRunAfter({ cadence: p.cadence!, day_of_month: p.day_of_month, weekday: p.weekday, start_date: p.start_date }, today > date ? today : date);
    await sql`update benefit_programs set next_run_date = ${next}::date, warned_for = null where org_account_id = ${orgId}`;
  };
  const [prior] = await sql<{ id: string; status: string; attempts: number }[]>`select id, status, attempts from benefit_runs where org_account_id = ${orgId} and idempotency_key = ${key}`;
  if (prior && prior.status !== "waiting_for_funds") { await advance(); return "skipped"; }   // already done (credited or missed)

  const rows = await sql<{ employee_id: string; amount: bigint }[]>`
    select employee_id, fixed_benefit as amount from employees where org_account_id = ${orgId} and status = 'active' and fixed_benefit is not null order by employee_id`;
  if (rows.length === 0) { await advance(); return "skipped"; }
  const total = rows.reduce((s, r) => s + r.amount, 0n);
  const [o] = await sql<{ name: string; email: string | null }[]>`select name, email from accounts where id = ${orgId}`;

  const late = daysBetween(date, today);
  const attempts = (prior?.attempts ?? 0) + 1;
  const record = (status: "waiting_for_funds" | "missed", code: string) => sql`
    insert into benefit_runs (org_account_id, source, run_date, status, idempotency_key, row_count, total, failure_code, attempts)
    values (${orgId}, 'schedule', ${date}::date, ${status}, ${key}, ${rows.length}, ${total.toString()}, ${code}, ${attempts})
    on conflict (org_account_id, idempotency_key) do update set status = excluded.status, failure_code = excluded.failure_code, attempts = excluded.attempts, row_count = excluded.row_count, total = excluded.total`;
  const miss = async (code: string): Promise<"missed"> => {
    await record("missed", code);
    if (o?.email) await sendMail(env, { to: o.email, ...runMissedEmail(o.name, date, total, code === "insufficient_balance" ? "the wallet could not cover it" : code.replace(/_/g, " ")) });
    await advance();
    return "missed";
  };
  if (late >= RETRY_DAYS) return miss(prior ? "retries_over" : "late");

  const res = await runBenefitRun(sql, { orgId, idempotencyKey: key, source: "schedule", runDate: date, notify: "unnotified", rows: rows.map((r) => ({ employee_id: r.employee_id, amount: r.amount })) });
  if (res.kind === "ok") {
    await sendCreditEmails(env, sql, o?.name ?? "Your employer", res.notices);
    await advance();
    return "credited";
  }
  const retryable = res.error === "insufficient_balance" || res.error === "recipient_unavailable" || res.error === "organization_unavailable";
  if (!retryable) return miss(res.error);
  if (attempts >= RETRY_DAYS) return miss(res.error);
  await record("waiting_for_funds", res.error);
  return "waiting";
}
