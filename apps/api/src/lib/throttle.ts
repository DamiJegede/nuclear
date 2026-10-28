import type { Context, MiddlewareHandler } from "hono";
import type { AppContext, Env } from "../env";
import { sameSecret } from "./adminAuth";

/** `limit` hits per `windowSec` seconds; the window starts at the first hit. */
export type Rule = { limit: number; windowSec: number };

/** Every limit in one place. */
export const RULES = {
  loginFailures: { limit: 5, windowSec: 15 * 60 },     // wrong passwords per email: then locked until the window ends
  loginIp: { limit: 30, windowSec: 60 },
  adminLoginIp: { limit: 20, windowSec: 60 },
  signupIp: { limit: 10, windowSec: 60 * 60 },
  redeemIp: { limit: 20, windowSec: 60 },
  tokenIp: { limit: 20, windowSec: 60 },                // opening an emailed verification or reset link
  resetIp: { limit: 10, windowSec: 60 * 60 },           // asking for a password reset email, per IP
  resetEmail: { limit: 3, windowSec: 60 * 60 },         // ... and per email address (stops mail bombing someone)
  verifyResend: { limit: 3, windowSec: 60 * 60 },       // asking for another verification email, per account
  lookupEmail: { limit: 30, windowSec: 60 * 60 },      // recipient lookup by email, per account (stops enumeration)
  lookupHandle: { limit: 60, windowSec: 60 },
  tagClaim: { limit: 20, windowSec: 60 * 60 },
  closeOut: { limit: 5, windowSec: 60 * 60 },           // a merchant closing out (one settlement a day goes through; this stops hammering)
  orbBind: { limit: 20, windowSec: 60 * 60 },           // bind authorizations per terminal
  shopOrder: { limit: 10, windowSec: 60 },
  agentRequests: { limit: 120, windowSec: 60 },         // every request by an agent key
  orgApi: { limit: 120, windowSec: 60 },                // every request by an organization Benefits API key
  agentMoney: { limit: 30, windowSec: 60 },             // sends and payments by an agent key
} satisfies Record<string, Rule>;

export type Counted = { ok: boolean; count: number; retryAfter: number };

/**
 * Fixed windows that start at the first hit. This is the pure logic; where it runs depends on the deployment: a Durable Object (`RateLimiter`,
 * lib/rateLimiter.ts) in production, so counters are shared by every Worker instance, and an in-memory instance when no object is bound (local runs
 * and tests). Nothing is stored in the database.
 */
export class Windows {
  private m = new Map<string, { count: number; start: number }>();

  hit(key: string, rule: Rule, now = Date.now()): Counted {
    let e = this.m.get(key);
    if (!e || e.start + rule.windowSec * 1000 <= now) e = { count: 0, start: now };
    e.count += 1;
    this.m.set(key, e);
    return { ok: e.count <= rule.limit, count: e.count, retryAfter: this.retry(e, rule, now) };
  }

  peek(key: string, rule: Rule, now = Date.now()): { blocked: boolean; retryAfter: number } {
    const e = this.m.get(key);
    if (!e || e.start + rule.windowSec * 1000 <= now || e.count < rule.limit) return { blocked: false, retryAfter: 0 };
    return { blocked: true, retryAfter: this.retry(e, rule, now) };
  }

  reset(key: string) { this.m.delete(key); }

  /** Forgets windows that started more than `olderThanMs` ago. */
  sweep(olderThanMs: number, now = Date.now()): number {
    let n = 0;
    for (const [k, e] of this.m) if (e.start < now - olderThanMs) { this.m.delete(k); n++; }
    return n;
  }

  /** Tests: forget every window whose key starts with `prefix` (all of them without one). */
  clear(prefix = "") { for (const k of this.keys()) if (k.startsWith(prefix)) this.m.delete(k); }
  get(key: string) { return this.m.get(key); }
  set(key: string, v: { count: number; start: number }) { this.m.set(key, v); }
  keys() { return [...this.m.keys()]; }
  size() { return this.m.size; }
  /** Tests: make every window whose key starts with `prefix` look as if it began `ms` ago. */
  age(prefix: string, ms: number) { for (const [k, e] of this.m) if (k.startsWith(prefix)) e.start -= ms; }

  private retry(e: { start: number }, rule: Rule, now: number) { return Math.max(1, Math.ceil((e.start + rule.windowSec * 1000 - now) / 1000)); }
}

/** What the routes call. */
export interface Limiter {
  hit(key: string, rule: Rule): Promise<Counted>;
  peek(key: string, rule: Rule): Promise<{ blocked: boolean; retryAfter: number }>;
  reset(key: string): Promise<void>;
  sweep(): Promise<number>;
}

export class MemoryLimiter implements Limiter {
  readonly windows = new Windows();
  async hit(key: string, rule: Rule) { return this.windows.hit(key, rule); }
  async peek(key: string, rule: Rule) { return this.windows.peek(key, rule); }
  async reset(key: string) { this.windows.reset(key); }
  async sweep() { return this.windows.sweep(86_400_000); }
}

/** The in-memory limiter used when no Durable Object is bound (one per process; tests reach into `.windows`). */
export const memoryLimiter = new MemoryLimiter();

type Namespace = NonNullable<Env["LIMITER"]>;

/** Talks to the RateLimiter Durable Objects; a key always goes to the same shard. */
export class ObjectLimiter implements Limiter {
  constructor(private ns: Namespace, private shards: number) {}
  private shardOf(key: string) { let h = 2166136261; for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0; return h % this.shards; }
  private call<T>(shard: number, body: unknown): Promise<T> {
    return this.ns.get(this.ns.idFromName(`limiter-${shard}`)).fetch("https://limiter/op", { method: "POST", body: JSON.stringify(body) }).then((r) => r.json() as Promise<T>);
  }
  hit(key: string, rule: Rule) { return this.call<Counted>(this.shardOf(key), { op: "hit", key, ...rule }); }
  peek(key: string, rule: Rule) { return this.call<{ blocked: boolean; retryAfter: number }>(this.shardOf(key), { op: "peek", key, ...rule }); }
  async reset(key: string) { await this.call(this.shardOf(key), { op: "reset", key }); }
  async sweep() { let n = 0; for (let i = 0; i < this.shards; i++) n += (await this.call<{ swept: number }>(i, { op: "sweep" })).swept; return n; }
}

/** The limiter for this deployment. A limiter failure never blocks a request: the call sites treat an unreachable limiter as "allowed". */
export function limiterFor(env: Env): Limiter {
  const n = Math.max(1, Math.min(16, Number(env.LIMITER_SHARDS) || 1));
  return env.LIMITER ? new ObjectLimiter(env.LIMITER, n) : memoryLimiter;
}

export const hit = (l: Limiter, key: string, rule: Rule) => l.hit(key, rule).catch((): Counted => ({ ok: true, count: 0, retryAfter: 0 }));
export const peek = (l: Limiter, key: string, rule: Rule) => l.peek(key, rule).catch(() => ({ blocked: false, retryAfter: 0 }));
export const reset = (l: Limiter, key: string) => l.reset(key).catch(() => undefined);
export const sweep = (l: Limiter) => l.sweep().catch(() => 0);

/** The caller's address as Cloudflare reports it. Absent when running locally or in tests: IP limits are then skipped. */
export const clientIp = (c: Context): string | null => c.req.header("cf-connecting-ip") ?? null;

export const rateLimited = (c: Context, retryAfter: number) =>
  c.json({ error: "rate_limited", retry_after: retryAfter }, 429, { "retry-after": String(retryAfter) });

/** Route middleware: counts a hit against `who(c)` (null = no limit for this caller) and answers 429 past the limit. */
export function rateLimit(name: string, rule: Rule, who: (c: Context<AppContext>) => string | null): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const id = who(c);
    if (id !== null) {
      const r = await hit(c.get("limiter"), `${name}:${id}`, rule);
      if (!r.ok) return rateLimited(c, r.retryAfter);
    }
    await next();
  };
}

/** Per-IP limits do not apply to a request carrying the operator token (`x-operator-token`, the same secret the operator scripts already hold): seeding and load scripts run from one address. */
export const byIp = (c: Context<AppContext>) => {
  const op = c.env.ADMIN_API_TOKEN, given = c.req.header("x-operator-token");
  if (op && given && sameSecret(given, op)) return null;
  return clientIp(c);
};
export const byAccount = (c: Context<AppContext>) => c.get("auth")?.accountId ?? null;
