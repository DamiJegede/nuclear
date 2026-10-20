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
  const [cur] = await sql<{ value: string }[]>`select value from system where key = 'daily_reset_day'`;
  if (cur && cur.value >= day) return { reset: false, wallets: 0, products: 0 };    // the usual case: one cheap read
  return sql.begin(async (tx) => {
    const won = await tx`update system set value = ${day} where key = 'daily_reset_day' and value < ${day} returning value`;
    if (won.length === 0) return { reset: false, wallets: 0, products: 0 };
    const w = await tx`update wallets set spent_today = 0 where spent_today <> 0 returning id`;
    const p = await tx`update products set sold_today = 0 where sold_today <> 0 returning id`;
    // The daily value cap: every consumer account starts the day with its actual ordinary value (balance minus Benefits wallets) as the
    // opening value and nothing added yet. (An account that is somehow missed rolls itself the next time its row is locked.)
    await tx`
      update balances b set ordinary_opening = b.balance - coalesce((select sum(w.balance) from wallets w where w.account_id = b.account_id and w.type = 'benefits'), 0),
                            added_today = 0, opening_day = ${day}::date
        from accounts a where a.id = b.account_id and a.type = 'C' and b.opening_day < ${day}::date`;
    return { reset: true, wallets: w.length, products: p.length };
  }) as Promise<ResetResult>;
}

/** Middleware for routes that read or change the daily counters: catches up first if the cron missed a day. */
const checked = new WeakSet<Request>();
export const programDay: MiddlewareHandler<AppContext> = async (c, next) => {
  // A route can match more than one registered pattern (/wallets and /wallets/*): check once per request.
  if (!checked.has(c.req.raw)) {
    checked.add(c.req.raw);
    await ensureDay(c.get("sql"), easternDate(new Date()));
  }
  await next();
};
