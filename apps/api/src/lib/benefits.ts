import { earmarkLog } from "./audit";
import type { TransactionSql } from "postgres";
import type { Sql } from "../db";
import { CAP_COLS, capApplies, capHeadroom, capToday, type CapRow } from "./cap";
import { insertTx, type NewTx } from "./txn";

type Tx = TransactionSql<{ bigint: bigint }>;

/**
 * Benefits wallets (docs/ORGANIZATIONS.md). A Benefits wallet belongs to one consumer account and is bound to ONE employer for good. Its
 * money is wallets.balance (so no other wallet can spend it) and is part of balances.balance (the account total). It can pay merchants,
 * receive its employer's credits and refunds of its own purchases, and move to another wallet of the SAME account; nothing else.
 */

/** The employer's Benefits wallet for this account: reused when it exists, created (at 0) when it does not. Never matches by email. */
export async function ensureBenefitsWallet(tx: Tx, accountId: string, orgId: string, orgName: string): Promise<{ id: string; status: string }> {
  const [made] = await tx<{ id: string; status: string }[]>`
    insert into wallets (account_id, display_name, type, org_account_id, balance, allow_send)
    values (${accountId}, ${`${orgName} Benefits`.slice(0, 80)}, 'benefits', ${orgId}, 0, false)
    on conflict (account_id, org_account_id) where type = 'benefits' and status <> 'closed' do nothing
    returning id, status`;
  if (made) return made;
  const [w] = await tx<{ id: string; status: string }[]>`
    select id, status from wallets where account_id = ${accountId} and org_account_id = ${orgId} and type = 'benefits' and status <> 'closed'`;
  return w!;
}

/** The account's daily headroom right now (null for organizations and businesses, which the cap does not cover). A plain read: money paths read the same numbers under the balances lock. */
export async function dailyHeadroom(sql: Sql, accountId: string, cap: bigint): Promise<bigint | null> {
  const [r] = await sql<CapRow[]>`select b.balance, ${sql.unsafe(CAP_COLS)} from balances b join accounts a on a.id = b.account_id where b.account_id = ${accountId}`;
  return r && capApplies(r) ? capHeadroom(r, cap) : null;
}

export type MoveInput = { accountId: string; fromWalletId: string; toWalletId: string; amount: bigint; idempotencyKey: string; dailyCap: bigint; deviceId: string | null };
export type MoveRow = { id: string; status: string; status_code: string | null; amount: bigint; from_wallet_id: string; to_wallet_id: string; timestamp: Date; completed_at: Date | null };
export type MoveOutcome =
  | { kind: "ok"; tx: MoveRow; replayed: boolean }
  | { kind: "declined"; tx: MoveRow; replayed: boolean; headroom?: bigint }
  | { kind: "error"; status: 404 | 409 | 422; error: string };

const M_COLS = `id, status, status_code, amount, from_wallet_id, to_wallet_id, "timestamp", completed_at`;

/**
 * Move funded money from a Benefits wallet to another (non-Benefits) wallet of the SAME account. The account total is unchanged. It
 * competes for the account-wide daily headroom (see headroomFrom), once, under the balances lock. Idempotent per (account, key); a retry
 * with a different source, destination or amount is a mismatch. A destination with an earmark grows by the amount; an unearmarked
 * destination simply leaves the money in the shared funds.
 */
export async function moveFunds(sql: Sql, i: MoveInput): Promise<MoveOutcome> {
  if (i.fromWalletId === i.toWalletId) return { kind: "error", status: 422, error: "same_wallet" };
  return sql.begin(async (tx): Promise<MoveOutcome> => {
    const found = await tx<{ id: string; type: string }[]>`
      select id, type from wallets where id in (${i.fromWalletId}, ${i.toWalletId}) and account_id = ${i.accountId}`;
    const from = found.find((w) => w.id === i.fromWalletId);
    const to = found.find((w) => w.id === i.toWalletId);
    if (!from || !to) return { kind: "error", status: 404, error: "wallet_not_found" };       // exact account ownership
    if (from.type !== "benefits") return { kind: "error", status: 422, error: "source_must_be_benefits" };
    if (to.type === "benefits") return { kind: "error", status: 422, error: "destination_not_allowed" };

    const idem = `move:${i.accountId}:${i.idempotencyKey}`;
    // One round trip, run in this order: the balances lock, both wallets (by id), then the plain reads taken while the lock is held
    // (the account's status and the earlier attempt for this key, so a concurrent retry waits and replays).
    const [[bal], ws, [acct], [prev]] = await Promise.all([
      tx<({ credit_limit: bigint; credit_spent: bigint } & CapRow)[]>`
        select b.balance, b.credit_limit, b.credit_spent, ${tx.unsafe(CAP_COLS)}
          from balances b join accounts a on a.id = b.account_id where b.account_id = ${i.accountId} for no key update of b`,
      tx<{ id: string; status: string; balance: bigint | null }[]>`select id, status, balance from wallets where id in (${i.fromWalletId}, ${i.toWalletId}) order by id for no key update`,
      tx<{ status: string }[]>`select status from accounts where id = ${i.accountId}`,
      tx<MoveRow[]>`select ${tx.unsafe(M_COLS)} from txn where idempotency_key = ${idem}`,
    ]);
    if (prev) {
      if (prev.from_wallet_id !== i.fromWalletId || prev.to_wallet_id !== i.toWalletId || prev.amount !== i.amount) return { kind: "error", status: 409, error: "idempotency_mismatch" };
      return { kind: prev.status === "completed" ? "ok" : "declined", tx: prev, replayed: true };
    }
    const sw = ws.find((w) => w.id === i.fromWalletId);
    const dw = ws.find((w) => w.id === i.toWalletId);
    if (!bal || !sw || !dw) throw new Error("rows missing");
    const room = capHeadroom(bal, i.dailyCap);          // one daily rule: cap - ordinary opening - added today - pending loads

    let code: string | null = null;
    if (!acct || acct.status !== "active") code = "account_unavailable";
    else if (bal.balance < 0n || bal.credit_spent > bal.credit_limit) code = "account_restricted";
    else if (sw.status !== "active" || dw.status !== "active") code = "wallet_unavailable";
    else if ((sw.balance ?? 0n) < i.amount) code = "wallet_balance_exceeded";
    else if (i.amount > room) code = "daily_value_limit_exceeded";
    const t: NewTx = { type: "move", declined: code, from: i.fromWalletId, to: i.toWalletId, amount: i.amount, account: i.accountId, idem };
    const rowOf2 = (w: { id: string; created_at: Date }): MoveRow => ({
      id: w.id, status: code ? "failed" : "completed", status_code: code, amount: i.amount, from_wallet_id: i.fromWalletId, to_wallet_id: i.toWalletId,
      timestamp: w.created_at, completed_at: code ? null : w.created_at,
    });
    if (code) {
      const [w] = await insertTx(tx, t);
      return { kind: "declined", tx: rowOf2(w!), replayed: false, headroom: room };
    }

    const amt = i.amount.toString();
    const destEarmarked = dw.balance !== null;
    const writes = [
      // The move is an addition to the ordinary compartment: today's additions go up (a stale row rolls to today first).
      tx`update balances set ordinary_opening = ${capToday(bal).opening.toString()}, added_today = ${(capToday(bal).added + i.amount).toString()}, opening_day = greatest(opening_day, ${bal.today}::date) where account_id = ${i.accountId}`,
      tx`update wallets set balance = balance - ${amt} where id = ${i.fromWalletId}`,
      destEarmarked ? tx`update wallets set balance = balance + ${amt} where id = ${i.toWalletId}` : tx`select 1`,
      earmarkLog(tx, i.accountId, i.fromWalletId, -i.amount, (sw.balance ?? 0n) - i.amount, i.deviceId),
      destEarmarked ? earmarkLog(tx, i.accountId, i.toWalletId, i.amount, (dw.balance ?? 0n) + i.amount, i.deviceId) : tx`select 1`,
      // Net zero for the account: the Benefits compartment goes down, the ordinary compartment goes up.
      insertTx(tx, t),
    ];
    const results = await Promise.all(writes);
    return { kind: "ok", tx: rowOf2((results[results.length - 1] as unknown as { id: string; created_at: Date }[])[0]!), replayed: false };
  });
}
