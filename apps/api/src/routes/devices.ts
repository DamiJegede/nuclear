import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { newSessionToken, verifyWalletLink } from "../crypto";
import { requireDeviceSession, requireOwner } from "../session";

export const devices = new Hono<AppContext>();

const uuid = z.string().uuid();

// Redeem is unauthenticated: the one-time link JWT is the credential.
// Explicit POST (never GET) so message-preview fetches cannot consume the link.
devices.post("/redeem", async (c) => {
  const body = z
    .object({
      token: z.string().min(20).max(2048),
      platform: z.enum(["ios", "android", "web"]).optional(),
      push_token: z.string().max(512).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);

  const claims = await verifyWalletLink(c.env.JWT_SECRET, body.data.token);
  if (!claims) return c.json({ error: "invalid_link" }, 400);

  const { token, hash } = newSessionToken();
  const sql = c.get("sql");
  // Single-use: conditional update only while unredeemed + unrevoked, owner/wallet matching the
  // JWT, and the account/wallet still active.
  const [dev] = await sql<{ id: string; wallet_id: string; session_expires_at: Date }[]>`
    update devices d
       set session_token_hash = ${hash},
           session_expires_at = now() + interval '90 days',
           last_accessed_at   = now(),
           platform           = coalesce(${body.data.platform ?? null}, d.platform),
           push_token         = coalesce(${body.data.push_token ?? null}, d.push_token)
     where d.id = ${claims.device_id}
       and d.account_id = ${claims.account_id}
       and d.wallet_id = ${claims.sub}
       and d.session_token_hash is null
       and d.revoked_at is null
       and exists (select 1
                     from wallets w join accounts a on a.id = w.account_id
                    where w.id = d.wallet_id and w.account_id = d.account_id
                      and w.status = 'active' and a.status = 'active')
    returning d.id, d.wallet_id, d.session_expires_at`;
  if (!dev) return c.json({ error: "invalid_link" }, 400);

  return c.json({
    device_id: dev.id,
    wallet_id: dev.wallet_id,
    session_token: token,
    session_expires_at: dev.session_expires_at,
  });
});

devices.use("*", requireDeviceSession);

// Called on every app launch. Rolling 90 days; never shortens expiry or clears revocation.
devices.post("/session/extend", async (c) => {
  const { deviceId } = c.get("auth");
  const [row] = await c.get("sql")<{ session_expires_at: Date }[]>`
    update devices
       set session_expires_at = greatest(session_expires_at, now() + interval '90 days'),
           last_accessed_at   = now()
     where id = ${deviceId} and revoked_at is null and session_expires_at > now()
    returning session_expires_at`;
  if (!row) return c.json({ error: "unauthorized" }, 401);
  return c.json({ session_expires_at: row.session_expires_at });
});

// Owner: list registered devices / sessions (never exposes token hashes).
devices.get("/", requireOwner, async (c) => {
  const { accountId } = c.get("auth");
  const rows = await c.get("sql")`
    select id, wallet_id, platform, created_at, last_accessed_at, session_expires_at, revoked_at,
           (session_token_hash is not null) as redeemed
      from devices where account_id = ${accountId}
     order by created_at desc, id desc limit 100`;
  return c.json({ devices: rows });
});

// Owner: revoke a device. Ownership enforced in the WHERE clause.
devices.post("/:id/revoke", requireOwner, async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const { accountId } = c.get("auth");
  const rows = await c.get("sql")`
    update devices set revoked_at = coalesce(revoked_at, now())
     where id = ${id.data} and account_id = ${accountId} returning id`;
  if (rows.length === 0) return c.json({ error: "not_found" }, 404);
  return c.body(null, 204);
});
