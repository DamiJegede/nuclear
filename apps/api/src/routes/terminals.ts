import { Hono } from "hono";
import { imageUrl } from "../lib/images";
import { z } from "zod";
import { uuid } from "../lib/validate";
import { soldToday } from "../lib/txn";
import type { AppContext } from "../env";
import { hashToken, signTerminalJwt } from "../crypto";
import { decryptTagUrl } from "../lib/tagproof";
import { consumeCounter, isFresh, loadTag } from "../lib/tap";
import { requireOwner, requireSession, requireTerminal } from "../session";
import type { Sql } from "../db";
import { ORB_NONCE, ORB_UID, authorizeBind, orbKey } from "../lib/orbKeys";
import { log } from "../lib/audit";
import { closeOut } from "../lib/settlement";
import { proofFrom, tapStaff } from "./refunds";
import { RULES, rateLimit } from "../lib/throttle";

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
 * Pair an Orb with a terminal. The Orb is not a table of its own: its MAC address, model and firmware are columns of the terminal it is paired
 * with, so it belongs to that terminal's account. Pairing writes them on this terminal (replacing any Orb it had) and, if the same MAC was on
 * another terminal of the account, moves it off that one. A MAC on another account's terminal cannot be paired (409). The reported firmware is
 * recorded. The Orb's `id` in the API is its terminal's id.
 */
export async function pairOrb(
  sql: Sql,
  accountId: string,
  terminalId: string,
  c: Claim,
): Promise<{ error: string; status: 404 | 409 } | { orb: OrbRow }> {
  type R = { error: string; status: 404 | 409 } | { orb: OrbRow };
  try {
    return (await sql.begin(async (tx): Promise<R> => {
      const [t] = await tx<{ id: string }[]>`select id from terminals where id = ${terminalId} and account_id = ${accountId} for no key update`;
      if (!t) return { error: "terminal_not_found", status: 404 };
      const [held] = await tx<{ id: string; account_id: string }[]>`select id, account_id from terminals where orb_uid = ${c.uid} for no key update`;
      if (held && held.account_id !== accountId) return { error: "orb_assigned_to_another_account", status: 409 };
      if (held && held.id !== terminalId) {
        await tx`update terminals set orb_uid = null, orb_model = null, orb_software = null, orb_paired_at = null where id = ${held.id}`;
      }
      await tx`
        update terminals set orb_uid = ${c.uid}, orb_model = ${c.model}, orb_software = ${c.software},
                             orb_paired_at = case when orb_uid = ${c.uid} then orb_paired_at else now() end
         where id = ${terminalId}`;
      return { orb: { id: terminalId, uid: c.uid, model: c.model, software: c.software, account_id: accountId, terminal_id: terminalId } };
    })) as R;
  } catch (err) {
    // Two first claims of one MAC at once: the unique index lets exactly one in.
    if ((err as { code?: string }).code === "23505") return { error: "orb_assigned_to_another_account", status: 409 };
    throw err;
  }
}

/** Frees the terminal's Orb: its MAC address, model and firmware are removed from the terminal, so any account can pair that MAC next. */
async function unpairOrb(sql: Sql, accountId: string, terminalId: string): Promise<boolean> {
  const rows = await sql`
    update terminals set orb_uid = null, orb_model = null, orb_software = null, orb_paired_at = null
     where id = ${terminalId} and account_id = ${accountId} and orb_uid is not null returning id`;
  return rows.length > 0;
}

async function orbFor(sql: Sql, terminalId: string): Promise<OrbRow | null> {
  const [o] = await sql<OrbRow[]>`
    select id, orb_uid as uid, orb_model as model, orb_software as software, account_id, id as terminal_id from terminals where id = ${terminalId} and orb_uid is not null`;
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
  const rows = await c.get("sql")<(TerminalRow & { orb_uid: string | null; orb_model: string | null; orb_software: string | null })[]>`
    select t.id, t.account_id, t.name, t.allow_refunds, t.created_at, t.updated_at, t.orb_uid, t.orb_model, t.orb_software
      from terminals t
     where t.account_id = ${accountId}
     order by t.created_at, t.id`;
  return c.json({
    terminals: rows.map((r) =>
      terminalJson(r, r.orb_uid ? { id: r.id, uid: r.orb_uid, model: r.orb_model!, software: r.orb_software!, account_id: accountId, terminal_id: r.id } : null),
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

// Authorizes binding an Orb to this terminal (docs/ORB.md §8a). The terminal read `uid` and the connection nonce from the Orb's Hello; the
// answer is relayed to the Orb in the Bind handshake. Nothing is stored: the proof is tied to that Orb, that nonce and a fresh binding id.
terminalSelf.post("/orb/bind", rateLimit("orb-bind", RULES.orbBind, (c) => c.get("terminal").terminalId), async (c) => {
  const body = z.object({ uid: orbUid, nonce: z.string().regex(ORB_NONCE) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const key = orbKey(c.env.ORB_KEY_V1);
  if (!key) return c.json({ error: "orb_keys_unavailable" }, 503);
  const { accountId, terminalId } = c.get("terminal");
  const sql = c.get("sql");
  const [held] = await sql<{ account_id: string }[]>`select account_id from terminals where orb_uid = ${body.data.uid} and account_id <> ${accountId} limit 1`;
  if (held) return c.json({ error: "orb_assigned_to_another_account" }, 409);
  const out = await authorizeBind(key, body.data.uid, body.data.nonce);
  await log(sql, { actor: { type: "system", label: "terminal" }, action: "orb.bind_authorized", target: { type: "terminal", id: terminalId }, details: { account_id: accountId, uid: body.data.uid, binding_id: out.binding_id } });
  return c.json(out);
});

// The terminal reports the paired Orb's current firmware (read over BLE) after an update.
terminalSelf.patch("/orb", async (c) => {
  const body = z.object({ software: z.string().trim().min(1).max(64) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const { accountId, terminalId } = c.get("terminal");
  const [o] = await c.get("sql")<OrbRow[]>`
    update terminals set orb_software = ${body.data.software}
     where id = ${terminalId} and account_id = ${accountId} and orb_uid is not null
    returning id, orb_uid as uid, orb_model as model, orb_software as software, account_id, id as terminal_id`;
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
        photo: imageUrl(tag.photo),
        staff: st ? { role: st.role } : null,
      },
    };
  })) as LookupResult;

  if ("error" in result) return c.json({ error: result.error }, result.status);
  return c.json({ account: result.account });
});

// Close out from the terminal: the merchant's staff ends the day. Needs a tap by staff with the `write` role (the proof is burned either way), then
// runs the same whole-balance close-out as the owner's (`POST /v1/business/close-out`): one settlement a day, paid to the payout bank at once.
terminalSelf.post("/close-out", rateLimit("terminal-close-out", RULES.terminalCloseOut, (c) => c.get("terminal")?.accountId ?? null), async (c) => {
  const body = z.object({ approval: z.object({ credential: credentialSchema }) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const proof = await proofFrom(c.env, body.data.approval.credential);
  if (proof === "pass") return c.json({ error: "pass_verification_unavailable" }, 501);
  if (!proof) return c.json({ error: "invalid_tag" }, 400);
  const sql = c.get("sql"), { accountId } = c.get("terminal");
  type R = { error: string; status: 403 | 404 | 409 | 422 } | { staff: string };
  const tap = (await sql.begin(async (tx): Promise<R> => {
    const t = await tapStaff(tx, proof, accountId);
    if (t.kind === "error") return t;
    if (t.kind === "not_staff") return { error: "approver_not_authorized", status: 403 };
    return { staff: t.accountId };
  })) as R;
  if ("error" in tap) return c.json({ error: tap.error }, tap.status);

  const r = await closeOut(c.env, sql, accountId);
  if (!r.ok) {
    const status = r.error === "payouts_unavailable" ? 503 : 409;
    return c.json({ error: r.error, ...(r.owed !== undefined ? { owed: r.owed } : {}) }, status);
  }
  await log(sql, { actor: { type: "customer", id: tap.staff }, action: "merchant.closed_out_by_staff", target: { type: "settlement", id: r.settlement.id, label: r.settlement.date }, details: { merchant_id: accountId, terminal_id: c.get("terminal").terminalId, amount: r.settlement.amount } });
  return c.json({ settlement: { ...r.settlement, status: r.settlement.status === "settled" ? "completed" : r.settlement.status === "submitted" ? "pending" : r.settlement.status } }, 201);
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
  photo: imageUrl(p.photo),
  stock: p.stock,
  active: p.active,
  status: p.status,
  total_sold: Number(p.total_sold),
  sold_today: p.sold_today,
});
const PRODUCT_COLS = `id, category_id, name, currency, price, photo, stock, active, status, total_sold, ${soldToday} as sold_today, discount`;

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

// ---- The merchant's Orbs: /v1/orbs (an Orb is the hardware paired with one of its terminals, so this lists terminals that have one) ----------

export const orbs = new Hono<AppContext>();
orbs.use("*", requireSession, requireOwner);
orbs.get("/", async (c) => {
  const rows = await c.get("sql")<OrbRow[]>`
    select id, orb_uid as uid, orb_model as model, orb_software as software, account_id, id as terminal_id from terminals
     where account_id = ${c.get("auth").accountId} and orb_uid is not null order by orb_paired_at, id`;
  return c.json({ orbs: rows.map((o) => ({ ...orbJson(o), terminal_id: o.terminal_id })) });
});

// Free an Orb (sold, returned, replaced): its MAC address, model and firmware are removed from the terminal and any account can pair it next.
// The id is the terminal's id.
orbs.post("/:id/release", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  if (!(await unpairOrb(c.get("sql"), c.get("auth").accountId, id.data))) return c.json({ error: "not_found" }, 404);
  return c.body(null, 204);
});
