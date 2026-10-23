import { RULES, byIp, rateLimit } from "../lib/throttle";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { uuid } from "../lib/validate";
import type { AppContext } from "../env";
import { amountOrZero, n } from "../lib/money";
import { achProvider } from "../lib/ach";
import { easternDate } from "../lib/dailyReset";
import { confirmSettlement, runSettlement } from "../lib/settlement";
import { SETTLEMENT_ADMINS, SHOP_WRITERS, MERCHANT_ADMINS, MERCHANT_WRITERS, PAGES, USER_ADMINS, USER_WRITERS, ROLES, ROLE_PAGES, TAG_WRITERS, canSee, isRole, landing, type Page, type Role } from "../lib/roles";
import { approvePending, rejectPending } from "../lib/refund";
import { clientIp, reset as resetThrottle } from "../lib/throttle";
import { adminLog, log } from "../lib/audit";
import { saveProfilePhoto } from "../lib/profilePhoto";
import { approvedEmail, declinedEmail, sendMail } from "../lib/email";
import { MAX_DOWNLOAD_BYTES, deleteUpload, downloadExt, getUpload, mimeOfPath, putUpload } from "../lib/uploads";
import { deleteImage, imageUrl, isPng, newImageKey, putPng, MAX_IMAGE_BYTES } from "../lib/images";
import { USER_TX_KINDS, userDetail, userDevices, userFunding, userOrders, userTags, userTransactions, userWallets, type UserTxKind } from "../lib/userSupport";
import { MERCHANT_TX_KINDS, merchantDetail, merchantProducts, merchantStaff, merchantTerminals, merchantTransactions, type MerchantTxKind } from "../lib/merchantSupport";
import { organizationDetail, organizationEmployees, organizationList, organizationRuns } from "../lib/orgSupport";
import { TX_KINDS, merchantList, transactionFeed, userList, type TxKind } from "../lib/adminLists";
import { decodeTimeCursor, pageLimit } from "../lib/paging";
import { dropDay, probeCounters, readCounters, shardCount, track } from "../lib/tracker";
import { readStats, refreshLive, refreshReconciliation } from "../lib/statsCache";
import { MFA_CHALLENGE_SECONDS, hashPassword, signMfaChallenge, verifyMfaChallenge } from "../crypto"; // hashing helpers are shared with customer accounts
import {
  ACCESS_TOKEN_LENGTH, completeMfa, findSession, generateAccessId, generateAccessToken, login, mfaEnable,
  mfaNewRecoveryCodes, mfaSetup, revokeSessions, sameSecret, type Session,
} from "../lib/adminAuth";

// Admin area. Two ways in:
//   - a person signs in to the portal with their own access ID and access token (POST /login), then
//     a code from their authenticator, and sends the resulting session token;
//   - scripts send the operator token (ADMIN_API_TOKEN), which also creates and manages the admin
//     accounts too (a signed-in admin can also create admins).
// Not account sessions: nothing here is reachable with a customer or terminal token.

export const admin = new Hono<AppContext>();

// The admin portal is a browser app on its own origin. Only origins listed in ADMIN_ORIGINS
// (comma-separated) get CORS headers; with none configured, browsers are refused. This runs before
// the token check so preflight requests (which carry no token) succeed.
admin.use(
  "*",
  cors({
    origin: (origin, c) => {
      const allowed = (c.env.ADMIN_ORIGINS ?? "").split(",").map((o: string) => o.trim()).filter(Boolean);
      return allowed.includes(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
    allowHeaders: ["authorization", "content-type"],
    maxAge: 600,
  }),
);

const bearer = (h: string | undefined) => (h ?? "").startsWith("Bearer ") ? (h as string).slice(7).trim() : "";

// ---- Sign-in (public) -------------------------------------------------------------------------

const loginBody = z.object({ access_id: z.string().trim().min(1).max(64), access_token: z.string().length(ACCESS_TOKEN_LENGTH) });

/** What the portal needs to know about a role: the pages to show and where to land. */
const roleJson = (role: Role) => ({ role, pages: ROLE_PAGES[role], landing: landing(role) });

const sessionJson = (r: Session) => ({
  session_token: r.token,
  expires_at: r.expiresAt,
  admin: { access_id: r.admin.access_id, name: r.admin.name, role: r.admin.role },
  ...roleJson(r.admin.role),
  mfa_enabled: r.admin.mfa_enabled,
});

// Step one: access ID and access token. With MFA enrolled the answer is a short-lived challenge
// instead of a session.
admin.post("/login", rateLimit("admin-login-ip", RULES.adminLoginIp, byIp), async (c) => {
  const body = loginBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const r = await login(c.get("sql"), body.data.access_id.toUpperCase(), body.data.access_token);
  // One answer for every failure: unknown id, wrong access token, disabled or locked.
  if (r.ok === false) {
    await log(c.get("sql"), { actor: { type: "admin", label: body.data.access_id.toUpperCase() }, action: "admin.login_failed", ip: clientIp(c) });
    return c.json({ error: "invalid_credentials" }, 401);
  }
  if (r.ok === "mfa") {
    return c.json({
      mfa_required: true,
      mfa_token: await signMfaChallenge(c.env.JWT_SECRET, r.adminId),
      expires_in: MFA_CHALLENGE_SECONDS,
    });
  }
  await log(c.get("sql"), { actor: { type: "admin", id: r.admin.id, label: r.admin.access_id }, action: "admin.login", target: { type: "admin", id: r.admin.id, label: r.admin.access_id }, ip: clientIp(c) });
  return c.json(sessionJson(r));
});

// Step two: the 6-digit authenticator code, or one recovery code.
const mfaLoginBody = z.object({ mfa_token: z.string().min(20).max(2048), code: z.string().trim().min(6).max(32) });

admin.post("/login/mfa", rateLimit("admin-login-ip", RULES.adminLoginIp, byIp), async (c) => {
  const body = mfaLoginBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const adminId = await verifyMfaChallenge(c.env.JWT_SECRET, body.data.mfa_token);
  if (!adminId) return c.json({ error: "invalid_credentials" }, 401);
  const r = await completeMfa(c.get("sql"), c.env, adminId, body.data.code);
  if (r.ok === "unavailable") return c.json({ error: "mfa_unavailable" }, 503);
  if (r.ok === false) {
    await log(c.get("sql"), { actor: { type: "admin", id: adminId }, action: "admin.mfa_failed", target: { type: "admin", id: adminId }, ip: clientIp(c) });
    return c.json({ error: "invalid_credentials" }, 401);
  }
  await log(c.get("sql"), { actor: { type: "admin", id: r.admin.id, label: r.admin.access_id }, action: "admin.login", target: { type: "admin", id: r.admin.id, label: r.admin.access_id }, details: { mfa: true }, ip: clientIp(c) });
  return c.json(sessionJson(r));
});

// ---- Everything below needs the operator token or a signed-in admin ---------------------------

admin.use("*", async (c, next) => {
  const token = bearer(c.req.header("authorization"));
  if (!token) return c.json({ error: "unauthorized" }, 401);

  const op = c.env.ADMIN_API_TOKEN;
  if (op && sameSecret(token, op)) {
    c.set("adminAuth", { kind: "operator" });
    return next();
  }

  const s = await findSession(c.get("sql"), token);
  if (!s) return c.json({ error: "unauthorized" }, 401);
  c.set("adminAuth", {
    kind: "admin", adminId: s.admin_id, accessId: s.access_id, name: s.name, role: s.role,
    sessionId: s.session_id, mfaEnabled: s.mfa_enabled,
  });

  // The authenticator must be enrolled before anything else (multi-factor is mandatory).
  const path = c.req.path;
  const open = ["/v1/admin/me", "/v1/admin/logout"];
  if (!s.mfa_enabled && ![...open, "/v1/admin/mfa/setup", "/v1/admin/mfa/enable"].includes(path)) {
    return c.json({ error: "mfa_setup_required" }, 403);
  }
  return next();
});

/** Operator-only: changing existing admin accounts is not something a signed-in admin can do (yet). */
const requireOperator = async (c: any, next: any) => {
  if (c.get("adminAuth").kind !== "operator") return c.json({ error: "forbidden" }, 403);
  await next();
};

// ---- Roles: which routes each role may use (the operator token counts as admin) ------------------
const requirePage = (page: Page) => async (c: any, next: any) => {
  const a = c.get("adminAuth");
  if (a.kind === "admin" && !canSee(a.role, page)) return c.json({ error: "forbidden_role" }, 403);
  await next();
};
/** Reading tags needs the Tags page; changing them needs a role that manages tags. */
const tagsAccess = async (c: any, next: any) => {
  const a = c.get("adminAuth");
  if (a.kind === "admin") {
    if (!canSee(a.role, "tags")) return c.json({ error: "forbidden_role" }, 403);
    if (c.req.method !== "GET" && !TAG_WRITERS.includes(a.role)) return c.json({ error: "forbidden_role" }, 403);
  }
  await next();
};
admin.use("/stats", requirePage("overview"));
admin.use("/stats/*", requirePage("overview"));
admin.use("/merchants", requirePage("merchants"));
admin.use("/merchants/*", requirePage("merchants"));
admin.use("/terminals/*", requirePage("merchants"));
admin.use("/organizations", requirePage("organizations"));
admin.use("/organizations/*", requirePage("organizations"));
admin.use("/users", requirePage("users"));
admin.use("/users/*", requirePage("users"));
admin.use("/wallets/*", requirePage("users"));
admin.use("/transactions", requirePage("transactions"));
admin.use("/settlements", requirePage("transactions"));
admin.use("/settlements/*", requirePage("transactions"));
admin.use("/admins", requirePage("admins"));
admin.use("/admins/*", requirePage("admins"));
/** Shop items: Admin and Sales may change them, everyone with the Shop page may look. */
const shopAccess = async (c: any, next: any) => {
  const a = c.get("adminAuth");
  if (a.kind === "admin") {
    if (!canSee(a.role, "shop")) return c.json({ error: "forbidden_role" }, 403);
    if (c.req.method !== "GET" && !SHOP_WRITERS.includes(a.role)) return c.json({ error: "forbidden_role" }, 403);
  }
  await next();
};
admin.use("/shop-items", shopAccess);
admin.use("/shop-items/*", shopAccess);
admin.use("/logs", requirePage("audit"));
admin.use("/tag-models", tagsAccess);
admin.use("/tag-models/*", tagsAccess);

admin.get("/me", (c) => {
  const a = c.get("adminAuth");
  return c.json(
    a.kind === "operator"
      ? { operator: true, ...roleJson("admin") }
      : { access_id: a.accessId, name: a.name, ...roleJson(a.role), mfa_enabled: a.mfaEnabled },
  );
});

admin.post("/logout", async (c) => {
  const a = c.get("adminAuth");
  if (a.kind === "admin") {
    await c.get("sql")`update admin_sessions set revoked_at = now() where id = ${a.sessionId}`;
    await adminLog(c, "admin.logout", { type: "admin", id: a.adminId, label: a.accessId });
  }
  return c.body(null, 204);
});

// ---- Multi-factor enrollment (a signed-in admin) ----------------------------------------------
// The portal shows the otpauth URI as a QR code and the secret for manual entry. Nothing is active
// until a code from the new authenticator is confirmed.

const personOnly = (c: any): { adminId: string; accessId: string; sessionId: string } | null => {
  const a = c.get("adminAuth");
  return a.kind === "admin" ? a : null;
};
const codeBody = z.object({ code: z.string().trim().min(6).max(32) });

admin.post("/mfa/setup", async (c) => {
  const a = personOnly(c);
  if (!a) return c.json({ error: "forbidden" }, 403);
  if (!c.env.MFA_ENCRYPTION_KEY) return c.json({ error: "mfa_unavailable" }, 503);
  const r = await mfaSetup(c.get("sql"), c.env, a.adminId, a.accessId);
  if ("error" in r) return c.json({ error: r.error }, r.error === "already_enrolled" ? 409 : 404);
  return c.json({ secret: r.secret, otpauth_uri: r.uri });
});

admin.post("/mfa/enable", async (c) => {
  const a = personOnly(c);
  if (!a) return c.json({ error: "forbidden" }, 403);
  if (!c.env.MFA_ENCRYPTION_KEY) return c.json({ error: "mfa_unavailable" }, 503);
  const body = codeBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const r = await mfaEnable(c.get("sql"), c.env, a.adminId, body.data.code, a.sessionId);
  if ("error" in r) {
    const status = r.error === "invalid_code" ? 401 : r.error === "already_enrolled" ? 409 : 400;
    return c.json({ error: r.error }, status);
  }
  await adminLog(c, "admin.mfa_enabled", { type: "admin", id: a.adminId, label: a.accessId });
  return c.json({ recovery_codes: r.recoveryCodes });
});

// New recovery codes (the old ones stop working). Needs a current authenticator code.
admin.post("/mfa/recovery-codes", async (c) => {
  const a = personOnly(c);
  if (!a) return c.json({ error: "forbidden" }, 403);
  if (!c.env.MFA_ENCRYPTION_KEY) return c.json({ error: "mfa_unavailable" }, 503);
  const body = codeBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const r = await mfaNewRecoveryCodes(c.get("sql"), c.env, a.adminId, body.data.code);
  if ("error" in r) return c.json({ error: r.error }, r.error === "invalid_code" ? 401 : 400);
  await adminLog(c, "admin.recovery_codes_regenerated", { type: "admin", id: a.adminId, label: a.accessId });
  return c.json({ recovery_codes: r.recoveryCodes });
});

// ---- Admin accounts ---------------------------------------------------------------------------
// Creating admins and seeing the list is open to the operator token and to any fully signed-in admin.
// Disabling, resetting and similar changes stay with the operator (the scripts).

/** The operator, or an admin whose session is fully open (the gating above already ensures that). */
const requireStaff = async (c: any, next: any) => {
  const a = c.get("adminAuth");
  if (a.kind !== "operator" && a.kind !== "admin") return c.json({ error: "forbidden" }, 403);
  await next();
};

const newAdminBody = z.object({ name: z.string().trim().min(1).max(80), role: z.enum(ROLES).default("admin") });

// The server generates the Access ID (12 characters, uppercase) and the access token (32 characters).
// The token is returned here, once, and only its hash is stored: it can never be shown again.
admin.post("/admins", requireStaff, async (c) => {
  const body = newAdminBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const by = c.get("adminAuth");
  const sql = c.get("sql");
  const accessToken = generateAccessToken();
  const hash = await hashPassword(accessToken);

  for (let attempt = 0; attempt < 5; attempt++) {
    const accessId = generateAccessId();
    try {
      const [a] = await sql<{ id: string; access_id: string; name: string; role: Role }[]>`
        insert into admins (access_id, name, role, access_token_hash, created_by)
        values (${accessId}, ${body.data.name}, ${body.data.role}, ${hash}, ${by.kind === "admin" ? by.adminId : null})
        returning id, access_id, name, role`;
      await adminLog(c, "admin.created", { type: "admin", id: a!.id, label: a!.access_id }, { name: a!.name, role: a!.role });
      return c.json(
        {
          admin: { ...a, status: "active" },
          credentials: { access_id: a!.access_id, access_token: accessToken },
        },
        201,
      );
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err; // an ID collision: draw another
    }
  }
  return c.json({ error: "try_again" }, 503);
});

admin.get("/admins", requireStaff, async (c) => {
  const rows = await c.get("sql")`
    select a.id, a.access_id, a.name, a.role, a.status, a.last_login_at, a.created_at,
           (a.mfa_enabled_at is not null) as mfa_enabled,
           (a.locked_until is not null and a.locked_until > now()) as locked,
           c.access_id as created_by
      from admins a left join admins c on c.id = a.created_by
     order by a.created_at, a.id`;
  return c.json({ admins: rows });
});

// Change an admin's role (Admin role or the operator). You cannot change your own, so the person making the
// change always stays an Admin (someone can always manage roles). Takes effect on their next request.
admin.put("/admins/:id/role", async (c) => {
  const id = z.string().uuid().safeParse(c.req.param("id"));
  const body = z.object({ role: z.enum(ROLES) }).safeParse(await c.req.json().catch(() => null));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const by = c.get("adminAuth");
  if (by.kind === "admin" && by.adminId === id.data) return c.json({ error: "cannot_change_own_role" }, 409);
  const sql = c.get("sql");
  let before: Role | null = null;
  const res = await sql.begin(async (tx) => {
    const [cur] = await tx<{ role: Role }[]>`select role from admins where id = ${id.data} for no key update`;
    if (!cur) return c.json({ error: "not_found" }, 404);
    before = cur.role;
    const [a] = await tx<{ id: string; access_id: string; name: string; role: Role; status: string }[]>`
      update admins set role = ${body.data.role} where id = ${id.data} returning id, access_id, name, role, status`;
    return c.json({ admin: a });
  });
  if (res.status === 200) await adminLog(c, "admin.role_changed", { type: "admin", id: id.data, label: (await sql<{ access_id: string }[]>`select access_id from admins where id = ${id.data}`)[0]?.access_id }, { from: before, to: body.data.role });
  return res;
});

const patchAdminBody = z
  .object({ status: z.enum(["active", "disabled"]), reset_access_token: z.literal(true), reset_mfa: z.literal(true) })
  .partial()
  .refine((o) => Object.keys(o).length > 0, { message: "empty_patch" });

// Operator only. Disable or re-enable an account, issue a fresh access token (generated here and
// returned once; the person must replace it at next sign-in), or reset two-step verification (lost
// phone). Disabling or resetting signs the person out everywhere; enabling also clears a lockout.
admin.patch("/admins/:id", requireOperator, async (c) => {
  const id = z.string().uuid().safeParse(c.req.param("id"));
  const body = patchAdminBody.safeParse(await c.req.json().catch(() => null));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const sql = c.get("sql");
  const [cur] = await sql<{ access_id: string }[]>`select access_id from admins where id = ${id.data}`;
  if (!cur) return c.json({ error: "not_found" }, 404);

  let issued: string | null = null;
  if (body.data.reset_access_token) {
    issued = generateAccessToken();
    await sql`
      update admins set access_token_hash = ${await hashPassword(issued)},
                        failed_attempts = 0, locked_until = null
       where id = ${id.data}`;
  }
  if (body.data.status) {
    await sql`
      update admins set status = ${body.data.status},
                        failed_attempts = case when ${body.data.status} = 'active' then 0 else failed_attempts end,
                        locked_until = case when ${body.data.status} = 'active' then null else locked_until end
       where id = ${id.data}`;
  }
  if (body.data.reset_mfa) {
    // Lost authenticator: forget it. The person signs in with their access token and enrolls again.
    await sql`
      update admins set mfa_secret = null, mfa_enabled_at = null, mfa_last_step = null, mfa_recovery = '[]'::jsonb
       where id = ${id.data}`;
  }
  if (body.data.reset_access_token || body.data.reset_mfa || body.data.status === "disabled") await revokeSessions(sql, id.data);
  const [a] = await sql`select id, access_id, name, status from admins where id = ${id.data}`;
  const t = { type: "admin", id: id.data, label: cur.access_id };
  if (body.data.reset_access_token) await adminLog(c, "admin.token_reset", t);
  if (body.data.status) await adminLog(c, body.data.status === "disabled" ? "admin.disabled" : "admin.enabled", t);
  if (body.data.reset_mfa) await adminLog(c, "admin.mfa_reset", t);
  return c.json({ admin: a, ...(issued ? { credentials: { access_id: cur.access_id, access_token: issued } } : {}) });
});

// Rotate an admin's Access Token (any signed-in admin, or the operator): a fresh server-generated token is
// saved (hashed) and returned once. The person's other sessions end; the caller's own session survives
// when they rotate their own token. A lockout is cleared.
admin.post("/admins/:id/rotate-token", requireStaff, async (c) => {
  const id = z.string().uuid().safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const sql = c.get("sql");
  const issued = generateAccessToken();
  const [a] = await sql<{ id: string; access_id: string; name: string; status: string }[]>`
    update admins set access_token_hash = ${await hashPassword(issued)}, failed_attempts = 0, locked_until = null
     where id = ${id.data} returning id, access_id, name, status`;
  if (!a) return c.json({ error: "not_found" }, 404);
  const by = c.get("adminAuth");
  await revokeSessions(sql, a.id, by.kind === "admin" && by.adminId === a.id ? by.sessionId : undefined);
  await adminLog(c, "admin.token_rotated", { type: "admin", id: a.id, label: a.access_id });
  return c.json({ admin: a, credentials: { access_id: a.access_id, access_token: issued } });
});


// ---- System snapshot --------------------------------------------------------------------------

// The Overview reads snapshots (lib/statsCache.ts): the live numbers refresh at most every few minutes, the ledger checks nightly or on Run Check.
admin.get("/stats", async (c) => c.json(await readStats(c.env, c.get("sql"))));
// Operator-only throughput probe for the counter objects (see tracker.ts): writes only to the throwaway day "loadtest".
const probeEnv = (c: any, shards: number) => ({ ...c.env, STATS_SHARDS: String(Math.max(1, Math.min(64, shards))) });
admin.post("/stats/loadtest", async (c) => {
  if (c.get("adminAuth").kind !== "operator") return c.json({ error: "forbidden_role" }, 403);
  const b = z.object({ events: z.number().int().min(1).max(1000), shards: z.number().int().min(1).max(64).default(1), width: z.number().int().min(1).max(16).default(6) }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: "invalid_request" }, 400);
  return c.json(await probeCounters(probeEnv(c, b.data.shards), b.data.events, b.data.width));
});
admin.get("/stats/loadtest", async (c) => {
  if (c.get("adminAuth").kind !== "operator") return c.json({ error: "forbidden_role" }, 403);
  const env = probeEnv(c, Number(c.req.query("shards")) || 1);
  const r = await readCounters(env, ["loadtest"]);
  return c.json({ probe_n: r["loadtest"]?.probe_n ?? 0, shards: shardCount(env) });
});
admin.delete("/stats/loadtest", async (c) => {
  if (c.get("adminAuth").kind !== "operator") return c.json({ error: "forbidden_role" }, 403);
  await dropDay(probeEnv(c, Number(c.req.query("shards")) || 64), "loadtest");
  return c.body(null, 204);
});
admin.post("/stats/refresh", async (c) => c.json(await refreshLive(c.env, c.get("sql"))));
admin.post("/stats/reconcile", async (c) => {
  const out = await refreshReconciliation(c.env, c.get("sql"));
  await adminLog(c, "stats.reconciled", undefined, { ok: out.reconciliation.balances_match_ledger && out.reconciliation.credit_matches_ledger && out.reconciliation.ledger_balanced });
  return c.json(out);
});

// ---- Merchants, users and transactions --------------------------------------------------------

const nameFilter = z.object({ q: z.string().trim().max(80).optional() });
admin.get("/merchants", async (c) => {
  const q = nameFilter.safeParse(c.req.query());
  if (!q.success) return c.json({ error: "invalid_request" }, 400);
  return c.json({ merchants: await merchantList(c.get("sql"), q.data.q || null) });
});
admin.get("/users", async (c) => {
  const q = nameFilter.safeParse(c.req.query());
  if (!q.success) return c.json({ error: "invalid_request" }, 400);
  return c.json({ users: await userList(c.get("sql"), q.data.q || null) });
});

// ---- One merchant, for support: profile and numbers, terminals, staff, products, payments and refunds ----
const merchantId = uuid;
const merchantTxQuery = z.object({
  kind: z.enum(MERCHANT_TX_KINDS as [MerchantTxKind, ...MerchantTxKind[]]).default("all"),
  limit: pageLimit,
  cursor: z.string().max(100).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).refine((q) => [q.from, q.to].every((d) => d === undefined || (!Number.isNaN(Date.parse(d)) && new Date(d).toISOString().startsWith(d))), { message: "invalid_date" })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, { message: "from_after_to" });

admin.get("/merchants/:id", async (c) => {
  const id = merchantId.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const m = await merchantDetail(c.get("sql"), id.data);
  return m ? c.json({ merchant: m }) : c.json({ error: "not_found" }, 404);
});
admin.get("/merchants/:id/terminals", async (c) => {
  const id = merchantId.safeParse(c.req.param("id"));
  if (!id.success || !(await merchantDetail(c.get("sql"), id.data))) return c.json({ error: "not_found" }, 404);
  return c.json({ terminals: await merchantTerminals(c.get("sql"), id.data) });
});
admin.get("/merchants/:id/staff", async (c) => {
  const id = merchantId.safeParse(c.req.param("id"));
  if (!id.success || !(await merchantDetail(c.get("sql"), id.data))) return c.json({ error: "not_found" }, 404);
  return c.json({ staff: await merchantStaff(c.get("sql"), id.data) });
});
admin.get("/merchants/:id/products", async (c) => {
  const id = merchantId.safeParse(c.req.param("id"));
  if (!id.success || !(await merchantDetail(c.get("sql"), id.data))) return c.json({ error: "not_found" }, 404);
  const limit = pageLimit.safeParse(c.req.query("limit")), cursor = decodeTimeCursor(c.req.query("cursor"));
  if (!limit.success || cursor === "invalid") return c.json({ error: "invalid_request" }, 400);
  return c.json(await merchantProducts(c.get("sql"), id.data, limit.data, cursor));
});
admin.get("/merchants/:id/transactions", async (c) => {
  const id = merchantId.safeParse(c.req.param("id"));
  const q = merchantTxQuery.safeParse(c.req.query());
  if (!id.success) return c.json({ error: "not_found" }, 404);
  if (!q.success) return c.json({ error: "invalid_request" }, 400);
  let cursor: { ts: string; id: string } | null = null;
  if (q.data.cursor) {
    const [ts, cid] = q.data.cursor.split("|");
    if (!ts || !cid || Number.isNaN(Date.parse(ts)) || !z.string().uuid().safeParse(cid).success) return c.json({ error: "invalid_cursor" }, 400);
    cursor = { ts, id: cid };
  }
  if (!(await merchantDetail(c.get("sql"), id.data))) return c.json({ error: "not_found" }, 404);
  return c.json(await merchantTransactions(c.get("sql"), id.data, q.data.kind, q.data.limit, cursor, { from: q.data.from ?? null, to: q.data.to ?? null }));
});

// Admin-only actions on a merchant. Both are recorded on the rows they touch without any new schema:
// a refund resolved here carries `provider_reference` = "admin:<ACCESS ID>" (or "operator"), shown as the approver.
const adminOnly = (c: any) => {
  const a = c.get("adminAuth");
  return a.kind === "admin" && !MERCHANT_ADMINS.includes(a.role) ? c.json({ error: "forbidden_role" }, 403) : null;
};
const actor = (c: any) => { const a = c.get("adminAuth"); return a.kind === "admin" ? `admin:${a.accessId}` : "operator"; };

for (const action of ["approve", "reject"] as const) {
  admin.post(`/merchants/:id/refunds/:refundId/${action}`, async (c) => {
    const denied = adminOnly(c); if (denied) return denied;
    const id = merchantId.safeParse(c.req.param("id")), rid = merchantId.safeParse(c.req.param("refundId"));
    if (!id.success || !rid.success) return c.json({ error: "not_found" }, 404);
    const out = await c.get("sql").begin(async (tx) => {
      const r = action === "approve" ? await approvePending(tx, id.data, rid.data, null) : await rejectPending(tx, id.data, rid.data);
      if (r.kind !== "error") await tx`update transactions set provider_reference = ${actor(c)} where id = ${rid.data}`;
      return r;
    });
    if (out.kind === "error") return c.json({ error: out.error }, out.status);
    if (action === "approve" && out.kind === "ok" && !out.replayed && out.row.status === "completed") track(c, { refunds_n: 1, refunds_v: Number(out.row.amount) });   // today's running estimate
    await adminLog(c, `refund.${action === "approve" ? "approved" : "rejected"}`, { type: "refund", id: rid.data }, { merchant_id: id.data, amount: Number(out.row.amount), status: out.row.status });
    return c.json({ refund: { id: out.row.id, status: out.row.status, status_code: out.row.status_code } }, 200);
  });
}

// Suspend or reactivate a merchant (admin only). A suspended merchant cannot take payments, its owner's
// sessions and its terminals stop working at once (every request re-checks the account), and everything
// resumes when it is reactivated.
admin.put("/merchants/:id/status", async (c) => {
  const denied = adminOnly(c); if (denied) return denied;
  const id = merchantId.safeParse(c.req.param("id"));
  const body = z.object({ status: z.enum(["active", "suspended"]) }).safeParse(await c.req.json().catch(() => null));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const rows = await c.get("sql")`update accounts set status = ${body.data.status} where id = ${id.data} and type = 'B' and status in ('active', 'suspended') returning id, status, name`;
  if (!rows.length) return c.json({ error: "not_found" }, 404);
  await adminLog(c, body.data.status === "suspended" ? "merchant.suspended" : "merchant.reactivated", { type: "merchant", id: id.data, label: rows[0]!.name });
  return c.json({ merchant: { id: rows[0]!.id, status: rows[0]!.status } });
});

// ---- Organizations (employers): profile, program, employees, runs and documents ------------------------
admin.get("/organizations", async (c) => {
  const q = nameFilter.safeParse(c.req.query());
  if (!q.success) return c.json({ error: "invalid_request" }, 400);
  return c.json({ organizations: await organizationList(c.get("sql"), q.data.q || null) });
});
admin.get("/organizations/:id", async (c) => {
  const id = merchantId.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const o = await organizationDetail(c.get("sql"), id.data);
  return o ? c.json({ organization: o }) : c.json({ error: "not_found" }, 404);
});
admin.get("/organizations/:id/employees", async (c) => {
  const id = merchantId.safeParse(c.req.param("id")), q = nameFilter.safeParse(c.req.query());
  if (!id.success || !(await organizationDetail(c.get("sql"), id.data))) return c.json({ error: "not_found" }, 404);
  const limit = pageLimit.safeParse(c.req.query("limit")), cursor = decodeTimeCursor(c.req.query("cursor"));
  if (!q.success || !limit.success || cursor === "invalid") return c.json({ error: "invalid_request" }, 400);
  return c.json(await organizationEmployees(c.get("sql"), id.data, q.data.q || null, limit.data, cursor));
});
admin.get("/organizations/:id/runs", async (c) => {
  const id = merchantId.safeParse(c.req.param("id"));
  if (!id.success || !(await organizationDetail(c.get("sql"), id.data))) return c.json({ error: "not_found" }, 404);
  return c.json({ runs: await organizationRuns(c.get("sql"), id.data) });
});
admin.get("/organizations/:id/documents", async (c) => {
  const id = merchantId.safeParse(c.req.param("id"));
  if (!id.success || !(await organizationDetail(c.get("sql"), id.data))) return c.json({ error: "not_found" }, 404);
  const rows = await c.get("sql")<{ id: string; type: string; path: string; created_at: Date }[]>`
    select id, type, path, created_at from uploads where account_id = ${id.data} order by created_at desc, id desc`;
  return c.json({ documents: rows.map((d) => ({ id: d.id, type: d.type, created_at: d.created_at, file: d.path.split(".").pop() })) });
});
admin.get("/organizations/:id/documents/:uploadId", async (c) => {
  const id = merchantId.safeParse(c.req.param("id")), uid = merchantId.safeParse(c.req.param("uploadId"));
  if (!id.success || !uid.success) return c.json({ error: "not_found" }, 404);
  const [d] = await c.get("sql")<{ path: string }[]>`
    select u.path from uploads u join accounts a on a.id = u.account_id where u.id = ${uid.data} and u.account_id = ${id.data} and a.type = 'O'`;
  const obj = d ? await getUpload(c.env, d.path) : null;
  if (!d || !obj) return c.json({ error: "not_found" }, 404);
  await adminLog(c, "organization.document_downloaded", { type: "organization", id: id.data }, { upload_id: uid.data });
  const ext = d.path.split(".").pop();
  return new Response(await obj.arrayBuffer(), {
    headers: { "content-type": mimeOfPath(d.path), "content-disposition": `attachment; filename="organization-document.${ext}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
});
// Suspend or reactivate an organization (admin only): its sign-ins, API key and scheduled payments stop at once, nothing is deleted.
admin.put("/organizations/:id/status", async (c) => {
  const denied = adminOnly(c); if (denied) return denied;
  const id = merchantId.safeParse(c.req.param("id"));
  const body = z.object({ status: z.enum(["active", "suspended"]) }).safeParse(await c.req.json().catch(() => null));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const rows = await c.get("sql")`update accounts set status = ${body.data.status} where id = ${id.data} and type = 'O' and status in ('active', 'suspended') returning id, status, name`;
  if (!rows.length) return c.json({ error: "not_found" }, 404);
  await adminLog(c, body.data.status === "suspended" ? "organization.suspended" : "organization.reactivated", { type: "organization", id: id.data, label: rows[0]!.name });
  return c.json({ organization: { id: rows[0]!.id, status: rows[0]!.status } });
});

// ---- One person, for support ------------------------------------------------------------------------
const userTxQuery = z.object({
  kind: z.enum(USER_TX_KINDS as [UserTxKind, ...UserTxKind[]]).default("all"),
  limit: pageLimit,
  cursor: z.string().max(100).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).refine((q) => [q.from, q.to].every((d) => d === undefined || (!Number.isNaN(Date.parse(d)) && new Date(d).toISOString().startsWith(d))), { message: "invalid_date" })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, { message: "from_after_to" });

admin.get("/users/:id", async (c) => {
  const id = merchantId.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const u = await userDetail(c.get("sql"), id.data, c.get("limiter"));
  return u ? c.json({ user: u }) : c.json({ error: "not_found" }, 404);
});
for (const [sub, fn, key] of [["wallets", userWallets, "wallets"], ["tags", userTags, "tags"], ["devices", userDevices, "devices"], ["funding", userFunding, "funding"], ["orders", userOrders, "orders"]] as const) {
  admin.get(`/users/:id/${sub}`, async (c) => {
    const id = merchantId.safeParse(c.req.param("id"));
    if (!id.success || !(await userDetail(c.get("sql"), id.data))) return c.json({ error: "not_found" }, 404);
    return c.json({ [key]: await fn(c.get("sql"), id.data) });
  });
}
admin.get("/users/:id/transactions", async (c) => {
  const id = merchantId.safeParse(c.req.param("id"));
  const q = userTxQuery.safeParse(c.req.query());
  if (!id.success) return c.json({ error: "not_found" }, 404);
  if (!q.success) return c.json({ error: "invalid_request" }, 400);
  let cursor: { ts: string; id: string } | null = null;
  if (q.data.cursor) {
    const [ts, cid] = q.data.cursor.split("|");
    if (!ts || !cid || Number.isNaN(Date.parse(ts)) || !z.string().uuid().safeParse(cid).success) return c.json({ error: "invalid_cursor" }, 400);
    cursor = { ts, id: cid };
  }
  if (!(await userDetail(c.get("sql"), id.data))) return c.json({ error: "not_found" }, 404);
  return c.json(await userTransactions(c.get("sql"), id.data, q.data.kind, q.data.limit, cursor, { from: q.data.from ?? null, to: q.data.to ?? null }));
});

const roleGate = (list: readonly Role[]) => (c: any) => {
  const a = c.get("adminAuth");
  return a.kind === "admin" && !list.includes(a.role) ? c.json({ error: "forbidden_role" }, 403) : null;
};
// Support actions (Admin and Support roles): sign a person out everywhere, unlock their login after too many
// wrong passwords, and revoke an agent wallet's API key (for a leaked key; the owner can issue a new one).
admin.post("/users/:id/sign-out", async (c) => {
  const denied = roleGate(USER_WRITERS)(c); if (denied) return denied;
  const id = merchantId.safeParse(c.req.param("id"));
  if (!id.success || !(await userDetail(c.get("sql"), id.data))) return c.json({ error: "not_found" }, 404);
  const rows = await c.get("sql")`update devices set revoked_at = now() where account_id = ${id.data} and revoked_at is null returning id`;
  await adminLog(c, "user.signed_out", { type: "user", id: id.data, label: (await userDetail(c.get("sql"), id.data))?.name }, { sessions: rows.length });
  return c.json({ signed_out: rows.length });
});
admin.post("/users/:id/unlock-login", async (c) => {
  const denied = roleGate(USER_WRITERS)(c); if (denied) return denied;
  const id = merchantId.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const u = await userDetail(c.get("sql"), id.data);
  if (!u) return c.json({ error: "not_found" }, 404);
  if (u.email) await resetThrottle(c.get("limiter"), `login:${u.email.toLowerCase()}`);
  await adminLog(c, "user.login_unlocked", { type: "user", id: id.data, label: u.name });
  return c.body(null, 204);
});
admin.post("/wallets/:id/revoke-key", async (c) => {
  const denied = roleGate(USER_WRITERS)(c); if (denied) return denied;
  const id = merchantId.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const rows = await c.get("sql")`update wallets set key_hash = null, key_hint = null, key_last_used_at = null where id = ${id.data} and key_hash is not null returning id, display_name, account_id`;
  if (!rows.length) return c.json({ error: "not_found" }, 404);
  await adminLog(c, "wallet.key_revoked", { type: "wallet", id: id.data, label: rows[0]!.display_name }, { account_id: rows[0]!.account_id });
  return c.body(null, 204);
});
// ---- Business approval: a new business is `pending` until an Admin or Merchants person reads its document and approves
// or declines it (a decline needs a reason and emails the business what to do). A declined business that uploads again
// goes back to pending (see POST /v1/account/documents). Documents are private: they are streamed from R2 only here.
const approvalGate = (c: any) => {
  const a = c.get("adminAuth");
  return a.kind === "admin" && !MERCHANT_WRITERS.includes(a.role) ? c.json({ error: "forbidden_role" }, 403) : null;
};
admin.get("/merchants/:id/documents", async (c) => {
  const denied = approvalGate(c); if (denied) return denied;
  const id = merchantId.safeParse(c.req.param("id"));
  if (!id.success || !(await merchantDetail(c.get("sql"), id.data))) return c.json({ error: "not_found" }, 404);
  const rows = await c.get("sql")<{ id: string; type: string; path: string; created_at: Date }[]>`
    select id, type, path, created_at from uploads where account_id = ${id.data} order by created_at desc, id desc`;
  return c.json({ documents: rows.map((d) => ({ id: d.id, type: d.type, created_at: d.created_at, file: d.path.split(".").pop() })) });
});
admin.get("/merchants/:id/documents/:uploadId", async (c) => {
  const denied = approvalGate(c); if (denied) return denied;
  const id = merchantId.safeParse(c.req.param("id")), uid = merchantId.safeParse(c.req.param("uploadId"));
  if (!id.success || !uid.success) return c.json({ error: "not_found" }, 404);
  const [d] = await c.get("sql")<{ path: string }[]>`select path from uploads where id = ${uid.data} and account_id = ${id.data}`;
  const obj = d ? await getUpload(c.env, d.path) : null;
  if (!d || !obj) return c.json({ error: "not_found" }, 404);
  await adminLog(c, "merchant.document_downloaded", { type: "merchant", id: id.data }, { upload_id: uid.data });
  const ext = d.path.split(".").pop();
  return new Response(await obj.arrayBuffer(), {
    headers: { "content-type": mimeOfPath(d.path), "content-disposition": `attachment; filename="business-document.${ext}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
});

const decideBody = z.object({ reason: z.string().trim().min(5).max(1000).optional() });
for (const decision of ["approve", "decline"] as const) {
  admin.post(`/merchants/:id/${decision}`, async (c) => {
    const denied = approvalGate(c); if (denied) return denied;
    const id = merchantId.safeParse(c.req.param("id"));
    const body = decideBody.safeParse(await c.req.json().catch(() => ({})));
    if (!id.success) return c.json({ error: "not_found" }, 404);
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    if (decision === "decline" && !body.data.reason) return c.json({ error: "reason_required" }, 400);
    const sql = c.get("sql");
    const next = decision === "approve" ? "active" : "declined";
    const rows = decision === "approve"
      ? await sql<{ id: string; name: string; email: string | null }[]>`update accounts set status = 'active' where id = ${id.data} and type = 'B' and status in ('pending', 'declined') returning id, name, email`
      : await sql<{ id: string; name: string; email: string | null }[]>`update accounts set status = 'declined' where id = ${id.data} and type = 'B' and status = 'pending' returning id, name, email`;
    if (!rows.length) return c.json({ error: "not_pending" }, 409);
    const m = rows[0]!;
    const mail = decision === "approve" ? approvedEmail(m.name) : declinedEmail(m.name, body.data.reason!);
    const sent = m.email ? await sendMail(c.env, { to: m.email, ...mail }) : "failed";
    await adminLog(c, decision === "approve" ? "merchant.approved" : "merchant.declined", { type: "merchant", id: m.id, label: m.name }, {
      ...(decision === "decline" ? { reason: body.data.reason } : {}), email: sent, ...(sent === "sent" ? {} : { email_text: mail.text }),
    });
    return c.json({ merchant: { id: m.id, status: next }, email: sent });
  });
}

// ---- Email merchants (Admin and Merchants roles): one merchant, a list of them, or every active / pending business.
// {{name}} in the subject or message becomes each merchant's name. The text goes through Cloudflare Email Service; each
// merchant gets its own log row (and, when nothing was sent, the text is kept there). Active and pending businesses only.
const MAX_EMAIL_RECIPIENTS = 200;
const emailBody = z.object({
  merchant_ids: z.array(merchantId).min(1).max(MAX_EMAIL_RECIPIENTS).optional(),
  audience: z.enum(["active", "pending", "active_pending"]).optional(),
  subject: z.string().trim().min(1).max(150),
  body: z.string().trim().min(1).max(5000),
}).refine((b) => (b.merchant_ids === undefined) !== (b.audience === undefined), { message: "ids_or_audience" });
const fill = (t: string, name: string) => t.replace(/\{\{\s*name\s*\}\}/gi, name);

admin.post("/merchants/email", async (c) => {
  const denied = approvalGate(c); if (denied) return denied;
  const body = emailBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const b = body.data;
  const sql = c.get("sql");
  const statuses = b.audience === "active" ? ["active"] : b.audience === "pending" ? ["pending"] : ["active", "pending"];
  const rows = await sql<{ id: string; name: string; email: string | null; status: string }[]>`
    select id, name, email, status from accounts
     where type = 'B' and status in ${sql(statuses)} ${b.merchant_ids ? sql`and id in ${sql(b.merchant_ids)}` : sql``}
     order by created_at, id limit ${MAX_EMAIL_RECIPIENTS}`;
  const missing = b.merchant_ids ? b.merchant_ids.filter((id) => !rows.some((r) => r.id === id)) : [];
  if (rows.length === 0) return c.json({ error: "no_recipients" }, 422);

  const results: { id: string; name: string; email: "sent" | "failed" | "not_configured" | "suppressed" | "no_address" }[] = [];
  for (let i = 0; i < rows.length; i += 5) {
    const batch = rows.slice(i, i + 5);
    const done = await Promise.all(batch.map(async (m) => {
      const subject = fill(b.subject, m.name), text = fill(b.body, m.name);
      const sent = m.email ? await sendMail(c.env, { to: m.email, subject, text }) : "no_address" as const;
      await adminLog(c, "merchant.emailed", { type: "merchant", id: m.id, label: m.name }, { subject, email: sent, ...(sent === "sent" ? {} : { email_text: text }) });
      return { id: m.id, name: m.name, email: sent };
    }));
    results.push(...done);
  }
  const count = (k: string) => results.filter((r) => r.email === k).length;
  return c.json({ total: results.length, sent: count("sent"), failed: count("failed"), not_configured: count("not_configured"), suppressed: count("suppressed"), no_address: count("no_address"), skipped: missing, results });
});

// Admin only: suspend or reactivate a person, or one of their wallets. A suspended account is refused on its
// next request (sessions, wallets, agent keys alike); nothing is deleted.
admin.put("/users/:id/status", async (c) => {
  const denied = roleGate(USER_ADMINS)(c); if (denied) return denied;
  const id = merchantId.safeParse(c.req.param("id"));
  const body = z.object({ status: z.enum(["active", "suspended"]) }).safeParse(await c.req.json().catch(() => null));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const rows = await c.get("sql")`update accounts set status = ${body.data.status} where id = ${id.data} and type = 'C' and status <> 'closed' returning id, status, name`;
  if (!rows.length) return c.json({ error: "not_found" }, 404);
  await adminLog(c, body.data.status === "suspended" ? "user.suspended" : "user.reactivated", { type: "user", id: id.data, label: rows[0]!.name });
  return c.json({ user: { id: rows[0]!.id, status: rows[0]!.status } });
});
admin.put("/wallets/:id/status", async (c) => {
  const denied = roleGate(USER_ADMINS)(c); if (denied) return denied;
  const id = merchantId.safeParse(c.req.param("id"));
  const body = z.object({ status: z.enum(["active", "suspended"]) }).safeParse(await c.req.json().catch(() => null));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const rows = await c.get("sql")`update wallets w set status = ${body.data.status} from accounts a where w.id = ${id.data} and a.id = w.account_id and a.type = 'C' and w.status <> 'closed' returning w.id, w.status, w.display_name, w.account_id`;
  if (!rows.length) return c.json({ error: "not_found" }, 404);
  await adminLog(c, body.data.status === "suspended" ? "wallet.suspended" : "wallet.reactivated", { type: "wallet", id: id.data, label: rows[0]!.display_name }, { account_id: rows[0]!.account_id });
  return c.json({ wallet: { id: rows[0]!.id, status: rows[0]!.status } });
});

// Support action: sign a terminal out (clears its stored session, so its token stops working and the
// merchant signs it in again). Admin and Merchants roles only.
admin.post("/terminals/:id/sign-out", async (c) => {
  const a = c.get("adminAuth");
  if (a.kind === "admin" && !MERCHANT_WRITERS.includes(a.role)) return c.json({ error: "forbidden_role" }, 403);
  const id = merchantId.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const rows = await c.get("sql")`update terminals set session_token_hash = null where id = ${id.data} returning id, name, account_id`;
  if (!rows.length) return c.json({ error: "not_found" }, 404);
  await adminLog(c, "terminal.signed_out", { type: "terminal", id: id.data, label: rows[0]!.name }, { merchant_id: rows[0]!.account_id });
  return c.body(null, 204);
});

// ---- Settlements: the daily payout and collection runs (lib/settlement.ts) --------------------------------------
admin.get("/settlements", async (c) => {
  const rows = await c.get("sql")<{ id: string; cutoff_date: string; cutoff_at: Date; status: string; merchants: number; payout_total: bigint; collection_total: bigint; provider_reference: string | null; failure_code: string | null; created_at: Date; completed_at: Date | null }[]>`
    select id, cutoff_date::text, cutoff_at, status, merchants, payout_total, collection_total, provider_reference, failure_code, created_at, completed_at
      from settlements order by cutoff_date desc limit 60`;
  return c.json({ settlements: rows.map((r) => ({ ...r, payout_total: Number(r.payout_total), collection_total: Number(r.collection_total) })) });
});

admin.get("/settlements/:id", async (c) => {
  const id = c.req.param("id");
  if (!z.string().uuid().safeParse(id).success) return c.json({ error: "not_found" }, 404);
  const sql = c.get("sql");
  const [run] = await sql<{ id: string; cutoff_date: string; status: string; provider_reference: string | null; failure_code: string | null }[]>`
    select id, cutoff_date::text, status, provider_reference, failure_code from settlements where id = ${id}`;
  if (!run) return c.json({ error: "not_found" }, 404);
  const items = await sql<{ id: string; merchant_id: string; merchant: string; amount: bigint; status: string; status_code: string | null; payout: boolean; last4: string | null }[]>`
    select t.id, t.from_account_id as merchant_id, a.name as merchant, t.amount, t.status, t.status_code, (t.to_bank_account_id is not null) as payout, ba.last4
      from transactions t join accounts a on a.id = t.from_account_id left join bank_accounts ba on ba.id = coalesce(t.to_bank_account_id, t.from_bank_account_id)
     where t.settlement_id = ${id} order by t.amount desc, t.id`;
  return c.json({ settlement: run, items: items.map((i) => ({ id: i.id, merchant_id: i.merchant_id, merchant: i.merchant, kind: i.payout ? "payout" : "collection", amount: Number(i.amount), status: i.status, status_code: i.status_code, bank_last4: i.last4 })) });
});

const settlementAdmin = (c: any) => {
  const a = c.get("adminAuth");
  return a.kind === "admin" && !SETTLEMENT_ADMINS.includes(a.role) ? c.json({ error: "forbidden_role" }, 403) : null;
};

// Runs the settlement for the program day before today now (the cron does this daily). Idempotent: a day already settled does nothing.
admin.post("/settlements/run", async (c) => {
  const denied = settlementAdmin(c); if (denied) return denied;
  const r = await runSettlement(c.env, c.get("sql"), easternDate(new Date()));
  await adminLog(c, "settlement.run", r.ran ? { type: "settlement", id: r.settlement_id } : undefined, { ...r });
  if (!r.ran && r.reason === "no_provider") return c.json({ error: "no_payment_provider", ...r }, 503);
  return c.json(r);
});

// Asks the bank for the answer to a submitted run.
admin.post("/settlements/:id/confirm", async (c) => {
  const denied = settlementAdmin(c); if (denied) return denied;
  const id = c.req.param("id");
  if (!z.string().uuid().safeParse(id).success) return c.json({ error: "not_found" }, 404);
  const provider = achProvider(c.env);
  if (!provider) return c.json({ error: "no_payment_provider" }, 503);
  const r = await confirmSettlement(c.get("sql"), id, provider);
  if (r.status === "missing") return c.json({ error: "not_found" }, 404);
  await adminLog(c, "settlement.confirmed", { type: "settlement", id }, { ...r });
  return c.json(r);
});

const txQuery = z.object({
  kind: z.enum(TX_KINDS as [TxKind, ...TxKind[]]).default("all"),
  limit: pageLimit,
  cursor: z.string().max(100).optional(),
  // Program dates (America/New_York), inclusive: from the start of `from` to the end of `to`.
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).refine((q) => [q.from, q.to].every((d) => d === undefined || (!Number.isNaN(Date.parse(d)) && new Date(d).toISOString().startsWith(d))), { message: "invalid_date" })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, { message: "from_after_to" });
admin.get("/transactions", async (c) => {
  const q = txQuery.safeParse(c.req.query());
  if (!q.success) return c.json({ error: "invalid_request" }, 400);
  let cursor: { ts: string; id: string } | null = null;
  if (q.data.cursor) {
    const [ts, id] = q.data.cursor.split("|");
    if (!ts || !id || Number.isNaN(Date.parse(ts)) || !z.string().uuid().safeParse(id).success) return c.json({ error: "invalid_cursor" }, 400);
    cursor = { ts, id };
  }
  return c.json(await transactionFeed(c.get("sql"), q.data.kind, q.data.limit, cursor, { from: q.data.from ?? null, to: q.data.to ?? null }));
});

// ---- Tag models -------------------------------------------------------------------------------

const modelBody = z.object({
  type: z.enum(["band", "card"]),
  name: z.string().trim().min(1).max(120),
  currency: z.string().trim().toUpperCase().length(3).default("USD"),
  price: amountOrZero,                                   // integer minor units (cents)
  country: z.string().trim().toUpperCase().length(2).optional(),
  quantity: z.number().int().min(0).max(10_000_000),
  limited: z.boolean().default(false),
  status: z.enum(["pending", "preorder", "available", "closed"]).default("pending"),
});

type ModelRow = {
  id: string; type: string; name: string; photo: string | null; currency: string; price: bigint;
  country: string | null; quantity: number; sold: number; limited: boolean; status: string; created_at: Date;
};
const modelJson = (m: ModelRow, extra: object = {}) => ({
  id: m.id, type: m.type, name: m.name, photo: imageUrl(m.photo), currency: m.currency, price: n(m.price),
  country: m.country, quantity: m.quantity, sold: m.sold, limited: m.limited, status: m.status,
  created_at: m.created_at, ...extra,
});
const M_COLS = "id, type, name, photo, currency, price, country, quantity, sold, limited, status, created_at";

admin.post("/tag-models", async (c) => {
  const body = modelBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const b = body.data;
  const sql = c.get("sql");
  const [m] = await sql<ModelRow[]>`
    insert into tag_models (type, name, photo, currency, price, country, quantity, limited, status)
    values (${b.type}, ${b.name}, ${null}, ${b.currency}, ${b.price.toString()},
            ${b.country ?? null}, ${b.quantity}, ${b.limited}, ${b.status})
    returning ${sql.unsafe(M_COLS)}`;
  await adminLog(c, "tag_model.created", { type: "tag_model", id: m!.id, label: m!.name }, { type: m!.type, price: Number(m!.price), quantity: m!.quantity });
  return c.json({ model: modelJson(m!) }, 201);
});

admin.get("/tag-models", async (c) => {
  const sql = c.get("sql");
  const rows = await sql<(ModelRow & { tags: number; unassigned: number })[]>`
    select ${sql.unsafe(M_COLS.split(", ").map((x) => "m." + x).join(", "))},
           count(t.id)::int as tags,
           (count(t.id) filter (where t.wallet_id is null))::int as unassigned
      from tag_models m left join tags t on t.model_id = m.id
     group by m.id order by m.created_at, m.id`;
  return c.json({ models: rows.map((m) => modelJson(m, { tags: m.tags, unassigned: m.unassigned })) });
});

// One model with its provisioning and activation numbers and its sales rank (1 = best seller; models
// with the same sold count share a rank).
admin.get("/tag-models/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const sql = c.get("sql");
  const [m] = await sql<(ModelRow & { tags: number; unassigned: number; activated: number; rank: number; models_total: number })[]>`
    select ${sql.unsafe(M_COLS.split(", ").map((x) => "m." + x).join(", "))},
           (select count(*) from tags t where t.model_id = m.id)::int as tags,
           (select count(*) from tags t where t.model_id = m.id and t.wallet_id is null)::int as unassigned,
           (select count(*) from tags t where t.model_id = m.id and t.wallet_id is not null)::int as activated,
           (1 + (select count(*) from tag_models o where o.sold > m.sold))::int as rank,
           (select count(*) from tag_models)::int as models_total
      from tag_models m
     where m.id = ${id.data}`;
  if (!m) return c.json({ error: "not_found" }, 404);
  return c.json({
    model: modelJson(m, {
      tags: m.tags, unassigned: m.unassigned, activated: m.activated,
      pending: Math.max(0, m.quantity - m.tags), rank: m.rank, models_total: m.models_total,
    }),
  });
});

const patchModelBody = z.object({
  type: z.enum(["band", "card"]),
  name: z.string().trim().min(1).max(120),
  currency: z.string().trim().toUpperCase().length(3),
  price: amountOrZero,
  country: z.string().trim().toUpperCase().length(2).nullable(),
  quantity: z.number().int().min(0).max(10_000_000),
  limited: z.boolean(),
  status: z.enum(["pending", "preorder", "available", "closed"]),
}).partial().refine((b) => Object.keys(b).length > 0, { message: "empty" });

// Edit a model. Quantity cannot drop below what is already sold; the type is fixed once tags are
// loaded or units sold. Price changes never touch past orders (they carry a snapshot).
admin.patch("/tag-models/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const body = patchModelBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const b = body.data;
  const sql = c.get("sql");
  const res = await sql.begin(async (tx) => {
    const [cur] = await tx<{ type: string; sold: number; tags: number }[]>`
      select m.type, m.sold, (select count(*) from tags t where t.model_id = m.id)::int as tags
        from tag_models m where m.id = ${id.data} for no key update`;
    if (!cur) return c.json({ error: "not_found" }, 404);
    if (b.quantity !== undefined && b.quantity < cur.sold) return c.json({ error: "quantity_below_sold" }, 409);
    if (b.type !== undefined && b.type !== cur.type && (cur.sold > 0 || cur.tags > 0)) return c.json({ error: "type_locked" }, 409);
    await tx`
      update tag_models set
        type = coalesce(${b.type ?? null}, type), name = coalesce(${b.name ?? null}, name),
        currency = coalesce(${b.currency ?? null}, currency),
        price = coalesce(${b.price === undefined ? null : b.price.toString()}::bigint, price),
        country = case when ${b.country !== undefined} then ${b.country ?? null} else country end,
        quantity = coalesce(${b.quantity ?? null}::int, quantity),
        limited = coalesce(${b.limited ?? null}::boolean, limited),
        status = coalesce(${b.status ?? null}, status), updated_at = now()
       where id = ${id.data}`;
    const [m] = await tx<ModelRow[]>`select ${tx.unsafe(M_COLS)} from tag_models where id = ${id.data}`;
    return c.json({ model: modelJson(m!) });
  });
  if (res.status === 200) await adminLog(c, "tag_model.updated", { type: "tag_model", id: id.data, label: (await sql<{ name: string }[]>`select name from tag_models where id = ${id.data}`)[0]?.name }, { fields: Object.keys(b) });
  return res;
});

// Upload a model's photo: the raw PNG bytes (256 KB at most). The portal resizes to 256 x 256 first. The bytes go to R2; tag_models.photo keeps the public path.
admin.put("/tag-models/:id/photo", async (c) => {
  const id = z.string().uuid().safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "image/png") return c.json({ error: "unsupported_image_type" }, 415);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length === 0) return c.json({ error: "invalid_request" }, 400);
  if (bytes.length > MAX_IMAGE_BYTES) return c.json({ error: "image_too_large" }, 413);
  if (!isPng(bytes)) return c.json({ error: "invalid_image" }, 400);
  const sql = c.get("sql");
  const [m] = await sql<{ name: string; photo: string | null }[]>`select name, photo from tag_models where id = ${id.data}`;
  if (!m) return c.json({ error: "not_found" }, 404);
  const key = newImageKey("tags", id.data, "png");
  if (!(await putPng(c.env, key, bytes))) return c.json({ error: "storage_unavailable" }, 503);
  await sql`update tag_models set photo = ${key} where id = ${id.data}`;
  if (m.photo) await deleteImage(c.env, m.photo);
  await adminLog(c, "tag_model.photo_uploaded", { type: "tag_model", id: id.data, label: m.name });
  return c.body(null, 204);
});

// ---- Supplier import --------------------------------------------------------------------------
// The supplier's UID list for a model becomes unassigned tags, ready to be claimed by tapping.

/** NFC UID: 7 bytes, 14 hex characters; separators and case are normalized away. */
const nfcUid = (v: string) => v.trim().replace(/[:\-\s]/g, "").toUpperCase();
const NFC_UID = /^[0-9A-F]{14}$/;
const MAX_IMPORT = 5000;

const importBody = z.object({ uids: z.array(z.string().max(64)).min(1).max(MAX_IMPORT) });

admin.post("/tag-models/:id/tags", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const body = importBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const sql = c.get("sql");

  const [model] = await sql<{ id: string; name: string }[]>`select id, name from tag_models where id = ${id.data}`;
  if (!model) return c.json({ error: "model_not_found" }, 404);

  // Validate everything first: one bad UID rejects the batch, so a typo never half-imports a list.
  const seen = new Set<string>();
  const invalid: string[] = [];
  let duplicatesInRequest = 0;
  for (const raw of body.data.uids) {
    const u = nfcUid(raw);
    if (!NFC_UID.test(u)) { invalid.push(raw); continue; }
    if (seen.has(u)) { duplicatesInRequest++; continue; }
    seen.add(u);
  }
  if (invalid.length > 0) {
    return c.json({ error: "invalid_uids", invalid: invalid.slice(0, 50), invalid_count: invalid.length }, 400);
  }
  const uids = [...seen];

  const inserted = await sql.begin(async (tx): Promise<string[]> => {
    const done: string[] = [];
    for (let i = 0; i < uids.length; i += 500) {
      // UIDs are validated as 14 hex characters, so a plain array literal is safe to build.
      const chunk = uids.slice(i, i + 500);
      const rows = await tx<{ uid: string }[]>`
        insert into tags (uid, model_id)
        select u, ${model.id}::uuid from unnest(${`{${chunk.join(",")}}`}::text[]) as u
        on conflict (uid) do nothing
        returning uid`;
      done.push(...rows.map((r) => r.uid));
    }
    return done;
  });

  // UIDs that were already in the system (possibly under another model) are reported, not changed.
  const insertedSet = new Set(inserted);
  const skipped = uids.filter((u) => !insertedSet.has(u));
  const existing = skipped.length === 0
    ? []
    : await sql<{ uid: string; model_id: string }[]>`select uid, model_id from tags where uid in ${sql(skipped as string[])}`;

  if (inserted.length > 0) await adminLog(c, "tag_model.tags_imported", { type: "tag_model", id: model.id, label: model.name }, { inserted: inserted.length });
  return c.json(
    {
      model_id: model.id,
      model_name: model.name,
      requested: body.data.uids.length,
      inserted: inserted.length,
      duplicates_in_request: duplicatesInRequest,
      already_existing: existing.map((e) => ({ uid: e.uid, model_id: e.model_id })),
    },
    201,
  );
});

// ---- Shop items (our merch) -------------------------------------------------------------------
const ITEM_COLS = "id, name, description, photo, price, currency, stock, sold, status, kind, file, created_at, updated_at";
type ItemRow = { id: string; name: string; description: string | null; photo: string | null; price: bigint; currency: string; stock: number | null; sold: number; status: string; kind: "physical" | "digital"; file: string | null; created_at: Date; updated_at: Date };
/** `file` (a private storage key) is never returned: the page only learns whether there is one and its type. */
const itemJson = ({ file, ...i }: ItemRow) => ({ ...i, photo: imageUrl(i.photo), price: n(i.price), has_file: !!file, file_ext: file ? file.split(".").pop()! : null });
const itemBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable().optional(),
  price: z.number().int().min(0).max(1_000_000_00),
  currency: z.string().length(3).optional(),
  stock: z.number().int().min(0).max(1_000_000).nullable().optional(),
  status: z.enum(["pending", "available", "closed"]).optional(),
  kind: z.enum(["physical", "digital"]).optional(),   // physical: shipped; digital: a file the buyer downloads after paying (no stock)
}).strict();

admin.get("/shop-items", async (c) => {
  const rows = await c.get("sql")<ItemRow[]>`select ${c.get("sql").unsafe(ITEM_COLS)} from shop order by created_at, id`;
  return c.json({ items: rows.map(itemJson) });
});

admin.get("/shop-items/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const [i] = await c.get("sql")<ItemRow[]>`select ${c.get("sql").unsafe(ITEM_COLS)} from shop where id = ${id.data}`;
  return i ? c.json({ item: itemJson(i) }) : c.json({ error: "not_found" }, 404);
});

admin.post("/shop-items", async (c) => {
  const b = itemBody.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: "invalid_request", issues: b.error.flatten() }, 400);
  const kind = b.data.kind ?? "physical";
  if (kind === "digital" && b.data.status === "available") return c.json({ error: "file_required" }, 409);   // upload the file first, then publish
  const sql = c.get("sql");
  const [i] = await sql<ItemRow[]>`
    insert into shop (name, description, price, currency, stock, status, kind)
    values (${b.data.name}, ${b.data.description ?? null}, ${b.data.price}, ${(b.data.currency ?? "USD").toUpperCase()}, ${kind === "digital" ? null : b.data.stock ?? null}, ${b.data.status ?? "pending"}, ${kind})
    returning ${sql.unsafe(ITEM_COLS)}`;
  await adminLog(c, "shop_item.created", { type: "shop_item", id: i!.id, label: i!.name }, { price: Number(i!.price), stock: i!.stock, kind });
  return c.json({ item: itemJson(i!) }, 201);
});

admin.patch("/shop-items/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const b = itemBody.partial().safeParse(await c.req.json().catch(() => null));
  if (!b.success || Object.keys(b.data).length === 0) return c.json({ error: "invalid_request" }, 400);
  const sql = c.get("sql");
  const [cur] = await sql<ItemRow[]>`select ${sql.unsafe(ITEM_COLS)} from shop where id = ${id.data}`;
  if (!cur) return c.json({ error: "not_found" }, 404);
  const d = b.data;
  const kind = d.kind ?? cur.kind;
  if (kind !== cur.kind && cur.sold > 0) return c.json({ error: "kind_locked" }, 409);   // like a tag's type once units are sold
  const status = d.status ?? cur.status;
  const dropFile = kind === "physical" && cur.file !== null;
  const file = dropFile ? null : cur.file;
  if (kind === "digital" && status === "available" && !file) return c.json({ error: "file_required" }, 409);
  const stock = kind === "digital" ? null : d.stock === undefined ? cur.stock : d.stock;
  const [i] = await sql<ItemRow[]>`
    update shop set name = ${d.name ?? cur.name},
      description = ${d.description === undefined ? cur.description : d.description},
      price = ${d.price ?? cur.price}, currency = ${d.currency ? d.currency.toUpperCase() : cur.currency},
      stock = ${stock}, status = ${status}, kind = ${kind}, file = ${file}
     where id = ${id.data} returning ${sql.unsafe(ITEM_COLS)}`;
  if (dropFile) await deleteUpload(c.env, cur.file!);
  await adminLog(c, "shop_item.updated", { type: "shop_item", id: id.data, label: i!.name }, { fields: Object.keys(d) });
  return c.json({ item: itemJson(i!) });
});

// The downloadable file of a digital item: the raw bytes (PDF, ZIP, EPUB, MP3, MP4, PNG, JPEG or TXT, 25 MB at most), kept in the
// private bucket nuclear-uploads under downloads/<item id>-<ms>.<ext>. A new file replaces the old one.
admin.put("/shop-items/:id/file", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const mime = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = downloadExt(mime);
  if (!ext) return c.json({ error: "unsupported_file_type" }, 415);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length === 0) return c.json({ error: "invalid_request" }, 400);
  if (bytes.length > MAX_DOWNLOAD_BYTES) return c.json({ error: "file_too_large" }, 413);
  const sql = c.get("sql");
  const [it] = await sql<{ name: string; kind: string; file: string | null }[]>`select name, kind, file from shop where id = ${id.data}`;
  if (!it) return c.json({ error: "not_found" }, 404);
  if (it.kind !== "digital") return c.json({ error: "not_digital" }, 409);
  const key = `downloads/${id.data}-${Date.now()}.${ext}`;
  if (!(await putUpload(c.env, key, bytes, mime))) return c.json({ error: "storage_unavailable" }, 503);
  await sql`update shop set file = ${key} where id = ${id.data}`;
  if (it.file) await deleteUpload(c.env, it.file);
  await adminLog(c, "shop_item.file_uploaded", { type: "shop_item", id: id.data, label: it.name }, { type: ext, bytes: bytes.length });
  return c.body(null, 204);
});

// A shop item's picture: any PNG, JPEG or WebP (8 MB at most); the API crops it to 256 x 256 and compresses it to JPEG
// (only tag pictures must be PNG). Saved in nuclear-images as shop/<item id>-<ms>.jpg.
admin.put("/shop-items/:id/photo", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const sql = c.get("sql");
  const [m] = await sql<{ name: string; photo: string | null }[]>`select name, photo from shop where id = ${id.data}`;
  if (!m) return c.json({ error: "not_found" }, 404);
  const r = await saveProfilePhoto(c, "shop", id.data, m.photo);
  if (r instanceof Response) return r;
  await sql`update shop set photo = ${r.key} where id = ${id.data}`;
  await adminLog(c, "shop_item.photo_uploaded", { type: "shop_item", id: id.data, label: m.name });
  return c.body(null, 204);
});

// ---- Audit log --------------------------------------------------------------------------------
type LogRow = { id: string; actor_type: string; actor_id: string | null; actor_label: string | null; action: string; target_type: string | null; target_id: string | null; target_label: string | null; details: unknown; ip: string | null; created_at: Date };
const LOG_COLS = "id, actor_type, actor_id, actor_label, action, target_type, target_id, target_label, details, ip, created_at";

/** Newest first, cursor `<ts>|<id>`. Optional filters: actor kind (`who=admin|customer|...`), `action` prefix, `q` on labels. */
async function logPage(c: any, extra?: { accountId: string }) {
  const sql = c.get("sql");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
  const who = c.req.query("who");
  const action = c.req.query("action");
  const q = (c.req.query("q") ?? "").trim().slice(0, 80).replace(/[\\%_]/g, "\\$&");
  const cur = (c.req.query("cursor") ?? "").split("|");
  const cursor = cur.length === 2 && !Number.isNaN(Date.parse(cur[0]!)) && uuid.safeParse(cur[1]).success ? { ts: cur[0]!, id: cur[1]! } : null;
  const rows = await sql<LogRow[]>`
    select ${sql.unsafe(LOG_COLS)} from logs
     where true
       ${extra ? sql`and (target_id = ${extra.accountId} or actor_id = ${extra.accountId} or details->>'account_id' = ${extra.accountId} or details->>'merchant_id' = ${extra.accountId})` : sql``}
       ${who ? sql`and actor_type = ${who}` : sql``}
       ${action ? sql`and action like ${action.replace(/[\\%_]/g, "\\$&") + "%"}` : sql``}
       ${q ? sql`and (coalesce(actor_label,'') ilike ${"%" + q + "%"} or coalesce(target_label,'') ilike ${"%" + q + "%"} or action ilike ${"%" + q + "%"})` : sql``}
       ${cursor ? sql`and (created_at, id) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)` : sql``}
     order by created_at desc, id desc limit ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return c.json({ logs: page, next_cursor: rows.length > limit && last ? `${last.created_at.toISOString()}|${last.id}` : null });
}
admin.get("/logs", (c) => logPage(c));
admin.get("/users/:id/activity", (c) => { const id = uuid.safeParse(c.req.param("id")); return id.success ? logPage(c, { accountId: id.data }) : c.json({ error: "not_found" }, 404); });
admin.get("/organizations/:id/activity", (c) => { const id = uuid.safeParse(c.req.param("id")); return id.success ? logPage(c, { accountId: id.data }) : c.json({ error: "not_found" }, 404); });
admin.get("/merchants/:id/activity", (c) => { const id = uuid.safeParse(c.req.param("id")); return id.success ? logPage(c, { accountId: id.data }) : c.json({ error: "not_found" }, 404); });
