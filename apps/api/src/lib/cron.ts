import { connect } from "../db";
import type { Env } from "../env";
import { easternDate, ensureDay } from "./dailyReset";
import { sweep } from "./throttle";
import { remindUnclaimed } from "./orgMail";

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
    // A visible heartbeat: `select value from system where key = 'cron_last_run'` shows when the cron last fired.
    await sql`insert into system (key, value) values ('cron_last_run', ${new Date(scheduledTime).toISOString()})
              on conflict (key) do update set value = excluded.value`;
    const day = await ensureDay(sql, easternDate(new Date(scheduledTime)));
    // The monthly nudge to employees who have not claimed their employer credit (see lib/orgMail.ts); never blocks the reset.
    const reminders = await remindUnclaimed(env, sql).catch((err) => (console.error("reminders failed", err), null));
    return { ...day, swept, reminders };
  } finally {
    await sql.end();
  }
}
