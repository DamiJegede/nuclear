import { connect } from "../db";
import type { Env } from "../env";
import { easternDate, ensureDay } from "./dailyReset";
import { sweep } from "./throttle";

/**
 * The daily job. Cloudflare fires it at 04:00 and 05:00 UTC, which brackets midnight in New York in
 * both summer (04:00) and winter (05:00). Neither run decides anything by the clock: each asks for the
 * reset of its own program day, and only the first one on a new day does anything (see ensureDay). If the
 * cron is ever missed, the first money request after midnight does the same reset. Both runs sweep old
 * rate-limit counters.
 */
export async function dailyJobs(scheduledTime: number, env: Env) {
  const sql = connect(env);
  try {
    const swept = await sweep(sql);
    return { ...(await ensureDay(sql, easternDate(new Date(scheduledTime)))), swept };
  } finally {
    await sql.end();
  }
}
