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
