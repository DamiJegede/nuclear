import { RULES, byIp, rateLimit } from "../lib/throttle";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { AppContext } from "../env";
import { amountOrZero, n } from "../lib/money";
import { MERCHANT_ADMINS, MERCHANT_WRITERS, PAGES, USER_ADMINS, USER_WRITERS, ROLES, ROLE_PAGES, TAG_WRITERS, canSee, isRole, landing, type Page, type Role } from "../lib/roles";
import { approvePending, rejectPending } from "../lib/refund";
import { reset as resetThrottle } from "../lib/throttle";
import { USER_TX_KINDS, userDetail, userDevices, userFunding, userOrders, userTags, userTransactions, userWallets, type UserTxKind } from "../lib/userSupport";
import { MERCHANT_TX_KINDS, merchantDetail, merchantProducts, merchantStaff, merchantTerminals, merchantTransactions, type MerchantTxKind } from "../lib/merchantSupport";
import { TX_KINDS, merchantList, transactionFeed, userList, type TxKind } from "../lib/adminLists";
import { PHOTO_SQL } from "../lib/photo";
import { systemStats } from "../lib/stats";
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
  if (r.ok === false) return c.json({ error: "invalid_credentials" }, 401);
  if (r.ok === "mfa") {
    return c.json({
      mfa_required: true,
      mfa_token: await signMfaChallenge(c.env.JWT_SECRET, r.adminId),
      expires_in: MFA_CHALLENGE_SECONDS,
    });
  }
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
  if (r.ok === false) return c.json({ error: "invalid_credentials" }, 401);
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
admin.use("/merchants", requirePage("merchants"));
admin.use("/merchants/*", requirePage("merchants"));
admin.use("/terminals/*", requirePage("merchants"));
admin.use("/users", requirePage("users"));
admin.use("/users/*", requirePage("users"));
admin.use("/wallets/*", requirePage("users"));
admin.use("/transactions", requirePage("transactions"));
admin.use("/admins", requirePage("admins"));
admin.use("/admins/*", requirePage("admins"));
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
  return sql.begin(async (tx) => {
    const [cur] = await tx<{ role: Role }[]>`select role from admins where id = ${id.data} for no key update`;
    if (!cur) return c.json({ error: "not_found" }, 404);
    const [a] = await tx<{ id: string; access_id: string; name: string; role: Role; status: string }[]>`
      update admins set role = ${body.data.role} where id = ${id.data} returning id, access_id, name, role, status`;
    return c.json({ admin: a });
  });
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
  return c.json({ admin: a, credentials: { access_id: a.access_id, access_token: issued } });
});

const uuid = z.string().uuid();

// ---- System snapshot --------------------------------------------------------------------------

admin.get("/stats", async (c) => c.json(await systemStats(c.get("sql"))));

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
const merchantId = z.string().uuid();
const merchantTxQuery = z.object({
  kind: z.enum(MERCHANT_TX_KINDS as [MerchantTxKind, ...MerchantTxKind[]]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
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
  return c.json({ products: await merchantProducts(c.get("sql"), id.data) });
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
  const rows = await c.get("sql")`update accounts set status = ${body.data.status} where id = ${id.data} and type = 'B' and status <> 'closed' returning id, status`;
  return rows.length ? c.json({ merchant: rows[0] }) : c.json({ error: "not_found" }, 404);
});

// ---- One person, for support ------------------------------------------------------------------------
const userTxQuery = z.object({
  kind: z.enum(USER_TX_KINDS as [UserTxKind, ...UserTxKind[]]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(100).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).refine((q) => [q.from, q.to].every((d) => d === undefined || (!Number.isNaN(Date.parse(d)) && new Date(d).toISOString().startsWith(d))), { message: "invalid_date" })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, { message: "from_after_to" });

admin.get("/users/:id", async (c) => {
  const id = merchantId.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const u = await userDetail(c.get("sql"), id.data);
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
  return c.json({ signed_out: rows.length });
});
admin.post("/users/:id/unlock-login", async (c) => {
  const denied = roleGate(USER_WRITERS)(c); if (denied) return denied;
  const id = merchantId.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const u = await userDetail(c.get("sql"), id.data);
  if (!u) return c.json({ error: "not_found" }, 404);
  if (u.email) await resetThrottle(c.get("sql"), `login:${u.email.toLowerCase()}`);
  return c.body(null, 204);
});
admin.post("/wallets/:id/revoke-key", async (c) => {
  const denied = roleGate(USER_WRITERS)(c); if (denied) return denied;
  const id = merchantId.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const rows = await c.get("sql")`update wallets set key_hash = null, key_hint = null, key_last_used_at = null where id = ${id.data} and key_hash is not null returning id`;
  return rows.length ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
});
// Admin only: suspend or reactivate a person, or one of their wallets. A suspended account is refused on its
// next request (sessions, wallets, agent keys alike); nothing is deleted.
admin.put("/users/:id/status", async (c) => {
  const denied = roleGate(USER_ADMINS)(c); if (denied) return denied;
  const id = merchantId.safeParse(c.req.param("id"));
  const body = z.object({ status: z.enum(["active", "suspended"]) }).safeParse(await c.req.json().catch(() => null));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const rows = await c.get("sql")`update accounts set status = ${body.data.status} where id = ${id.data} and type = 'C' and status <> 'closed' returning id, status`;
  return rows.length ? c.json({ user: rows[0] }) : c.json({ error: "not_found" }, 404);
});
admin.put("/wallets/:id/status", async (c) => {
  const denied = roleGate(USER_ADMINS)(c); if (denied) return denied;
  const id = merchantId.safeParse(c.req.param("id"));
  const body = z.object({ status: z.enum(["active", "suspended"]) }).safeParse(await c.req.json().catch(() => null));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const rows = await c.get("sql")`update wallets w set status = ${body.data.status} from accounts a where w.id = ${id.data} and a.id = w.account_id and a.type = 'C' and w.status <> 'closed' returning w.id, w.status`;
  return rows.length ? c.json({ wallet: rows[0] }) : c.json({ error: "not_found" }, 404);
});

// Support action: sign a terminal out (clears its stored session, so its token stops working and the
// merchant signs it in again). Admin and Merchants roles only.
admin.post("/terminals/:id/sign-out", async (c) => {
  const a = c.get("adminAuth");
  if (a.kind === "admin" && !MERCHANT_WRITERS.includes(a.role)) return c.json({ error: "forbidden_role" }, 403);
  const id = merchantId.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const rows = await c.get("sql")`update terminals set session_token_hash = null where id = ${id.data} returning id`;
  return rows.length ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
});

const txQuery = z.object({
  kind: z.enum(TX_KINDS as [TxKind, ...TxKind[]]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
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
  photo: z.string().trim().max(2048).optional(),
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
  id: m.id, type: m.type, name: m.name, photo: m.photo, currency: m.currency, price: n(m.price),
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
    values (${b.type}, ${b.name}, ${b.photo ?? null}, ${b.currency}, ${b.price.toString()},
            ${b.country ?? null}, ${b.quantity}, ${b.limited}, ${b.status})
    returning ${sql.unsafe(M_COLS)}`;
  return c.json({ model: modelJson(m!) }, 201);
});

admin.get("/tag-models", async (c) => {
  const sql = c.get("sql");
  const rows = await sql<(ModelRow & { tags: number; unassigned: number })[]>`
    select ${sql.unsafe(M_COLS.split(", ").filter((x) => x !== "photo").map((x) => "m." + x).join(", "))}, ${sql.unsafe(PHOTO_SQL)},
           count(t.id)::int as tags,
           (count(t.id) filter (where t.wallet_id is null))::int as unassigned
      from tag_models m left join tags t on t.model_id = m.id
           left join tag_model_photos p on p.model_id = m.id
     group by m.id, p.model_id, p.updated_at order by m.created_at, m.id`;
  return c.json({ models: rows.map((m) => modelJson(m, { tags: m.tags, unassigned: m.unassigned })) });
});

// One model with its provisioning and activation numbers and its sales rank (1 = best seller; models
// with the same sold count share a rank).
admin.get("/tag-models/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const sql = c.get("sql");
  const [m] = await sql<(ModelRow & { tags: number; unassigned: number; activated: number; rank: number; models_total: number })[]>`
    select ${sql.unsafe(M_COLS.split(", ").filter((x) => x !== "photo").map((x) => "m." + x).join(", "))}, ${sql.unsafe(PHOTO_SQL)},
           (select count(*) from tags t where t.model_id = m.id)::int as tags,
           (select count(*) from tags t where t.model_id = m.id and t.wallet_id is null)::int as unassigned,
           (select count(*) from tags t where t.model_id = m.id and t.wallet_id is not null)::int as activated,
           (1 + (select count(*) from tag_models o where o.sold > m.sold))::int as rank,
           (select count(*) from tag_models)::int as models_total
      from tag_models m left join tag_model_photos p on p.model_id = m.id
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
  return sql.begin(async (tx) => {
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
});

// Upload a model's photo: the raw PNG bytes (256 KB at most). The portal resizes to 256 x 256 first. Stored as hex through decode() so the driver never handles binary parameters.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_PHOTO_BYTES = 262_144;
admin.put("/tag-models/:id/photo", async (c) => {
  const id = z.string().uuid().safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "image/png") return c.json({ error: "unsupported_image_type" }, 415);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length === 0) return c.json({ error: "invalid_request" }, 400);
  if (bytes.length > MAX_PHOTO_BYTES) return c.json({ error: "image_too_large" }, 413);
  if (bytes.length < 8 || !PNG_SIGNATURE.every((b, k) => bytes[k] === b)) return c.json({ error: "invalid_image" }, 400);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const sql = c.get("sql");
  const done = await sql`
    insert into tag_model_photos (model_id, content_type, data)
    select ${id.data}, ${type}, decode(${hex}, 'hex') where exists (select 1 from tag_models where id = ${id.data})
    on conflict (model_id) do update set content_type = excluded.content_type, data = excluded.data, updated_at = now()
    returning model_id`;
  if (done.length === 0) return c.json({ error: "not_found" }, 404);
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
