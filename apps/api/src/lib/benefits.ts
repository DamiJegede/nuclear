import type { TransactionSql } from "postgres";
import type { Sql } from "../db";
import { PROGRAM_TZ, incomingTodayQuery } from "./ledger";

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

/**
 * Ordinary opening value: the account's funded money at 00:00 America/New_York of today, minus what sat in Benefits wallets. Computed from
 * the append-only ledger (so there is nothing to snapshot or reset): all funded_balance postings before the day started, less the ones
 * attributed to Benefits wallets.
 */
export const openingQuery = (tx: Tx, accountId: string) => tx<{ total: bigint; benefits: bigint }[]>`
  with start as (select date_trunc('day', now() at time zone ${PROGRAM_TZ}) at time zone ${PROGRAM_TZ} as t)
  select coalesce(sum(case l.direction when 'credit' then l.amount else -l.amount end), 0)::bigint as total,
         coalesce(sum(case when l.wallet_id is not null then case l.direction when 'credit' then l.amount else -l.amount end end), 0)::bigint as benefits
    from ledger_entries l, start
   where l.account_id = ${accountId} and l.bucket = 'funded_balance' and l.created_at < start.t`;

/**
 * Room left today for money entering the ordinary compartment: the cap minus the ordinary opening value minus today's ordinary additions
 * (released loads, incoming sends, Benefits-to-ordinary moves). Spending and sending never restore it. Refunds are never counted and are
 * never limited. Read it while holding the account's balances lock when the answer decides a move.
 */
export function headroomFrom(cap: bigint, opening: { total: bigint; benefits: bigint }, incoming: bigint): bigint {
  const left = cap - (opening.total - opening.benefits) - incoming;
  return left > 0n ? left : 0n;
}

export async function dailyHeadroom(sql: Sql, accountId: string, cap: bigint): Promise<bigint> {
  return sql.begin(async (tx) => {
    const [[o], [inc]] = await Promise.all([openingQuery(tx, accountId), incomingTodayQuery(tx, accountId)]);
    return headroomFrom(cap, o!, inc!.total);
  });
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

    const ins = await tx<{ id: string }[]>`
      insert into transactions (type, from_account_id, to_account_id, from_wallet_id, to_wallet_id, amount, status, idempotency_key)
      values ('move', ${i.accountId}, ${i.accountId}, ${i.fromWalletId}, ${i.toWalletId}, ${i.amount.toString()}, 'pending', ${i.idempotencyKey})
      on conflict (type, from_account_id, idempotency_key) where from_account_id is not null and type <> 'pay' do nothing
      returning id`;
    if (!ins[0]) {
      const [prev] = await tx<MoveRow[]>`
        select ${tx.unsafe(M_COLS)} from transactions where type = 'move' and from_account_id = ${i.accountId} and idempotency_key = ${i.idempotencyKey}`;
      if (!prev || prev.from_wallet_id !== i.fromWalletId || prev.to_wallet_id !== i.toWalletId || prev.amount !== i.amount) return { kind: "error", status: 409, error: "idempotency_mismatch" };
      return { kind: prev.status === "completed" ? "ok" : "declined", tx: prev, replayed: true };
    }
    const txId = ins[0].id;

    // One round trip, run in this order: the balances lock, both wallets (by id), then the plain reads taken while the lock is held.
    const [[bal], ws, [acct], [open], [inc]] = await Promise.all([
      tx<{ balance: bigint; credit_limit: bigint; credit_spent: bigint }[]>`select balance, credit_limit, credit_spent from balances where account_id = ${i.accountId} for no key update`,
      tx<{ id: string; status: string; balance: bigint | null }[]>`select id, status, balance from wallets where id in (${i.fromWalletId}, ${i.toWalletId}) order by id for no key update`,
      tx<{ status: string }[]>`select status from accounts where id = ${i.accountId}`,
      openingQuery(tx, i.accountId),
      incomingTodayQuery(tx, i.accountId),
    ]);
    const sw = ws.find((w) => w.id === i.fromWalletId);
    const dw = ws.find((w) => w.id === i.toWalletId);
    if (!bal || !sw || !dw) throw new Error("rows missing");
    const room = headroomFrom(i.dailyCap, open!, inc!.total);

    let code: string | null = null;
    if (!acct || acct.status !== "active") code = "account_unavailable";
    else if (bal.balance < 0n || bal.credit_spent > bal.credit_limit) code = "account_restricted";
    else if (sw.status !== "active" || dw.status !== "active") code = "wallet_unavailable";
    else if ((sw.balance ?? 0n) < i.amount) code = "wallet_balance_exceeded";
    else if (i.amount > room) code = "daily_value_limit_exceeded";
    if (code) {
      const [t] = await tx<MoveRow[]>`update transactions set status = 'failed', status_code = ${code} where id = ${txId} returning ${tx.unsafe(M_COLS)}`;
      return { kind: "declined", tx: t!, replayed: false, headroom: room };
    }

    const amt = i.amount.toString();
    const destEarmarked = dw.balance !== null;
    const writes = [
      tx`update wallets set balance = balance - ${amt} where id = ${i.fromWalletId}`,
      destEarmarked ? tx`update wallets set balance = balance + ${amt} where id = ${i.toWalletId}` : tx`select 1`,
      tx`insert into wallet_allocations (wallet_id, account_id, amount, balance_after, device_id)
         values (${i.fromWalletId}, ${i.accountId}, ${`-${amt}`}, ${((sw.balance ?? 0n) - i.amount).toString()}::bigint, ${i.deviceId})`,
      destEarmarked
        ? tx`insert into wallet_allocations (wallet_id, account_id, amount, balance_after, device_id)
             values (${i.toWalletId}, ${i.accountId}, ${amt}, ${((dw.balance ?? 0n) + i.amount).toString()}::bigint, ${i.deviceId})`
        : tx`select 1`,
      // Net zero for the account: the Benefits compartment goes down, the ordinary compartment goes up.
      tx`insert into ledger_entries (transaction_id, posting_key, line_no, account_id, bucket, direction, amount, wallet_id)
         values (${txId}, 'move', 1, ${i.accountId}, 'funded_balance', 'debit', ${amt}, ${i.fromWalletId}),
                (${txId}, 'move', 2, ${i.accountId}, 'funded_balance', 'credit', ${amt}, null)`,
      tx<MoveRow[]>`update transactions set status = 'completed', completed_at = now() where id = ${txId} returning ${tx.unsafe(M_COLS)}`,
    ];
    const results = await Promise.all(writes);
    return { kind: "ok", tx: (results[5] as unknown as MoveRow[])[0]!, replayed: false };
  });
}
