import { earmarkLog } from "./audit";
import type { TransactionSql } from "postgres";

type Tx = TransactionSql<{ bigint: bigint }>;

/**
 * Total set aside across the account's wallets: an earmarked wallet's whole balance (its holds are inside it) and the holds of the wallets that
 * draw on shared funds. Read it while holding the account's balances row lock.
 */
export async function earmarkedTotal(tx: Tx, accountId: string): Promise<bigint> {
  const [r] = await tx<{ total: bigint }[]>`
    select coalesce(sum(case when balance is not null then balance else held end), 0)::bigint as total from wallets where account_id = ${accountId}`;
  return r!.total;
}

export const pos = (v: bigint) => (v > 0n ? v : 0n);

/**
 * What a wallet may draw on for a spend or send. An earmarked wallet has only its own balance (and no
 * credit); an unearmarked wallet has the account's funds minus everything earmarked for other wallets.
 */
export async function spendable(tx: Tx, accountId: string, accountBalance: bigint, walletBalance: bigint | null, walletHeld = 0n) {
  if (walletBalance !== null) return { earmarked: true as const, funds: pos(walletBalance - walletHeld) };
  return { earmarked: false as const, funds: pos(accountBalance - (await earmarkedTotal(tx, accountId))) };
}

/** The earmarked-total query, to send alongside other reads in a batch. */
export const earmarkedTotalQuery = (tx: Tx, accountId: string) => tx<{ total: bigint }[]>`
  select coalesce(sum(case when balance is not null then balance else held end), 0)::bigint as total from wallets where account_id = ${accountId}`;

/** Money coming back to a wallet (a refund, an incoming send): top up its earmark if it has one. */
export async function creditWallet(tx: Tx, walletId: string, amount: bigint) {
  if (amount <= 0n) return;
  await tx`update wallets set balance = balance + ${amount.toString()} where id = ${walletId} and balance is not null`;
}

export type SetBalanceResult =
  | { ok: true; balance: bigint | null; delta: bigint }
  | { ok: false; error: "not_found" | "wallet_closed" | "insufficient_shared_balance" | "account_restricted" | "benefits_wallet_locked" | "hold_active"; available?: bigint; held?: bigint };

/**
 * Set a wallet's earmark: a number to set money aside (or change it), null to release it back to the
 * shared funds. Locks the account's balances row, then the wallet, like every other money movement.
 * Raising it needs enough shared funds; lowering or releasing always works.
 */
export async function setWalletBalance(
  tx: Tx,
  i: { accountId: string; walletId: string; target: bigint | null; deviceId: string | null },
): Promise<SetBalanceResult> {
  const [b] = await tx<{ balance: bigint; credit_limit: bigint; credit_spent: bigint }[]>`
    select balance, credit_limit, credit_spent from balances where account_id = ${i.accountId} for no key update`;
  const [w] = await tx<{ status: string; balance: bigint | null; type: string; held: bigint }[]>`
    select status, balance, type, held from wallets where id = ${i.walletId} and account_id = ${i.accountId} for no key update`;
  if (!b || !w) return { ok: false, error: "not_found" };
  // A Benefits wallet's money comes only from its employer and leaves only by a payment, a refund back or a same-account move.
  if (w.type === "benefits") return { ok: false, error: "benefits_wallet_locked" };
  if (w.status === "closed") return { ok: false, error: "wallet_closed" };

  // Money held for a tab stays held: an earmark may not go below it (releasing the earmark keeps the holds as shared holds).
  if (i.target !== null && i.target < w.held) return { ok: false, error: "hold_active", held: w.held };
  const current = w.balance;
  const delta = (i.target ?? 0n) - (current ?? 0n);   // release: everything earmarked goes back
  if (delta > 0n) {
    if (b.balance < 0n || b.credit_spent > b.credit_limit) return { ok: false, error: "account_restricted" };
    // the shared pool already lost this wallet's holds while it was shared; they move inside the new earmark
    const free = pos(b.balance - (await earmarkedTotal(tx, i.accountId)));
    const need = delta - (current === null ? w.held : 0n);
    if (need > free) return { ok: false, error: "insufficient_shared_balance", available: free };
  }
  if (delta === 0n && (current === null) === (i.target === null)) return { ok: true, balance: current, delta: 0n };

  await tx`update wallets set balance = ${i.target === null ? null : i.target.toString()}::bigint where id = ${i.walletId}`;
  if (delta !== 0n) {
    await earmarkLog(tx, i.accountId, i.walletId, delta, i.target, i.deviceId);
  }
  return { ok: true, balance: i.target, delta };
}
