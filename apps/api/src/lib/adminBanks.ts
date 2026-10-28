import type { Sql } from "../db";
import { DEFAULT_PAGE, encodePair } from "./paging";
import { imageUrl } from "./images";
import { likePattern as like } from "./sqlText";

type Cursor = { ts: string; id: string } | null;

/** The Banks page (admin portal): every routing number we have seen, with what we know about it and how many live accounts use it. */
export async function bankList(sql: Sql, q: string | null, needsLogo: boolean, limit: number = DEFAULT_PAGE, cursor: Cursor = null) {
  // A bank "needs a logo" once somebody is actually using it.
  const inUse = sql`exists (select 1 from bank_accounts a where a.bank_id = b.id and a.status = 'active')`;
  const where = sql`true
    ${q ? sql`and (b.name ilike ${like(q)} or b.routing_number like ${q.replace(/\D/g, "") ? `${q.replace(/\D/g, "")}%` : "no-match"})` : sql``}
    ${needsLogo ? sql`and b.icon is null and ${inUse}` : sql``}`;
  const [cnt] = await sql<{ total: number }[]>`select count(*)::int as total from banks b where ${where}`;
  const [need] = await sql<{ n: number }[]>`select count(*)::int as n from banks b where b.icon is null and ${inUse}`;
  const rows = await sql<{
    id: string; routing_number: string; name: string | null; icon: string | null; instant: boolean | null; networks: string[];
    refreshed_at: Date | null; created_at: Date; accounts: number; ts_key: string;
  }[]>`
    select b.id, b.routing_number, b.name, b.icon, b.instant, b.networks, b.refreshed_at, b.created_at, b.created_at::text as ts_key,
           (select count(*) from bank_accounts a where a.bank_id = b.id and a.status = 'active')::int as accounts
      from banks b
     where ${where}
       ${cursor ? sql`and (b.created_at, b.id) < (${cursor.ts}::text::timestamptz, ${cursor.id}::uuid)` : sql``}
     order by b.created_at desc, b.id desc limit ${limit + 1}`;
  const page = rows.slice(0, limit), last = page[page.length - 1];
  return {
    banks: page.map(({ ts_key: _t, icon, ...r }) => ({ ...r, icon: imageUrl(icon) })),
    next_cursor: rows.length > limit && last ? encodePair(last.ts_key, last.id) : null,
    total: cnt!.total,
    needs_logo: need!.n,
  };
}
