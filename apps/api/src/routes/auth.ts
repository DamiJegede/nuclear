import { RULES, byIp, hit, peek, rateLimit, rateLimited, reset } from "../lib/throttle";
import { customerLog } from "../lib/audit";
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { hashPassword, newSessionToken, verifyPassword } from "../crypto";
import { requireDeviceSession, requireOwner } from "../session";

export const auth = new Hono<AppContext>();

const platform = z.enum(["ios", "android", "web"]);

const signupBody = z.object({
  type: z.enum(["C", "B", "O"]).default("C"),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().max(32).optional(),
  password: z.string().min(10).max(256),
  platform: platform.optional(),
  push_token: z.string().max(512).optional(),
});

const loginBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(256),
  platform: platform.optional(),
  push_token: z.string().max(512).optional(),
});

// Precomputed hash so unknown-email logins cost the same as wrong-password logins.
const DUMMY_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

auth.post("/signup", rateLimit("signup", RULES.signupIp, byIp), async (c) => {
  const parsed = signupBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.flatten() }, 400);
  const b = parsed.data;
  const sql = c.get("sql");
  const passwordHash = await hashPassword(b.password);
  const { token, hash } = newSessionToken();

  try {
    const result = await sql.begin(async (tx) => {
      const [acct] = await tx<{ id: string }[]>`
        insert into accounts (type, name, email, phone, password_hash, status)
        values (${b.type}, ${b.name}, ${b.email}, ${b.phone ?? null}, ${passwordHash}, ${b.type === "B" ? "pending" : "active"})
        returning id`;
      const accountId = acct!.id;
      await tx`insert into balances (account_id) values (${accountId})`;
      // An organization starts with a Benefits program row: Flexible, not chosen yet (the portal asks right after sign-up).
      if (b.type === "O") await tx`insert into benefit_programs (org_account_id) values (${accountId})`;
      const [wallet] = await tx<{ id: string }[]>`
        insert into wallets (account_id, display_name, type)
        values (${accountId}, ${b.name}, 'default') returning id`;
      const [dev] = await tx<{ id: string; session_expires_at: Date }[]>`
        insert into devices (account_id, platform, push_token, session_token_hash,
                             session_expires_at, last_accessed_at)
        values (${accountId}, ${b.platform ?? null}, ${b.push_token ?? null}, ${hash},
                now() + interval '90 days', now())
        returning id, session_expires_at`;
      return { accountId, walletId: wallet!.id, device: dev! };
    });
    await customerLog(c, result.accountId, b.email, "customer.signed_up", { type: b.type });
    return c.json(
      {
        account_id: result.accountId,
        default_wallet_id: result.walletId,
        device_id: result.device.id,
        session_token: token,
        session_expires_at: result.device.session_expires_at,
      },
      201,
    );
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return c.json({ error: "email_taken" }, 409);
    throw err;
  }
});

auth.post("/login", rateLimit("login-ip", RULES.loginIp, byIp), async (c) => {
  const parsed = loginBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const b = parsed.data;
  const sql = c.get("sql");

  // Wrong passwords are counted per email (known or not, so the answer reveals nothing); after five in
  // 15 minutes the email is locked until the window ends, even for the right password.
  const failKey = `login:${b.email}`;
  const lock = await peek(sql, failKey, RULES.loginFailures);
  if (lock.blocked) return rateLimited(c, lock.retryAfter);

  const [acct] = await sql<{ id: string; password_hash: string | null; status: string }[]>`
    select id, password_hash, status from accounts where lower(email) = ${b.email}`;
  const ok = await verifyPassword(b.password, acct?.password_hash ?? DUMMY_HASH);
  if (!acct || !acct.password_hash || !ok || !["active", "pending", "declined"].includes(acct.status)) {
    const h = await hit(sql, failKey, RULES.loginFailures);
    if (acct) await customerLog(c, acct.id, b.email, "customer.login_failed", { locked: !h.ok });
    return c.json({ error: "invalid_credentials" }, 401);
  }
  await reset(sql, failKey);

  const { token, hash } = newSessionToken();
  const [dev] = await sql<{ id: string; session_expires_at: Date }[]>`
    insert into devices (account_id, platform, push_token, session_token_hash,
                         session_expires_at, last_accessed_at)
    values (${acct.id}, ${b.platform ?? null}, ${b.push_token ?? null}, ${hash},
            now() + interval '90 days', now())
    returning id, session_expires_at`;
  await customerLog(c, acct.id, b.email, "customer.login", { device_id: dev!.id });
  return c.json({
    account_id: acct.id,
    device_id: dev!.id,
    session_token: token,
    session_expires_at: dev!.session_expires_at,
  });
});

auth.post("/logout", requireDeviceSession, async (c) => {
  const { deviceId, accountId } = c.get("auth");
  await customerLog(c, accountId, null, "customer.logout", { device_id: deviceId });
  // revoked_at only; session_token_hash is never reset (would reopen redemption).
  await c.get("sql")`update devices set revoked_at = coalesce(revoked_at, now()) where id = ${deviceId}`;
  return c.body(null, 204);
});

export { requireOwner };
