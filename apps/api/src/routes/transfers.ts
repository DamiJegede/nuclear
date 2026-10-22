import { track } from "../lib/tracker";
import { RULES, rateLimit } from "../lib/throttle";
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { amount, n } from "../lib/money";
import { DEFAULT_DAILY_VALUE_CAP, sendFunds, type TxRow } from "../lib/ledger";
import { requireSession } from "../session";

export const transfers = new Hono<AppContext>();
transfers.use("*", requireSession);

const uuid = z.string().uuid();

export function dailyCap(env: { DAILY_VALUE_CAP_CENTS?: string }): bigint {
  const v = env.DAILY_VALUE_CAP_CENTS;
  return v && /^\d+$/.test(v) ? BigInt(v) : DEFAULT_DAILY_VALUE_CAP;
}

function txJson(t: TxRow, viewerAccountId: string) {
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    status_code: t.status_code,
    amount: n(t.amount),
    direction: t.from_account_id === viewerAccountId ? "out" : "in",
    from_wallet_id: t.from_wallet_id,
    to_wallet_id: t.to_wallet_id,
    timestamp: t.timestamp,
    completed_at: t.completed_at,
  };
}

const body = z.object({
  from_wallet_id: uuid.optional(),
  to_wallet_id: uuid,
  amount,
});

// Wallet -> wallet send. Funded balance only; atomic, idempotent (Idempotency-Key required).
transfers.post("/", rateLimit("agent-money", RULES.agentMoney, (c) => (c.get("auth")?.kind === "agent" ? c.get("auth").walletId : null)), async (c) => {
  const key = c.req.header("idempotency-key")?.trim();
  if (!key || key.length > 128) return c.json({ error: "idempotency_key_required" }, 400);
  const parsed = body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.flatten() }, 400);

  const { accountId, walletId } = c.get("auth");
  const out = await sendFunds(c.get("sql"), {
    actorAccountId: accountId,
    authWalletId: walletId,
    fromWalletId: parsed.data.from_wallet_id ?? null,
    toWalletId: parsed.data.to_wallet_id,
    amount: parsed.data.amount,
    idempotencyKey: key,
    dailyCap: dailyCap(c.env),
  });

  if (out.kind === "error") return c.json({ error: out.error }, out.status);
  const transaction = txJson(out.tx, accountId);
  if (out.kind === "declined") {
    return c.json({ error: "declined", status_code: out.tx.status_code, transaction }, 422);
  }
  if (!out.replayed) {
    const v = Number(out.tx.amount);
    track(c, { sends_n: 1, sends_v: v, ...(c.get("auth").kind === "agent" ? { agents_n: 1, agents_v: v } : {}) });   // today's running estimate
  }
  return c.json({ transaction }, out.replayed ? 200 : 201);
});

transfers.get("/:id", async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "not_found" }, 404);
  const { accountId, walletId } = c.get("auth");
  const sql = c.get("sql");
  const [t] = await sql<TxRow[]>`
    select id, type, status, status_code, amount, from_account_id, to_account_id,
           from_wallet_id, to_wallet_id, "timestamp", completed_at
      from transactions
     where id = ${id.data} and type = 'send'
       and (from_account_id = ${accountId} or to_account_id = ${accountId})
       ${walletId ? sql`and (from_wallet_id = ${walletId} or to_wallet_id = ${walletId})` : sql``}`;
  if (!t) return c.json({ error: "not_found" }, 404);
  return c.json({ transaction: txJson(t, accountId) });
});
