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
type OrbRow = { id: string; model: string; software: string; account_id: string | null; terminal_id: string | null };

const terminalJson = (t: TerminalRow, orb: OrbRow | null) => ({
  id: t.id,
  name: t.name,
  allow_refunds: t.allow_refunds,
  created_at: t.created_at,
  updated_at: t.updated_at,
  orb: orb ? { id: orb.id, model: orb.model, software: orb.software } : null,
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

/**
 * Pair an Orb to a terminal. The Orb leaves any previous terminal of the same account; an Orb owned
 * by a different account cannot be paired; an unassigned Orb is claimed by this account. A terminal
 * holds one Orb, so any Orb it already had is unpaired (and stays with the account).
 */
export async function pairOrb(
  sql: Sql,
  accountId: string,
  terminalId: string,
  orbId: string,
): Promise<{ error: string; status: 404 | 409 } | { orb: OrbRow }> {
  const result = await sql.begin(async (tx): Promise<{ error: string; status: 404 | 409 } | { orb: OrbRow }> => {
    const [t] = await tx<{ id: string }[]>`
      select id from terminals where id = ${terminalId} and account_id = ${accountId} for no key update`;
    if (!t) return { error: "terminal_not_found", status: 404 };

    const [o] = await tx<OrbRow[]>`
      select id, model, software, account_id, terminal_id from orbs where id = ${orbId} for no key update`;
    if (!o) return { error: "orb_not_found", status: 404 };
    if (o.account_id !== null && o.account_id !== accountId) {
      return { error: "orb_assigned_to_another_account", status: 409 };
    }

    await tx`update orbs set terminal_id = null where terminal_id = ${terminalId} and id <> ${orbId}`;
    const [paired] = await tx<OrbRow[]>`
      update orbs set account_id = ${accountId}, terminal_id = ${terminalId}
       where id = ${orbId} returning id, model, software, account_id, terminal_id`;
    return { orb: paired! };
  });
  return result as { error: string; status: 404 | 409 } | { orb: OrbRow };
}

async function unpairOrb(sql: Sql, accountId: string, terminalId: string): Promise<boolean> {
  const rows = await sql`
    update orbs set terminal_id = null
     where terminal_id = ${terminalId} and account_id = ${accountId} returning id`;
  return rows.length > 0;
}

async function orbFor(sql: Sql, terminalId: string): Promise<OrbRow | null> {
  const [o] = await sql<OrbRow[]>`
    select id, model, software, account_id, terminal_id from orbs where terminal_id = ${terminalId}`;
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
  const rows = await c.get("sql")<(TerminalRow & { orb_id: string | null; orb_model: string | null; orb_software: string | null })[]>`
    select t.id, t.account_id, t.name, t.allow_refunds, t.created_at, t.updated_at,
           o.id as orb_id, o.model as orb_model, o.software as orb_software
      from terminals t left join orbs o on o.terminal_id = t.id
     where t.account_id = ${accountId}
     order by t.created_at, t.id`;
  return c.json({
    terminals: rows.map((r) =>
      terminalJson(r, r.orb_id ? { id: r.orb_id, model: r.orb_model!, software: r.orb_software!, account_id: accountId, terminal_id: r.id } : null),
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

const orbBody = z.object({ orb_id: uuid });

terminals.put("/:id/orb", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  const body = orbBody.safeParse(await c.req.json().catch(() => null));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const r = await pairOrb(c.get("sql"), c.get("auth").accountId, id.data, body.data.orb_id);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  return c.json({ orb: { id: r.orb.id, model: r.orb.model, software: r.orb.software } });
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
  const body = orbBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const { accountId, terminalId } = c.get("terminal");
  const r = await pairOrb(c.get("sql"), accountId, terminalId, body.data.orb_id);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  return c.json({ orb: { id: r.orb.id, model: r.orb.model, software: r.orb.software } });
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

// ---- Orb inventory for the owning merchant: /v1/orbs ----------------------------------------

export const orbs = new Hono<AppContext>();
orbs.use("*", requireSession, requireOwner);
orbs.get("/", async (c) => {
  const rows = await c.get("sql")<OrbRow[]>`
    select id, model, software, account_id, terminal_id from orbs
     where account_id = ${c.get("auth").accountId} order by created_at, id`;
  return c.json({ orbs: rows.map((o) => ({ id: o.id, model: o.model, software: o.software, terminal_id: o.terminal_id })) });
});
