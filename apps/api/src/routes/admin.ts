import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { AppContext } from "../env";
import { amountOrZero, n } from "../lib/money";
import { PHOTO_SQL } from "../lib/photo";
import { systemStats } from "../lib/stats";
import { MFA_CHALLENGE_SECONDS, hashPassword, signMfaChallenge, verifyMfaChallenge } from "../crypto"; // hashing helpers are shared with customer accounts
import {
  completeMfa, findSession, generateAccessId, generateAccessToken, login, mfaEnable,
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
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
    allowHeaders: ["authorization", "content-type"],
    maxAge: 600,
  }),
);

const bearer = (h: string | undefined) => (h ?? "").startsWith("Bearer ") ? (h as string).slice(7).trim() : "";

// ---- Sign-in (public) -------------------------------------------------------------------------

const loginBody = z.object({ access_id: z.string().trim().min(1).max(64), access_token: z.string().min(1).max(256) });

const sessionJson = (r: Session) => ({
  session_token: r.token,
  expires_at: r.expiresAt,
  admin: { access_id: r.admin.access_id, name: r.admin.name },
  mfa_enabled: r.admin.mfa_enabled,
});

// Step one: access ID and access token. With MFA enrolled the answer is a short-lived challenge
// instead of a session.
admin.post("/login", async (c) => {
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

admin.post("/login/mfa", async (c) => {
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
    kind: "admin", adminId: s.admin_id, accessId: s.access_id, name: s.name,
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

admin.get("/me", (c) => {
  const a = c.get("adminAuth");
  return c.json(
    a.kind === "operator"
      ? { operator: true }
      : { access_id: a.accessId, name: a.name, mfa_enabled: a.mfaEnabled },
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

const newAdminBody = z.object({ name: z.string().trim().min(1).max(80) });

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
      const [a] = await sql<{ id: string; access_id: string; name: string }[]>`
        insert into admins (access_id, name, access_token_hash, created_by)
        values (${accessId}, ${body.data.name}, ${hash}, ${by.kind === "admin" ? by.adminId : null})
        returning id, access_id, name`;
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
    select a.id, a.access_id, a.name, a.status, a.last_login_at, a.created_at,
           (a.mfa_enabled_at is not null) as mfa_enabled,
           (a.locked_until is not null and a.locked_until > now()) as locked,
           c.access_id as created_by
      from admins a left join admins c on c.id = a.created_by
     order by a.created_at, a.id`;
  return c.json({ admins: rows });
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

// Upload a model's photo: the raw image bytes (JPEG, PNG or WebP, 256 KB at most). The portal resizes
// to 256 x 256 first. Stored as hex through decode() so the driver never handles binary parameters.
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_PHOTO_BYTES = 262_144;
admin.put("/tag-models/:id/photo", async (c) => {
  const id = z.string().uuid().safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!PHOTO_TYPES.includes(type)) return c.json({ error: "unsupported_image_type" }, 415);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length === 0) return c.json({ error: "invalid_request" }, 400);
  if (bytes.length > MAX_PHOTO_BYTES) return c.json({ error: "image_too_large" }, 413);
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
