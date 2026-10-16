import { connect } from "../db";
import type { Env } from "../env";
import { easternHour, resetDailyCounters } from "./ledger";
import { sweep } from "./throttle";

/**
 * The daily job. Cloudflare fires it at 04:00 and 05:00 UTC; midnight in New York is one or the other
 * depending on daylight saving, so only the run that lands on hour 0 Eastern resets the daily counters
 * (wallets.spent_today and products.sold_today). Both runs sweep old rate-limit counters.
 */
export async function dailyJobs(scheduledTime: number, env: Env) {
  const sql = connect(env);
  try {
    const swept = await sweep(sql);
    if (easternHour(new Date(scheduledTime)) !== 0) return { reset: false as const, swept };
    return { reset: true as const, swept, ...(await resetDailyCounters(sql)) };
  } finally {
    await sql.end();
  }
}
