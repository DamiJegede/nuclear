import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { amountOrZero, n } from "../lib/money";

// Operator endpoints: define tag models and import a supplier's band/card UIDs. Not account
// sessions: a single operator bearer token (ADMIN_API_TOKEN). With no token configured the whole
// area answers 404, so it cannot be reached by accident.

export const admin = new Hono<AppContext>();

const digest = (s: string) => createHash("sha256").update(s).digest();

admin.use("*", async (c, next) => {
  const expected = c.env.ADMIN_API_TOKEN;
  if (!expected) return c.json({ error: "not_found" }, 404);
  const h = c.req.header("authorization") ?? "";
  const got = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!got || !timingSafeEqual(digest(got), digest(expected))) return c.json({ error: "unauthorized" }, 401);
  await next();
});

const uuid = z.string().uuid();

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
    select ${sql.unsafe(M_COLS.split(", ").map((x) => "m." + x).join(", "))},
           count(t.id)::int as tags,
           (count(t.id) filter (where t.wallet_id is null))::int as unassigned
      from tag_models m left join tags t on t.model_id = m.id
     group by m.id order by m.created_at, m.id`;
  return c.json({ models: rows.map((m) => modelJson(m, { tags: m.tags, unassigned: m.unassigned })) });
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
