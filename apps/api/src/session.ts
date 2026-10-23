import { RULES, hit, limiterFor, rateLimited } from "./lib/throttle";
import type { MiddlewareHandler } from "hono";
import type { AppContext, SessionKind } from "./env";
import { AGENT_KEY_PREFIX, hashToken, verifySession, verifyTerminalJwt } from "./crypto";
import { connect } from "./db";

/** The only routes a pending or declined business may use. */
const PENDING_OK = new Set(["/v1/account", "/v1/account/documents", "/v1/auth/logout", "/v1/auth/verify-email/resend"]);

/** Opens one DB client per request and closes it after the response. */
export const withDb: MiddlewareHandler<AppContext> = async (c, next) => {
  const sql = connect(c.env);
  c.set("sql", sql);
  c.set("limiter", limiterFor(c.env));
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(sql.end());
  }
};

/**
 * The customer requests that skip the database entirely (a consumer's signed token is enough): the hot reads and the money moves. The money
 * functions check the device row inside their own call, so a revoked device cannot move money even though its reads still work until the
 * token expires (docs/SCHEME-V2.md, section 7: accepted). Everything not listed here also reads the device row.
 */
const LIGHT: [string, RegExp][] = [
  ["GET", /^\/v1\/(balance|activity|wallets|tags)\/?$/],
  ["GET", /^\/v1\/(payments|transfers)\/[0-9a-f-]{36}\/?$/],
  ["POST", /^\/v1\/(payments|transfers)\/?$/],
  ["POST", /^\/v1\/shop\/orders\/?$/],
];
const isLight = (method: string, path: string) => LIGHT.some(([m, re]) => m === method && re.test(path));

function bearer(header: string | undefined): string {
  const h = header ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

/**
 * Bearer session auth, restricted to the allowed session kinds. A signed token (no database read) carries the hot paths; the rest also
 * read the device row and the account on every request. Expiry is NOT extended here (only POST /v1/auth/refresh renews it).
 */
export function sessionGuard(...allowed: SessionKind[]): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const token = bearer(c.req.header("authorization"));
    if (!token) return c.json({ error: "unauthorized" }, 401);

    const sql = c.get("sql");

    // An agent wallet's API key: nk_agent_<random>. It acts for that wallet only, like a delegated session.
    if (token.startsWith(AGENT_KEY_PREFIX)) {
      // One statement; the key's last use is stamped at most once a minute (a row is not rewritten on every request).
      const [k] = await sql<{ id: string; account_id: string }[]>`
        with k as (
          select w.id, w.account_id from wallets w
           where w.key_hash = ${hashToken(token)} and w.status = 'active'
             and exists (select 1 from accounts a where a.id = w.account_id and a.status = 'active')),
        u as (
          update wallets set key_last_used_at = now()
           where id in (select id from k) and (key_last_used_at is null or key_last_used_at < now() - interval '1 minute'))
        select id, account_id from k`;
      if (!k) return c.json({ error: "unauthorized" }, 401);
      if (!allowed.includes("agent")) return c.json({ error: "forbidden" }, 403);
      const rl = await hit(c.get("limiter"), `agent:${k.id}`, RULES.agentRequests);   // a runaway agent is slowed, not the API
      if (!rl.ok) return rateLimited(c, rl.retryAfter);
      c.set("auth", { deviceId: null, accountId: k.account_id, kind: "agent", walletId: k.id });
      return next();
    }

    // A signed session token: the signature and expiry are checked here, with no database read, for the hot paths (see LIGHT).
    const claims = await verifySession(c.env.JWT_SECRET, token);
    if (!claims) return c.json({ error: "unauthorized" }, 401);
    const kind: SessionKind = claims.kind;
    if (!allowed.includes(kind)) return c.json({ error: "forbidden" }, 403);

    // Everything else also reads the device row and the account (a primary-key read, no write): a revoked or expired device, a suspended
    // account and a business that is not approved are refused at once. Businesses, organizations and delegated wallet devices always take this path.
    if (claims.typ !== "C" || kind === "wallet" || !isLight(c.req.method, c.req.path)) {
      const [dev] = await sql<{ account_status: string; account_type: string; wallet_ok: boolean }[]>`
        select a.status as account_status, a.type as account_type,
               (d.wallet_id is null or exists (select 1 from wallets w where w.id = d.wallet_id and w.status = 'active')) as wallet_ok
          from devices d join accounts a on a.id = d.account_id
         where d.id = ${claims.sid} and d.account_id = ${claims.sub}
           and d.revoked_at is null and d.session_expires_at > now()
           and a.status in ('active', 'pending', 'declined')`;
      if (!dev || !dev.wallet_ok) return c.json({ error: "unauthorized" }, 401);
      // A business waiting for approval (or declined) can sign in, see its status, upload documents and sign out: nothing else.
      if (dev.account_status !== "active" && !(dev.account_type === "B" && PENDING_OK.has(c.req.path.replace(/\/+$/, "")))) {
        return c.json({ error: "account_not_approved", status: dev.account_status }, 403);
      }
    }

    c.set("auth", { deviceId: claims.sid, accountId: claims.sub, kind, walletId: claims.wid });
    await next();
  };
}

/** Customer-facing endpoints, and logout/extend: the account holder or a delegated wallet device. */
export const requireSession = sessionGuard("owner", "wallet", "agent");

/** Endpoints tied to a device (sessions, logout): people only, never an agent key. */
export const requireDeviceSession = sessionGuard("owner", "wallet");

/** Owner-only endpoints: the primary holder's own login, never a delegated wallet device. */
export const requireOwner: MiddlewareHandler<AppContext> = async (c, next) => {
  if (c.get("auth").kind !== "owner") return c.json({ error: "forbidden" }, 403);
  await next();
};

/**
 * Merchant terminal auth: a signed JWT (HS256, own expiry) whose hash must equal the terminal's
 * current session_token_hash. Terminals are not devices and carry no owner/wallet powers; a device
 * session token never validates here, and a terminal JWT never validates as a device session.
 */
export const requireTerminal: MiddlewareHandler<AppContext> = async (c, next) => {
  const token = bearer(c.req.header("authorization"));
  if (!token) return c.json({ error: "unauthorized" }, 401);
  const claims = await verifyTerminalJwt(c.env.JWT_SECRET, token);
  if (!claims) return c.json({ error: "unauthorized" }, 401);

  const [t] = await c.get("sql")<{ id: string; account_id: string; allow_refunds: boolean }[]>`
    select t.id, t.account_id, t.allow_refunds
      from terminals t join accounts a on a.id = t.account_id and a.status = 'active' and a.type = 'B'
     where t.id = ${claims.terminalId} and t.account_id = ${claims.accountId}
       and t.session_token_hash = ${hashToken(token)}`;
  if (!t) return c.json({ error: "unauthorized" }, 401);

  c.set("terminal", { terminalId: t.id, accountId: t.account_id, allowRefunds: t.allow_refunds });
  await next();
};
