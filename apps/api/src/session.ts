import { RULES, hit, rateLimited } from "./lib/throttle";
import type { MiddlewareHandler } from "hono";
import type { AppContext, SessionKind } from "./env";
import { AGENT_KEY_PREFIX, hashToken, verifyTerminalJwt } from "./crypto";
import { connect } from "./db";

/** The only routes a pending or declined business may use. */
const PENDING_OK = new Set(["/v1/account", "/v1/account/documents", "/v1/auth/logout"]);

/** Opens one DB client per request and closes it after the response. */
export const withDb: MiddlewareHandler<AppContext> = async (c, next) => {
  const sql = connect(c.env);
  c.set("sql", sql);
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(sql.end());
  }
};

function bearer(header: string | undefined): string {
  const h = header ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

/**
 * Bearer session auth, restricted to the allowed session kinds. Current account/wallet status is
 * re-checked on every request; expiry is NOT extended here (only POST /v1/devices/session/extend
 * renews it).
 */
export function sessionGuard(...allowed: SessionKind[]): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const token = bearer(c.req.header("authorization"));
    if (!token) return c.json({ error: "unauthorized" }, 401);

    const sql = c.get("sql");

    // An agent wallet's API key: nk_agent_<random>. It acts for that wallet only, like a delegated session.
    if (token.startsWith(AGENT_KEY_PREFIX)) {
      const [k] = await sql<{ id: string; account_id: string }[]>`
        update wallets w set key_last_used_at = now()
         where w.key_hash = ${hashToken(token)} and w.status = 'active'
           and exists (select 1 from accounts a where a.id = w.account_id and a.status = 'active')
        returning w.id, w.account_id`;
      if (!k) return c.json({ error: "unauthorized" }, 401);
      if (!allowed.includes("agent")) return c.json({ error: "forbidden" }, 403);
      const rl = await hit(sql, `agent:${k.id}`, RULES.agentRequests);   // a runaway agent is slowed, not the API
      if (!rl.ok) return rateLimited(c, rl.retryAfter);
      c.set("auth", { deviceId: null, accountId: k.account_id, kind: "agent", walletId: k.id });
      return next();
    }

    const [dev] = await sql<{ id: string; account_id: string; wallet_id: string | null; account_status: string; account_type: string }[]>`
      select d.id, d.account_id, d.wallet_id, a.status as account_status, a.type as account_type
        from devices d
        join accounts a on a.id = d.account_id and a.status in ('active', 'pending', 'declined')
        left join wallets w on w.id = d.wallet_id
       where d.session_token_hash = ${hashToken(token)}
         and d.revoked_at is null
         and d.session_expires_at > now()
         and (d.wallet_id is null or w.status = 'active')`;
    if (!dev) return c.json({ error: "unauthorized" }, 401);

    const kind: SessionKind = dev.wallet_id ? "wallet" : "owner";
    if (!allowed.includes(kind)) return c.json({ error: "forbidden" }, 403);
    // A business waiting for approval (or declined) can sign in, see its status, upload documents and sign out: nothing else.
    if (dev.account_status !== "active" && !(dev.account_type === "B" && PENDING_OK.has(c.req.path.replace(/\/+$/, "")))) {
      return c.json({ error: "account_not_approved", status: dev.account_status }, 403);
    }

    c.set("auth", { deviceId: dev.id, accountId: dev.account_id, kind, walletId: dev.wallet_id });
    await sql`update devices set last_accessed_at = now() where id = ${dev.id}`;
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
