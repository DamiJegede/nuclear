import { agentActivity } from "./adminLists";
import type { Sql } from "../db";
import { PROGRAM_TZ } from "./dates";
import { n } from "./money";

type Vol = { count: number; volume: number };

export type LiveStats = {
  as_of: string;
  /** Set when the numbers are the latest snapshot plus today's running estimate (see snapshots.ts); absent when computed live. */
  estimate?: { snapshot_date: string; snapshot_taken_at: string; today: string };
  scheme: {
    /** Net funded balance held across every account (the value the scheme owes to holders). */
    balance: number;
    consumer_balance: number;
    merchant_balance: number;
    /** Employers' wallets (account type O): money organizations hold to credit employees. */
    organization_balance: number;
    /** Merchants whose balance is negative (refunds ahead of sales), as a positive amount. */
    merchant_debt: number;
    /** Bank loads awaiting clearance: informational, not spendable. */
    pending: number;
    /** Approved payment credit currently drawn, and the total approved limit. */
    credit_outstanding: number;
    credit_limit: number;
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


/** The reconciliation checks (docs/SCHEME-V2.md, section 8). Each one reads every effect or every account, so they are computed on a schedule (see statsCache.ts), never per request. */
export type Reconciliation = {
    /** Account balances equal the sum of what the transactions did to them. */
    balances_match_ledger: boolean;
    balance_difference: number;
    /** Outstanding credit equals the sum of the credit drawn and repaid by transactions. */
    credit_matches_ledger: boolean;
    credit_difference: number;
    /** Conservation: the accounts' total change equals what crossed the edge of the scheme. */
    ledger_balanced: boolean;
    earmarks_within_balances: boolean;
    /** Every organization's escrow wallet equals what its unclaimed employees are owed. */
    escrow_matches_employees: boolean;
    /** Every Benefits and escrow wallet's balance equals the sum of its transactions. */
    benefits_match_ledger: boolean;
    /** Every consumer account's opening value and added-today counter on the balances row equal what the transactions say for today. */
    daily_caps_match_ledger: boolean;
    /** Every wallet's spending counter for today equals the sum of today's completed sends, payments and purchases from it. */
    wallet_counters_match: boolean;
  };

/** What the admin Overview shows: the live numbers and the last reconciliation, each with its own time. */
export type SystemStats = LiveStats & {
  reconciliation: Reconciliation;
  /** When the reconciliation was last computed. */
  reconciliation_checked_at: string;
  /** True when that is more than a day old (the nightly job did not run). */
  reconciliation_stale: boolean;
};

const v = (count: number, volume: bigint | number): Vol => ({ count, volume: n(BigInt(volume)) as number });

/** The reconciliation checks. Heavy (they read every effect), so callers cache the result, see statsCache.ts. */
export async function reconciliationStats(sql: Sql): Promise<Reconciliation> {
  const [bal] = await sql<Record<string, bigint>[]>`
    select coalesce(sum(b.balance), 0)::bigint as total, coalesce(sum(b.credit_spent), 0)::bigint as credit_spent
      from balances b join accounts a on a.id = b.account_id where a.type <> 'S'`;

  const [eff] = await sql<Record<string, bigint>[]>`
    select coalesce(sum(delta), 0)::bigint as funded, coalesce(sum(credit_delta), 0)::bigint as credit,
           (select coalesce(sum(case type when 'fund' then amount when 'fund_return' then -amount when 'purchase' then -amount
                                          when 'settle' then -amount when 'settle_return' then amount when 'collect' then amount
                                          when 'adjustment' then (case when (select type from wallets where id = from_wallet_id) = 'system' and (select type from wallets where id = to_wallet_id) <> 'system' then amount
                                                                       when (select type from wallets where id = to_wallet_id) = 'system' and (select type from wallets where id = from_wallet_id) <> 'system' then -amount else 0 end)
                                          else 0 end), 0)::bigint
              from transactions where status = 'completed') as edge,
           (select count(*)::int from wallets w where w.type in ('benefits', 'escrow')
              and w.balance <> coalesce((select sum(e.wdelta) from account_effects e where e.wallet_id = w.id), 0)) as wallets_off,
           (select count(*)::int from wallets w where w.type = 'escrow'
              and w.balance <> coalesce((select sum(e.balance) from employees e where e.org_account_id = w.account_id and e.employee_account_id is null), 0)) as escrow_off
      from account_effects`;

  const [caps] = await sql<{ n: number }[]>`
    with start as (select date_trunc('day', now() at time zone ${PROGRAM_TZ}) at time zone ${PROGRAM_TZ} as t),
    opened as (
      select e.account_id, sum(e.delta - e.wdelta) as v from account_effects e, start where e.created_at < start.t group by e.account_id),
    added as (
      select account_id, sum(amount) as v from (
        select tw.account_id, t.amount from transactions t join wallets tw on tw.id = t.to_wallet_id, start
         where t.status = 'completed' and t.created_at >= start.t
           and ((t.type = 'send' and tw.type <> 'benefits') or t.type = 'move')
        union all
        select f.account_id, f.amount from fundings f, start where f.released_at >= start.t) x group by account_id)
    select count(*)::int as n
      from balances b join accounts a on a.id = b.account_id
      left join opened o on o.account_id = b.account_id left join added d on d.account_id = b.account_id
     where a.type = 'C' and b.opening_day = (now() at time zone ${PROGRAM_TZ})::date
       and (b.ordinary_opening <> coalesce(o.v, 0) or b.added_today <> coalesce(d.v, 0))`;

  const [counters] = await sql<{ n: number }[]>`
    with start as (select date_trunc('day', now() at time zone ${PROGRAM_TZ}) at time zone ${PROGRAM_TZ} as t)
    select count(*)::int as n from wallets w, start
     where w.spent_day = program_today()
       and w.spent_today <> coalesce((select sum(t.amount) from transactions t
                                       where t.from_wallet_id = w.id and t.status = 'completed' and t.created_at >= start.t
                                         and t.type in ('send', 'pay', 'purchase', 'allocate')), 0)`;

  const [over] = await sql<{ n: number }[]>`
    select count(*)::int as n from (
      select w.account_id from wallets w join balances b on b.account_id = w.account_id
       where w.balance is not null group by w.account_id, b.balance having sum(w.balance) > b.balance) x`;

  const balanceDiff = Number((bal!.total as bigint) - (eff!.funded as bigint));
  const creditDiff = Number((bal!.credit_spent as bigint) - (eff!.credit as bigint));
  return {
    balances_match_ledger: balanceDiff === 0,
    balance_difference: balanceDiff,
    credit_matches_ledger: creditDiff === 0,
    credit_difference: creditDiff,
    // Conservation: what the accounts gained in total, less the credit extended to them, is exactly what crossed the edge of the scheme (loads in, purchases, payouts and collections).
    ledger_balanced: Number(eff!.funded) - Number(eff!.credit) === Number(eff!.edge),
    earmarks_within_balances: over!.n === 0,
    escrow_matches_employees: Number(eff!.escrow_off) === 0,
    benefits_match_ledger: Number(eff!.wallets_off) === 0,
    daily_caps_match_ledger: caps!.n === 0,
    wallet_counters_match: counters!.n === 0,
  };
}

/** Every check passed (the headline of the Overview and of the nightly job). */
export const reconciliationOk = (r: Reconciliation) => Object.entries(r).every(([k, v]) => typeof v !== "boolean" || v);

/** The live numbers: counts and sums over completed transactions. Still scans the transactions table, so callers cache it (statsCache.ts). */
export async function liveStats(sql: Sql): Promise<LiveStats> {
  const [bal] = await sql<Record<string, bigint>[]>`
    select coalesce(sum(b.balance), 0)::bigint as total,
           coalesce(sum(b.balance) filter (where a.type = 'C'), 0)::bigint as consumer,
           coalesce(sum(b.balance) filter (where a.type = 'B'), 0)::bigint as merchant,
           coalesce(sum(b.balance) filter (where a.type = 'O'), 0)::bigint as organization,
           coalesce(-sum(b.balance) filter (where a.type = 'B' and b.balance < 0), 0)::bigint as merchant_debt,
           coalesce(sum(b.balance_pending), 0)::bigint as pending,
           coalesce(sum(b.credit_spent), 0)::bigint as credit_spent,
           coalesce(sum(b.credit_limit), 0)::bigint as credit_limit
      from balances b join accounts a on a.id = b.account_id`;

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
    select (select count(distinct w.account_id) from transactions t join wallets w on w.id = t.to_wallet_id
             where t.type = 'pay' and t.status = 'completed')::int as transacting,
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
      (count(*) filter (where type = 'send' and created_at >= start.t))::int as t_sent_n,
      coalesce(sum(amount) filter (where type = 'send' and created_at >= start.t), 0)::bigint as t_sent_v,
      (count(*) filter (where type = 'pay' and tag_id is not null and created_at >= start.t))::int as t_tap_n,
      coalesce(sum(amount) filter (where type = 'pay' and tag_id is not null and created_at >= start.t), 0)::bigint as t_tap_v,
      (count(*) filter (where type = 'pay' and tag_id is null and created_at >= start.t))::int as t_app_n,
      coalesce(sum(amount) filter (where type = 'pay' and tag_id is null and created_at >= start.t), 0)::bigint as t_app_v
    from transactions, start
    where status = 'completed'`;

  const agents = await agentActivity(sql);
  const t = tx as Record<string, number | bigint>;
  const num = (k: string) => Number(t[k]);
  const sent = v(num("sent_n"), t.sent_v as bigint);
  const tapped = v(num("tap_n"), t.tap_v as bigint);
  const inApp = v(num("app_n"), t.app_v as bigint);

  return {
    as_of: new Date().toISOString(),
    scheme: {
      balance: Number(bal!.total),
      consumer_balance: Number(bal!.consumer),
      merchant_balance: Number(bal!.merchant),
      organization_balance: Number(bal!.organization),
      merchant_debt: Number(bal!.merchant_debt),
      pending: Number(bal!.pending),
      credit_outstanding: Number(bal!.credit_spent),
      credit_limit: Number(bal!.credit_limit),
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

/**
 * The full check of one account (level R3 of docs/SCHEME-V2.md, section 8): its balance and credit against everything its transactions did to it,
 * and each of its Benefits or escrow wallets against theirs. Reads that one account's effects only, through the wallet indexes. Nothing is changed:
 * a mismatch is fixed by an `adjustment` transaction.
 */
export async function accountCheck(sql: Sql, accountId: string) {
  const [a] = await sql<{ balance: bigint; credit_spent: bigint; effects: bigint; credit_effects: bigint }[]>`
    select b.balance, b.credit_spent, coalesce(sum(e.delta), 0)::bigint as effects, coalesce(sum(e.credit_delta), 0)::bigint as credit_effects
      from balances b left join account_effects e on e.account_id = b.account_id
     where b.account_id = ${accountId} group by b.balance, b.credit_spent`;
  if (!a) return null;
  const wallets = await sql<{ id: string; type: string; balance: bigint; effects: bigint }[]>`
    select w.id, w.type, w.balance, coalesce(sum(e.wdelta), 0)::bigint as effects
      from wallets w left join account_effects e on e.wallet_id = w.id
     where w.account_id = ${accountId} and w.type in ('benefits', 'escrow') group by w.id, w.type, w.balance order by w.id`;
  return {
    balance: Number(a.balance), effects: Number(a.effects), balance_matches: a.balance === a.effects,
    credit_spent: Number(a.credit_spent), credit_effects: Number(a.credit_effects), credit_matches: a.credit_spent === a.credit_effects,
    wallets: wallets.map((w) => ({ id: w.id, type: w.type, balance: Number(w.balance), effects: Number(w.effects), matches: w.balance === w.effects })),
  };
}
