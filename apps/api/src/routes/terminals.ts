import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { hashToken, signTerminalJwt } from "../crypto";
import { decryptTagUrl } from "../lib/tagproof";
import { consumeCounter, isFresh, loadTag } from "../lib/tap";
import { requireOwner, requireSession, requireTerminal } from "../session";
import type { Sql } from "../db";

const uuid = z.string().uuid();
const nameSchema = z.string().trim().min(1).max(80);

type TerminalRow = { id: string; account_id: string; name: string; allow_refunds: boolean; created_at: Date; updated_at: Date };
type OrbRow = { id: string; uid: string; model: string; software: string; account_id: string | null; terminal_id: string | null };
const orbJson = (o: OrbRow) => ({ id: o.id, uid: o.uid, model: o.model, software: o.software });

const terminalJson = (t: TerminalRow, orb: OrbRow | null) => ({
  id: t.id,
  name: t.name,
  allow_refunds: t.allow_refunds,
  created_at: t.created_at,
  updated_at: t.updated_at,
  orb: orb ? orbJson(orb) : null,
});

/**
 * Issue a terminal session JWT and store its hash, replacing (and so revoking) any previous one.
 * The JWT carries its own expiry; terminals are not devices.
 */
async function issueTerminalSession(
  sql: Sql,
  secret: string,
  accountId: string,
  terminalId: string,
): Promise<{ token: string; expires: Date }> {
  const { token, expiresAt } = await signTerminalJwt(secret, { terminalId, accountId });
  await sql`update terminals set session_token_hash = ${hashToken(token)} where id = ${terminalId} and account_id = ${accountId}`;
  return { token, expires: expiresAt };
}

/** An Orb's UID is its MAC address: 12 hex characters, any separators, case-insensitive. */
export const orbUid = z
  .string()
  .trim()
  .transform((v) => v.replace(/[:\-\s]/g, "").toUpperCase())
  .refine((v) => /^[0-9A-F]{12}$/.test(v), { message: "invalid_orb_uid" });

const claimBody = z.object({
  uid: orbUid,
  model: z.string().trim().min(1).max(64),
  software: z.string().trim().min(1).max(64),
});

type Claim = z.infer<typeof claimBody>;

/**
 * Claim and pair an Orb to a terminal. An Orb the system has never seen registers itself here (the
 * terminal read its UID, model and firmware over BLE); an unassigned one is claimed by this account;
 * one owned by a different account cannot be paired. Pairing moves the Orb off any previous terminal
 * of the account, and a terminal holds one Orb, so its previous Orb is unpaired (and stays owned).
 * The reported firmware version is recorded.
 */
export async function pairOrb(
  sql: Sql,
  accountId: string,
  terminalId: string,
  c: Claim,
): Promise<{ error: string; status: 404 | 409 } | { orb: OrbRow }> {
  type R = { error: string; status: 404 | 409 } | { orb: OrbRow };
  const result = (await sql.begin(async (tx): Promise<R> => {
    const [t] = await tx<{ id: string }[]>`
      select id from terminals where id = ${terminalId} and account_id = ${accountId} for no key update`;
    if (!t) return { error: "terminal_not_found", status: 404 };

    // Register on first sight; a concurrent first claim of the same UID loses the insert race.
    await tx`
      insert into orbs (uid, model, software) values (${c.uid}, ${c.model}, ${c.software})
      on conflict (uid) do nothing`;
    const [o] = await tx<OrbRow[]>`
      select id, uid, model, software, account_id, terminal_id from orbs where uid = ${c.uid} for no key update`;
    if (!o) return { error: "orb_not_found", status: 404 };
    if (o.account_id !== null && o.account_id !== accountId) {
      return { error: "orb_assigned_to_another_account", status: 409 };
    }

    await tx`update orbs set terminal_id = null where terminal_id = ${terminalId} and id <> ${o.id}`;
    const [paired] = await tx<OrbRow[]>`
      update orbs set account_id = ${accountId}, terminal_id = ${terminalId}, software = ${c.software}
       where id = ${o.id} returning id, uid, model, software, account_id, terminal_id`;
    return { orb: paired! };
  })) as R;
  return result;
}

async function unpairOrb(sql: Sql, accountId: string, terminalId: string): Promise<boolean> {
  const rows = await sql`
    update orbs set terminal_id = null
     where terminal_id = ${terminalId} and account_id = ${accountId} returning id`;
  return rows.length > 0;
}

async function orbFor(sql: Sql, terminalId: string): Promise<OrbRow | null> {
  const [o] = await sql<OrbRow[]>`
    select id, uid, model, software, account_id, terminal_id from orbs where terminal_id = ${terminalId}`;
  return o ?? null;
}

// ---- Owner (merchant) management: /v1/terminals ---------------------------------------------

export const terminals = new Hono<AppContext>();
terminals.use("*", requireSession, requireOwner, async (c, next) => {
  const [a] = await c.get("sql")<{ type: string }[]>`select type from accounts where id = ${c.get("auth").accountId}`;
  if (a?.type !== "B") return c.json({ error: "business_account_required" }, 403);
  await next();
});

async function ownedTerminal(sql: Sql, accountId: string, id: string): Promise<TerminalRow | undefined> {
  const [t] = await sql<TerminalRow[]>`
    select id, account_id, name, allow_refunds, created_at, updated_at from terminals
     where id = ${id} and account_id = ${accountId}`;
  return t;
}

// Create a terminal from a merchant login; the app receives the terminal's own session.
terminals.post("/", async (c) => {
  const body = z
    .object({ name: nameSchema, allow_refunds: z.boolean().default(true) })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const { accountId } = c.get("auth");
  const sql = c.get("sql");

  const [t] = await sql<TerminalRow[]>`
    insert into terminals (account_id, name, allow_refunds)
    values (${accountId}, ${body.data.name}, ${body.data.allow_refunds})
    returning id, account_id, name, allow_refunds, created_at, updated_at`;
  const s = await issueTerminalSession(sql, c.env.JWT_SECRET, accountId, t!.id);
  return c.json({ terminal: terminalJson(t!, null), session_token: s.token, session_expires_at: s.expires }, 201);
});

terminals.get("/", async (c) => {
  const { accountId } = c.get("auth");
  const rows = await c.get("sql")<(TerminalRow & { orb_id: string | null; orb_uid: string | null; orb_model: string | null; orb_software: string | null })[]>`
    select t.id, t.account_id, t.name, t.allow_refunds, t.created_at, t.updated_at,
           o.id as orb_id, o.uid as orb_uid, o.model as orb_model, o.software as orb_software
      from terminals t left join orbs o on o.terminal_id = t.id
     where t.account_id = ${accountId}
     order by t.created_at, t.id`;
  return c.json({
    terminals: rows.map((r) =>
      terminalJson(r, r.orb_id ? { id: r.orb_id, uid: r.orb_uid!, model: r.orb_model!, software: r.orb_software!, account_id: accountId, terminal_id: r.id } : null),
    ),
  });
});

terminals.get("/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const sql = c.get("sql");
  const t = await ownedTerminal(sql, c.get("auth").accountId, id.data);
  if (!t) return c.json({ error: "not_found" }, 404);
  return c.json({ terminal: terminalJson(t, await orbFor(sql, t.id)) });
});

terminals.patch("/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  const body = z
    .object({ name: nameSchema, allow_refunds: z.boolean() })
    .partial()
    .refine((o) => Object.keys(o).length > 0, { message: "empty_patch" })
    .safeParse(await c.req.json().catch(() => null));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const sql = c.get("sql");
  const patch = body.data;
  const [t] = await sql<TerminalRow[]>`
    update terminals set ${sql(patch, ...(Object.keys(patch) as (keyof typeof patch)[]))}
     where id = ${id.data} and account_id = ${c.get("auth").accountId}
    returning id, account_id, name, allow_refunds, created_at, updated_at`;
  if (!t) return c.json({ error: "not_found" }, 404);
  return c.json({ terminal: terminalJson(t, await orbFor(sql, t.id)) });
});

// Re-issue a terminal session (e.g. replacement tablet); revokes the previous one.
terminals.post("/:id/session", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const sql = c.get("sql");
  const { accountId } = c.get("auth");
  if (!(await ownedTerminal(sql, accountId, id.data))) return c.json({ error: "not_found" }, 404);
  const s = await issueTerminalSession(sql, c.env.JWT_SECRET, accountId, id.data);
  return c.json({ session_token: s.token, session_expires_at: s.expires }, 201);
});

terminals.post("/:id/revoke", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const sql = c.get("sql");
  const { accountId } = c.get("auth");
  if (!(await ownedTerminal(sql, accountId, id.data))) return c.json({ error: "not_found" }, 404);
  await sql`update terminals set session_token_hash = null where id = ${id.data} and account_id = ${accountId}`;
  return c.body(null, 204);
});


terminals.put("/:id/orb", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  const body = claimBody.safeParse(await c.req.json().catch(() => null));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const r = await pairOrb(c.get("sql"), c.get("auth").accountId, id.data, body.data);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  return c.json({ orb: orbJson(r.orb) });
});

terminals.delete("/:id/orb", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const sql = c.get("sql");
  const { accountId } = c.get("auth");
  if (!(await ownedTerminal(sql, accountId, id.data))) return c.json({ error: "not_found" }, 404);
  await unpairOrb(sql, accountId, id.data);
  return c.body(null, 204);
});

// ---- The terminal itself: /v1/terminal -------------------------------------------------------

export const terminalSelf = new Hono<AppContext>();
terminalSelf.use("*", requireTerminal);

terminalSelf.get("/", async (c) => {
  const sql = c.get("sql");
  const { accountId, terminalId } = c.get("terminal");
  const t = await ownedTerminal(sql, accountId, terminalId);
  if (!t) return c.json({ error: "not_found" }, 404);
  return c.json({ terminal: terminalJson(t, await orbFor(sql, t.id)) });
});

terminalSelf.put("/orb", async (c) => {
  const body = claimBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const { accountId, terminalId } = c.get("terminal");
  const r = await pairOrb(c.get("sql"), accountId, terminalId, body.data);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  return c.json({ orb: orbJson(r.orb) });
});

// The terminal reports the paired Orb's current firmware (read over BLE) after an update.
terminalSelf.patch("/orb", async (c) => {
  const body = z.object({ software: z.string().trim().min(1).max(64) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const { accountId, terminalId } = c.get("terminal");
  const [o] = await c.get("sql")<OrbRow[]>`
    update orbs set software = ${body.data.software}
     where terminal_id = ${terminalId} and account_id = ${accountId}
    returning id, uid, model, software, account_id, terminal_id`;
  if (!o) return c.json({ error: "no_orb_paired" }, 404);
  return c.json({ orb: orbJson(o) });
});

terminalSelf.delete("/orb", async (c) => {
  const { accountId, terminalId } = c.get("terminal");
  await unpairOrb(c.get("sql"), accountId, terminalId);
  return c.body(null, 204);
});

// Re-issue the terminal's JWT with a fresh expiry; the presented token stops working.
terminalSelf.post("/session/extend", async (c) => {
  const { accountId, terminalId } = c.get("terminal");
  const s = await issueTerminalSession(c.get("sql"), c.env.JWT_SECRET, accountId, terminalId);
  return c.json({ session_token: s.token, session_expires_at: s.expires });
});

// End this terminal's session (a merchant owner login can issue a new one).
terminalSelf.delete("/session", async (c) => {
  const { accountId, terminalId } = c.get("terminal");
  await c.get("sql")`update terminals set session_token_hash = null where id = ${terminalId} and account_id = ${accountId}`;
  return c.body(null, 204);
});

// Who is this? Resolve a tapped band/card to its account (customer or staff).
// Like every verified tap, a lookup with a valid counter burns the proof: the counter is consumed
// atomically, even if the tag then turns out unassigned or locked. A tap used for lookup cannot
// also authorize a payment or refund; tap again (or send the tap straight to the pay/refund route).
const credentialSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tag"), url: z.string().min(1).max(512) }),
  z.object({ type: z.literal("pass"), id: z.string().max(128).optional(), proof: z.string().max(4096).optional() }),
]);

type LookupResult = { error: string; status: 404 | 409 | 422 } | { account: Record<string, unknown> };

terminalSelf.post("/lookup", async (c) => {
  const body = z.object({ credential: credentialSchema }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  if (body.data.credential.type === "pass") return c.json({ error: "pass_verification_unavailable" }, 501);

  const proof = await decryptTagUrl(c.env, body.data.credential.url);
  if (!proof) return c.json({ error: "invalid_tag" }, 400);
  const { accountId } = c.get("terminal");

  const result = (await c.get("sql").begin(async (tx): Promise<LookupResult> => {
    const tag = await loadTag(tx, proof.uid, true);
    if (!tag) return { error: "tag_not_found", status: 404 };
    if (!isFresh(tag, proof.counter)) return { error: "proof_replayed", status: 409 };
    await consumeCounter(tx, tag.id, proof.counter);

    if (!tag.wallet_id || !tag.account_id || tag.account_status !== "active") return { error: "tag_unassigned", status: 422 };
    if (tag.locked) return { error: "tag_locked", status: 422 };

    // Tell the POS whether the tapped person is this merchant's staff.
    const [st] = await tx<{ role: string }[]>`
      select role from staff where account_id = ${accountId} and staff_account_id = ${tag.account_id}`;
    return {
      account: {
        account_id: tag.account_id,
        wallet_id: tag.wallet_id,
        handle: tag.handle,
        display_name: tag.display_name,
        photo: tag.photo,
        staff: st ? { role: st.role } : null,
      },
    };
  })) as LookupResult;

  if ("error" in result) return c.json({ error: result.error }, result.status);
  return c.json({ account: result.account });
});

// ---- Catalogue on the terminal ----------------------------------------------------------------

type ProductRow = {
  id: string; category_id: string | null; name: string; currency: string; price: bigint; photo: string | null;
  stock: number | null; active: boolean; status: string; total_sold: bigint; sold_today: number; discount: bigint;
};
const productJson = (p: ProductRow) => ({
  id: p.id,
  category_id: p.category_id,
  name: p.name,
  currency: p.currency,
  price: Number(p.price),
  discount: Number(p.discount),
  effective_price: Number(p.price - p.discount),
  photo: p.photo,
  stock: p.stock,
  active: p.active,
  status: p.status,
  total_sold: Number(p.total_sold),
  sold_today: p.sold_today,
});
const PRODUCT_COLS = `id, category_id, name, currency, price, photo, stock, active, status, total_sold, sold_today, discount`;

// The merchant's active products for the POS (sold-out ones included, so they can be restocked).
terminalSelf.get("/products", async (c) => {
  const sql = c.get("sql");
  const category = z.string().uuid().safeParse(c.req.query("category_id"));
  const rows = await sql<ProductRow[]>`
    select ${sql.unsafe(PRODUCT_COLS)} from products
     where account_id = ${c.get("terminal").accountId} and active
       ${category.success ? sql`and category_id = ${category.data}` : sql``}
     order by name, id`;
  return c.json({ products: rows.map(productJson) });
});

// Restock: add units to a tracked product. Increments (not "set to") so concurrent sales are never
// overwritten; a sold-out product becomes available again. expected_stock is an optional guard: the
// restock is refused (409) if the stock is no longer what the POS saw, which also makes a blind
// retry after a lost response safe.
const restockBody = z.object({
  quantity: z.number().int().min(1).max(1_000_000),
  expected_stock: z.number().int().min(0).optional(),
});

terminalSelf.post("/products/:id/restock", async (c) => {
  const id = z.string().uuid().safeParse(c.req.param("id"));
  const body = restockBody.safeParse(await c.req.json().catch(() => null));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const sql = c.get("sql");
  const { accountId } = c.get("terminal");

  type R = { error: string; status: 404 | 409 | 422 } | { product: ProductRow };
  const result = (await sql.begin(async (tx): Promise<R> => {
    const [p] = await tx<ProductRow[]>`
      select ${tx.unsafe(PRODUCT_COLS)} from products
       where id = ${id.data} and account_id = ${accountId} for no key update`;
    if (!p || !p.active) return { error: "not_found", status: 404 };
    if (p.stock === null) return { error: "stock_not_tracked", status: 422 };
    if (body.data.expected_stock !== undefined && body.data.expected_stock !== p.stock) {
      return { error: "stock_changed", status: 409 };
    }
    if (p.stock + body.data.quantity > 2_147_483_647) return { error: "stock_too_large", status: 422 };
    const [u] = await tx<ProductRow[]>`
      update products set stock = stock + ${body.data.quantity}
       where id = ${id.data} returning ${tx.unsafe(PRODUCT_COLS)}`;
    return { product: u! };
  })) as R;

  if ("error" in result) return c.json({ error: result.error }, result.status);
  return c.json({ product: productJson(result.product) });
});

// ---- Orb inventory for the owning merchant: /v1/orbs ----------------------------------------

export const orbs = new Hono<AppContext>();
orbs.use("*", requireSession, requireOwner);
orbs.get("/", async (c) => {
  const rows = await c.get("sql")<OrbRow[]>`
    select id, uid, model, software, account_id, terminal_id from orbs
     where account_id = ${c.get("auth").accountId} order by created_at, id`;
  return c.json({ orbs: rows.map((o) => ({ ...orbJson(o), terminal_id: o.terminal_id })) });
});

// Release an Orb (sold, returned, replaced): it leaves this account and its terminal, and can then
// be claimed by whoever next pairs it.
orbs.post("/:id/release", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const rows = await c.get("sql")`
    update orbs set account_id = null, terminal_id = null
     where id = ${id.data} and account_id = ${c.get("auth").accountId} returning id`;
  if (rows.length === 0) return c.json({ error: "not_found" }, 404);
  return c.body(null, 204);
});
