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
