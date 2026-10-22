import type { Sql } from "../db";
import { imageUrl } from "./images";
import { n } from "./money";
import { DEFAULT_PAGE, encodePair } from "./paging";

/** Read-only views of one organization (an employer, account type O) for the admin portal. Everything comes from existing tables. */

import { likePattern as like } from "./sqlText";

export async function organizationList(sql: Sql, q: string | null) {
  const rows = await sql<{
    id: string; name: string; email: string | null; status: string; created_at: Date; email_verified: boolean; balance: bigint;
    mode: string | null; chosen: boolean | null; employees: number; claimed: number; held: bigint; runs: number;
  }[]>`
    select a.id, coalesce(b.display_name, a.name) as name, a.email, a.status, a.created_at, (a.email_verified_at is not null) as email_verified,
           coalesce(bal.balance, 0) as balance, p.mode, (p.chosen_at is not null) as chosen,
           (select count(*) from employees e where e.org_account_id = a.id and e.status = 'active')::int as employees,
           (select count(*) from employees e where e.org_account_id = a.id and e.status = 'active' and e.employee_account_id is not null)::int as claimed,
           (select coalesce(sum(e.balance), 0) from employees e where e.org_account_id = a.id and e.employee_account_id is null) as held,
           (select count(*) from benefit_runs r where r.org_account_id = a.id)::int as runs
      from accounts a
      left join businesses b on b.account_id = a.id
      left join balances bal on bal.account_id = a.id
      left join benefit_programs p on p.org_account_id = a.id
     where a.type = 'O'
       ${q ? sql`and (coalesce(b.display_name, a.name) ilike ${like(q)} or a.name ilike ${like(q)} or a.email ilike ${like(q)})` : sql``}
     order by a.created_at desc, a.id desc
     limit 200`;
  return rows.map((r) => ({ ...r, balance: n(r.balance), held: n(r.held) }));
}

export async function organizationDetail(sql: Sql, id: string) {
  const [o] = await sql<{
    id: string; name: string; handle: string | null; email: string | null; email_verified_at: Date | null; phone: string | null; status: string;
    created_at: Date; photo: string | null; bio: string | null; balance: bigint | null;
    legal_name: string | null; display_name: string | null; address: string | null; city: string | null; state: string | null;
    post_code: string | null; country: string | null; website: string | null;
    mode: string | null; chosen_at: Date | null; cadence: string | null; day_of_month: number | null; weekday: number | null; next_run_date: string | null;
  }[]>`
    select a.id, a.name, a.handle, a.email, a.email_verified_at, a.phone, a.status, a.created_at, a.photo, a.bio, bal.balance,
           b.legal_name, b.display_name, b.address, b.city, b.state, b.post_code, b.country, b.website,
           p.mode, p.chosen_at, p.cadence, p.day_of_month, p.weekday, p.next_run_date::text
      from accounts a
      left join businesses b on b.account_id = a.id
      left join balances bal on bal.account_id = a.id
      left join benefit_programs p on p.org_account_id = a.id
     where a.id = ${id} and a.type = 'O'`;
  if (!o) return null;
  const [e] = await sql<{ total: number; claimed: number; unclaimed: number; removed: number; held: bigint; fixed_total: bigint }[]>`
    select count(*) filter (where status = 'active')::int as total,
           count(*) filter (where status = 'active' and employee_account_id is not null)::int as claimed,
           count(*) filter (where status = 'active' and employee_account_id is null)::int as unclaimed,
           count(*) filter (where status = 'removed')::int as removed,
           coalesce(sum(balance) filter (where employee_account_id is null), 0) as held,
           coalesce(sum(fixed_benefit) filter (where status = 'active'), 0) as fixed_total
      from employees where org_account_id = ${id}`;
  const [r] = await sql<{ runs: number; credited: bigint; last_run_at: Date | null }[]>`
    select count(*)::int as runs, coalesce(sum(total) filter (where status = 'credited'), 0) as credited, max(created_at) filter (where status = 'credited') as last_run_at
      from benefit_runs where org_account_id = ${id}`;
  const [k] = await sql<{ key_hint: string; created_at: Date; last_used_at: Date | null }[]>`
    select key_hint, created_at, last_used_at from api_keys where account_id = ${id} and revoked_at is null`;
  const [d] = await sql<{ n: number }[]>`select count(*)::int as n from uploads where account_id = ${id}`;
  return {
    id: o.id, name: o.display_name ?? o.name, legal_name: o.legal_name, handle: o.handle, status: o.status,
    email: o.email, email_verified: o.email_verified_at !== null, phone: o.phone, created_at: o.created_at, website: o.website,
    photo: imageUrl(o.photo), bio: o.bio,
    address: { line: o.address, city: o.city, state: o.state, post_code: o.post_code, country: o.country },
    balance: n(o.balance ?? 0n),
    program: {
      mode: o.mode ?? "flexible", chosen: o.chosen_at !== null, cadence: o.cadence, day_of_month: o.day_of_month, weekday: o.weekday,
      next_run_date: o.next_run_date, fixed_total: n(e!.fixed_total),
    },
    employees: { total: e!.total, claimed: e!.claimed, unclaimed: e!.unclaimed, removed: e!.removed, held: n(e!.held) },
    runs: { count: r!.runs, credited: n(r!.credited), last_run_at: r!.last_run_at },
    api_key: k ? { hint: k.key_hint, created_at: k.created_at, last_used_at: k.last_used_at } : null,
    documents: d!.n,
  };
}

/** The organization's people. Claim tokens, employee account ids and anything secret are never returned. */
export async function organizationEmployees(sql: Sql, id: string, q: string | null, limit: number = DEFAULT_PAGE, cursor: { ts: string; id: string } | null = null) {
  const filters = sql`${q ? sql`and (name ilike ${like(q)} or email ilike ${like(q)} or employee_id ilike ${like(q)})` : sql``}`;
  const [cnt] = await sql<{ total: number }[]>`select count(*)::int as total from employees where org_account_id = ${id} ${filters}`;
  const total = cnt!.total;
  const rows = await sql<{
    id: string; employee_id: string; name: string; email: string; status: string; claimed: boolean; balance: bigint; fixed_benefit: bigint | null;
    reminded_at: Date | null; created_at: Date; ts_key: string;
  }[]>`
    select id, employee_id, name, email, status, (employee_account_id is not null) as claimed, balance, fixed_benefit, reminded_at, created_at, created_at::text as ts_key
      from employees where org_account_id = ${id} ${filters}
       ${cursor ? sql`and (created_at, id) < (${cursor.ts}::text::timestamptz, ${cursor.id}::uuid)` : sql``}
     order by created_at desc, id desc limit ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    employees: page.map(({ ts_key: _t, ...r }) => ({ ...r, balance: n(r.balance), fixed_benefit: r.fixed_benefit === null ? null : n(r.fixed_benefit) })),
    next_cursor: rows.length > limit && last ? encodePair(last.ts_key, last.id) : null,
    total,
  };
}

export async function organizationRuns(sql: Sql, id: string) {
  const rows = await sql<{
    id: string; source: string; run_date: string; status: string; row_count: number; total: bigint; sent: bigint; held: bigint; failure_code: string | null; created_at: Date;
  }[]>`
    select id, source, run_date::text, status, row_count, total, sent, held, failure_code, created_at
      from benefit_runs where org_account_id = ${id} order by created_at desc, id desc limit 100`;
  return rows.map((r) => ({ ...r, total: n(r.total), sent: n(r.sent), held: n(r.held) }));
}
