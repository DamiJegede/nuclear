import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { amount, n } from "../lib/money";
import { sandboxFund } from "../lib/ledger";
import { dailyCap } from "./transfers";
import { handleSchema } from "../lib/handle";
import { requireOwner, requireSession } from "../session";

export const account = new Hono<AppContext>();
account.use("*", requireSession);

// Primary-account profile. Handle is NULL until the owner sets it.
account.get("/account", requireOwner, async (c) => {
  const [a] = await c.get("sql")<
    { id: string; type: string; handle: string | null; name: string; photo: string | null; tier: string; status: string }[]
  >`select id, type, handle, name, photo, tier, status from accounts where id = ${c.get("auth").accountId}`;
  if (!a) return c.json({ error: "not_found" }, 404);
  return c.json({ account_id: a.id, type: a.type, handle: a.handle, name: a.name, photo: a.photo, tier: a.tier, status: a.status });
});

// Set or change the account handle. Primary/root account only: requireOwner rejects delegated
// shared-wallet sessions, and wallets/members never have handles of their own.
account.put("/account/handle", requireOwner, async (c) => {
  const parsed = z.object({ handle: handleSchema }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.flatten() }, 400);
  const { accountId } = c.get("auth");
  try {
    const [row] = await c.get("sql")<{ handle: string }[]>`
      update accounts set handle = ${parsed.data.handle}
       where id = ${accountId} and status = 'active' returning handle`;
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({ handle: row.handle });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return c.json({ error: "handle_taken" }, 409);
    throw err;
  }
});

type BalanceRow = {
  balance: bigint;
  balance_pending: bigint;
  credit_limit: bigint;
  credit_spent: bigint;
};
const pos = (v: bigint) => (v > 0n ? v : 0n);

// Account-wide funds shared by all wallets. Delegated sessions see availability, not credit detail.
account.get("/balance", async (c) => {
  const { accountId, walletId } = c.get("auth");
  const sql = c.get("sql");
  const [b] = await sql<BalanceRow[]>`
    select balance, balance_pending, credit_limit, credit_spent from balances
     where account_id = ${accountId}`;
  if (!b) return c.json({ error: "not_found" }, 404);

  const restricted = b.balance < 0n || b.credit_spent > b.credit_limit;
  const creditAvailable = pos(b.credit_limit - b.credit_spent);
  const availableToSend = restricted ? 0n : pos(b.balance);
  const availableToPay = restricted ? 0n : pos(b.balance) + creditAvailable;
  const common = {
    available_to_send: n(availableToSend),
    available_to_pay: n(availableToPay),
    restricted,
  };
  if (walletId !== null) return c.json(common);
  return c.json({
    ...common,
    balance: n(b.balance),
    balance_pending: n(b.balance_pending),
    credit_limit: n(b.credit_limit),
    credit_spent: n(b.credit_spent),
  });
});

// Find a recipient's default wallet by exact email. Open product decision (recipient lookup);
// returns display data only and 404s for anything not an active consumer account.
account.post("/recipients/lookup", async (c) => {
  const parsed = z
    .object({ email: z.string().trim().toLowerCase().email().max(254) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const { accountId } = c.get("auth");
  const [r] = await c.get("sql")<{ id: string; display_name: string; photo: string | null }[]>`
    select w.id, w.display_name, w.photo
      from accounts a join wallets w on w.account_id = a.id and w.type = 'default' and w.status = 'active'
     where lower(a.email) = ${parsed.data.email} and a.type = 'C' and a.status = 'active'
       and a.id <> ${accountId}`;
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json({ wallet_id: r.id, display_name: r.display_name, photo: r.photo });
});

// SANDBOX ONLY: simulated bank load, confirmed and released immediately.
account.post("/sandbox/fundings", requireOwner, async (c) => {
  if (c.env.SANDBOX_FUNDING !== "true") return c.json({ error: "not_found" }, 404);
  const key = c.req.header("idempotency-key")?.trim();
  if (!key || key.length > 128) return c.json({ error: "idempotency_key_required" }, 400);
  const parsed = z.object({ amount }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.flatten() }, 400);

  const out = await sandboxFund(c.get("sql"), {
    accountId: c.get("auth").accountId,
    amount: parsed.data.amount,
    idempotencyKey: key,
    dailyCap: dailyCap(c.env),
  });
  if (out.kind === "error") return c.json({ error: out.error }, out.status);
  const f = out.funding;
  const funding = {
    id: f.id,
    amount: n(f.amount),
    status: f.status,
    failure_code: f.failure_code,
    transaction_id: f.transaction_id,
    created_at: f.created_at,
    released_at: f.released_at,
  };
  if (out.kind === "failed") return c.json({ error: "declined", status_code: f.failure_code, funding }, 422);
  return c.json({ funding }, out.replayed ? 200 : 201);
});
