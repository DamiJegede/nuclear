import type { Sql } from "../db";
import { PROGRAM_TZ } from "./dates";
import type { Reconciliation } from "./stats";

type Big = bigint | null;
export type PrevDay = { balance_midnight: Big; credit_midnight: Big; wallets_midnight: Big; drift: bigint; drift_credit: bigint; drift_wallets: bigint; drift_conservation: bigint } | undefined;

/**
 * The nightly conservation check (docs/SCHEME-V2.md, section 8, level R1), written with the day's snapshot. It reads one calendar day of
 * transactions (a range on `created_at`, the pass the snapshot already makes), never history:
 *
 *   - the change in total balances between two midnights must equal what that day's completed transactions did to balances;
 *   - the same for credit drawn, and for the balances of the Benefits and escrow wallets;
 *   - conservation: the day's effects, less the credit extended, equal what crossed the edge of the scheme (loads in; purchases, payouts and
 *     collections out).
 *
 * A midnight balance is derived, not read: the balances now, minus the effects of everything created since that midnight (a few seconds of
 * rows, because the job runs at 00:01 New York time). Each night's gap is added to a running `drift`, so a one-off error stays red every
 * night until an `adjustment` transaction corrects it. Without a previous snapshot there is nothing to compare, so the drift starts at 0 (the
 * full check, Run Check, is the baseline). Nothing is corrected automatically.
 */
export async function nightlyCheck(sql: Sql, date: string, prev: PrevDay) {
  const [e] = await sql<Record<string, bigint | null>[]>`
    with b as (select (${date}::date + 1)::timestamp at time zone ${PROGRAM_TZ} as e, (${date}::date)::timestamp at time zone ${PROGRAM_TZ} as s)
    select coalesce(sum(x.delta) filter (where x.created_at < b.e), 0)::bigint as day_delta,
           coalesce(sum(x.credit_delta) filter (where x.created_at < b.e), 0)::bigint as day_credit,
           coalesce(sum(x.wdelta) filter (where x.created_at < b.e), 0)::bigint as day_wallets,
           coalesce(sum(x.delta) filter (where x.created_at >= b.e), 0)::bigint as after_delta,
           coalesce(sum(x.credit_delta) filter (where x.created_at >= b.e), 0)::bigint as after_credit,
           coalesce(sum(x.wdelta) filter (where x.created_at >= b.e), 0)::bigint as after_wallets
      from account_effects x, b where x.created_at >= b.s`;
  const [edge] = await sql<{ flows: bigint }[]>`
    with b as (select (${date}::date)::timestamp at time zone ${PROGRAM_TZ} as s, (${date}::date + 1)::timestamp at time zone ${PROGRAM_TZ} as e)
    select coalesce(sum(case t.type when 'fund' then t.amount when 'fund_return' then -t.amount when 'purchase' then -t.amount
                                    when 'settle' then -t.amount when 'collect_return' then -t.amount when 'settle_return' then t.amount when 'collect' then t.amount
                                    when 'adjustment' then (case when fw.type = 'system' and tw.type <> 'system' then t.amount
                                                                 when tw.type = 'system' and fw.type <> 'system' then -t.amount else 0 end)
                                    else 0 end), 0)::bigint as flows
      from transactions t join wallets fw on fw.id = t.from_wallet_id join wallets tw on tw.id = t.to_wallet_id, b
     where t.status = 'completed' and t.created_at >= b.s and t.created_at < b.e`;
  const [now] = await sql<Record<string, bigint>[]>`
    select (select coalesce(sum(b.balance), 0) from balances b join accounts a on a.id = b.account_id where a.type <> 'S')::bigint as balance,
           (select coalesce(sum(b.credit_spent), 0) from balances b join accounts a on a.id = b.account_id where a.type <> 'S')::bigint as credit,
           (select coalesce(sum(w.balance), 0) from wallets w where w.type in ('benefits', 'escrow'))::bigint as wallets`;
  const [small] = await sql<{ escrow_off: number; over: number }[]>`
    select (select count(*)::int from wallets w where w.type = 'escrow'
              and w.balance <> coalesce((select sum(m.balance) from employees m where m.org_account_id = w.account_id and m.employee_account_id is null), 0)) as escrow_off,
           (select count(*)::int from (select w.account_id from wallets w join balances b on b.account_id = w.account_id
                                        where w.balance is not null group by w.account_id, b.balance having sum(w.balance) > b.balance) x) as over`;

  const balanceMidnight = now!.balance! - e!.after_delta!;
  const creditMidnight = now!.credit! - e!.after_credit!;
  const walletsMidnight = now!.wallets! - e!.after_wallets!;
  const gapBalance = prev?.balance_midnight != null ? balanceMidnight - prev.balance_midnight - e!.day_delta! : 0n;
  const gapCredit = prev?.credit_midnight != null ? creditMidnight - prev.credit_midnight - e!.day_credit! : 0n;
  const gapWallets = prev?.wallets_midnight != null ? walletsMidnight - prev.wallets_midnight - e!.day_wallets! : 0n;
  const gapConservation = e!.day_delta! - e!.day_credit! - edge!.flows;
  const drift = (prev?.drift ?? 0n) + gapBalance;
  const driftCredit = (prev?.drift_credit ?? 0n) + gapCredit;
  const driftWallets = (prev?.drift_wallets ?? 0n) + gapWallets;
  const driftConservation = (prev?.drift_conservation ?? 0n) + gapConservation;

  // The same keys the Overview shows; the checks that only make sense for a day in progress (daily caps, wallet counters) are true here and run in Run Check.
  const reconciliation: Reconciliation = {
    balances_match_ledger: drift === 0n, balance_difference: Number(drift),
    credit_matches_ledger: driftCredit === 0n, credit_difference: Number(driftCredit),
    ledger_balanced: driftConservation === 0n,
    earmarks_within_balances: small!.over === 0,
    escrow_matches_employees: small!.escrow_off === 0,
    benefits_match_ledger: driftWallets === 0n,
    daily_caps_match_ledger: true,
    wallet_counters_match: true,
  };
  return {
    columns: {
      balance_midnight: balanceMidnight, credit_midnight: creditMidnight, wallets_midnight: walletsMidnight,
      effects_delta: e!.day_delta!, effects_credit: e!.day_credit!, effects_wallets: e!.day_wallets!, edge_flows: edge!.flows,
      drift, drift_credit: driftCredit, drift_wallets: driftWallets, drift_conservation: driftConservation,
    },
    reconciliation,
    reconciled: Object.values(reconciliation).every((v) => typeof v !== "boolean" || v),
  };
}
