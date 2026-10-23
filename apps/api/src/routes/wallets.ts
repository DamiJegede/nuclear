import { Hono } from "hono";
import { imageUrl } from "../lib/images";
import { saveProfilePhoto } from "../lib/profilePhoto";
import { customerLog } from "../lib/audit";
import { z } from "zod";
import { uuid } from "../lib/validate";
import type { AppContext } from "../env";
import { LINK_TTL, newAgentKey, signWalletLink } from "../crypto";
import { amount as amountPositive, amountOrZero, n } from "../lib/money";
import { requireOwner, requireSession } from "../session";
import { setWalletBalance } from "../lib/walletFunds";
import { moveFunds } from "../lib/benefits";
import { dailyCap } from "../lib/config";

export const wallets = new Hono<AppContext>();
wallets.use("*", requireSession);

const MAX_WALLETS_PER_ACCOUNT = 25;

type WalletRow = {
  id: string;
  account_id: string;
  display_name: string;
  photo: string | null;
  type: string;
  daily_limit: bigint | null;
  spent_today: bigint;
  allow_pay: boolean;
  allow_send: boolean;
  status: string;
  balance: bigint | null;
  key_hint: string | null;
  key_last_used_at: Date | null;
  created_at: Date;
  org_account_id: string | null;
  organization_name: string | null;
};

const COLS = `id, account_id, display_name, photo, type, daily_limit, spent_today,
  allow_pay, allow_send, status, balance, key_hint, key_last_used_at, created_at,
  org_account_id, (select o.name from accounts o where o.id = wallets.org_account_id) as organization_name`;

export function walletJson(w: WalletRow) {
  return {
    id: w.id,
    display_name: w.display_name,
    photo: imageUrl(w.photo),
    type: w.type,
    daily_limit: n(w.daily_limit),
    spent_today: n(w.spent_today),
    remaining_today: w.daily_limit === null ? null : n(w.daily_limit > w.spent_today ? w.daily_limit - w.spent_today : 0n),
    allow_pay: w.allow_pay,
    allow_send: w.allow_send,
    status: w.status,
    // Earmarked funds: null = spends from the account's shared funds; a number = a hard spending limit.
    balance: n(w.balance),
    earmarked: w.balance !== null,
    // The agent API key, if one exists: never the key itself, only what identifies it.
    key: w.key_hint === null ? null : { hint: w.key_hint, last_used_at: w.key_last_used_at },
    created_at: w.created_at,
    // A Benefits wallet: the employer it is bound to for good. Its balance is real funded money that only pays merchants or moves to another wallet of this account.
    organization: w.org_account_id ? { id: w.org_account_id, name: w.organization_name } : null,
  };
}

// List: owners see every wallet on the account; a delegated session sees only its own.
wallets.get("/", async (c) => {
  const { accountId, walletId } = c.get("auth");
  const sql = c.get("sql");
  const rows = await sql<WalletRow[]>`
    select ${sql.unsafe(COLS)} from wallets
     where account_id = ${accountId} ${walletId ? sql`and id = ${walletId}` : sql``}
     order by (type = 'default') desc, created_at, id`;
  return c.json({ wallets: rows.map(walletJson) });
});

const createBody = z.object({
  display_name: z.string().trim().min(1).max(80),
  type: z.enum(["agent", "person"]),
  daily_limit: amountOrZero.nullish(),
  allow_pay: z.boolean().default(true),
  allow_send: z.boolean().default(false), // sends are opt-in for non-default wallets
  // Funds set aside for this wallet. Agent wallets start at 0 (nothing to spend until the owner funds
  // them); null opts out and shares the account's funds. Person wallets share unless a number is given.
  balance: amountOrZero.nullish(),
});

wallets.post("/", requireOwner, async (c) => {
  const body = createBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const b = body.data;
  const { accountId } = c.get("auth");
  const sql = c.get("sql");

  // An agent wallet is created together with its API key (shown once, in this response).
  const agentKey = b.type === "agent" ? newAgentKey() : null;

  const row = await sql.begin(async (tx) => {
    // Serialize concurrent creates per account so the cap cannot be raced.
    await tx`select 1 from accounts where id = ${accountId} for no key update`;
    const [cnt] = await tx<{ count: bigint }[]>`
      select count(*)::bigint as count from wallets where account_id = ${accountId} and status <> 'closed'`;
    if ((cnt?.count ?? 0n) >= BigInt(MAX_WALLETS_PER_ACCOUNT)) return null;
    const [w] = await tx<WalletRow[]>`
      insert into wallets (account_id, display_name, type, daily_limit, allow_pay, allow_send, key_hash, key_hint)
      values (${accountId}, ${b.display_name}, ${b.type},
              ${b.daily_limit === undefined || b.daily_limit === null ? null : b.daily_limit.toString()},
              ${b.allow_pay}, ${b.allow_send}, ${agentKey?.hash ?? null}, ${agentKey?.hint ?? null})
      returning ${tx.unsafe(COLS)}`;
    const initial = b.balance === undefined ? (b.type === "agent" ? 0n : null) : b.balance;
    if (initial === null) return w!;
    const set = await setWalletBalance(tx, { accountId, walletId: w!.id, target: initial, deviceId: c.get("auth").deviceId });
    if (!set.ok) {
      await tx`delete from wallets where id = ${w!.id}`;   // nothing is created if the earmark cannot be set
      return { error: set.error, available: set.available } as const;
    }
    const [fresh] = await tx<WalletRow[]>`select ${tx.unsafe(COLS)} from wallets where id = ${w!.id}`;
    return fresh!;
  });
  if (!row) return c.json({ error: "wallet_limit_reached" }, 409);
  if ("error" in row) {
    // Not enough shared funds to set aside: nothing was created.
    return c.json({ error: row.error, available: n(row.available ?? 0n) }, 422);
  }
  return c.json({ wallet: walletJson(row), ...(agentKey ? { key: agentKey.key } : {}) }, 201);
});

// Move money from a Benefits wallet to another wallet of the SAME account (owner only; never a delegated session or an agent key). The account
// total is unchanged; the amount competes for the account's daily headroom once; a retry with the same key replays.
const moveBody = z.object({ from_wallet_id: z.string().uuid(), to_wallet_id: z.string().uuid(), amount: amountPositive });
wallets.post("/move", requireOwner, async (c) => {
  const key = c.req.header("idempotency-key")?.trim();
  if (!key || key.length > 128) return c.json({ error: "idempotency_key_required" }, 400);
  const body = moveBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const { accountId, deviceId } = c.get("auth");
  const out = await moveFunds(c.get("sql"), {
    accountId, deviceId, fromWalletId: body.data.from_wallet_id, toWalletId: body.data.to_wallet_id, amount: body.data.amount,
    idempotencyKey: key, dailyCap: dailyCap(c.env),
  });
  if (out.kind === "error") return c.json({ error: out.error }, out.status);
  const t = out.tx;
  const move = { id: t.id, status: t.status, status_code: t.status_code, amount: n(t.amount), from_wallet_id: t.from_wallet_id, to_wallet_id: t.to_wallet_id, created_at: t.timestamp, completed_at: t.completed_at };
  if (out.kind === "declined") return c.json({ error: "declined", status_code: t.status_code, ...(out.headroom !== undefined ? { daily_headroom: n(out.headroom) } : {}), move }, 422);
  return c.json({ move }, out.replayed ? 200 : 201);
});

wallets.get("/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  const { accountId, walletId } = c.get("auth");
  if (!id.success || (walletId !== null && walletId !== id.data)) return c.json({ error: "not_found" }, 404);
  const sql = c.get("sql");
  const [w] = await sql<WalletRow[]>`
    select ${sql.unsafe(COLS)} from wallets where id = ${id.data} and account_id = ${accountId}`;
  if (!w) return c.json({ error: "not_found" }, 404);
  return c.json({ wallet: walletJson(w) });
});

const patchBody = z
  .object({
    display_name: z.string().trim().min(1).max(80),
    daily_limit: amountOrZero.nullable(),
    allow_pay: z.boolean(),
    allow_send: z.boolean(),
    status: z.enum(["active", "suspended", "closed"]),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, { message: "empty_patch" });

// A wallet's picture, uploaded after the wallet exists: any PNG, JPEG or WebP, cropped to 256 x 256, compressed to JPEG, saved in R2;
// wallets.photo keeps the R2 key. Owner only.
wallets.put("/:id/photo", requireOwner, async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const { accountId } = c.get("auth");
  const sql = c.get("sql");
  const [w] = await sql<{ photo: string | null; status: string; display_name: string }[]>`select photo, status, display_name from wallets where id = ${id.data} and account_id = ${accountId}`;
  if (!w) return c.json({ error: "not_found" }, 404);
  if (w.status === "closed") return c.json({ error: "wallet_closed" }, 409);
  const r = await saveProfilePhoto(c, "wallets", id.data, w.photo);
  if (r instanceof Response) return r;
  await sql`update wallets set photo = ${r.key} where id = ${id.data} and account_id = ${accountId}`;
  await customerLog(c, accountId, null, "customer.photo_changed", { wallet_id: id.data }, { type: "wallet", id: id.data, label: w.display_name });
  return c.json({ photo: imageUrl(r.key) });
});

wallets.patch("/:id", requireOwner, async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const body = patchBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const { accountId } = c.get("auth");
  const sql = c.get("sql");

  const result = await sql.begin(async (tx) => {
    const [cur] = await tx<WalletRow[]>`
      select ${tx.unsafe(COLS)} from wallets
       where id = ${id.data} and account_id = ${accountId} for no key update`;
    if (!cur) return { error: "not_found", status: 404 as const };
    if (cur.status === "closed") return { error: "wallet_closed", status: 409 as const };
    if (body.data.status === "closed" && cur.type === "default") {
      return { error: "default_wallet_cannot_close", status: 409 as const };
    }

    // A Benefits wallet that still holds money cannot be closed: its funds are never released into the shared funds.
    if (body.data.status === "closed" && cur.type === "benefits" && (cur.balance ?? 0n) > 0n) {
      return { error: "benefits_wallet_not_empty", status: 422 as const };
    }
    if (body.data.status === "closed") await tx`update wallets set key_hash = null, key_hint = null, key_last_used_at = null where id = ${id.data}`;
    if (body.data.status === "closed" && cur.balance !== null && cur.type !== "benefits") {
      // A closed wallet gives its earmarked funds back to the shared funds.
      await setWalletBalance(tx, { accountId, walletId: id.data, target: null, deviceId: c.get("auth").deviceId });
    }
    const patch: Record<string, unknown> = { ...body.data };
    if ("daily_limit" in patch) {
      const v = body.data.daily_limit;
      patch.daily_limit = v === null || v === undefined ? null : v.toString();
    }
    const keys = Object.keys(patch);
    const [w] = await tx<WalletRow[]>`
      update wallets set ${tx(patch, ...keys)} where id = ${id.data} returning ${tx.unsafe(COLS)}`;

    if (body.data.status === "closed") {
      // Closing is terminal: revoke every device session and pass for this wallet.
      await tx`update devices set revoked_at = coalesce(revoked_at, now()) where wallet_id = ${id.data}`;
      await tx`update passes set status = 'revoked' where wallet_id = ${id.data} and status <> 'revoked'`;
    }
    return { wallet: w! };
  });

  if ("error" in result) return c.json({ error: result.error }, result.status);
  return c.json({ wallet: walletJson(result.wallet) });
});

// Owner: issue a five-minute magic link for one of their own wallets.
wallets.post("/:id/links", requireOwner, async (c) => {
  const walletId = uuid.safeParse(c.req.param("id"));
  if (!walletId.success) return c.json({ error: "not_found" }, 404);
  const { accountId } = c.get("auth");
  const sql = c.get("sql");

  const [wallet] = await sql<{ id: string }[]>`
    select id from wallets
     where id = ${walletId.data} and account_id = ${accountId} and status = 'active'`;
  if (!wallet) return c.json({ error: "not_found" }, 404);

  // Create the unredeemed grant first; the JWT is bound to this row's id.
  const [dev] = await sql<{ id: string }[]>`
    insert into devices (account_id, wallet_id) values (${accountId}, ${wallet.id}) returning id`;
  const jwt = await signWalletLink(c.env.JWT_SECRET, {
    walletId: wallet.id,
    deviceId: dev!.id,
    accountId,
  });
  const base = c.env.APP_URL ?? "https://app.nuclear.us";
  return c.json({ device_id: dev!.id, url: `${base}/magic-link/${jwt}`, expires_in: LINK_TTL }, 201);
});

// Set aside money for a wallet (or change it), or release it back to the shared funds with null.
// Owner only. The wallet's balance is a hard limit: it spends only that, with no further approval.
const balanceBody = z.object({ balance: amountOrZero.nullable() });

wallets.put("/:id/balance", requireOwner, async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const body = balanceBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const { accountId, deviceId } = c.get("auth");
  const sql = c.get("sql");
  const out = await sql.begin(async (tx) => {
    const r = await setWalletBalance(tx, { accountId, walletId: id.data, target: body.data.balance, deviceId });
    if (!r.ok) return r;
    const [w] = await tx<WalletRow[]>`select ${tx.unsafe(COLS)} from wallets where id = ${id.data}`;
    return { ...r, wallet: w! };
  });
  if (!out.ok) {
    const status = out.error === "not_found" ? 404 : out.error === "wallet_closed" ? 409 : 422;
    return c.json({ error: out.error, ...(out.available !== undefined ? { available: n(out.available) } : {}) }, status);
  }
  return c.json({ wallet: walletJson(out.wallet), change: n(out.delta) });
});

// The wallet's earmark history, newest first (owner, or the delegated session of that wallet).
wallets.get("/:id/allocations", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  const { accountId, walletId } = c.get("auth");
  if (!id.success || (walletId !== null && walletId !== id.data)) return c.json({ error: "not_found" }, 404);
  const sql = c.get("sql");
  const rows = await sql<{ id: string; amount: string; balance_after: string | null; created_at: Date }[]>`
    select id, details->>'amount' as amount, details->>'balance_after' as balance_after, created_at from logs
     where action = 'wallet.earmark' and target_id = ${id.data} and details->>'account_id' = ${accountId}
     order by created_at desc, id desc limit 50`;
  return c.json({ allocations: rows.map((r) => ({ id: r.id, amount: Number(r.amount), balance_after: r.balance_after === null ? null : Number(r.balance_after), created_at: r.created_at })) });
});

// The agent's API key. One per agent wallet, created together with the wallet; this route rotates it: it replaces the current key, which
// stops working at once. The key is returned only here, once. Owner only.
wallets.post("/:id/key", requireOwner, async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const { accountId } = c.get("auth");
  const sql = c.get("sql");
  const [cur] = await sql<{ type: string; status: string }[]>`
    select type, status from wallets where id = ${id.data} and account_id = ${accountId}`;
  if (!cur) return c.json({ error: "not_found" }, 404);
  if (cur.type !== "agent") return c.json({ error: "not_an_agent_wallet" }, 409);
  if (cur.status !== "active") return c.json({ error: "wallet_not_active" }, 409);
  const k = newAgentKey();
  const [w] = await sql<WalletRow[]>`
    update wallets set key_hash = ${k.hash}, key_hint = ${k.hint}, key_last_used_at = null
     where id = ${id.data} and account_id = ${accountId} returning ${sql.unsafe(COLS)}`;
  await customerLog(c, accountId, null, "customer.agent_key_rotated", { account_id: accountId }, { type: "wallet", id: id.data });
  return c.json({ wallet: walletJson(w!), key: k.key }, 201);
});

wallets.delete("/:id/key", requireOwner, async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const { accountId } = c.get("auth");
  const rows = await c.get("sql")`
    update wallets set key_hash = null, key_hint = null, key_last_used_at = null
     where id = ${id.data} and account_id = ${accountId} returning id`;
  if (rows.length === 0) return c.json({ error: "not_found" }, 404);
  await customerLog(c, accountId, null, "customer.agent_key_revoked", { account_id: accountId }, { type: "wallet", id: id.data });
  return c.body(null, 204);
});
