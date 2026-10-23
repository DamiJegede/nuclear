import { connect } from "../db";
import type { Env } from "../env";
import { easternDate } from "./dates";
import { limiterFor, sweep } from "./throttle";
import { purge } from "./retention";
import { remindUnclaimed } from "./orgMail";
import { runDuePrograms } from "./programs";
import { pollSubmittedSettlements, runSettlement } from "./settlement";
import { refreshReconciliation } from "./statsCache";
import { reconciliationOk } from "./stats";
import { catchUpSnapshots, addDays, saveReconciliation } from "./snapshots";
import { pruneCounters } from "./tracker";

/**
 * The daily job. Cloudflare fires it at 04:00 and 05:00 UTC, which brackets midnight in New York in
 * both summer (04:00) and winter (05:00). Neither run decides anything by the clock: each works on its own program day, and the
 * jobs claim their day so the second run does nothing new. There is no daily counter reset: counters roll themselves.
 */
export async function dailyJobs(scheduledTime: number, env: Env) {
  const sql = connect(env);
  try {
    const swept = await sweep(limiterFor(env));
    // Finished sessions and used or expired links go; never blocks the rest of the job.
    const purged = await purge(sql).catch((err) => (console.error("purge failed", err), null));
    // A visible heartbeat: `select value from system where key = 'cron_last_run'` shows when the cron last fired.
    await sql`insert into system (key, value) values ('cron_last_run', ${new Date(scheduledTime).toISOString()})
              on conflict (key) do update set value = excluded.value`;
    // The monthly nudge to employees who have not claimed their employer credit (see lib/orgMail.ts); never blocks the reset.
    const reminders = await remindUnclaimed(env, sql).catch((err) => (console.error("reminders failed", err), null));
    // Fixed Benefits programs: credit what is due today (and retry or close what is waiting). Never blocks the reset.
    const programs = await runDuePrograms(env, sql, easternDate(new Date(scheduledTime))).catch((err) => (console.error("programs failed", err), null));
    // Merchant settlement: pay out (or collect) every active merchant's net for the day that just ended, and poll runs the bank still owes
    // an answer for. Never blocks the reset; the run claims its date, so the second cron of the day does nothing new.
    const settlement = await runSettlement(env, sql, easternDate(new Date(scheduledTime))).catch((err) => (console.error("settlement failed", err), null));
    const polled = await pollSubmittedSettlements(env, sql).catch((err) => (console.error("settlement poll failed", err), null));
    // The Overview's snapshots: the nightly ledger checks (the heavy scans), and a fresh set of live numbers. Never blocks the job.
    // The day that just ended becomes an exact snapshot (and any missed day before it), then the ledger checks run and are recorded on it.
    const today = easternDate(new Date(scheduledTime));
    const yesterday = addDays(today, -1);
    const snapshots = await catchUpSnapshots(sql, yesterday).catch((err) => (console.error("snapshot failed", err), [] as string[]));
    const reconciled = await refreshReconciliation(env, sql, 0).then((s) => s.reconciliation, (err) => (console.error("reconciliation failed", err), null));
    if (reconciled) {
      const ok = reconciliationOk(reconciled);
      await saveReconciliation(sql, yesterday, reconciled, ok).catch((err) => console.error("saving reconciliation failed", err));
    }
    // Yesterday's running counters are superseded by the snapshot; keep a couple of days in case the next night's cron is late.
    await pruneCounters(env, addDays(today, -3)).catch(() => null);
    return { swept, reminders, programs, settlement, polled, snapshots, reconciled, purged };
  } finally {
    await sql.end();
  }
}
