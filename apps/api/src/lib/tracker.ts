import type { Context } from "hono";
import type { Env } from "../env";
import { easternDate } from "./dates";
import type { Days, Deltas } from "./counters";

/**
 * Feeds today's running estimate (counters.ts). Called after a money transaction has committed, never awaited by the request: a lost or
 * failed call only makes today's estimate a little low until the nightly snapshot replaces it. Replays and declines are never tracked.
 *
 * Keys: sends_n/_v, taps_n/_v, in_app_n/_v, agents_n/_v, refunds_n/_v, loads_n/_v, purchases_n/_v, claims_n/_v, benefit_runs_n,
 * benefit_credited_v, benefit_sent_v, benefit_held_v, users_new_n, merchants_new_n, organizations_new_n (`_n` counts, `_v` cents).
 */
const shards = (env: Env) => Math.max(1, Math.min(64, Number(env.STATS_SHARDS) || 1));

const stub = (env: Env, shard: number) => env.STATS!.get(env.STATS!.idFromName(`counter-${shard}`));

const send = (env: Env, shard: number, path: string, body: unknown) =>
  stub(env, shard).fetch(`https://stats${path}`, { method: "POST", body: JSON.stringify(body) });

/** Adds to today's counters. Returns the pending promise (hand it to waitUntil) or null when no counter object is bound. */
export function trackNow(env: Env, deltas: Deltas, day = easternDate(new Date())): Promise<unknown> | null {
  if (!env.STATS) return null;
  const shard = Math.floor(Math.random() * shards(env));
  return send(env, shard, "/add", { day, deltas }).catch((e) => console.error("track failed", e));
}

/** For request handlers: fire and forget. */
export function track(c: Context, deltas: Deltas) {
  const p = trackNow(c.env as Env, deltas);
  if (!p) return;
  try { c.executionCtx.waitUntil(p); } catch { /* no execution context: the promise still runs */ }
}

/** The counters of the given days, summed across shards. Never throws: an unreachable object reads as zero. */
export async function readCounters(env: Env, days: string[]): Promise<Days> {
  const out: Days = Object.fromEntries(days.map((d) => [d, {}]));
  if (!env.STATS || days.length === 0) return out;
  const parts = await Promise.all(Array.from({ length: shards(env) }, (_, i) =>
    send(env, i, "/read", { days }).then((r) => r.json() as Promise<{ days: Days }>).catch((e) => (console.error("read counters failed", e), { days: {} as Days }))));
  for (const p of parts) for (const [d, kv] of Object.entries(p.days)) for (const [k, v] of Object.entries(kv)) out[d]![k] = (out[d]![k] ?? 0) + v;
  return out;
}

export async function pruneCounters(env: Env, before: string) {
  if (!env.STATS) return;
  await Promise.all(Array.from({ length: shards(env) }, (_, i) => send(env, i, "/prune", { before }).catch(() => null)));
}

/** Spreads of shard counts used by the probe and by normal tracking. */
export const shardCount = shards;

/**
 * A throughput probe for the counter objects (operator endpoint /v1/admin/stats/loadtest): fires `events` adds at the throwaway day "loadtest",
 * at most `width` at a time (a Worker keeps only a few connections open at once), and reports what happened. Never touches a real day.
 */
export async function probeCounters(env: Env, events: number, width = 6) {
  const times: number[] = [];
  let ok = 0, failed = 0, next = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (next < events) {
      next += 1;
      const shard = Math.floor(Math.random() * shards(env));
      const s = Date.now();
      try {
        const r = await send(env, shard, "/add", { day: "loadtest", deltas: { probe_n: 1 } });
        if (r.ok) ok += 1; else failed += 1;
      } catch { failed += 1; }
      times.push(Date.now() - s);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, events) }, worker));
  times.sort((a, b) => a - b);
  const at = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))] ?? 0;
  return { events, ok, failed, ms: Date.now() - t0, p50: at(0.5), p95: at(0.95), max: times[times.length - 1] ?? 0 };
}

export async function dropDay(env: Env, day: string) {
  if (!env.STATS) return;
  await Promise.all(Array.from({ length: shards(env) }, (_, i) => send(env, i, "/drop", { day }).catch(() => null)));
}
