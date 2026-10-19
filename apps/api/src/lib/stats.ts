import { agentActivity } from "./adminLists";
import type { Sql } from "../db";
import { PROGRAM_TZ } from "./ledger";
import { n } from "./money";

type Vol = { count: number; volume: number };

export type SystemStats = {
  as_of: string;
  scheme: {
    /** Net funded balance held across every account (the value the scheme owes to holders). */
    balance: number;
    consumer_balance: number;
    merchant_balance: number;
    /** Merchants whose balance is negative (refunds ahead of sales), as a positive amount. */
    merchant_debt: number;
    /** Bank loads awaiting clearance: informational, not spendable. */
    pending: number;
    /** Approved payment credit currently drawn, and the total approved limit. */
    credit_outstanding: number;
    credit_limit: number;
  };
  reconciliation: {
    /** Account balances equal the ledger's funded-balance postings. */
    balances_match_ledger: boolean;
    balance_difference: number;
    /** Outstanding credit equals the ledger's credit-receivable postings. */
    credit_matches_ledger: boolean;
    credit_difference: number;
    /** Every posting event balances: total debits equal total credits. */
    ledger_balanced: boolean;
    earmarks_within_balances: boolean;
    /** Money held for employees who have not claimed (ledger bucket employee_escrow) equals the sum of employees.balance. */
    escrow_matches_employees: boolean;
  };
  users: { total: number; active: number; suspended: number; closed: number; new_today: number; new_7d: number; new_30d: number; wallets: number };
  merchants: { total: number; active: number; transacting: number; terminals: number };
  payments: {
    /** Wallet-to-wallet sends. */
    sent: Vol;
    /** Payments by tapping a band or card. */
    tapped: Vol;
    /** Payments confirmed in the customer's app. */
    in_app: Vol;
    agents: Vol;
    /** tapped + in_app: money paid to merchants. */
    merchant_payments: Vol;
    /** sent + tapped + in_app. */
    total: Vol;
    refunds: Vol;
    loaded: Vol;
    /** Completed since 00:00 America/New_York. */
    today: { sent: Vol; tapped: Vol; in_app: Vol; agents: Vol };
  };
};

const v = (count: number, volume: bigint | number): Vol => ({ count, volume: n(BigInt(volume)) as number });

/** A point-in-time view of the whole scheme. Counts and sums over completed transactions only. */
export async function systemStats(sql: Sql): Promise<SystemStats> {
  const [bal] = await sql<Record<string, bigint>[]>`
    select coalesce(sum(b.balance), 0)::bigint as total,
           coalesce(sum(b.balance) filter (where a.type = 'C'), 0)::bigint as consumer,
           coalesce(sum(b.balance) filter (where a.type = 'B'), 0)::bigint as merchant,
           coalesce(-sum(b.balance) filter (where a.type = 'B' and b.balance < 0), 0)::bigint as merchant_debt,
           coalesce(sum(b.balance_pending), 0)::bigint as pending,
           coalesce(sum(b.credit_spent), 0)::bigint as credit_spent,
           coalesce(sum(b.credit_limit), 0)::bigint as credit_limit
      from balances b join accounts a on a.id = b.account_id`;

  const [led] = await sql<Record<string, bigint>[]>`
    select coalesce(sum(case when bucket = 'funded_balance' and account_id is not null
                             then case direction when 'credit' then amount else -amount end end), 0)::bigint as funded,
           coalesce(sum(case when bucket = 'credit_receivable' and account_id is not null
                             then case direction when 'debit' then amount else -amount end end), 0)::bigint as credit,
           coalesce(sum(case direction when 'debit' then amount else -amount end), 0)::bigint as net,
           coalesce(sum(case when bucket = 'employee_escrow' then case direction when 'credit' then amount else -amount end end), 0)::bigint as escrow,
           (select coalesce(sum(balance), 0)::bigint from employees) as employees_held
      from ledger_entries`;

  const [over] = await sql<{ n: number }[]>`
    select count(*)::int as n from (
      select w.account_id from wallets w join balances b on b.account_id = w.account_id
       where w.balance is not null group by w.account_id, b.balance having sum(w.balance) > b.balance) x`;

  // Wallets of consumer accounts that are not closed (default, person and agent wallets).
  const [wal] = await sql<{ n: number }[]>`
    select count(*)::int as n from wallets w join accounts a on a.id = w.account_id
     where a.type = 'C' and w.status <> 'closed'`;

  const [acc] = await sql<Record<string, number>[]>`
    select (count(*) filter (where type = 'C'))::int as users,
           (count(*) filter (where type = 'C' and status = 'active'))::int as users_active,
           (count(*) filter (where type = 'C' and status = 'suspended'))::int as users_suspended,
           (count(*) filter (where type = 'C' and status = 'closed'))::int as users_closed,
           (count(*) filter (where type = 'C' and created_at >= (date_trunc('day', now() at time zone ${PROGRAM_TZ}) at time zone ${PROGRAM_TZ})))::int as users_today,
           (count(*) filter (where type = 'C' and created_at >= now() - interval '7 days'))::int as users_7d,
           (count(*) filter (where type = 'C' and created_at >= now() - interval '30 days'))::int as users_30d,
           (count(*) filter (where type = 'B'))::int as merchants,
           (count(*) filter (where type = 'B' and status = 'active'))::int as merchants_active
      from accounts`;

  const [extra] = await sql<Record<string, number>[]>`
    select (select count(distinct to_account_id) from transactions
             where type = 'pay' and status = 'completed')::int as transacting,
           (select count(*) from terminals)::int as terminals`;

  const [tx] = await sql<Record<string, bigint | number>[]>`
    with start as (
      select date_trunc('day', now() at time zone ${PROGRAM_TZ}) at time zone ${PROGRAM_TZ} as t
    )
    select
      (count(*) filter (where type = 'send'))::int as sent_n,
      coalesce(sum(amount) filter (where type = 'send'), 0)::bigint as sent_v,
      (count(*) filter (where type = 'pay' and tag_id is not null))::int as tap_n,
      coalesce(sum(amount) filter (where type = 'pay' and tag_id is not null), 0)::bigint as tap_v,
      (count(*) filter (where type = 'pay' and tag_id is null))::int as app_n,
      coalesce(sum(amount) filter (where type = 'pay' and tag_id is null), 0)::bigint as app_v,
      (count(*) filter (where type = 'refund'))::int as ref_n,
      coalesce(sum(amount) filter (where type = 'refund'), 0)::bigint as ref_v,
      (count(*) filter (where type = 'fund'))::int as fund_n,
      coalesce(sum(amount) filter (where type = 'fund'), 0)::bigint as fund_v,
      (count(*) filter (where type = 'send' and completed_at >= start.t))::int as t_sent_n,
      coalesce(sum(amount) filter (where type = 'send' and completed_at >= start.t), 0)::bigint as t_sent_v,
      (count(*) filter (where type = 'pay' and tag_id is not null and completed_at >= start.t))::int as t_tap_n,
      coalesce(sum(amount) filter (where type = 'pay' and tag_id is not null and completed_at >= start.t), 0)::bigint as t_tap_v,
      (count(*) filter (where type = 'pay' and tag_id is null and completed_at >= start.t))::int as t_app_n,
      coalesce(sum(amount) filter (where type = 'pay' and tag_id is null and completed_at >= start.t), 0)::bigint as t_app_v
    from transactions, start
    where status = 'completed'`;

  const agents = await agentActivity(sql);
  const t = tx as Record<string, number | bigint>;
  const num = (k: string) => Number(t[k]);
  const sent = v(num("sent_n"), t.sent_v as bigint);
  const tapped = v(num("tap_n"), t.tap_v as bigint);
  const inApp = v(num("app_n"), t.app_v as bigint);

  const balanceDiff = Number((bal!.total as bigint) - (led!.funded as bigint));
  const creditDiff = Number((bal!.credit_spent as bigint) - (led!.credit as bigint));

  return {
    as_of: new Date().toISOString(),
    scheme: {
      balance: Number(bal!.total),
      consumer_balance: Number(bal!.consumer),
      merchant_balance: Number(bal!.merchant),
      merchant_debt: Number(bal!.merchant_debt),
      pending: Number(bal!.pending),
      credit_outstanding: Number(bal!.credit_spent),
      credit_limit: Number(bal!.credit_limit),
    },
    reconciliation: {
      balances_match_ledger: balanceDiff === 0,
      balance_difference: balanceDiff,
      credit_matches_ledger: creditDiff === 0,
      credit_difference: creditDiff,
      ledger_balanced: Number(led!.net) === 0,
      earmarks_within_balances: over!.n === 0,
      escrow_matches_employees: Number(led!.escrow) === Number(led!.employees_held),
    },
    users: {
      total: acc!.users!, active: acc!.users_active!, suspended: acc!.users_suspended!,
      closed: acc!.users_closed!, new_today: acc!.users_today!, new_7d: acc!.users_7d!, new_30d: acc!.users_30d!,
      wallets: wal!.n,
    },
    merchants: {
      total: acc!.merchants!, active: acc!.merchants_active!,
      transacting: extra!.transacting!, terminals: extra!.terminals!,
    },
    payments: {
      sent,
      tapped,
      in_app: inApp,
      agents: agents.lifetime,   // memo: sends and payments from agent wallets, already counted above
      merchant_payments: v(tapped.count + inApp.count, BigInt(tapped.volume) + BigInt(inApp.volume)),
      total: v(sent.count + tapped.count + inApp.count, BigInt(sent.volume) + BigInt(tapped.volume) + BigInt(inApp.volume)),
      refunds: v(num("ref_n"), t.ref_v as bigint),
      loaded: v(num("fund_n"), t.fund_v as bigint),
      today: {
        sent: v(num("t_sent_n"), t.t_sent_v as bigint),
        tapped: v(num("t_tap_n"), t.t_tap_v as bigint),
        in_app: v(num("t_app_n"), t.t_app_v as bigint),
        agents: agents.today,
      },
    },
  };
}
