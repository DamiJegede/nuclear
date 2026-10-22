import { earmarkedTotalQuery, spendableFrom } from "./walletFunds";
import { CAP_COLS, capApplies, capHeadroom, capToday, type CapRow } from "./cap";
import type { TransactionSql } from "postgres";
import type { Sql } from "../db";

/** Pool client or an open transaction handle. */
type Tx = TransactionSql<{ bigint: bigint }>;

/** Program day boundary: 00:00 America/New_York (spent_today resets here). */
export const PROGRAM_TZ = "America/New_York";


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

  return sql.begin(async (tx): Promise<SendOutcome> => {
    // Resolve and authorize both endpoints in one round trip, on the transaction's connection (parallel queries outside a transaction
    // would each take a pool connection).
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
    if (to.type !== "C") return { kind: "error", status: 422, error: "recipient_not_eligible" };

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

    // One round trip for all the reads, sent together and run in this order on the server: both balance rows (stable order), then the
    // sender wallet, then the plain reads (the lock order is unchanged).
    const [bal, [sw], [sa], [rw], [ra], [em]] = await Promise.all([
      tx<({ account_id: string; credit_limit: bigint; credit_spent: bigint } & CapRow)[]>`
        select b.account_id, b.balance, b.credit_limit, b.credit_spent, ${tx.unsafe(CAP_COLS)}
          from balances b join accounts a on a.id = b.account_id
         where b.account_id in (${from.account_id}, ${to.account_id})
         order by b.account_id for no key update of b`,
      tx<{ status: string; allow_send: boolean; daily_limit: bigint | null; spent_today: bigint; balance: bigint | null }[]>`
        select status, allow_send, daily_limit, spent_today, balance from wallets where id = ${from.id} for no key update`,
      tx<{ status: string }[]>`select status from accounts where id = ${from.account_id}`,
      tx<{ status: string }[]>`select status from wallets where id = ${to.id} for share`,
      tx<{ status: string }[]>`select status from accounts where id = ${to.account_id}`,
      earmarkedTotalQuery(tx, from.account_id),
    ]);
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

    if (code) {
      const [t] = await tx<TxRow[]>`
        update transactions set status = 'failed', status_code = ${code}
         where id = ${txId} returning ${tx.unsafe(TX_COLS)}`;
      return { kind: "declined", tx: t!, replayed: false };
    }

    const amt = i.amount.toString();
    // Every write in one round trip (sent together, applied in this order).
    const [, , , , , [t]] = await Promise.all([
      tx`update balances set balance = balance - ${amt} where account_id = ${from.account_id}`,
      // The recipient: more balance, and (a consumer's) today's additions go up; a stale row rolls to today first.
      rb && capApplies(rb)
        ? tx`update balances set balance = balance + ${amt}, ordinary_opening = ${capToday(rb).opening.toString()}, added_today = ${(capToday(rb).added + i.amount).toString()}, opening_day = greatest(opening_day, ${rb.today}::date) where account_id = ${to.account_id}`
        : tx`update balances set balance = balance + ${amt} where account_id = ${to.account_id}`,
      // The sender's day counter, and its earmark when it has one.
      tx`update wallets set spent_today = spent_today + ${amt}, balance = case when balance is not null then balance - ${amt} else balance end where id = ${from.id}`,
      // Money sent to an earmarked wallet is that wallet's to spend.
      tx`update wallets set balance = balance + ${amt} where id = ${to.id} and balance is not null`,
      tx`insert into ledger_entries (transaction_id, posting_key, line_no, account_id, bucket, direction, amount)
         values (${txId}, 'send', 1, ${from.account_id}, 'funded_balance', 'debit', ${amt}),
                (${txId}, 'send', 2, ${to.account_id}, 'funded_balance', 'credit', ${amt})`,
      tx<TxRow[]>`update transactions set status = 'completed', completed_at = now()
                   where id = ${txId} returning ${tx.unsafe(TX_COLS)}`,
    ]);
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

    const [b] = await tx<({ credit_spent: bigint } & CapRow)[]>`
      select b.balance, b.credit_spent, ${tx.unsafe(CAP_COLS)}
        from balances b join accounts a on a.id = b.account_id
       where b.account_id = ${i.accountId} for no key update of b`;
    if (!b) throw new Error("balances row missing");

    // One daily rule for a consumer's ordinary money: cap - opening value - added today. Organizations and businesses are exempt.
    if (capApplies(b) && capHeadroom(b, i.dailyCap) < i.amount) {
      const [f] = await tx<FundingRow[]>`
        update fundings set status = 'failed', failure_code = 'daily_value_limit_exceeded'
         where id = ${fundingId} returning ${tx.unsafe(F_COLS)}`;
      return { kind: "failed", funding: f!, replayed: false };
    }

    // Credit principal is repaid first; only the remainder increases funded balance.
    const repay = b.credit_spent < i.amount ? b.credit_spent : i.amount;
    const toBalance = i.amount - repay;
    const amt = i.amount.toString();

    // The whole load counts as today's addition (even the part that repays credit); a stale row rolls to today first.
    await tx`
      update balances set balance = balance + ${toBalance.toString()},
                          credit_spent = credit_spent - ${repay.toString()}
                          ${capApplies(b) ? tx`, ordinary_opening = ${capToday(b).opening.toString()}, added_today = ${(capToday(b).added + i.amount).toString()}, opening_day = greatest(opening_day, ${b.today}::date)` : tx``}
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
