import { RULES, byAccount, rateLimit } from "../lib/throttle";
import { imageUrl } from "../lib/images";
import { Hono } from "hono";
import { z } from "zod";
import { uuid } from "../lib/validate";
import type { AppContext } from "../env";
import type { Sql } from "../db";
import { amount, n } from "../lib/money";
import { decryptTagUrl } from "../lib/tagproof";
import { consumeCounter, isFresh, loadTag } from "../lib/tap";
import { requireOwner, requireSession } from "../session";

export const tags = new Hono<AppContext>();
tags.use("*", requireSession);


type TagView = {
  id: string;
  label: string | null;
  wallet_id: string | null;
  locked: boolean;
  transaction_limit: bigint | null;
  last_read_at: Date | null;
  created_at: Date;
  model_id: string;
  model_type: string;
  model_name: string;
  model_photo: string | null;
};

const VIEW = `t.id, t.label, t.wallet_id, t.locked, t.transaction_limit, t.last_read_at, t.created_at,
  m.id as model_id, m.type as model_type, m.name as model_name, m.photo as model_photo`;

const viewJson = (t: TagView) => ({
  id: t.id,
  label: t.label,
  wallet_id: t.wallet_id,
  locked: t.locked,
  transaction_limit: n(t.transaction_limit),
  last_read_at: t.last_read_at,
  created_at: t.created_at,
  model: { id: t.model_id, type: t.model_type, name: t.model_name, photo: imageUrl(t.model_photo) },
});

// A tag is managed through its owning wallet's account: owners see every tag on their account,
// a delegated device only its own wallet's. Unassigned tags have no owner and cannot be managed.
async function ownedTag(sql: Sql, id: string, accountId: string, walletId: string | null): Promise<TagView | undefined> {
  const [t] = await sql<TagView[]>`
    select ${sql.unsafe(VIEW)}
      from tags t join tag_models m on m.id = t.model_id join wallets w on w.id = t.wallet_id
     where t.id = ${id} and w.account_id = ${accountId}
       ${walletId ? sql`and t.wallet_id = ${walletId}` : sql``}`;
  return t;
}

tags.get("/", async (c) => {
  const { accountId, walletId } = c.get("auth");
  const sql = c.get("sql");
  const rows = await sql<TagView[]>`
    select ${sql.unsafe(VIEW)}
      from tags t join tag_models m on m.id = t.model_id join wallets w on w.id = t.wallet_id
     where w.account_id = ${accountId} ${walletId ? sql`and t.wallet_id = ${walletId}` : sql``}
     order by t.created_at, t.id`;
  return c.json({ tags: rows.map(viewJson) });
});

// ---- Claim ------------------------------------------------------------------------------------
// The customer taps the band with their phone and sends the URL it read. Physical possession is the
// proof, and the tap is burned (single-use) whatever the outcome, like every verified tap.

const claimBody = z.object({
  url: z.string().min(1).max(512),
  wallet_id: uuid.optional(),
  label: z.string().trim().min(1).max(60).optional(),
});

type ClaimResult = { error: string; status: 404 | 409 } | { tag: TagView; replayed: boolean };

tags.post("/claim", requireOwner, rateLimit("claim", RULES.tagClaim, byAccount), async (c) => {
  const body = claimBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const { accountId } = c.get("auth");
  const sql = c.get("sql");

  const proof = await decryptTagUrl(c.env, body.data.url);
  if (!proof) return c.json({ error: "invalid_tag" }, 400);

  // Target wallet: one of the owner's active wallets (default wallet when omitted).
  const [wallet] = body.data.wallet_id
    ? await sql<{ id: string }[]>`
        select id from wallets where id = ${body.data.wallet_id} and account_id = ${accountId} and status = 'active'`
    : await sql<{ id: string }[]>`
        select id from wallets where account_id = ${accountId} and type = 'default' and status = 'active'`;
  if (!wallet) return c.json({ error: "wallet_not_found" }, 404);

  const result = (await sql.begin(async (tx): Promise<ClaimResult> => {
    const tag = await loadTag(tx, proof.uid, true);
    if (!tag) return { error: "tag_not_found", status: 404 };

    // Lost-response retry: this exact tap already claimed it for this account.
    if (tag.account_id === accountId && tag.counter !== null && tag.counter === BigInt(proof.counter)) {
      const [v] = await tx<TagView[]>`
        select ${tx.unsafe(VIEW)} from tags t join tag_models m on m.id = t.model_id where t.id = ${tag.id}`;
      return { tag: v!, replayed: true };
    }

    if (!isFresh(tag, proof.counter)) return { error: "proof_replayed", status: 409 };
    await consumeCounter(tx, tag.id, proof.counter);

    if (tag.wallet_id !== null) return { error: "tag_already_claimed", status: 409 };

    await tx`
      update tags set wallet_id = ${wallet.id}, label = ${body.data.label ?? null}
       where id = ${tag.id}`;
    const [v] = await tx<TagView[]>`
      select ${tx.unsafe(VIEW)} from tags t join tag_models m on m.id = t.model_id where t.id = ${tag.id}`;
    return { tag: v!, replayed: false };
  })) as ClaimResult;

  if ("error" in result) return c.json({ error: result.error }, result.status);
  return c.json({ tag: viewJson(result.tag) }, result.replayed ? 200 : 201);
});

// ---- Manage by tag id -------------------------------------------------------------------------

tags.get("/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const { accountId, walletId } = c.get("auth");
  const t = await ownedTag(c.get("sql"), id.data, accountId, walletId);
  if (!t) return c.json({ error: "not_found" }, 404);
  return c.json({ tag: viewJson(t) });
});

const patchBody = z
  .object({
    label: z.string().trim().min(1).max(60).nullable(),
    locked: z.boolean(),
    transaction_limit: amount.nullable(),
    wallet_id: uuid,
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, { message: "empty_patch" });

// Rename, lock/unlock, set a per-payment limit, or assign the tag to another wallet of the same
// account. A delegated device may only lock its own wallet's tags (a lost band); everything else,
// including unlock, is the owner's.
tags.patch("/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  const body = patchBody.safeParse(await c.req.json().catch(() => null));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const { accountId, walletId, kind } = c.get("auth");
  const sql = c.get("sql");
  const p = body.data;

  if (kind === "wallet") {
    const keys = Object.keys(p);
    if (!(keys.length === 1 && p.locked === true)) return c.json({ error: "forbidden" }, 403);
  }

  const cur = await ownedTag(sql, id.data, accountId, walletId);
  if (!cur) return c.json({ error: "not_found" }, 404);

  if (p.wallet_id !== undefined) {
    const [w] = await sql<{ id: string }[]>`
      select id from wallets where id = ${p.wallet_id} and account_id = ${accountId} and status = 'active'`;
    if (!w) return c.json({ error: "wallet_not_found" }, 404);
  }

  const patch: Record<string, unknown> = { ...p };
  if ("transaction_limit" in patch) {
    patch.transaction_limit = p.transaction_limit === null ? null : p.transaction_limit!.toString();
  }
  await sql`update tags set ${sql(patch, ...Object.keys(patch))} where id = ${id.data}`;
  const t = await ownedTag(sql, id.data, accountId, null);
  return c.json({ tag: viewJson(t!) });
});

// Reset: the tag leaves the wallet and goes back to unassigned, clearing its label, lock and limit.
// Its counter and history are kept. It can be claimed again by tapping it.
tags.post("/:id/reset", requireOwner, async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const { accountId } = c.get("auth");
  const sql = c.get("sql");
  const cur = await ownedTag(sql, id.data, accountId, null);
  if (!cur) return c.json({ error: "not_found" }, 404);
  await sql`
    update tags set wallet_id = null, label = null, locked = false, transaction_limit = null
     where id = ${id.data}`;
  return c.body(null, 204);
});
