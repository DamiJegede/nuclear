import type { Sql } from "../db";
import { DEFAULT_PAGE, encodePair } from "./paging";
import { imageUrl } from "./images";
import { likePattern as like } from "./sqlText";
import { textArray } from "./banks";

type Cursor = { ts: string; id: string } | null;

/** In use = at least one live bank account sits on one of the institution's routing numbers (or on this routing number). */
const instInUse = (sql: Sql) => sql`exists (select 1 from routing_numbers r join bank_accounts a on a.routing_number_id = r.id and a.status = 'active' where r.institution_id = i.id)`;
const rnInUse = (sql: Sql) => sql`exists (select 1 from bank_accounts a where a.routing_number_id = r.id and a.status = 'active')`;

/** What needs an admin: institutions in use without a logo, and routing numbers in use that no institution claims yet. */
export async function attention(sql: Sql) {
  const [a] = await sql<{ needs_logo: number; unlinked: number }[]>`
    select (select count(*) from institutions i where i.icon is null and ${instInUse(sql)})::int as needs_logo,
           (select count(*) from routing_numbers r where r.institution_id is null and ${rnInUse(sql)})::int as unlinked`;
  return a!;
}

/** The Institutions tab: Chase, Wells Fargo...: name, logo, website, the names the directory knows them by, and how many routing numbers and live accounts they have. */
export async function institutionList(sql: Sql, q: string | null, needsLogo: boolean, limit: number = DEFAULT_PAGE, cursor: Cursor = null) {
  const where = sql`true
    ${q ? sql`and (i.name ilike ${like(q)} or i.domain ilike ${like(q)})` : sql``}
    ${needsLogo ? sql`and i.icon is null and ${instInUse(sql)}` : sql``}`;
  const [cnt] = await sql<{ total: number }[]>`select count(*)::int as total from institutions i where ${where}`;
  const rows = await sql<{
    id: string; name: string; icon: string | null; domain: string | null; aliases: string[]; created_at: Date;
    routing_numbers: number; accounts: number; ts_key: string;
  }[]>`
    select i.id, i.name, i.icon, i.domain, i.aliases, i.created_at, i.created_at::text as ts_key,
           (select count(*) from routing_numbers r where r.institution_id = i.id)::int as routing_numbers,
           (select count(*) from routing_numbers r join bank_accounts a on a.routing_number_id = r.id and a.status = 'active' where r.institution_id = i.id)::int as accounts
      from institutions i
     where ${where}
       ${cursor ? sql`and (i.created_at, i.id) < (${cursor.ts}::text::timestamptz, ${cursor.id}::uuid)` : sql``}
     order by i.created_at desc, i.id desc limit ${limit + 1}`;
  const page = rows.slice(0, limit), last = page[page.length - 1];
  return {
    institutions: page.map(({ ts_key: _t, icon, aliases, ...r }) => ({ ...r, aliases: textArray(aliases), icon: imageUrl(icon) })),
    next_cursor: rows.length > limit && last ? encodePair(last.ts_key, last.id) : null,
    total: cnt!.total,
    ...(await attention(sql)),
  };
}

/** The Routing Numbers tab: every number we have seen, what the directory says about it, the institution it belongs to (if any) and its live accounts. */
export async function routingList(sql: Sql, q: string | null, unlinked: boolean, limit: number = DEFAULT_PAGE, cursor: Cursor = null) {
  const digits = q ? q.replace(/\D/g, "") : "";
  const where = sql`true
    ${q ? sql`and (r.directory_name ilike ${like(q)} or i.name ilike ${like(q)} ${digits ? sql`or r.routing_number like ${`${digits}%`}` : sql``})` : sql``}
    ${unlinked ? sql`and r.institution_id is null and ${rnInUse(sql)}` : sql``}`;
  const [cnt] = await sql<{ total: number }[]>`select count(*)::int as total from routing_numbers r left join institutions i on i.id = r.institution_id where ${where}`;
  const rows = await sql<{
    id: string; routing_number: string; directory_name: string | null; instant: boolean | null; networks: string[]; refreshed_at: Date | null;
    created_at: Date; institution_id: string | null; institution: string | null; icon: string | null; accounts: number; ts_key: string;
  }[]>`
    select r.id, r.routing_number, r.directory_name, r.instant, r.networks, r.refreshed_at, r.created_at, r.created_at::text as ts_key,
           r.institution_id, i.name as institution, i.icon,
           (select count(*) from bank_accounts a where a.routing_number_id = r.id and a.status = 'active')::int as accounts
      from routing_numbers r left join institutions i on i.id = r.institution_id
     where ${where}
       ${cursor ? sql`and (r.created_at, r.id) < (${cursor.ts}::text::timestamptz, ${cursor.id}::uuid)` : sql``}
     order by r.created_at desc, r.id desc limit ${limit + 1}`;
  const page = rows.slice(0, limit), last = page[page.length - 1];
  return {
    routing_numbers: page.map(({ ts_key: _t, icon, networks, ...r }) => ({ ...r, networks: textArray(networks), icon: imageUrl(icon) })),
    next_cursor: rows.length > limit && last ? encodePair(last.ts_key, last.id) : null,
    total: cnt!.total,
    ...(await attention(sql)),
  };
}
