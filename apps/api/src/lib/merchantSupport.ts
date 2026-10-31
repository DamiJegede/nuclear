import type { Sql } from "../db";
import { imageUrl } from "./images";
import { PROGRAM_TZ, addDays } from "./dates";
import { merchantSnapshotDay } from "./merchantSnapshots";
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
    created_at: Date;
  }[]>`
    select s.id, s.staff_account_id, a.name, a.email, a.handle, s.role, s.created_at
      from staff s join accounts a on a.id = s.staff_account_id
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
  sql: Sql, id: string, kind: MerchantTxKind, limit: number, cursor: { ts: string; id: string } | null, range: DayRange, withTotals = true,
) {
  // Index-driven: each source (payments into the merchant's wallets, refunds out of them, and the refund requests still open or rejected) is read in its own
  // index order and stops after `limit + 1` rows, so a page costs the same however long the merchant's history is. The three are merged and cut again.
  const wallets = sql`(select w.id from wallets w where w.account_id = ${id})`; // the aggregate below
  const wantPay = kind === "all" || kind === "payments", wantRefund = kind === "all" || kind === "refunds", wantPending = kind === "all" || kind === "pending";
  const tRange = sql`
    ${range.from ? sql`and t.created_at >= (${range.from}::text::date)::timestamp at time zone ${PROGRAM_TZ}` : sql``}
    ${range.to ? sql`and t.created_at < ((${range.to}::text::date + 1)::timestamp at time zone ${PROGRAM_TZ})` : sql``}`;
  const rRange = sql`
    ${range.from ? sql`and r.created_at >= (${range.from}::text::date)::timestamp at time zone ${PROGRAM_TZ}` : sql``}
    ${range.to ? sql`and r.created_at < ((${range.to}::text::date + 1)::timestamp at time zone ${PROGRAM_TZ})` : sql``}`;
  const tCursor = cursor ? sql`and (t.created_at, t.id) < (${cursor.ts}::text::timestamptz, ${cursor.id}::uuid)` : sql``;
  const rCursor = cursor ? sql`and (r.created_at, r.id) < (${cursor.ts}::text::timestamptz, ${cursor.id}::uuid)` : sql``;
  // a transaction as the old `txn` view reported it (the system wallets are no account, a declined row is `failed`)
  const tCols = sql`t.id, t.type, case t.status when 'declined' then 'failed' else t.status end as status, t.status_code, t.amount, t.created_at as "timestamp",
        t.tag_id, t.pass_id, t.reference, t.terminal_id, t.related_id as related_transaction_id,
        case when fw.type = 'system' then null else fw.account_id end as from_account_id, case when tw.type = 'system' then null else tw.account_id end as to_account_id,
        case when t.type = 'refund' and t.meta ? 'approved' then t.account_id end as approved_by_account_id, t.meta ->> 'provider_reference' as provider_reference, t.checkout_id`;
  const rows = await sql<{
    id: string; type: string; status: string; status_code: string | null; amount: bigint; ts: Date; ts_key: string;
    via: string | null; reference: string | null; terminal: string | null; customer: string | null; approver: string | null;
    related: string | null; from_name: string | null; to_name: string | null; tip: bigint | null; served_by: string | null;
    orig_ts: Date | null; orig_amount: bigint | null; orig_tip: bigint | null; orig_served: string | null; orig_via: string | null; orig_reference: string | null;
    from_id: string | null; from_type: string | null; from_photo: string | null; to_id: string | null; to_type: string | null; to_photo: string | null;
  }[]>`
    -- Page first, then join: the 20 rows are found and ordered on their own, so the lookups below (terminal, accounts, order, original payment) run for the
    -- rows shown, never for every row of the period.
    with pg as (
      select * from (
        (select x.* from wallets mw cross join lateral (
          select ${tCols} from transactions t join wallets fw on fw.id = t.from_wallet_id join wallets tw on tw.id = t.to_wallet_id
           where ${wantPay} and t.type = 'pay' and t.to_wallet_id = mw.id ${tRange} ${tCursor}
           order by t.created_at desc, t.id desc limit ${limit + 1}) x
          where mw.account_id = ${id})
        union all
        (select x.* from wallets mw cross join lateral (
          select ${tCols} from transactions t join wallets fw on fw.id = t.from_wallet_id join wallets tw on tw.id = t.to_wallet_id
           where ${wantRefund} and t.type = 'refund' and t.from_wallet_id = mw.id ${tRange} ${tCursor}
           order by t.created_at desc, t.id desc limit ${limit + 1}) x
          where mw.account_id = ${id})
        union all
        (select r.id, 'refund'::text, case r.status when 'pending' then 'pending' else 'failed' end, case r.status when 'pending' then 'awaiting_approval' else 'rejected' end,
                r.amount, r.created_at, null::uuid, null::uuid, r.reference, r.terminal_id, r.pay_transaction_id,
                r.merchant_account_id, pw.account_id, null::uuid, null::text, pay.checkout_id
           from refunds r join transactions pay on pay.id = r.pay_transaction_id join wallets pw on pw.id = pay.from_wallet_id
          where r.merchant_account_id = ${id} and r.status in ('pending', 'rejected')
            and ((r.status = 'pending' and ${wantPending}) or (r.status = 'rejected' and ${wantRefund})) ${rRange} ${rCursor}
          order by r.created_at desc, r.id desc limit ${limit + 1})
      ) u order by u."timestamp" desc, u.id desc limit ${limit + 1})
    select t.id, t.type, t.status, t.status_code, t.amount, t."timestamp" as ts,
           to_char(t."timestamp" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ts_key,
           case when t.type = 'pay' and t.tag_id is not null then 'tap' when t.type = 'pay' and t.pass_id is not null then 'pass' when t.type = 'pay' then 'app' end as via,
           t.reference, tm.name as terminal,
           case when t.type = 'pay' then fa.name else ta.name end as customer,
           coalesce(case when t.provider_reference like 'admin:%' then 'Admin ' || substr(t.provider_reference, 7) when t.provider_reference = 'operator' then 'Operator' end, ap.name) as approver,
           t.related_transaction_id as related,
           fa.name as from_name, ta.name as to_name,
           case when t.type = 'pay' and t.status = 'completed' then co.tip_amount end as tip, sv.name as served_by,
           op.created_at as orig_ts, op.amount as orig_amount, oc.tip_amount as orig_tip, osv.name as orig_served, oc.reference as orig_reference,
           case when op.tag_id is not null then 'tap' when op.pass_id is not null then 'pass' when op.id is not null then 'app' end as orig_via,
           fa.id as from_id, fa.type as from_type, fa.photo as from_photo, ta.id as to_id, ta.type as to_type, ta.photo as to_photo
      from pg t
      left join terminals tm on tm.id = t.terminal_id
      left join accounts fa on fa.id = t.from_account_id
      left join accounts ta on ta.id = t.to_account_id
      left join accounts ap on ap.id = t.approved_by_account_id
      left join checkouts co on co.id = t.checkout_id and t.type = 'pay'
      left join accounts sv on sv.id = co.served_by
      left join transactions op on op.id = t.related_transaction_id and t.type = 'refund'
      left join checkouts oc on oc.id = op.checkout_id
      left join accounts osv on osv.id = oc.served_by
     order by t."timestamp" desc, t.id desc`;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  // Counts per filter and the completed totals (skipped for the pages after the first: the client already has them). Finished days come from
  // `merchant_snapshots` (a few rows per day, final), the days after the last snapshot (normally today) are counted live, and refund REQUESTS
  // (pending or rejected: a pending one changes state) are always live.
  let agg: { all: number; payments: number; refunds: number; pending: number; pay_n: number; pay_v: bigint; ref_n: number; ref_v: bigint } | undefined;
  if (withTotals) {
    const day = await merchantSnapshotDay(sql);
    const useSnap = day !== null && !(range.from && range.from > day);
    const live: DayRange = useSnap ? { from: range.from && range.from > day! ? range.from : addDays(day!, 1), to: range.to } : range;
    const liveOn = !useSnap || !range.to || range.to > day!;
    const snapTo = range.to && range.to < day! ? range.to : day;
    const lRange = (col: string) => sql`
      ${live.from ? sql`and ${sql(col)} >= (${live.from}::text::date)::timestamp at time zone ${PROGRAM_TZ}` : sql``}
      ${live.to ? sql`and ${sql(col)} < ((${live.to}::text::date + 1)::timestamp at time zone ${PROGRAM_TZ})` : sql``}`;
    [agg] = await sql<{ all: number; payments: number; refunds: number; pending: number; pay_n: number; pay_v: bigint; ref_n: number; ref_v: bigint }[]>`
      select (pay_n + refund_n + req_refund_n + req_pending_n)::int as "all", pay_n::int as payments, (refund_n + req_refund_n)::int as refunds, req_pending_n::int as pending,
             pay_done_n::int as pay_n, pay_v, refund_done_n::int as ref_n, refund_v as ref_v
        from (
          select coalesce(sum(pay_n), 0) as pay_n, coalesce(sum(pay_done_n), 0) as pay_done_n, coalesce(sum(pay_v), 0) as pay_v,
                 coalesce(sum(refund_n), 0) as refund_n, coalesce(sum(refund_done_n), 0) as refund_done_n, coalesce(sum(refund_v), 0) as refund_v
            from (
              ${useSnap ? sql`select pay_n, pay_done_n, pay_v, refund_n, refund_done_n, refund_v from merchant_snapshots
                 where merchant_account_id = ${id} ${range.from ? sql`and snapshot_date >= ${range.from}::date` : sql``} and snapshot_date <= ${snapTo!}::date
                 union all` : sql``}
              ${liveOn ? sql`select 1, (t.status = 'completed')::int, case when t.status = 'completed' then t.amount else 0 end, 0, 0, 0
                   from transactions t where t.type = 'pay' and t.to_wallet_id in ${wallets} ${lRange("t.created_at")}
                 union all
                 select 0, 0, 0, 1, (t.status = 'completed')::int, case when t.status = 'completed' then t.amount else 0 end
                   from transactions t where t.type = 'refund' and t.from_wallet_id in ${wallets} ${lRange("t.created_at")}` : sql`select 0, 0, 0, 0, 0, 0 where false`}
            ) x(pay_n, pay_done_n, pay_v, refund_n, refund_done_n, refund_v)) s,
          (select (count(*) filter (where r.status = 'rejected'))::bigint as req_refund_n, (count(*) filter (where r.status = 'pending'))::bigint as req_pending_n
             from refunds r where r.merchant_account_id = ${id} and r.status <> 'approved' ${rRange}) q`;
  }
  return {
    counts: agg ? { all: agg.all, payments: agg.payments, refunds: agg.refunds, pending: agg.pending } : null,
    totals: agg ? { payments: { count: agg.pay_n, volume: n(agg.pay_v) }, refunds: { count: agg.ref_n, volume: n(agg.ref_v) } } : null,
    transactions: page.map((r) => ({
      id: r.id, type: r.type, status: r.status, status_code: r.status_code, amount: n(r.amount), timestamp: r.ts,
      via: r.via, reference: r.reference, terminal: r.terminal, customer: r.customer, approved_by: r.approver, refund_of: r.related,
      tip: r.tip === null ? null : n(r.tip), served_by: r.served_by,
      // a refund carries the payment it refunds: when it was paid, how much (tip included), who served and how
      original: r.related && r.orig_ts ? { id: r.related, timestamp: r.orig_ts, amount: n(r.orig_amount), tip: r.orig_tip ? n(r.orig_tip) : 0, served_by: r.orig_served, via: r.orig_via, reference: r.orig_reference } : null,
      from: r.from_name, to: r.to_name, from_party: party(r.from_id, r.from_type, r.from_photo), to_party: party(r.to_id, r.to_type, r.to_photo),
    })),
    next_cursor: rows.length > limit && last ? `${last.ts_key}|${last.id}` : null,
  };
}
