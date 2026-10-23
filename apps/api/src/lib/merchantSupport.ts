import type { Sql } from "../db";
import { imageUrl } from "./images";
import { PROGRAM_TZ } from "./dates";
import { n } from "./money";
import { DEFAULT_PAGE, encodePair } from "./paging";
import { party, type DayRange } from "./adminLists";

/** Read-only views of one merchant for the support team. Everything comes from existing tables. */

export async function merchantDetail(sql: Sql, id: string) {
  const [m] = await sql<{
    id: string; name: string; handle: string | null; email: string | null; phone: string | null; status: string; created_at: Date;
    photo: string | null; bio: string | null; tier: string | null;
    legal_name: string | null; display_name: string | null; address: string | null; city: string | null; state: string | null;
    post_code: string | null; country: string | null; website: string | null;
    bank_last4: string | null; bank_status: string | null; balance: bigint | null;
  }[]>`
    select a.id, a.name, a.handle, a.email, a.phone, a.status, a.created_at, a.photo, a.bio, a.tier,
           b.legal_name, b.display_name, b.address, b.city, b.state, b.post_code, b.country, b.website,
           ba.last4 as bank_last4, ba.status as bank_status, bal.balance
      from accounts a
      left join businesses b on b.account_id = a.id
      left join bank_accounts ba on ba.id = b.bank_account_id and ba.account_id = a.id
      left join balances bal on bal.account_id = a.id
     where a.id = ${id} and a.type = 'B'`;
  if (!m) return null;

  const [s] = await sql<Record<string, bigint | number | Date | null>[]>`
    with start as (select date_trunc('day', now() at time zone ${PROGRAM_TZ}) at time zone ${PROGRAM_TZ} as t)
    select
      (count(*) filter (where x.type = 'pay' and x.status = 'completed'))::int as pay_n,
      coalesce(sum(x.amount) filter (where x.type = 'pay' and x.status = 'completed'), 0) as pay_v,
      (count(*) filter (where x.type = 'pay' and x.status = 'completed' and x.completed_at >= start.t))::int as pay_today_n,
      coalesce(sum(x.amount) filter (where x.type = 'pay' and x.status = 'completed' and x.completed_at >= start.t), 0) as pay_today_v,
      (count(*) filter (where x.type = 'pay' and x.status = 'failed'))::int as declined_n,
      (count(*) filter (where x.type = 'refund' and x.status = 'completed'))::int as ref_n,
      coalesce(sum(x.amount) filter (where x.type = 'refund' and x.status = 'completed'), 0) as ref_v,
      (count(*) filter (where x.type = 'refund' and x.status = 'pending'))::int as pend_n,
      coalesce(sum(x.amount) filter (where x.type = 'refund' and x.status = 'pending'), 0) as pend_v,
      (count(distinct x.from_account_id) filter (where x.type = 'pay' and x.status = 'completed'))::int as customers,
      max(x.completed_at) filter (where x.type = 'pay' and x.status = 'completed') as last_payment_at
      from txn x, start
     where (x.to_account_id = ${id} and x.type = 'pay') or (x.from_account_id = ${id} and x.type = 'refund')`;
  const [c] = await sql<{ terminals: number; staff: number; products: number }[]>`
    select (select count(*) from terminals where account_id = ${id})::int as terminals,
           (select count(*) from staff where account_id = ${id})::int as staff,
           (select count(*) from products where account_id = ${id})::int as products`;

  return {
    id: m.id, name: m.display_name ?? m.name, legal_name: m.legal_name, handle: m.handle, status: m.status,
    email: m.email, phone: m.phone, created_at: m.created_at, website: m.website, photo: imageUrl(m.photo), bio: m.bio, tier: m.tier,
    address: { line: m.address, city: m.city, state: m.state, post_code: m.post_code, country: m.country },
    bank: m.bank_last4 ? { last4: m.bank_last4, status: m.bank_status } : null,
    balance: n(m.balance ?? 0n),
    stats: {
      payments: { count: s!.pay_n, volume: n(s!.pay_v as bigint), today: { count: s!.pay_today_n, volume: n(s!.pay_today_v as bigint) }, declined: s!.declined_n },
      refunds: { count: s!.ref_n, volume: n(s!.ref_v as bigint) },
      pending_refunds: { count: s!.pend_n, volume: n(s!.pend_v as bigint) },
      customers: s!.customers, last_payment_at: s!.last_payment_at,
      terminals: c!.terminals, staff: c!.staff, products: c!.products,
    },
  };
}

export async function merchantTerminals(sql: Sql, id: string) {
  const rows = await sql<{
    id: string; name: string; allow_refunds: boolean; created_at: Date; signed_in: boolean;
    orb_uid: string | null; orb_model: string | null; orb_software: string | null;
    payments: number; volume: bigint; last_payment_at: Date | null;
  }[]>`
    select t.id, t.name, t.allow_refunds, t.created_at, (t.session_token_hash is not null) as signed_in,
           t.orb_uid, t.orb_model, t.orb_software,
           (select count(*) from txn x where x.terminal_id = t.id and x.type = 'pay' and x.status = 'completed')::int as payments,
           (select coalesce(sum(x.amount), 0) from txn x where x.terminal_id = t.id and x.type = 'pay' and x.status = 'completed') as volume,
           (select max(x.completed_at) from txn x where x.terminal_id = t.id and x.type = 'pay' and x.status = 'completed') as last_payment_at
      from terminals t
     where t.account_id = ${id}
     order by t.created_at, t.id`;
  return rows.map((r) => ({
    id: r.id, name: r.name, allow_refunds: r.allow_refunds, created_at: r.created_at, signed_in: r.signed_in,
    orb: r.orb_uid ? { uid: r.orb_uid, model: r.orb_model, software: r.orb_software } : null,
    payments: r.payments, volume: n(r.volume), last_payment_at: r.last_payment_at,
  }));
}

export async function merchantStaff(sql: Sql, id: string) {
  const rows = await sql<{
    id: string; staff_account_id: string; name: string; email: string | null; handle: string | null; role: string;
    bank_last4: string | null; created_at: Date;
  }[]>`
    select s.id, s.staff_account_id, a.name, a.email, a.handle, s.role, ba.last4 as bank_last4, s.created_at
      from staff s join accounts a on a.id = s.staff_account_id
      left join bank_accounts ba on ba.id = s.bank_account_id
     where s.account_id = ${id}
     order by s.created_at, s.id`;
  return rows;
}

export async function merchantProducts(sql: Sql, id: string, limit: number = DEFAULT_PAGE, cursor: { ts: string; id: string } | null = null) {
  const [cnt] = await sql<{ total: number }[]>`select count(*)::int as total from products where account_id = ${id}`;
  const total = cnt!.total;
  const rows = await sql<{
    id: string; name: string; category: string | null; price: bigint; discount: bigint; stock: number | null; active: boolean;
    status: string; total_sold: bigint; sold_today: number; ts_key: string;
  }[]>`
    select p.id, p.name, c.name as category, p.price, p.discount, p.stock, p.active, p.status, p.total_sold, (case when p.sold_day = program_today() then p.sold_today else 0 end) as sold_today, p.created_at::text as ts_key
      from products p left join categories c on c.id = p.category_id and c.account_id = p.account_id
     where p.account_id = ${id}
       ${cursor ? sql`and (p.created_at, p.id) > (${cursor.ts}::text::timestamptz, ${cursor.id}::uuid)` : sql``}
     order by p.created_at, p.id limit ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    products: page.map(({ ts_key: _t, ...r }) => ({ ...r, price: n(r.price), discount: n(r.discount), total_sold: n(r.total_sold) })),
    next_cursor: rows.length > limit && last ? encodePair(last.ts_key, last.id) : null,
    total,
  };
}

export type MerchantTxKind = "all" | "payments" | "refunds" | "pending";
export const MERCHANT_TX_KINDS: MerchantTxKind[] = ["all", "payments", "refunds", "pending"];

/** The merchant's payments and refunds, newest first, with counts per filter and the completed totals. */
export async function merchantTransactions(
  sql: Sql, id: string, kind: MerchantTxKind, limit: number, cursor: { ts: string; id: string } | null, range: DayRange,
) {
  const mine = sql`((t.to_account_id = ${id} and t.type = 'pay') or (t.from_account_id = ${id} and t.type = 'refund'))`;
  const filter =
    kind === "payments" ? sql`and t.type = 'pay'`
    : kind === "refunds" ? sql`and t.type = 'refund' and t.status <> 'pending'`
    : kind === "pending" ? sql`and t.type = 'refund' and t.status = 'pending'`
    : sql``;
  const inRange = sql`
    ${range.from ? sql`and t."timestamp" >= (${range.from}::text::date)::timestamp at time zone ${PROGRAM_TZ}` : sql``}
    ${range.to ? sql`and t."timestamp" < ((${range.to}::text::date + 1)::timestamp at time zone ${PROGRAM_TZ})` : sql``}`;
  const rows = await sql<{
    id: string; type: string; status: string; status_code: string | null; amount: bigint; ts: Date; ts_key: string;
    via: string | null; reference: string | null; terminal: string | null; customer: string | null; approver: string | null;
    related: string | null; from_name: string | null; to_name: string | null;
    from_id: string | null; from_type: string | null; from_photo: string | null; to_id: string | null; to_type: string | null; to_photo: string | null;
  }[]>`
    select t.id, t.type, t.status, t.status_code, t.amount, t."timestamp" as ts,
           to_char(t."timestamp" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ts_key,
           case when t.type = 'pay' and t.tag_id is not null then 'tap' when t.type = 'pay' and t.pass_id is not null then 'pass' when t.type = 'pay' then 'app' end as via,
           t.reference, tm.name as terminal,
           case when t.type = 'pay' then fa.name else ta.name end as customer,
           coalesce(case when t.provider_reference like 'admin:%' then 'Admin ' || substr(t.provider_reference, 7) when t.provider_reference = 'operator' then 'Operator' end, ap.name) as approver,
           t.related_transaction_id as related,
           fa.name as from_name, ta.name as to_name,
           fa.id as from_id, fa.type as from_type, fa.photo as from_photo, ta.id as to_id, ta.type as to_type, ta.photo as to_photo
      from txn t
      left join terminals tm on tm.id = t.terminal_id
      left join accounts fa on fa.id = t.from_account_id
      left join accounts ta on ta.id = t.to_account_id
      left join accounts ap on ap.id = t.approved_by_account_id
     where ${mine} ${filter} ${inRange}
       ${cursor ? sql`and (t."timestamp", t.id) < (${cursor.ts}::text::timestamptz, ${cursor.id}::uuid)` : sql``}
     order by t."timestamp" desc, t.id desc
     limit ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  const [c] = await sql<Record<string, number>[]>`
    select count(*)::int as "all",
           (count(*) filter (where t.type = 'pay'))::int as payments,
           (count(*) filter (where t.type = 'refund' and t.status <> 'pending'))::int as refunds,
           (count(*) filter (where t.type = 'refund' and t.status = 'pending'))::int as pending
      from txn t where ${mine} ${inRange}`;
  const [tot] = await sql<{ pay_n: number; pay_v: bigint; ref_n: number; ref_v: bigint }[]>`
    select (count(*) filter (where t.type = 'pay'))::int as pay_n, coalesce(sum(t.amount) filter (where t.type = 'pay'), 0) as pay_v,
           (count(*) filter (where t.type = 'refund'))::int as ref_n, coalesce(sum(t.amount) filter (where t.type = 'refund'), 0) as ref_v
      from txn t where t.status = 'completed' and ${mine} ${inRange}`;
  return {
    counts: c!,
    totals: { payments: { count: tot!.pay_n, volume: n(tot!.pay_v) }, refunds: { count: tot!.ref_n, volume: n(tot!.ref_v) } },
    transactions: page.map((r) => ({
      id: r.id, type: r.type, status: r.status, status_code: r.status_code, amount: n(r.amount), timestamp: r.ts,
      via: r.via, reference: r.reference, terminal: r.terminal, customer: r.customer, approved_by: r.approver, refund_of: r.related,
      from: r.from_name, to: r.to_name, from_party: party(r.from_id, r.from_type, r.from_photo), to_party: party(r.to_id, r.to_type, r.to_photo),
    })),
    next_cursor: rows.length > limit && last ? `${last.ts_key}|${last.id}` : null,
  };
}
