import type { Sql } from "../db";
import type { Env } from "../env";
import { PROGRAM_TZ } from "./ledger";
import { easternDate } from "./dailyReset";
import { readCounters } from "./tracker";
import type { Days, Deltas } from "./counters";
import { liveStats, type LiveStats } from "./stats";

/**
 * Daily snapshots (migration 0040, docs/TABLES.md "snapshots"). Once a night the cron records what happened on the program day that just ended,
 * exactly, from the day's own transactions (a range read on `transactions_completed_at_idx`), plus the gauges (balances, people) at that moment and a
 * running lifetime (previous row + the day). The admin Overview shows the latest snapshot plus today's running estimate (tracker.ts), so it never
 * scans history.
 */
export const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** What each activity column counts: a filter over completed transactions. */
const FILTERS: Record<string, string> = {
  sends: "type = 'send'",
  taps: "type = 'pay' and tag_id is not null",
  in_app: "type = 'pay' and tag_id is null",
  agents: "type in ('send', 'pay') and from_wallet_id in (select id from wallets where type = 'agent')",
  refunds: "type = 'refund'",
  loads: "type = 'fund'",
  purchases: "type = 'purchase'",
  payouts: "type = 'settle' and to_bank_account_id is not null",
  collections: "type = 'settle' and from_bank_account_id is not null",
  claims: "type = 'claim'",
};
const DAY_KINDS = Object.keys(FILTERS);
const LIFETIME_KINDS = ["sends", "taps", "in_app", "agents", "refunds", "loads", "purchases", "payouts", "collections", "claims"];

const selectList = (kinds: string[]) => kinds
  .map((k) => `count(*) filter (where ${FILTERS[k]})::bigint as ${k}_count, coalesce(sum(amount) filter (where ${FILTERS[k]}), 0)::bigint as ${k}_volume`)
  .join(", ");

type Counts = Record<string, bigint>;

export type SnapshotRow = Record<string, unknown> & { snapshot_date: string; taken_at: Date };

/** Computes and stores the snapshot for program day `date`. Returns false when that day already has one (nothing is changed). */
export async function takeSnapshot(sql: Sql, date: string): Promise<boolean> {
  const [exists] = await sql`select 1 from snapshots where snapshot_date = ${date}::date`;
  if (exists) return false;
  const b = sql`(select (${date}::date)::timestamp at time zone ${PROGRAM_TZ} as s, ((${date}::date + 1))::timestamp at time zone ${PROGRAM_TZ} as e) b`;

  const [day] = await sql<Counts[]>`
    select ${sql.unsafe(selectList(DAY_KINDS))}, count(distinct to_account_id) filter (where type = 'pay')::bigint as merchants_paid
      from transactions t, ${b}
     where t.status = 'completed' and t.completed_at >= b.s and t.completed_at < b.e`;

  // Lifetime = the previous day's lifetime plus this day. With no previous day (first run, or a gap) it is summed from all history once.
  const [prev] = await sql<Counts[]>`select * from snapshots where snapshot_date = ${addDays(date, -1)}::date`;
  const lifetime: Counts = {};
  if (prev) {
    for (const k of LIFETIME_KINDS) {
      lifetime[`lifetime_${k}_count`] = (prev[`lifetime_${k}_count`] ?? 0n) + day![`${k}_count`]!;
      lifetime[`lifetime_${k}_volume`] = (prev[`lifetime_${k}_volume`] ?? 0n) + day![`${k}_volume`]!;
    }
  } else {
    const [all] = await sql<Counts[]>`
      select ${sql.unsafe(selectList(LIFETIME_KINDS))} from transactions t, ${b} where t.status = 'completed' and t.completed_at < b.e`;
    for (const k of LIFETIME_KINDS) { lifetime[`lifetime_${k}_count`] = all![`${k}_count`]!; lifetime[`lifetime_${k}_volume`] = all![`${k}_volume`]!; }
  }

  const [runs] = await sql<Counts[]>`
    select count(*) filter (where r.status = 'credited' and r.created_at >= b.s and r.created_at < b.e)::bigint as benefit_runs_count,
           coalesce(sum(r.total) filter (where r.status = 'credited' and r.created_at >= b.s and r.created_at < b.e), 0)::bigint as benefit_credited,
           coalesce(sum(r.sent) filter (where r.status = 'credited' and r.created_at >= b.s and r.created_at < b.e), 0)::bigint as benefit_sent,
           coalesce(sum(r.held) filter (where r.status = 'credited' and r.created_at >= b.s and r.created_at < b.e), 0)::bigint as benefit_held,
           count(*) filter (where r.status = 'missed' and r.created_at >= b.s and r.created_at < b.e)::bigint as benefit_runs_missed,
           count(*) filter (where r.status = 'credited')::bigint as lifetime_benefit_runs_count,
           coalesce(sum(r.total) filter (where r.status = 'credited'), 0)::bigint as lifetime_benefit_credited
      from benefit_runs r, ${b} where r.created_at < b.e`;

  const [people] = await sql<Counts[]>`
    select (count(*) filter (where a.type = 'C' and a.created_at >= b.s and a.created_at < b.e))::bigint as users_new,
           (count(*) filter (where a.type = 'B' and a.created_at >= b.s and a.created_at < b.e))::bigint as merchants_new,
           (count(*) filter (where a.type = 'O' and a.created_at >= b.s and a.created_at < b.e))::bigint as organizations_new,
           (count(*) filter (where a.type = 'C'))::bigint as users_total,
           (count(*) filter (where a.type = 'C' and a.status = 'active'))::bigint as users_active,
           (count(*) filter (where a.type = 'C' and a.status = 'suspended'))::bigint as users_suspended,
           (count(*) filter (where a.type = 'C' and a.status = 'closed'))::bigint as users_closed,
           (count(*) filter (where a.type = 'B'))::bigint as merchants_total,
           (count(*) filter (where a.type = 'B' and a.status = 'active'))::bigint as merchants_active,
           (count(*) filter (where a.type = 'O'))::bigint as organizations_total,
           (count(*) filter (where a.type = 'O' and a.status = 'active'))::bigint as organizations_active
      from accounts a, ${b}`;

  const [gauges] = await sql<Counts[]>`
    select coalesce(sum(bl.balance), 0)::bigint as scheme_balance,
           coalesce(sum(bl.balance) filter (where a.type = 'C'), 0)::bigint as consumer_balance,
           coalesce(sum(bl.balance) filter (where a.type = 'B'), 0)::bigint as merchant_balance,
           coalesce(sum(bl.balance) filter (where a.type = 'O'), 0)::bigint as organization_balance,
           coalesce(-sum(bl.balance) filter (where a.type = 'B' and bl.balance < 0), 0)::bigint as merchant_debt,
           coalesce(sum(bl.balance_pending), 0)::bigint as pending_loads,
           coalesce(sum(bl.credit_spent), 0)::bigint as credit_outstanding,
           coalesce(sum(bl.credit_limit), 0)::bigint as credit_limit,
           (select coalesce(sum(w.balance), 0) from wallets w where w.type = 'benefits')::bigint as benefits_wallet_balance,
           (select coalesce(sum(e.balance), 0) from employees e where e.employee_account_id is null)::bigint as employee_escrow,
           (select count(*) from wallets w join accounts x on x.id = w.account_id where x.type = 'C' and w.status <> 'closed')::bigint as wallets,
           (select count(*) from terminals)::bigint as terminals,
           (select count(*) from employees e where e.status = 'active')::bigint as employees_total,
           (select count(*) from employees e where e.status = 'active' and e.employee_account_id is not null)::bigint as employees_claimed,
           (select count(*) from employees e where e.status = 'active' and e.employee_account_id is null)::bigint as employees_unclaimed
      from balances bl join accounts a on a.id = bl.account_id`;

  const [more] = await sql<Counts[]>`
    select (select count(distinct t.to_account_id) from transactions t, ${b}
             where t.type = 'pay' and t.status = 'completed' and t.completed_at >= b.e - interval '30 days' and t.completed_at < b.e)::bigint as merchants_transacting,
           (select count(*) from employees e, ${b} where e.created_at >= b.s and e.created_at < b.e)::bigint as employees_added`;

  const row = { snapshot_date: date, ...day, ...lifetime, ...runs, ...people, ...gauges, ...more };
  await sql`insert into snapshots ${sql(row as Record<string, string | bigint>)} on conflict (snapshot_date) do nothing`;
  return true;
}

/** Writes any missing days up to `through` (a missed cron is made up the next night), oldest first, at most 14. */
export async function catchUpSnapshots(sql: Sql, through: string): Promise<string[]> {
  const [last] = await sql<{ d: string | null }[]>`select max(snapshot_date)::text as d from snapshots`;
  const made: string[] = [];
  let d = last?.d ? addDays(last.d, 1) : through;
  while (d <= through && made.length < 14) {
    if (await takeSnapshot(sql, d)) made.push(d);
    d = addDays(d, 1);
  }
  return made;
}

type Snap = Record<string, string | bigint | Date | null>;
const big = (s: Snap, k: string) => (s[k] as bigint | null) ?? 0n;
const n = (b: bigint) => Number(b);
const sum = (days: Days, k: string, only?: string) => Object.entries(days).reduce((a, [d, kv]) => a + (only && d !== only ? 0 : kv[k] ?? 0), 0);

/**
 * The Overview numbers without a history scan: the latest snapshot (exact as of its midnight) plus today's running estimate. The days after the
 * snapshot come from the counters. When no snapshot can be made it falls back to computing live.
 */
export async function overviewStats(env: Env, sql: Sql): Promise<LiveStats> {
  const today = easternDate(new Date());
  const yesterday = addDays(today, -1);
  let [snap] = await sql<Snap[]>`select *, snapshot_date::text as sd from snapshots order by snapshot_date desc limit 1`;
  if (!snap || (snap.sd as string) < yesterday) {
    try { await catchUpSnapshots(sql, yesterday); } catch (e) { console.error("snapshot catch-up failed", e); }
    [snap] = await sql<Snap[]>`select *, snapshot_date::text as sd from snapshots order by snapshot_date desc limit 1`;
  }
  if (!snap) return liveStats(sql);

  const sd = snap.sd as string;
  const days: string[] = [];
  for (let d = addDays(sd, 1); d <= today && days.length < 40; d = addDays(d, 1)) days.push(d);
  const counters = await readCounters(env, days);            // everything after the snapshot's midnight
  const since = (k: string) => sum(counters, k);
  const todayOf = (k: string) => sum(counters, k, today);
  const vol = (count: bigint, volume: bigint, cn: number, vn: number) => ({ count: Number(count) + cn, volume: n(volume) + vn });

  // Money in the scheme moves with loads (in), store purchases (out), claims (in) and credits held for employees (out); sends, payments and refunds only move it around.
  const balanceChange = since("loads_v") - since("purchases_v") + since("claims_v") - since("benefit_held_v");
  const [recent] = await sql<{ d7: bigint; d30: bigint }[]>`
    select coalesce(sum(users_new) filter (where snapshot_date > ${addDays(today, -7)}::date), 0)::bigint as d7,
           coalesce(sum(users_new) filter (where snapshot_date > ${addDays(today, -30)}::date), 0)::bigint as d30
      from snapshots`;

  const sent = vol(big(snap, "lifetime_sends_count"), big(snap, "lifetime_sends_volume"), since("sends_n"), since("sends_v"));
  const tapped = vol(big(snap, "lifetime_taps_count"), big(snap, "lifetime_taps_volume"), since("taps_n"), since("taps_v"));
  const inApp = vol(big(snap, "lifetime_in_app_count"), big(snap, "lifetime_in_app_volume"), since("in_app_n"), since("in_app_v"));
  const agents = vol(big(snap, "lifetime_agents_count"), big(snap, "lifetime_agents_volume"), since("agents_n"), since("agents_v"));
  const tv = (c: string) => ({ count: todayOf(`${c}_n`), volume: todayOf(`${c}_v`) });

  return {
    as_of: new Date().toISOString(),
    estimate: { snapshot_date: sd, snapshot_taken_at: (snap.taken_at as unknown as Date).toISOString(), today },
    scheme: {
      balance: n(big(snap, "scheme_balance")) + balanceChange,
      consumer_balance: n(big(snap, "consumer_balance")),
      merchant_balance: n(big(snap, "merchant_balance")),
      organization_balance: n(big(snap, "organization_balance")),
      merchant_debt: n(big(snap, "merchant_debt")),
      pending: n(big(snap, "pending_loads")),
      credit_outstanding: n(big(snap, "credit_outstanding")),
      credit_limit: n(big(snap, "credit_limit")),
    },
    users: {
      total: Number(big(snap, "users_total")) + since("users_new_n"), active: Number(big(snap, "users_active")) + since("users_new_n"),
      suspended: Number(big(snap, "users_suspended")), closed: Number(big(snap, "users_closed")),
      new_today: todayOf("users_new_n"), new_7d: Number(recent!.d7) + since("users_new_n"), new_30d: Number(recent!.d30) + since("users_new_n"),
      wallets: Number(big(snap, "wallets")) + since("users_new_n"),
    },
    merchants: {
      total: Number(big(snap, "merchants_total")) + since("merchants_new_n"), active: Number(big(snap, "merchants_active")),
      transacting: Number(big(snap, "merchants_transacting")), terminals: Number(big(snap, "terminals")),
    },
    payments: {
      sent, tapped, in_app: inApp, agents,
      merchant_payments: { count: tapped.count + inApp.count, volume: tapped.volume + inApp.volume },
      total: { count: sent.count + tapped.count + inApp.count, volume: sent.volume + tapped.volume + inApp.volume },
      refunds: vol(big(snap, "lifetime_refunds_count"), big(snap, "lifetime_refunds_volume"), since("refunds_n"), since("refunds_v")),
      loaded: vol(big(snap, "lifetime_loads_count"), big(snap, "lifetime_loads_volume"), since("loads_n"), since("loads_v")),
      today: { sent: tv("sends"), tapped: tv("taps"), in_app: tv("in_app"), agents: tv("agents") },
    },
  };
}

/** Records the ledger check on the day's snapshot row. */
export const saveReconciliation = (sql: Sql, date: string, rec: Record<string, unknown>, ok: boolean) =>
  sql`update snapshots set reconciled = ${ok}, reconciliation = ${JSON.stringify(rec)}::text::jsonb where snapshot_date = ${date}::date`;

export type { Deltas };
