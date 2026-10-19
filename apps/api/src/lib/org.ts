import { randomBytes } from "node:crypto";
import type { Sql } from "../db";
import { hashToken } from "../crypto";

/**
 * Employer credits (docs/ORGANIZATIONS.md). An organization (account type O) credits its employees from its own funded balance:
 *  - an employee who already claimed (has an account): a normal `send` from the organization's default wallet to theirs;
 *  - an employee who has not: an `allocate` transaction holds the money (ledger bucket employee_escrow, employees.balance) until they
 *    claim it with the emailed token (`claim` transaction). Held credits never expire.
 * A whole CSV is ONE database transaction using bulk statements: it is applied completely or not at all, and a batch the organization
 * cannot cover is refused before anything is written. Lock order: the organization's balances row, then the recipients' balances rows
 * (by account id), then the organization's wallet.
 */

export const MAX_BATCH_ROWS = 2000;
/** One credit may not exceed $100,000.00. */
export const MAX_CREDIT = 10_000_000n;

export type CreditRow = { employee_id: string; name: string; email: string; amount: bigint };

export type BatchSummary = {
  id: string;
  row_count: number;
  total: bigint;
  sent: bigint;
  held: bigint;
  created_at: Date;
};

/** An employee who is owed an email after the batch committed (raw token: shown only here, never stored). */
export type Notice = { employee_id: string; name: string; email: string; amount: bigint; token: string };

export type BatchOutcome =
  | { kind: "ok"; batch: BatchSummary; notices: Notice[]; replayed: boolean }
  | { kind: "error"; status: 404 | 409 | 422; error: string; extra?: Record<string, unknown> };

function newClaimToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export async function runCreditBatch(sql: Sql, i: { orgId: string; idempotencyKey: string; rows: CreditRow[] }): Promise<BatchOutcome> {
  const total = i.rows.reduce((s, r) => s + r.amount, 0n);
  return sql.begin(async (tx): Promise<BatchOutcome> => {
    // 1. Lock the organization's balance and wallet (one round trip), then the batch idempotency check.
    const [[bal], [wallet], [org]] = await Promise.all([
      tx<{ balance: bigint }[]>`select balance from balances where account_id = ${i.orgId} for no key update`,
      tx<{ id: string; status: string; allow_send: boolean }[]>`
        select id, status, allow_send from wallets where account_id = ${i.orgId} and type = 'default' for no key update`,
      tx<{ status: string; type: string }[]>`select status, type from accounts where id = ${i.orgId}`,
    ]);
    if (!bal || !wallet || !org) throw new Error("organization rows missing");
    if (org.type !== "O") return { kind: "error", status: 404, error: "organization_required" };
    if (org.status !== "active" || wallet.status !== "active" || !wallet.allow_send) return { kind: "error", status: 422, error: "organization_unavailable" };

    const [prev] = await tx<(BatchSummary & { total: bigint })[]>`
      select id, row_count, total, sent, held, created_at from credit_batches
       where org_account_id = ${i.orgId} and idempotency_key = ${i.idempotencyKey}`;
    if (prev) {
      if (prev.total !== total || prev.row_count !== i.rows.length) return { kind: "error", status: 409, error: "idempotency_mismatch" };
      return { kind: "ok", batch: prev, notices: [], replayed: true };
    }

    // 2. The whole batch or nothing: the balance must cover the total.
    if (bal.balance < total) {
      return { kind: "error", status: 422, error: "insufficient_balance", extra: { required: Number(total), available: Number(bal.balance < 0n ? 0n : bal.balance) } };
    }

    // 3. Employees: create new ones, refresh name and email of known ones (employee_id is immutable and is the key).
    const emps = await tx<{ id: string; employee_id: string; employee_account_id: string | null }[]>`
      insert into employees (org_account_id, employee_id, name, email)
      select ${i.orgId}, e.employee_id, e.name, e.email
        from jsonb_to_recordset(${JSON.stringify(i.rows.map((r) => ({ employee_id: r.employee_id, name: r.name, email: r.email })))}::text::jsonb)
             as e(employee_id text, name text, email text)
      on conflict (org_account_id, employee_id) do update set name = excluded.name, email = excluded.email, status = 'active'
      returning id, employee_id, employee_account_id`;
    const byKey = new Map(emps.map((e) => [e.employee_id, e]));

    // 4. Recipients that have an account: wallets and statuses, then their balance rows locked in a stable order.
    const accountIds = [...new Set(emps.filter((e) => e.employee_account_id).map((e) => e.employee_account_id!))].sort();
    const targets = accountIds.length
      ? await tx<{ account_id: string; wallet_id: string; w_status: string; a_status: string; a_type: string }[]>`
          select w.account_id, w.id as wallet_id, w.status as w_status, a.status as a_status, a.type as a_type
            from wallets w join accounts a on a.id = w.account_id
           where w.type = 'default' and w.account_id in ${tx(accountIds)}`
      : [];
    const bad = targets.filter((t) => t.a_status !== "active" || t.w_status !== "active" || t.a_type !== "C");
    const missing = accountIds.filter((a) => !targets.some((t) => t.account_id === a));
    if (bad.length || missing.length) {
      const badIds = new Set([...bad.map((b) => b.account_id), ...missing]);
      const ids = emps.filter((e) => e.employee_account_id && badIds.has(e.employee_account_id)).map((e) => e.employee_id);
      throw new BatchRefused("recipient_unavailable", { employee_ids: ids });
    }
    if (accountIds.length) {
      await tx`select account_id from balances where account_id in ${tx(accountIds)} order by account_id for no key update`;
    }
    const walletOf = new Map(targets.map((t) => [t.account_id, t.wallet_id]));

    // 5. The batch row, then one transaction per CSV row (one bulk insert).
    const lines = i.rows.map((r, idx) => {
      const e = byKey.get(r.employee_id)!;
      const held = e.employee_account_id === null;
      return { n: idx + 1, ref: e.id, held, amount: r.amount, to_account: e.employee_account_id, to_wallet: e.employee_account_id ? walletOf.get(e.employee_account_id)! : null };
    });
    const held = lines.filter((l) => l.held).reduce((s, l) => s + l.amount, 0n);
    const sent = total - held;
    const [batch] = await tx<BatchSummary[]>`
      insert into credit_batches (org_account_id, idempotency_key, row_count, total, sent, held)
      values (${i.orgId}, ${i.idempotencyKey}, ${i.rows.length}, ${total.toString()}, ${sent.toString()}, ${held.toString()})
      returning id, row_count, total, sent, held, created_at`;
    const batchId = batch!.id;

    const payload = JSON.stringify(lines.map((l) => ({ n: l.n, type: l.held ? "allocate" : "send", to_account: l.to_account, to_wallet: l.to_wallet, amount: l.amount.toString() })));
    const txs = await tx<{ id: string; idempotency_key: string; type: string; amount: bigint }[]>`
      insert into transactions (type, from_account_id, from_wallet_id, to_account_id, to_wallet_id, amount, status, idempotency_key, completed_at)
      select r.type, ${i.orgId}, ${wallet.id}, r.to_account, r.to_wallet, r.amount, 'completed', ${`batch:${batchId}:`} || r.n::text, now()
        from jsonb_to_recordset(${payload}::text::jsonb) as r(n int, type text, to_account uuid, to_wallet uuid, amount bigint)
      returning id, idempotency_key, type, amount`;
    const txByN = new Map(txs.map((t) => [Number(t.idempotency_key.split(":")[2]), t]));

    // 6. Tokens for the employees who must be told (one fresh token each; an employee in the CSV is unique).
    const notices: Notice[] = [];
    const tokenRows: { id: string; hash: string; amount: string }[] = [];
    for (const [idx, l] of lines.entries()) {
      if (!l.held) continue;
      const t = newClaimToken();
      const r = i.rows[idx]!;
      notices.push({ employee_id: r.employee_id, name: r.name, email: r.email, amount: r.amount, token: t.token });
      tokenRows.push({ id: l.ref, hash: t.hash, amount: l.amount.toString() });
    }

    // 7. Every write in one round trip, applied in this order.
    const ledger = JSON.stringify(
      lines.flatMap((l) => {
        const t = txByN.get(l.n)!;
        const key = l.held ? "allocate" : "send";
        return [
          { tx: t.id, key, line: 1, account: i.orgId, bucket: "funded_balance", dir: "debit", amount: l.amount.toString() },
          { tx: t.id, key, line: 2, account: l.to_account, bucket: l.held ? "employee_escrow" : "funded_balance", dir: "credit", amount: l.amount.toString() },
        ];
      }),
    );
    const rowsJson = JSON.stringify(lines.map((l) => ({ ref: l.ref, amount: l.amount.toString(), mode: l.held ? "held" : "sent", tx: txByN.get(l.n)!.id })));
    const incoming = JSON.stringify(lines.filter((l) => !l.held).map((l) => ({ account: l.to_account, amount: l.amount.toString() })));
    await Promise.all([
      tx`insert into ledger_entries (transaction_id, posting_key, line_no, account_id, bucket, direction, amount)
         select l.tx, l.key, l.line, l.account, l.bucket, l.dir, l.amount
           from jsonb_to_recordset(${ledger}::text::jsonb) as l(tx uuid, key text, line int, account uuid, bucket text, dir text, amount bigint)`,
      tx`insert into credit_batch_rows (batch_id, employee_ref, amount, mode, transaction_id)
         select ${batchId}, r.ref, r.amount, r.mode, r.tx
           from jsonb_to_recordset(${rowsJson}::text::jsonb) as r(ref uuid, amount bigint, mode text, tx uuid)`,
      tx`update balances set balance = balance - ${total.toString()} where account_id = ${i.orgId}`,
      tx`update wallets set spent_today = spent_today + ${total.toString()} where id = ${wallet.id}`,
      tx`update balances b set balance = b.balance + s.amount
           from (select account, sum(amount) as amount
                   from jsonb_to_recordset(${incoming}::text::jsonb) as x(account uuid, amount bigint) group by account) s
          where b.account_id = s.account`,
      tokenRows.length
        ? tx`update employees e set balance = e.balance + t.amount, claim_token_hash = t.hash, reminded_at = now()
               from jsonb_to_recordset(${JSON.stringify(tokenRows)}::text::jsonb) as t(id uuid, hash text, amount bigint)
              where e.id = t.id`
        : tx`select 1`,
    ]);
    return { kind: "ok", batch: batch!, notices, replayed: false };
  }).catch((err) => {
    if (err instanceof BatchRefused) return { kind: "error", status: 422, error: err.code, extra: err.extra } satisfies BatchOutcome;
    throw err;
  });
}

class BatchRefused extends Error {
  constructor(public code: string, public extra: Record<string, unknown>) {
    super(code);
  }
}

export type ClaimOutcome =
  | { kind: "ok"; amount: bigint; org_name: string; already: boolean }
  | { kind: "error"; status: 404 | 409 | 422; error: string };

/**
 * An employee claims with the emailed token: the employee row is linked to their (consumer) account and the held balance moves into
 * their funded balance. The token works once. Email addresses are never matched automatically.
 */
export async function claimCredit(sql: Sql, i: { accountId: string; token: string }): Promise<ClaimOutcome> {
  const hash = hashToken(i.token);
  return sql.begin(async (tx): Promise<ClaimOutcome> => {
    const [emp] = await tx<{ id: string; org_account_id: string; balance: bigint; employee_account_id: string | null; org_name: string }[]>`
      select e.id, e.org_account_id, e.balance, e.employee_account_id, o.name as org_name
        from employees e join accounts o on o.id = e.org_account_id
       where e.claim_token_hash = ${hash} for no key update of e`;
    if (!emp) return { kind: "error", status: 404, error: "invalid_token" };
    const [[bal], [acct], [wallet]] = await Promise.all([
      tx<{ balance: bigint }[]>`select balance from balances where account_id = ${i.accountId} for no key update`,
      tx<{ type: string; status: string }[]>`select type, status from accounts where id = ${i.accountId}`,
      tx<{ id: string; status: string }[]>`select id, status from wallets where account_id = ${i.accountId} and type = 'default'`,
    ]);
    if (!bal || !acct || !wallet) throw new Error("account rows missing");
    if (acct.type !== "C") return { kind: "error", status: 422, error: "consumer_account_required" };
    if (acct.status !== "active" || wallet.status !== "active") return { kind: "error", status: 422, error: "account_unavailable" };

    const amt = emp.balance;
    let line = 1;
    if (amt > 0n) {
      const [t] = await tx<{ id: string }[]>`
        insert into transactions (type, to_account_id, to_wallet_id, amount, status, idempotency_key, completed_at)
        values ('claim', ${i.accountId}, ${wallet.id}, ${amt.toString()}, 'completed', ${`claim:${emp.id}`}, now())
        returning id`;
      await Promise.all([
        tx`insert into ledger_entries (transaction_id, posting_key, line_no, account_id, bucket, direction, amount)
           values (${t!.id}, 'claim', ${line++}, null, 'employee_escrow', 'debit', ${amt.toString()}),
                  (${t!.id}, 'claim', ${line++}, ${i.accountId}, 'funded_balance', 'credit', ${amt.toString()})`,
        tx`update balances set balance = balance + ${amt.toString()} where account_id = ${i.accountId}`,
      ]);
    }
    await tx`update employees set employee_account_id = ${i.accountId}, balance = 0, claim_token_hash = null where id = ${emp.id}`;
    return { kind: "ok", amount: amt, org_name: emp.org_name, already: false };
  });
}
