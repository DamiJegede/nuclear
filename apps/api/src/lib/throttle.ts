import type { Context, MiddlewareHandler } from "hono";
import type { Sql } from "../db";
import type { AppContext } from "../env";

/** `limit` hits per `windowSec` seconds; the window starts at the first hit. */
export type Rule = { limit: number; windowSec: number };

/** Every limit in one place. */
export const RULES = {
  loginFailures: { limit: 5, windowSec: 15 * 60 },     // wrong passwords per email: then locked until the window ends
  loginIp: { limit: 30, windowSec: 60 },
  adminLoginIp: { limit: 20, windowSec: 60 },
  signupIp: { limit: 10, windowSec: 60 * 60 },
  redeemIp: { limit: 20, windowSec: 60 },
  lookupEmail: { limit: 30, windowSec: 60 * 60 },      // recipient lookup by email, per account (stops enumeration)
  lookupHandle: { limit: 60, windowSec: 60 },
  tagClaim: { limit: 20, windowSec: 60 * 60 },
  shopOrder: { limit: 10, windowSec: 60 },
  agentRequests: { limit: 120, windowSec: 60 },         // every request by an agent key
  agentMoney: { limit: 30, windowSec: 60 },             // sends and payments by an agent key
} satisfies Record<string, Rule>;

type Counted = { ok: boolean; count: number; retryAfter: number };

/** Counts one hit. `ok` is false once the count passes the limit. */
export async function hit(sql: Sql, key: string, rule: Rule): Promise<Counted> {
  const [r] = await sql<{ count: number; retry: number }[]>`
    insert into throttles (key, count, window_start) values (${key}, 1, now())
    on conflict (key) do update set
      count = case when throttles.window_start <= now() - make_interval(secs => ${rule.windowSec}) then 1 else throttles.count + 1 end,
      window_start = case when throttles.window_start <= now() - make_interval(secs => ${rule.windowSec}) then now() else throttles.window_start end
    returning count, greatest(1, ceil(extract(epoch from (window_start + make_interval(secs => ${rule.windowSec}) - now()))))::int as retry`;
  return { ok: r!.count <= rule.limit, count: r!.count, retryAfter: r!.retry };
}

/** Reads the count without adding a hit. `blocked` once `limit` hits are already recorded. */
export async function peek(sql: Sql, key: string, rule: Rule): Promise<{ blocked: boolean; retryAfter: number }> {
  const [r] = await sql<{ count: number; retry: number }[]>`
    select count, greatest(1, ceil(extract(epoch from (window_start + make_interval(secs => ${rule.windowSec}) - now()))))::int as retry
      from throttles where key = ${key} and window_start > now() - make_interval(secs => ${rule.windowSec})`;
  return r && r.count >= rule.limit ? { blocked: true, retryAfter: r.retry } : { blocked: false, retryAfter: 0 };
}

export const reset = (sql: Sql, key: string) => sql`delete from throttles where key = ${key}`;

/** Removes counters whose window ended long ago (the daily job calls this). */
export async function sweep(sql: Sql): Promise<number> {
  const rows = await sql`delete from throttles where window_start < now() - interval '1 day' returning key`;
  return rows.length;
}

/** The caller's address as Cloudflare reports it. Absent when running locally or in tests: IP limits are then skipped. */
export const clientIp = (c: Context): string | null => c.req.header("cf-connecting-ip") ?? null;

export const rateLimited = (c: Context, retryAfter: number) =>
  c.json({ error: "rate_limited", retry_after: retryAfter }, 429, { "retry-after": String(retryAfter) });

/** Route middleware: counts a hit against `who(c)` (null = no limit for this caller) and answers 429 past the limit. */
export function rateLimit(name: string, rule: Rule, who: (c: Context<AppContext>) => string | null): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const id = who(c);
    if (id !== null) {
      const r = await hit(c.get("sql"), `${name}:${id}`, rule);
      if (!r.ok) return rateLimited(c, r.retryAfter);
    }
    await next();
  };
}

export const byIp = (c: Context<AppContext>) => clientIp(c);
export const byAccount = (c: Context<AppContext>) => c.get("auth")?.accountId ?? null;
