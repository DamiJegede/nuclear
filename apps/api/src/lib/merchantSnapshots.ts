import type { Sql } from "../db";
import { addDays } from "./dates";

/** The last program day the merchant snapshots cover (`system.merchant_snapshot_day`); null when never set up. */
export async function merchantSnapshotDay(sql: Sql): Promise<string | null> {
  const [r] = await sql<{ value: string }[]>`select value from system where key = 'merchant_snapshot_day'`;
  return r?.value ?? null;
}

/**
 * Writes the finished days after the marker up to `through` (a missed cron is made up the next night), at most 14 days a call, then moves the marker.
 * The rows come from `app_merchant_snapshot` (migrations/0011), which leaves a day already written alone.
 */
export async function catchUpMerchantSnapshots(sql: Sql, through: string): Promise<{ from: string; to: string; rows: number } | null> {
  const day = await merchantSnapshotDay(sql);
  if (!day || day >= through) return null;
  const from = addDays(day, 1);
  const to = addDays(from, 13) < through ? addDays(from, 13) : through;
  const [w] = await sql<{ n: number }[]>`select app_merchant_snapshot(${from}::date, ${to}::date)::int as n`;
  await sql`update system set value = ${to}, updated_at = now() where key = 'merchant_snapshot_day'`;
  return { from, to, rows: w?.n ?? 0 };
}

export type SalesDay = { date: string; sales: number; payments: number };

/**
 * Completed-payment sales per program day for `from..to` (inclusive, at most 62 days; every day is present, zero when quiet). Finished days come from
 * `merchant_snapshots`; the days after the last snapshot (normally today) are counted live from the merchant's wallet index.
 */
export async function merchantDailySales(sql: Sql, merchantId: string, from: string, to: string): Promise<SalesDay[]> {
  const marker = await merchantSnapshotDay(sql);
  const snapTo = marker && marker < to ? marker : to;
  const got = new Map<string, SalesDay>();
  if (!marker || from <= marker) {
    for (const r of await sql<{ d: string; v: bigint; n: bigint }[]>`
      select snapshot_date::text as d, pay_v as v, pay_done_n as n from merchant_snapshots
       where merchant_account_id = ${merchantId} and snapshot_date >= ${from}::date and snapshot_date <= ${snapTo}::date`) got.set(r.d, { date: r.d, sales: Number(r.v), payments: Number(r.n) });
  }
  const liveFrom = marker && marker >= from ? addDays(marker, 1) : from;
  if (!marker || liveFrom <= to) {
    for (const r of await sql<{ d: string; v: bigint; n: bigint }[]>`
      select (t.created_at at time zone 'America/New_York')::date::text as d, sum(t.amount) as v, count(*) as n
        from transactions t join wallets w on w.id = t.to_wallet_id
       where w.account_id = ${merchantId} and t.type = 'pay' and t.status = 'completed'
         and t.created_at >= (${liveFrom}::text::date)::timestamp at time zone 'America/New_York'
         and t.created_at < ((${to}::text::date + 1)::timestamp at time zone 'America/New_York')
       group by 1`) got.set(r.d, { date: r.d, sales: Number(r.v), payments: Number(r.n) });
  }
  const days: SalesDay[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(got.get(d) ?? { date: d, sales: 0, payments: 0 });
  return days;
}

export type ReportDay = { date: string; payments: number; sales: number; refunds: number; refunded: number; tips: number; taxable: number; exempt: number; tax: number; tax_refunded: number };
const ZERO = (date: string): ReportDay => ({ date, payments: 0, sales: 0, refunds: 0, refunded: 0, tips: 0, taxable: 0, exempt: 0, tax: 0, tax_refunded: 0 });
type StatRow = { d: string; pay_done_n: bigint; pay_v: bigint; refund_done_n: bigint; refund_v: bigint; tips_v: bigint; taxable_v: bigint; exempt_v: bigint; tax_v: bigint; tax_refunded_v: bigint };
const dayOf = (r: StatRow): ReportDay => ({ date: r.d, payments: Number(r.pay_done_n), sales: Number(r.pay_v), refunds: Number(r.refund_done_n), refunded: Number(r.refund_v), tips: Number(r.tips_v),
  taxable: Number(r.taxable_v), exempt: Number(r.exempt_v), tax: Number(r.tax_v), tax_refunded: Number(r.tax_refunded_v) });

/**
 * The merchant's daily report for `from..to` (inclusive, at most 92 days, every day present): completed sales and refunds, tips, taxable and exempt item sales,
 * sales tax collected and returned. Finished days come from `merchant_snapshots`; the days after the last one are worked out by `merchant_day_stats`, the same
 * definition the nightly job writes the snapshots from.
 */
export async function merchantDailyReport(sql: Sql, merchantId: string, from: string, to: string): Promise<ReportDay[]> {
  const marker = await merchantSnapshotDay(sql);
  const got = new Map<string, ReportDay>();
  if (!marker || from <= marker) {
    const snapTo = marker && marker < to ? marker : to;
    for (const r of await sql<StatRow[]>`
      select snapshot_date::text as d, pay_done_n, pay_v, refund_done_n, refund_v, tips_v, taxable_v, exempt_v, tax_v, tax_refunded_v from merchant_snapshots
       where merchant_account_id = ${merchantId} and snapshot_date >= ${from}::date and snapshot_date <= ${snapTo}::date`) got.set(r.d, dayOf(r));
  }
  const liveFrom = marker && marker >= from ? addDays(marker, 1) : from;
  if (liveFrom <= to) {
    for (const r of await sql<StatRow[]>`
      select day::text as d, pay_done_n, pay_v, refund_done_n, refund_v, tips_v, taxable_v, exempt_v, tax_v, tax_refunded_v
        from merchant_day_stats(${liveFrom}::date, ${to}::date, ${merchantId})`) got.set(r.d, dayOf(r));
  }
  const days: ReportDay[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(got.get(d) ?? ZERO(d));
  return days;
}

export const REPORT_PERIODS = ["week", "last_week", "30d", "month", "last_month"] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

/** The program dates of a named period ending no later than today's week or month (weeks run Monday to Sunday). */
export function periodRange(period: ReportPeriod, today: string): [string, string] {
  const monday = addDays(today, -((new Date(today + "T00:00:00Z").getUTCDay() + 6) % 7));
  if (period === "week") return [monday, addDays(monday, 6)];
  if (period === "last_week") return [addDays(monday, -7), addDays(monday, -1)];
  if (period === "30d") return [addDays(today, -29), today];
  const first = today.slice(0, 8) + "01";
  if (period === "month") { const nextFirst = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 1)).toISOString().slice(0, 10); return [first, addDays(nextFirst, -1)]; }
  return [new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 2, 1)).toISOString().slice(0, 10), addDays(first, -1)];
}
