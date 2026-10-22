import { track } from "../lib/tracker";
import { RULES, byIp, hit, peek, rateLimit, rateLimited, reset } from "../lib/throttle";
import { customerLog } from "../lib/audit";
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { hashPassword, newSessionToken, verifyPassword } from "../crypto";
import { requireDeviceSession, requireOwner } from "../session";
import { consumeAccountToken, issueAccountToken, sendPasswordChanged } from "../lib/accountMail";

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
    track(c, { [b.type === "B" ? "merchants_new_n" : b.type === "O" ? "organizations_new_n" : "users_new_n"]: 1 });   // today's running estimate
    // The verification email never holds up or undoes the sign-up.
    await issueAccountToken(c.env, sql, { id: result.accountId, type: b.type, name: b.name, email: b.email }, "verify_email", (p) => c.executionCtx.waitUntil(p)).catch((e) => console.error("verify token", e));
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

const tokenBody = z.object({ token: z.string().min(20).max(200) });

// Opening the emailed verification link. Public: the link itself is the proof.
auth.post("/verify-email", rateLimit("token-ip", RULES.tokenIp, byIp), async (c) => {
  const parsed = tokenBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const sql = c.get("sql");
  const done = await sql.begin(async (tx) => {
    const t = await consumeAccountToken(tx as unknown as typeof sql, parsed.data.token, "verify_email");
    if (!t) return null;
    // A link only verifies the address it was sent to (the account's email may have changed since).
    const [a] = await tx<{ id: string }[]>`
      update accounts set email_verified_at = coalesce(email_verified_at, now()), updated_at = now()
       where id = ${t.account_id} and lower(email) = ${t.email.toLowerCase()} returning id`;
    return a ? { accountId: a.id, email: t.email } : null;
  });
  if (!done) return c.json({ error: "invalid_token" }, 400);
  await customerLog(c, done.accountId, done.email, "customer.email_verified");
  return c.json({ verified: true });
});

// Another verification email for the signed-in owner.
auth.post("/verify-email/resend", requireDeviceSession, requireOwner, rateLimit("verify-resend", RULES.verifyResend, (c) => c.get("auth").accountId), async (c) => {
  const sql = c.get("sql");
  const [a] = await sql<{ id: string; type: string; name: string; email: string | null; email_verified_at: Date | null }[]>`
    select id, type, name, email, email_verified_at from accounts where id = ${c.get("auth").accountId}`;
  if (!a?.email) return c.json({ error: "no_email" }, 422);
  if (a.email_verified_at) return c.json({ already_verified: true });
  const sent = await issueAccountToken(c.env, sql, { id: a.id, type: a.type, name: a.name, email: a.email }, "verify_email");
  return c.json({ email: sent }, 202);
});

const resetRequestBody = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
const resetConfirmBody = z.object({ token: z.string().min(20).max(200), password: z.string().min(10).max(256) });

// Ask for a reset link. Always the same answer, known email or not, so the endpoint reveals nothing.
auth.post("/password-reset", rateLimit("reset-ip", RULES.resetIp, byIp), async (c) => {
  const parsed = resetRequestBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const email = parsed.data.email;
  const sql = c.get("sql");
  const h = await hit(sql, `reset-email:${email}`, RULES.resetEmail);
  if (h.ok) {
    const [a] = await sql<{ id: string; type: string; name: string; email: string; status: string; password_hash: string | null }[]>`
      select id, type, name, email, status, password_hash from accounts where lower(email) = ${email}`;
    if (a && a.password_hash && ["active", "pending", "declined"].includes(a.status)) {
      await customerLog(c, a.id, email, "customer.password_reset_requested");
      await issueAccountToken(c.env, sql, a, "reset_password", (p) => c.executionCtx.waitUntil(p));
    }
  }
  return c.json({ ok: true }, 202);
});

// Choose a new password with the emailed link. Signs every device out and lifts a login lock.
auth.post("/password-reset/confirm", rateLimit("token-ip", RULES.tokenIp, byIp), async (c) => {
  const parsed = resetConfirmBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.flatten() }, 400);
  const sql = c.get("sql");
  const passwordHash = await hashPassword(parsed.data.password);
  const done = await sql.begin(async (tx) => {
    const t = await consumeAccountToken(tx as unknown as typeof sql, parsed.data.token, "reset_password");
    if (!t) return null;
    const [a] = await tx<{ id: string; name: string; email: string }[]>`
      update accounts set password_hash = ${passwordHash}, email_verified_at = coalesce(email_verified_at, now()), updated_at = now()
       where id = ${t.account_id} and lower(email) = ${t.email.toLowerCase()} and status in ('active', 'pending', 'declined')
       returning id, name, email`;
    if (!a) return null;
    await tx`update devices set revoked_at = coalesce(revoked_at, now()) where account_id = ${a.id}`;
    return a;
  });
  if (!done) return c.json({ error: "invalid_token" }, 400);
  await reset(sql, `login:${done.email.toLowerCase()}`);
  await customerLog(c, done.id, done.email, "customer.password_reset");
  c.executionCtx.waitUntil(sendPasswordChanged(c.env, done).catch((e) => console.error("changed mail", e)));
  return c.json({ ok: true });
});

export { requireOwner };
