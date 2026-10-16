import { creditWallet, debitWallet, spendable } from "./walletFunds";
import type { TransactionSql } from "postgres";
import type { Sql } from "../db";

/** Pool client or an open transaction handle. */
type Tx = TransactionSql<{ bigint: bigint }>;

/** Program day boundary: 00:00 America/New_York (spent_today resets here). */
export const PROGRAM_TZ = "America/New_York";

export const DEFAULT_DAILY_VALUE_CAP = 200_000n; // $2,000, configurable (spec target, not final)

export type TxRow = {
  id: string;
  type: string;
  status: string;
  status_code: string | null;
  amount: bigint;
  from_account_id: string | null;
  to_account_id: string | null;
  from_wallet_id: string | null;
  to_wallet_id: string | null;
  timestamp: Date;
  completed_at: Date | null;
};

const TX_COLS = `id, type, status, status_code, amount, from_account_id, to_account_id,
  from_wallet_id, to_wallet_id, "timestamp", completed_at`;

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

/** Incoming value counted against a recipient's program day: released loads + incoming sends. */
async function incomingToday(tx: Tx, accountId: string): Promise<bigint> {
  const [row] = await tx<{ total: bigint }[]>`
    with start as (
      select date_trunc('day', now() at time zone ${PROGRAM_TZ}) at time zone ${PROGRAM_TZ} as t
    )
    select (
      coalesce((select sum(amount) from transactions, start
                 where to_account_id = ${accountId} and type = 'send'
                   and status = 'completed' and completed_at >= start.t), 0)
      +
      coalesce((select sum(amount) from fundings, start
                 where account_id = ${accountId} and released_at >= start.t), 0)
    )::bigint as total`;
  return row!.total;
}

export { incomingToday };

/**
 * Wallet -> wallet transfer of funded balance (never credit). One DB transaction: idempotent
 * transaction row, ordered balance locks, authority/limit checks, balance + wallet counter
 * updates and a balanced ledger posting. A declined attempt is committed as a failed row.
 */
export async function sendFunds(sql: Sql, i: SendInput): Promise<SendOutcome> {
  // Resolve and authorize endpoints (ownership in the WHERE clause).
  // A delegated session can only send from its own wallet; owners pick any of their wallets
  // (default wallet when omitted).
  if (i.authWalletId !== null && i.fromWalletId !== null && i.fromWalletId !== i.authWalletId) {
    return { kind: "error", status: 404, error: "wallet_not_found" };
  }
  const wanted = i.authWalletId ?? i.fromWalletId;
  const [from] = wanted
    ? await sql<{ id: string; account_id: string }[]>`
        select id, account_id from wallets where id = ${wanted} and account_id = ${i.actorAccountId}`
    : await sql<{ id: string; account_id: string }[]>`
        select id, account_id from wallets
         where account_id = ${i.actorAccountId} and type = 'default'`;
  if (!from) return { kind: "error", status: 404, error: "wallet_not_found" };

  const [to] = await sql<{ id: string; account_id: string; type: string }[]>`
    select w.id, w.account_id, a.type from wallets w join accounts a on a.id = w.account_id
     where w.id = ${i.toWalletId}`;
  if (!to) return { kind: "error", status: 404, error: "recipient_not_found" };
  if (to.id === from.id) return { kind: "error", status: 422, error: "same_wallet" };
  // Wallets of one account share funds; budget changes authority, it does not move money.
  if (to.account_id === from.account_id) return { kind: "error", status: 422, error: "same_account" };
  if (to.type !== "C") return { kind: "error", status: 422, error: "recipient_not_eligible" };

  return sql.begin(async (tx): Promise<SendOutcome> => {
    const ins = await tx<{ id: string }[]>`
      insert into transactions (type, from_account_id, to_account_id, from_wallet_id, to_wallet_id,
                                amount, status, idempotency_key)
      values ('send', ${from.account_id}, ${to.account_id}, ${from.id}, ${to.id},
              ${i.amount.toString()}, 'pending', ${i.idempotencyKey})
      on conflict (type, from_account_id, idempotency_key) where from_account_id is not null and type <> 'pay'
      do nothing
      returning id`;

    if (!ins[0]) {
      const [prev] = await tx<TxRow[]>`
        select ${tx.unsafe(TX_COLS)} from transactions
         where type = 'send' and from_account_id = ${from.account_id}
           and idempotency_key = ${i.idempotencyKey}`;
      if (
        !prev ||
        prev.from_wallet_id !== from.id ||
        prev.to_wallet_id !== to.id ||
        prev.amount !== i.amount
      ) {
        return { kind: "error", status: 409, error: "idempotency_mismatch" };
      }
      return { kind: prev.status === "completed" ? "ok" : "declined", tx: prev, replayed: true };
    }
    const txId = ins[0].id;

    // Lock both balance rows in a stable order, then the sender wallet's counters.
    const bal = await tx<{ account_id: string; balance: bigint; credit_limit: bigint; credit_spent: bigint }[]>`
      select account_id, balance, credit_limit, credit_spent from balances
       where account_id in (${from.account_id}, ${to.account_id})
       order by account_id for no key update`;
    const sb = bal.find((r) => r.account_id === from.account_id);
    if (!sb || bal.length !== 2) throw new Error("balances row missing");

    const [sw] = await tx<{ status: string; allow_send: boolean; daily_limit: bigint | null; spent_today: bigint; balance: bigint | null }[]>`
      select status, allow_send, daily_limit, spent_today, balance from wallets where id = ${from.id} for no key update`;
    const [sa] = await tx<{ status: string }[]>`select status from accounts where id = ${from.account_id}`;
    const [rw] = await tx<{ status: string }[]>`select status from wallets where id = ${to.id} for share`;
    const [ra] = await tx<{ status: string }[]>`select status from accounts where id = ${to.account_id}`;

    const funds = await spendable(tx, from.account_id, sb.balance, sw ? sw.balance : null);
    let code: string | null = null;
    if (!sa || sa.status !== "active" || !sw || sw.status !== "active") code = "sender_unavailable";
    else if (!sw.allow_send) code = "send_not_allowed";
    else if (sb.balance < 0n || sb.credit_spent > sb.credit_limit) code = "account_restricted";
    else if (!rw || rw.status !== "active" || !ra || ra.status !== "active") code = "recipient_unavailable";
    else if (funds.funds < i.amount) code = funds.earmarked ? "wallet_balance_exceeded" : "insufficient_balance"; // funded balance only, no credit
    else if (sw.daily_limit !== null && sw.spent_today + i.amount > sw.daily_limit) code = "spend_limit_exceeded";
    else if ((await incomingToday(tx, to.account_id)) + i.amount > i.dailyCap) code = "recipient_limit_exceeded";

    if (code) {
      const [t] = await tx<TxRow[]>`
        update transactions set status = 'failed', status_code = ${code}
         where id = ${txId} returning ${tx.unsafe(TX_COLS)}`;
      return { kind: "declined", tx: t!, replayed: false };
    }

    const amt = i.amount.toString();
    await tx`update balances set balance = balance - ${amt} where account_id = ${from.account_id}`;
    await tx`update balances set balance = balance + ${amt} where account_id = ${to.account_id}`;
    await tx`update wallets set spent_today = spent_today + ${amt} where id = ${from.id}`;
    await debitWallet(tx, from.id, i.amount);
    await creditWallet(tx, to.id, i.amount);   // money sent to an earmarked wallet is that wallet's to spend
    await tx`
      insert into ledger_entries (transaction_id, posting_key, line_no, account_id, bucket, direction, amount)
      values (${txId}, 'send', 1, ${from.account_id}, 'funded_balance', 'debit', ${amt}),
             (${txId}, 'send', 2, ${to.account_id}, 'funded_balance', 'credit', ${amt})`;
    const [t] = await tx<TxRow[]>`
      update transactions set status = 'completed', completed_at = now()
       where id = ${txId} returning ${tx.unsafe(TX_COLS)}`;
    return { kind: "ok", tx: t!, replayed: false };
  }) as Promise<SendOutcome>;
}

export type FundingOutcome =
  | { kind: "ok"; funding: FundingRow; replayed: boolean }
  | { kind: "failed"; funding: FundingRow; replayed: boolean }
  | { kind: "error"; status: 409; error: string };

export type FundingRow = {
  id: string;
  account_id: string;
  amount: bigint;
  status: string;
  failure_code: string | null;
  transaction_id: string | null;
  created_at: Date;
  released_at: Date | null;
};

const F_COLS = `id, account_id, amount, status, failure_code, transaction_id, created_at, released_at`;

/**
 * SANDBOX ONLY: simulates a bank load that is confirmed and released immediately. A real provider
 * adapter should reuse the release step (repay credit first, post balanced entries, one fund
 * transaction, link funding.transaction_id).
 */
export async function sandboxFund(
  sql: Sql,
  i: { accountId: string; amount: bigint; idempotencyKey: string; dailyCap: bigint },
): Promise<FundingOutcome> {
  return sql.begin(async (tx): Promise<FundingOutcome> => {
    let [bank] = await tx<{ id: string }[]>`
      select id from bank_accounts
       where account_id = ${i.accountId} and status = 'active' and provider_account_id is null
         and routing_number = 'SANDBOX'
       limit 1`;
    if (!bank) {
      [bank] = await tx<{ id: string }[]>`
        insert into bank_accounts (account_id, routing_number, account_number, last4)
        values (${i.accountId}, 'SANDBOX', 'SANDBOX', '0000') returning id`;
    }

    const ins = await tx<{ id: string }[]>`
      insert into fundings (account_id, bank_account_id, amount, idempotency_key, status)
      values (${i.accountId}, ${bank!.id}, ${i.amount.toString()}, ${i.idempotencyKey}, 'created')
      on conflict (account_id, idempotency_key) do nothing
      returning id`;
    if (!ins[0]) {
      const [prev] = await tx<FundingRow[]>`
        select ${tx.unsafe(F_COLS)} from fundings
         where account_id = ${i.accountId} and idempotency_key = ${i.idempotencyKey}`;
      if (!prev || prev.amount !== i.amount) return { kind: "error", status: 409, error: "idempotency_mismatch" };
      return { kind: prev.status === "completed" ? "ok" : "failed", funding: prev, replayed: true };
    }
    const fundingId = ins[0].id;

    const [b] = await tx<{ balance: bigint; credit_spent: bigint }[]>`
      select balance, credit_spent from balances where account_id = ${i.accountId} for no key update`;
    if (!b) throw new Error("balances row missing");

    if ((await incomingToday(tx, i.accountId)) + i.amount > i.dailyCap) {
      const [f] = await tx<FundingRow[]>`
        update fundings set status = 'failed', failure_code = 'daily_value_limit_exceeded'
         where id = ${fundingId} returning ${tx.unsafe(F_COLS)}`;
      return { kind: "failed", funding: f!, replayed: false };
    }

    // Credit principal is repaid first; only the remainder increases funded balance.
    const repay = b.credit_spent < i.amount ? b.credit_spent : i.amount;
    const toBalance = i.amount - repay;
    const amt = i.amount.toString();

    await tx`
      update balances set balance = balance + ${toBalance.toString()},
                          credit_spent = credit_spent - ${repay.toString()}
       where account_id = ${i.accountId}`;

    const [t] = await tx<{ id: string }[]>`
      insert into transactions (type, from_account_id, to_account_id, from_bank_account_id,
                                amount, status, idempotency_key, completed_at)
      values ('fund', ${i.accountId}, ${i.accountId}, ${bank!.id}, ${amt}, 'completed',
              ${i.idempotencyKey}, now())
      returning id`;

    let line = 1;
    await tx`
      insert into ledger_entries (funding_id, posting_key, line_no, account_id, bucket, direction, amount)
      values (${fundingId}, 'release', ${line++}, null, 'bank_settlement', 'debit', ${amt})`;
    if (toBalance > 0n) {
      await tx`
        insert into ledger_entries (funding_id, posting_key, line_no, account_id, bucket, direction, amount)
        values (${fundingId}, 'release', ${line++}, ${i.accountId}, 'funded_balance', 'credit', ${toBalance.toString()})`;
    }
    if (repay > 0n) {
      await tx`
        insert into ledger_entries (funding_id, posting_key, line_no, account_id, bucket, direction, amount)
        values (${fundingId}, 'release', ${line++}, ${i.accountId}, 'credit_receivable', 'credit', ${repay.toString()})`;
    }

    const [f] = await tx<FundingRow[]>`
      update fundings set status = 'completed', released_at = now(), transaction_id = ${t!.id}
       where id = ${fundingId} returning ${tx.unsafe(F_COLS)}`;
    return { kind: "ok", funding: f!, replayed: false };
  }) as Promise<FundingOutcome>;
}

/** Cron: reset combined send/payment counters at 00:00 Eastern. */
export function easternHour(d: Date): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: PROGRAM_TZ, hour: "2-digit", hourCycle: "h23" })
    .formatToParts(d)
    .find((p) => p.type === "hour")!.value;
  return Number(h);
}

/** Cron at 00:00 Eastern: reset wallets.spent_today and products.sold_today. */
export async function resetDailyCounters(sql: Sql): Promise<{ wallets: number; products: number }> {
  const w = await sql`update wallets set spent_today = 0 where spent_today <> 0 returning id`;
  const p = await sql`update products set sold_today = 0 where sold_today <> 0 returning id`;
  return { wallets: w.length, products: p.length };
}
