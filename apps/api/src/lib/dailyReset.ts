import type { MiddlewareHandler } from "hono";
import type { Sql } from "../db";
import type { AppContext } from "../env";
import { PROGRAM_TZ } from "./ledger";

/** The program date (America/New_York) of an instant, as YYYY-MM-DD. */
export const easternDate = (d: Date): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: PROGRAM_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

export type ResetResult = { reset: boolean; wallets: number; products: number };

/**
 * Makes sure the daily counters have been reset for program day `day`. The first caller on a new day
 * wins the single `daily_reset` row and zeroes wallets.spent_today and products.sold_today in the same
 * transaction; everyone else (including a cron that fires later) finds the day already done and does
 * nothing, so spend made after midnight is never wiped. Safe to call any number of times, from any
 * number of requests at once: a second caller waits for the first to commit and then sees the new day.
 */
export async function ensureDay(sql: Sql, day: string): Promise<ResetResult> {
  const [cur] = await sql<{ last_day: string }[]>`select last_day::text from daily_reset`;
  if (cur && cur.last_day >= day) return { reset: false, wallets: 0, products: 0 };    // the usual case: one cheap read
  return sql.begin(async (tx) => {
    const won = await tx`update daily_reset set last_day = ${day}::date where last_day < ${day}::date returning last_day`;
    if (won.length === 0) return { reset: false, wallets: 0, products: 0 };
    const w = await tx`update wallets set spent_today = 0 where spent_today <> 0 returning id`;
    const p = await tx`update products set sold_today = 0 where sold_today <> 0 returning id`;
    return { reset: true, wallets: w.length, products: p.length };
  }) as Promise<ResetResult>;
}

/** Middleware for routes that read or change the daily counters: catches up first if the cron missed a day. */
export const programDay: MiddlewareHandler<AppContext> = async (c, next) => {
  await ensureDay(c.get("sql"), easternDate(new Date()));
  await next();
};
