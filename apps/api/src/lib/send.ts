import { earmarkedTotalQuery, spendableFrom } from "./walletFunds";
import { CAP_COLS, capApplies, capHeadroom, capToday, type CapRow } from "./cap";
import { findByIdem, insertTx, isUniqueViolation, rowOf, spentToday, TX_COLS, type NewTx, type TxRow } from "./txn";
import type { Sql } from "../db";

export type SendInput = {
  actorAccountId: string;
  /** Set for delegated (shared-wallet) sessions; the sender must be this wallet. */
  authWalletId: string | null;
  fromWalletId: string | null;
  toWalletId: string;
  amount: bigint;
  idempotencyKey: string;
  dailyCap: bigint;
};

export type SendOutcome =
  | { kind: "ok"; tx: TxRow; replayed: boolean }
  | { kind: "declined"; tx: TxRow; replayed: boolean }
  | { kind: "error"; status: 404 | 409 | 422; error: string };

/**
 * Wallet -> wallet transfer of funded balance (never credit). One DB transaction: ordered balance locks, the idempotency check (taken
 * under the sender's lock, so a concurrent retry waits and then replays), authority/limit checks, then one batch of writes. A declined
 * attempt is committed as a `declined` transaction and nothing else changes.
 */
export async function sendFunds(sql: Sql, i: SendInput): Promise<SendOutcome> {
  try {
    return await attempt(sql, i);
  } catch (e) {
    if (isUniqueViolation(e)) return attempt(sql, i);   // lost a race on the key with a different sender lock order: now it replays
    throw e;
  }
}

async function attempt(sql: Sql, i: SendInput): Promise<SendOutcome> {
  // A delegated session can only send from its own wallet; owners pick any of their wallets (default wallet when omitted).
  if (i.authWalletId !== null && i.fromWalletId !== null && i.fromWalletId !== i.authWalletId) {
    return { kind: "error", status: 404, error: "wallet_not_found" };
  }
  const wanted = i.authWalletId ?? i.fromWalletId;

  return sql.begin(async (tx): Promise<SendOutcome> => {
    // Resolve and authorize both endpoints in one round trip, on the transaction's connection.
    const [[from], [to]] = await Promise.all([
      wanted
        ? tx<{ id: string; account_id: string; wtype: string }[]>`
            select id, account_id, type as wtype from wallets where id = ${wanted} and account_id = ${i.actorAccountId}`
        : tx<{ id: string; account_id: string; wtype: string }[]>`
            select id, account_id, type as wtype from wallets
             where account_id = ${i.actorAccountId} and type = 'default'`,
      tx<{ id: string; account_id: string; type: string; wtype: string }[]>`
        select w.id, w.account_id, a.type, w.type as wtype from wallets w join accounts a on a.id = w.account_id
         where w.id = ${i.toWalletId}`,
    ]);
    if (!from) return { kind: "error", status: 404, error: "wallet_not_found" };
    if (!to) return { kind: "error", status: 404, error: "recipient_not_found" };
    if (to.id === from.id) return { kind: "error", status: 422, error: "same_wallet" };
    // Benefits money never leaves the account as a transfer, and only its bound employer can put money into a Benefits wallet.
    if (from.wtype === "benefits") return { kind: "error", status: 422, error: "benefits_wallet_not_transferable" };
    if (to.wtype === "benefits") return { kind: "error", status: 422, error: "recipient_not_eligible" };
    // Wallets of one account share funds; budget changes authority, it does not move money.
    if (to.account_id === from.account_id) return { kind: "error", status: 422, error: "same_account" };
    if (to.type !== "C" || to.wtype === "system" || to.wtype === "escrow") return { kind: "error", status: 422, error: "recipient_not_eligible" };

    const idem = `send:${from.account_id}:${i.idempotencyKey}`;
    // One round trip for all the reads, sent together and run in this order on the server: both balance rows (stable order), then the
    // sender wallet, then the plain reads. The key is read after the sender's lock is held, so a concurrent retry sees the first result.
    const [bal, [sw], [sa], [rw], [ra], [em], [prev]] = await Promise.all([
      tx<({ account_id: string; credit_limit: bigint; credit_spent: bigint } & CapRow)[]>`
        select b.account_id, b.balance, b.credit_limit, b.credit_spent, ${tx.unsafe(CAP_COLS)}
          from balances b join accounts a on a.id = b.account_id
         where b.account_id in (${from.account_id}, ${to.account_id})
         order by b.account_id for no key update of b`,
      tx<{ status: string; allow_send: boolean; daily_limit: bigint | null; spent_today: bigint; balance: bigint | null }[]>`
        select status, allow_send, daily_limit, ${tx.unsafe(spentToday)} as spent_today, balance from wallets where id = ${from.id} for no key update`,
      tx<{ status: string }[]>`select status from accounts where id = ${from.account_id}`,
      tx<{ status: string }[]>`select status from wallets where id = ${to.id} for share`,
      tx<{ status: string }[]>`select status from accounts where id = ${to.account_id}`,
      earmarkedTotalQuery(tx, from.account_id),
      tx<TxRow[]>`select ${tx.unsafe(TX_COLS)} from txn where idempotency_key = ${idem}`,
    ]);
    if (prev) {
      if (prev.from_wallet_id !== from.id || prev.to_wallet_id !== to.id || prev.amount !== i.amount) {
        return { kind: "error", status: 409, error: "idempotency_mismatch" };
      }
      return { kind: prev.status === "completed" ? "ok" : "declined", tx: prev, replayed: true };
    }
    const sb = bal.find((r) => r.account_id === from.account_id);
    const rb = bal.find((r) => r.account_id === to.account_id);
    if (!sb || bal.length !== 2) throw new Error("balances row missing");

    const funds = spendableFrom(sb.balance, sw ? sw.balance : null, em!.total);
    let code: string | null = null;
    if (!sa || sa.status !== "active" || !sw || sw.status !== "active") code = "sender_unavailable";
    else if (!sw.allow_send) code = "send_not_allowed";
    else if (sb.balance < 0n || sb.credit_spent > sb.credit_limit) code = "account_restricted";
    else if (!rw || rw.status !== "active" || !ra || ra.status !== "active") code = "recipient_unavailable";
    else if (funds.funds < i.amount) code = funds.earmarked ? "wallet_balance_exceeded" : "insufficient_balance"; // funded balance only, no credit
    else if (sw.daily_limit !== null && sw.spent_today + i.amount > sw.daily_limit) code = "spend_limit_exceeded";
    else if (rb && capApplies(rb) && capHeadroom(rb, i.dailyCap) < i.amount) code = "recipient_limit_exceeded";   // one daily rule: cap - opening - added today

    const t: NewTx = { type: "send", declined: code, from: from.id, to: to.id, amount: i.amount, account: i.actorAccountId, idem };
    const sides = { fromAccount: from.account_id, toAccount: to.account_id, fromWallet: from.id, toWallet: to.id };
    if (code) {
      const [w] = await insertTx(tx, t);
      return { kind: "declined", tx: rowOf(t, w!, sides), replayed: false };
    }

    const amt = i.amount.toString();
    // Every write in one round trip (sent together, applied in this order).
    const [, , , , [w]] = await Promise.all([
      tx`update balances set balance = balance - ${amt} where account_id = ${from.account_id}`,
      // The recipient: more balance, and (a consumer's) today's additions go up; a stale row rolls to today first.
      rb && capApplies(rb)
        ? tx`update balances set balance = balance + ${amt}, ordinary_opening = ${capToday(rb).opening.toString()}, added_today = ${(capToday(rb).added + i.amount).toString()}, opening_day = greatest(opening_day, ${rb.today}::date) where account_id = ${to.account_id}`
        : tx`update balances set balance = balance + ${amt} where account_id = ${to.account_id}`,
      // The sender's day counter (rolling over on a new day), and its earmark when it has one.
      tx`update wallets set spent_today = case when spent_day = program_today() then spent_today + ${amt} else ${amt} end, spent_day = program_today(),
                balance = case when balance is not null then balance - ${amt} else balance end where id = ${from.id}`,
      // Money sent to an earmarked wallet is that wallet's to spend.
      tx`update wallets set balance = balance + ${amt} where id = ${to.id} and balance is not null`,
      insertTx(tx, t),
    ]);
    return { kind: "ok", tx: rowOf(t, w!, sides), replayed: false };
  }) as Promise<SendOutcome>;
}

export { findByIdem };
