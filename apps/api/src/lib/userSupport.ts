import type { Sql } from "../db";
import { PROGRAM_TZ } from "./ledger";
import { n } from "./money";
import { peek, RULES } from "./throttle";
import type { DayRange } from "./adminLists";

/** Read-only views of one consumer for the support team. Everything comes from existing tables. */

export async function userDetail(sql: Sql, id: string) {
  const [u] = await sql<{
    id: string; name: string; handle: string | null; email: string | null; phone: string | null; status: string; tier: string | null;
    created_at: Date; photo: string | null;
    balance: bigint | null; pending: bigint | null; credit_limit: bigint | null; credit_spent: bigint | null; earmarked: bigint;
  }[]>`
    select a.id, a.name, a.handle, a.email, a.phone, a.status, a.tier, a.created_at, a.photo,
           b.balance, b.balance_pending as pending, b.credit_limit, b.credit_spent,
           (select coalesce(sum(w.balance), 0)::bigint from wallets w where w.account_id = a.id and w.balance is not null) as earmarked
      from accounts a left join balances b on b.account_id = a.id
     where a.id = ${id} and a.type = 'C'`;
  if (!u) return null;

  const [s] = await sql<Record<string, bigint | number | Date | null>[]>`
    with start as (select date_trunc('day', now() at time zone ${PROGRAM_TZ}) at time zone ${PROGRAM_TZ} as t)
    select
      (count(*) filter (where x.type = 'send' and x.from_account_id = ${id} and x.status = 'completed'))::int as sent_n,
      coalesce(sum(x.amount) filter (where x.type = 'send' and x.from_account_id = ${id} and x.status = 'completed'), 0) as sent_v,
      (count(*) filter (where x.type = 'send' and x.to_account_id = ${id} and x.status = 'completed'))::int as recv_n,
      coalesce(sum(x.amount) filter (where x.type = 'send' and x.to_account_id = ${id} and x.status = 'completed'), 0) as recv_v,
      (count(*) filter (where x.type = 'pay' and x.status = 'completed'))::int as pay_n,
      coalesce(sum(x.amount) filter (where x.type = 'pay' and x.status = 'completed'), 0) as pay_v,
      (count(*) filter (where x.type = 'fund' and x.status = 'completed'))::int as fund_n,
      coalesce(sum(x.amount) filter (where x.type = 'fund' and x.status = 'completed'), 0) as fund_v,
      (count(*) filter (where x.status = 'failed' and x.from_account_id = ${id}))::int as failed_n,
      (count(*) filter (where x.completed_at >= start.t))::int as today_n,
      max(x.completed_at) as last_at
      from transactions x, start
     where x.from_account_id = ${id} or x.to_account_id = ${id}`;
  const [c] = await sql<{ wallets: number; agents: number; tags: number; devices: number; orders: number }[]>`
    select (select count(*) from wallets where account_id = ${id} and status <> 'closed')::int as wallets,
           (select count(*) from wallets where account_id = ${id} and type = 'agent' and status <> 'closed')::int as agents,
           (select count(*) from tags t join wallets w on w.id = t.wallet_id where w.account_id = ${id})::int as tags,
           (select count(*) from devices where account_id = ${id} and revoked_at is null and session_expires_at > now())::int as devices,
           (select count(*) from tag_orders where account_id = ${id})::int as orders`;
  const lock = u.email ? await peek(sql, `login:${u.email.toLowerCase()}`, RULES.loginFailures) : { blocked: false, retryAfter: 0 };

  return {
    id: u.id, name: u.name, handle: u.handle, email: u.email, phone: u.phone, status: u.status, tier: u.tier, created_at: u.created_at,
    login_locked: lock.blocked ? { retry_after: lock.retryAfter } : null,
    balances: {
      balance: n(u.balance ?? 0n), pending: n(u.pending ?? 0n), credit_limit: n(u.credit_limit ?? 0n), credit_spent: n(u.credit_spent ?? 0n),
      earmarked: n(u.earmarked), shared: n((u.balance ?? 0n) > u.earmarked ? (u.balance ?? 0n) - u.earmarked : 0n),
    },
    stats: {
      sent: { count: s!.sent_n, volume: n(s!.sent_v as bigint) }, received: { count: s!.recv_n, volume: n(s!.recv_v as bigint) },
      payments: { count: s!.pay_n, volume: n(s!.pay_v as bigint) }, loads: { count: s!.fund_n, volume: n(s!.fund_v as bigint) },
      failed: s!.failed_n, today: s!.today_n, last_activity_at: s!.last_at,
      wallets: c!.wallets, agents: c!.agents, tags: c!.tags, devices: c!.devices, orders: c!.orders,
    },
  };
}

export async function userWallets(sql: Sql, id: string) {
  const rows = await sql<{
    id: string; display_name: string; type: string; status: string; balance: bigint | null; daily_limit: bigint | null; spent_today: bigint;
    allow_pay: boolean; allow_send: boolean; key_hint: string | null; key_last_used_at: Date | null; created_at: Date; tags: number;
  }[]>`
    select w.id, w.display_name, w.type, w.status, w.balance, w.daily_limit, w.spent_today, w.allow_pay, w.allow_send,
           w.key_hint, w.key_last_used_at, w.created_at,
           (select count(*) from tags t where t.wallet_id = w.id)::int as tags
      from wallets w where w.account_id = ${id}
     order by (w.type = 'default') desc, w.created_at, w.id`;
  return rows.map((w) => ({
    id: w.id, name: w.display_name, type: w.type, status: w.status,
    balance: n(w.balance), earmarked: w.balance !== null, daily_limit: n(w.daily_limit), spent_today: n(w.spent_today),
    allow_pay: w.allow_pay, allow_send: w.allow_send, tags: w.tags,
    key: w.key_hint === null ? null : { hint: w.key_hint, last_used_at: w.key_last_used_at }, created_at: w.created_at,
  }));
}

export async function userTags(sql: Sql, id: string) {
  const rows = await sql<{
    id: string; label: string | null; locked: boolean; transaction_limit: bigint | null; last_read_at: Date | null; updated_at: Date;
    model: string; model_type: string; wallet: string;
  }[]>`
    select t.id, t.label, t.locked, t.transaction_limit, t.last_read_at, t.updated_at, m.name as model, m.type as model_type, w.display_name as wallet
      from tags t join wallets w on w.id = t.wallet_id join tag_models m on m.id = t.model_id
     where w.account_id = ${id}
     order by t.updated_at desc, t.id`;
  return rows.map((t) => ({ ...t, transaction_limit: n(t.transaction_limit) }));
}

export async function userDevices(sql: Sql, id: string) {
  const rows = await sql<{
    id: string; platform: string | null; wallet: string | null; created_at: Date; last_accessed_at: Date | null;
    session_expires_at: Date | null; revoked_at: Date | null; active: boolean;
  }[]>`
    select d.id, d.platform, w.display_name as wallet, d.created_at, d.last_accessed_at, d.session_expires_at, d.revoked_at,
           (d.revoked_at is null and d.session_expires_at > now()) as active
      from devices d left join wallets w on w.id = d.wallet_id
     where d.account_id = ${id}
     order by d.created_at desc, d.id desc limit 100`;
  return rows;
}

export async function userFunding(sql: Sql, id: string) {
  const banks = await sql<{ id: string; last4: string; status: string; created_at: Date }[]>`
    select id, last4, status, created_at from bank_accounts where account_id = ${id} order by created_at, id`;
  const fundings = await sql<{
    id: string; amount: bigint; status: string; failure_code: string | null; last4: string | null; created_at: Date; released_at: Date | null; returned_at: Date | null;
  }[]>`
    select f.id, f.amount, f.status, f.failure_code, b.last4, f.created_at, f.released_at, f.returned_at
      from fundings f left join bank_accounts b on b.id = f.bank_account_id
     where f.account_id = ${id} order by f.created_at desc, f.id desc limit 100`;
  return { banks, fundings: fundings.map((f) => ({ ...f, amount: n(f.amount) })) };
}

export async function userOrders(sql: Sql, id: string) {
  const rows = await sql<{
    id: string; model_name: string; model_type: string; quantity: number; unit_price: bigint; total: bigint; status: string;
    shipping: { name?: string; city?: string; region?: string; country?: string }; created_at: Date;
  }[]>`
    select id, model_name, model_type, quantity, unit_price, total, status, shipping, created_at
      from tag_orders where account_id = ${id} order by created_at desc, id desc limit 100`;
  return rows.map((o) => ({ ...o, unit_price: n(o.unit_price), total: n(o.total) }));
}

export type UserTxKind = "all" | "sends" | "received" | "payments" | "loads" | "refunds";
export const USER_TX_KINDS: UserTxKind[] = ["all", "sends", "received", "payments", "loads", "refunds"];

/** Everything the person's account took part in, newest first, with counts per filter. */
export async function userTransactions(
  sql: Sql, id: string, kind: UserTxKind, limit: number, cursor: { ts: string; id: string } | null, range: DayRange,
) {
  const mine = sql`(t.from_account_id = ${id} or t.to_account_id = ${id})`;
  const filter =
    kind === "sends" ? sql`and t.type = 'send' and t.from_account_id = ${id}`
    : kind === "received" ? sql`and t.type = 'send' and t.to_account_id = ${id}`
    : kind === "payments" ? sql`and t.type in ('pay', 'purchase') and t.from_account_id = ${id}`
    : kind === "loads" ? sql`and t.type = 'fund'`
    : kind === "refunds" ? sql`and t.type = 'refund' and t.to_account_id = ${id} and t.status <> 'pending'`
    : sql``;
  const inRange = sql`
    ${range.from ? sql`and t."timestamp" >= (${range.from}::text::date)::timestamp at time zone ${PROGRAM_TZ}` : sql``}
    ${range.to ? sql`and t."timestamp" < ((${range.to}::text::date + 1)::timestamp at time zone ${PROGRAM_TZ})` : sql``}`;
  // Not shown: a refund request still waiting for the merchant (the merchant's business, not the customer's)
  // and failed attempts that someone else made towards this person (they did not try anything).
  const visible = sql`and not (t.type = 'refund' and t.status = 'pending') and not (t.status = 'failed' and t.from_account_id <> ${id})`;
  const rows = await sql<{
    id: string; type: string; status: string; status_code: string | null; amount: bigint; ts: Date; ts_key: string;
    direction: string; via: string | null; counterparty: string | null; wallet: string | null; agent: boolean; reference: string | null;
  }[]>`
    select t.id, t.type, t.status, t.status_code, t.amount, t."timestamp" as ts,
           to_char(t."timestamp" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ts_key,
           case when t.to_account_id = ${id} then 'in' else 'out' end as direction,
           case when t.type = 'pay' and t.tag_id is not null then 'tap' when t.type = 'pay' and t.pass_id is not null then 'pass' when t.type = 'pay' then 'app' end as via,
           case when t.type = 'purchase' then 'Nuclear store'
                when t.type = 'fund' then 'Bank'
                when t.from_account_id = ${id} then coalesce(tb.display_name, ta.name) else coalesce(fb.display_name, fa.name) end as counterparty,
           case when t.from_account_id = ${id} then fw.display_name else tw.display_name end as wallet,
           coalesce((case when t.from_account_id = ${id} then fw.type else tw.type end) = 'agent', false) as agent,
           t.reference
      from transactions t
      left join accounts fa on fa.id = t.from_account_id left join businesses fb on fb.account_id = t.from_account_id
      left join accounts ta on ta.id = t.to_account_id left join businesses tb on tb.account_id = t.to_account_id
      left join wallets fw on fw.id = t.from_wallet_id left join wallets tw on tw.id = t.to_wallet_id
     where ${mine} ${visible} ${filter} ${inRange}
       ${cursor ? sql`and (t."timestamp", t.id) < (${cursor.ts}::text::timestamptz, ${cursor.id}::uuid)` : sql``}
     order by t."timestamp" desc, t.id desc
     limit ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  const [c] = await sql<Record<string, number>[]>`
    select count(*)::int as "all",
           (count(*) filter (where t.type = 'send' and t.from_account_id = ${id}))::int as sends,
           (count(*) filter (where t.type = 'send' and t.to_account_id = ${id}))::int as received,
           (count(*) filter (where t.type in ('pay', 'purchase') and t.from_account_id = ${id}))::int as payments,
           (count(*) filter (where t.type = 'fund'))::int as loads,
           (count(*) filter (where t.type = 'refund' and t.to_account_id = ${id}))::int as refunds
      from transactions t where ${mine} ${visible} ${inRange}`;
  const [tot] = await sql<{ out_v: bigint; in_v: bigint }[]>`
    select coalesce(sum(t.amount) filter (where t.from_account_id = ${id} and t.type <> 'fund'), 0) as out_v,
           coalesce(sum(t.amount) filter (where t.to_account_id = ${id}), 0) as in_v
      from transactions t where t.status = 'completed' and ${mine} ${visible} ${inRange}`;
  return {
    counts: c!,
    totals: { money_out: n(tot!.out_v), money_in: n(tot!.in_v) },
    transactions: page.map((r) => ({
      id: r.id, type: r.type, status: r.status, status_code: r.status_code, amount: n(r.amount), timestamp: r.ts,
      direction: r.direction, via: r.via, counterparty: r.counterparty, wallet: r.wallet, agent: r.agent, reference: r.reference,
    })),
    next_cursor: rows.length > limit && last ? `${last.ts_key}|${last.id}` : null,
  };
}
