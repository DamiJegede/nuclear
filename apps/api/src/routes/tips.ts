import { Hono } from "hono";
import { z } from "zod";
import { uuid } from "../lib/validate";
import { n } from "../lib/money";
import { decodeTimeCursor, encodePair, pageLimit } from "../lib/paging";
import { PROGRAM_TZ } from "../lib/dates";
import type { AppContext } from "../env";
import { requireOwner, requireSession } from "../session";

/**
 * Tips (docs/TABLES.md, "tips"). Nuclear records who a tip belongs to and shows it; it never pays staff. A person sees only their own tips; a business
 * (its owner) and its staff with the `write` role see everyone's. A consumer signs in as themselves and names the business (`business`).
 */
export const tips = new Hono<AppContext>();
tips.use("*", requireSession, requireOwner);

// The businesses a person works for, with their role: what the staff view starts from.
tips.get("/employers", async (c) => {
  const rows = await c.get("sql")<{ business_id: string; name: string; photo: string | null; role: string }[]>`
    select s.account_id as business_id, coalesce(b.display_name, a.name) as name, a.photo, s.role
      from staff s join accounts a on a.id = s.account_id left join businesses b on b.account_id = a.id
     where s.staff_account_id = ${c.get("auth").accountId} order by name, s.account_id`;
  return c.json({ employers: rows.map((r) => ({ business_id: r.business_id, name: r.name, role: r.role })) });
});

const query = z.object({
  business: uuid.optional(),
  staff: uuid.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  cursor: z.string().optional(),
  limit: pageLimit,
}).refine((q) => [q.from, q.to].every((d) => d === undefined || (!Number.isNaN(Date.parse(d)) && new Date(d).toISOString().startsWith(d))), { message: "invalid_date" })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, { message: "from_after_to" });

type Row = { id: string; amount: bigint; created_at: Date; ts_key: string; transaction_id: string; staff_account_id: string; staff_name: string; kind: string; reference: string | null };

tips.get("/", async (c) => {
  const q = query.safeParse(c.req.query());
  if (!q.success) return c.json({ error: "invalid_request" }, 400);
  const cursor = decodeTimeCursor(q.data.cursor);
  if (cursor === "invalid") return c.json({ error: "invalid_request" }, 400);
  const sql = c.get("sql");
  const me = c.get("auth").accountId;
  const [acct] = await sql<{ type: string }[]>`select type from accounts where id = ${me}`;

  // Who is asking, for which business, and whose tips they may see.
  let business: string, role: "owner" | "write" | "read", only: string | null = null;
  if (acct?.type === "B") {
    business = me; role = "owner";
    if (q.data.business && q.data.business !== me) return c.json({ error: "not_found" }, 404);
  } else {
    if (!q.data.business) return c.json({ error: "business_required" }, 400);
    const [s] = await sql<{ role: string }[]>`select role from staff where account_id = ${q.data.business} and staff_account_id = ${me}`;
    if (!s) return c.json({ error: "not_staff" }, 404);
    business = q.data.business; role = s.role === "write" ? "write" : "read";
  }
  if (role === "read") {
    if (q.data.staff && q.data.staff !== me) return c.json({ error: "forbidden" }, 403);
    only = me;
  } else if (q.data.staff) only = q.data.staff;

  const scope = sql`t.account_id = ${business}
    ${only ? sql`and t.staff_account_id = ${only}` : sql``}
    ${q.data.from ? sql`and t.created_at >= (${q.data.from}::text::date)::timestamp at time zone ${PROGRAM_TZ}` : sql``}
    ${q.data.to ? sql`and t.created_at < ((${q.data.to}::text::date + 1)::timestamp at time zone ${PROGRAM_TZ})` : sql``}`;

  const [totals, byStaff, byDay, rows, [biz]] = await Promise.all([
    sql<{ total: bigint; n: number }[]>`select coalesce(sum(t.amount), 0) as total, count(*)::int as n from tips t where ${scope}`,
    sql<{ staff_account_id: string; name: string; total: bigint }[]>`
      select t.staff_account_id, a.name, sum(t.amount) as total from tips t join accounts a on a.id = t.staff_account_id
       where ${scope} group by t.staff_account_id, a.name order by sum(t.amount) desc, a.name, t.staff_account_id`,
    // per program day (New York), newest first; a very long period returns the latest 366 days
    sql<{ day: string; total: bigint; n: number }[]>`
      select (t.created_at at time zone ${PROGRAM_TZ})::date::text as day, sum(t.amount) as total, count(*)::int as n
        from tips t where ${scope} group by 1 order by 1 desc limit 366`,
    sql<Row[]>`
      select t.id, t.amount, t.created_at, to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ts_key, t.transaction_id,
             t.staff_account_id, a.name as staff_name, x.type as kind, x.reference
        from tips t join accounts a on a.id = t.staff_account_id join transactions x on x.id = t.transaction_id
       where ${scope}
         ${cursor ? sql`and (t.created_at, t.id) < (${cursor.ts}::text::timestamptz, ${cursor.id}::uuid)` : sql``}
       order by t.created_at desc, t.id desc limit ${q.data.limit + 1}`,
    sql<{ name: string }[]>`select coalesce(b.display_name, a.name) as name from accounts a left join businesses b on b.account_id = a.id where a.id = ${business}`,
  ]);
  const page = rows.slice(0, q.data.limit);
  const more = rows.length > q.data.limit;
  const last = page[page.length - 1];
  return c.json({
    business: { id: business, name: biz?.name ?? "" },
    role,
    period: { from: q.data.from ?? null, to: q.data.to ?? null },
    total: n(totals[0]!.total), count: totals[0]!.n,
    days: byDay.map((d) => ({ date: d.day, total: n(d.total), count: d.n })),
    staff: byStaff.map((s) => ({ staff_account_id: s.staff_account_id, name: s.name, total: n(s.total) })),
    tips: page.map((r) => ({
      id: r.id, amount: n(r.amount), created_at: r.created_at, transaction_id: r.transaction_id, kind: r.kind === "refund" ? "refund" : "tip",
      staff_account_id: r.staff_account_id, staff_name: r.staff_name, reference: r.reference,
    })),
    next_cursor: more && last ? encodePair(last.ts_key, last.id) : null,
  });
});
