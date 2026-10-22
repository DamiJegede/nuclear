import type { Sql } from "../db";
import type { Env } from "../env";
import { liveStats, reconciliationStats, type LiveStats, type Reconciliation, type SystemStats } from "./stats";
import { overviewStats } from "./snapshots";

/**
 * Snapshots of the admin Overview, kept in the `system` key/value table (no table of its own).
 *
 *   stats_snapshot            the live numbers (counts and sums over every transaction). Refreshed on demand when older than the TTL
 *                             (default 5 minutes, env STATS_TTL_SECONDS); one request wins the refresh, everyone else keeps reading the
 *                             previous snapshot, so a crowd of admins (or the Overview's own 60 s polling) costs one computation.
 *   reconciliation_snapshot   the ledger checks (full ledger scans). Never computed by a read once a snapshot exists: the nightly job
 *                             refreshes it and an admin can press Run Check (at most once a minute).
 *
 * Two modes. Normal: the live numbers are the latest daily snapshot plus today's running estimate (snapshots.ts), which never scans history, so
 * there is nothing to cache or refresh and the Refresh button just re-reads. STATS_TTL_SECONDS=0 switches to the old exact mode (every read
 * computes everything live, scanning all transactions): for tests and tiny deployments.
 */
const LIVE = "stats_snapshot";
const RECON = "reconciliation_snapshot";
const DEFAULT_TTL_S = 300;
const RECON_MIN_AGE_S = 60;          // nor Run Check
const RECON_STALE_AFTER_S = 26 * 3600;

type Row = { value: string; ts: string; age: number };

const ttl = (env: Env) => {
  const n = Number(env.STATS_TTL_SECONDS);
  return env.STATS_TTL_SECONDS !== undefined && Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_S;
};

const read = async (sql: Sql, key: string): Promise<Row | null> => {
  const [r] = await sql<Row[]>`select value, updated_at::text as ts, extract(epoch from (now() - updated_at))::float8 as age from system where key = ${key}`;
  return r ?? null;
};

const save = (sql: Sql, key: string, value: unknown) => sql`
  insert into system (key, value) values (${key}, ${JSON.stringify(value)})
  on conflict (key) do update set value = excluded.value, updated_at = now()`;

/**
 * Returns the snapshot for `key`, recomputing it when it is older than `maxAge` seconds. The caller that recomputes first claims the row
 * (a compare-and-set on updated_at, compared as text so no precision is lost), so concurrent callers return the previous value instead of repeating the work.
 */
async function snapshot<T>(sql: Sql, key: string, maxAge: number, compute: () => Promise<T>): Promise<{ value: T; ageS: number }> {
  const row = await read(sql, key);
  if (row && row.age < maxAge) return { value: JSON.parse(row.value) as T, ageS: row.age };
  if (row) {
    const claimed = await sql`update system set updated_at = now() where key = ${key} and updated_at::text = ${row.ts} returning key`;
    if (claimed.length === 0) return { value: JSON.parse(row.value) as T, ageS: row.age };   // someone else is refreshing it
    try {
      const value = await compute();
      await save(sql, key, value);
      return { value, ageS: 0 };
    } catch (err) {
      console.error("stats refresh failed", key, err);
      return { value: JSON.parse(row.value) as T, ageS: row.age };                          // serve the old numbers rather than none
    }
  }
  const value = await compute();                                                            // the very first time
  await save(sql, key, value);
  return { value, ageS: 0 };
}

const withMeta = (live: LiveStats, rec: { value: Reconciliation; ageS: number; checkedAt: string }): SystemStats => ({
  ...live,
  reconciliation: rec.value,
  reconciliation_checked_at: rec.checkedAt,
  reconciliation_stale: rec.ageS > RECON_STALE_AFTER_S,
});

/** The Overview numbers, from the snapshots. */
export async function readStats(env: Env, sql: Sql): Promise<SystemStats> {
  const t = ttl(env);
  const live = t === 0 ? await snapshot(sql, LIVE, 0, () => liveStats(sql)) : { value: await overviewStats(env, sql), ageS: 0 };
  // With caching off the checks are computed too; otherwise they only appear when they exist (or the first time ever).
  const rec = await snapshot(sql, RECON, t === 0 ? 0 : Number.POSITIVE_INFINITY, async () => ({ ...(await reconciliationStats(sql)), checked_at: new Date().toISOString() }));
  const { checked_at, ...checks } = rec.value as Reconciliation & { checked_at: string };
  return withMeta(live.value, { value: checks as Reconciliation, ageS: rec.ageS, checkedAt: checked_at });
}

/** The Refresh button: recompute the live numbers now, unless they are only seconds old. */
export async function refreshLive(env: Env, sql: Sql): Promise<SystemStats> {
  if (ttl(env) === 0) await snapshot(sql, LIVE, 0, () => liveStats(sql));      // exact mode only; the normal mode has nothing to recompute
  return readStats(env, sql);
}

/** Run Check, and the nightly job: recompute the ledger checks, unless they were just computed. */
export async function refreshReconciliation(env: Env, sql: Sql, minAgeS = RECON_MIN_AGE_S): Promise<SystemStats> {
  await snapshot(sql, RECON, ttl(env) === 0 ? 0 : minAgeS, async () => ({ ...(await reconciliationStats(sql)), checked_at: new Date().toISOString() }));
  return readStats(env, sql);
}
