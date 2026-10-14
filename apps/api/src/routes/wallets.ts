import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { LINK_TTL, signWalletLink } from "../crypto";
import { amountOrZero, n } from "../lib/money";
import { requireOwner, requireSession } from "../session";

export const wallets = new Hono<AppContext>();
wallets.use("*", requireSession);

const MAX_WALLETS_PER_ACCOUNT = 25;
const uuid = z.string().uuid();

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
  created_at: Date;
};

const COLS = `id, account_id, display_name, photo, type, daily_limit, spent_today,
  allow_pay, allow_send, status, created_at`;

export function walletJson(w: WalletRow) {
  return {
    id: w.id,
    display_name: w.display_name,
    photo: w.photo,
    type: w.type,
    daily_limit: n(w.daily_limit),
    spent_today: n(w.spent_today),
    remaining_today: w.daily_limit === null ? null : n(w.daily_limit > w.spent_today ? w.daily_limit - w.spent_today : 0n),
    allow_pay: w.allow_pay,
    allow_send: w.allow_send,
    status: w.status,
    created_at: w.created_at,
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
  photo: z.string().max(2048).nullish(),
  daily_limit: amountOrZero.nullish(),
  allow_pay: z.boolean().default(true),
  allow_send: z.boolean().default(false), // sends are opt-in for non-default wallets
});

wallets.post("/", requireOwner, async (c) => {
  const body = createBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: body.error.flatten() }, 400);
  const b = body.data;
  const { accountId } = c.get("auth");
  const sql = c.get("sql");

  const row = await sql.begin(async (tx) => {
    // Serialize concurrent creates per account so the cap cannot be raced.
    await tx`select 1 from accounts where id = ${accountId} for no key update`;
    const [cnt] = await tx<{ count: bigint }[]>`
      select count(*)::bigint as count from wallets where account_id = ${accountId} and status <> 'closed'`;
    if ((cnt?.count ?? 0n) >= BigInt(MAX_WALLETS_PER_ACCOUNT)) return null;
    const [w] = await tx<WalletRow[]>`
      insert into wallets (account_id, display_name, photo, type, daily_limit, allow_pay, allow_send)
      values (${accountId}, ${b.display_name}, ${b.photo ?? null}, ${b.type},
              ${b.daily_limit === undefined || b.daily_limit === null ? null : b.daily_limit.toString()},
              ${b.allow_pay}, ${b.allow_send})
      returning ${tx.unsafe(COLS)}`;
    return w!;
  });
  if (!row) return c.json({ error: "wallet_limit_reached" }, 409);
  return c.json({ wallet: walletJson(row) }, 201);
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
    photo: z.string().max(2048).nullable(),
    daily_limit: amountOrZero.nullable(),
    allow_pay: z.boolean(),
    allow_send: z.boolean(),
    status: z.enum(["active", "suspended", "closed"]),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, { message: "empty_patch" });

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
