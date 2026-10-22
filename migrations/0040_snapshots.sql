-- Daily snapshots of the scheme (docs/TABLES.md, "snapshots"): one exact row per program day (America/New_York), written by the nightly job from the
-- transactions of that day. The admin Overview shows the latest snapshot plus today's running estimate (Durable Object counters), so it never scans
-- history. Money is bigint cents; counts are bigint. Lifetime columns are cumulative as of the end of the day (previous row + the day).
BEGIN;

CREATE TABLE snapshots (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  snapshot_date date NOT NULL UNIQUE,                       -- the program day this row is exact for
  taken_at      timestamptz NOT NULL DEFAULT now(),         -- when the job ran (gauges below are as of then)
  -- money held (gauges)
  scheme_balance                    bigint NOT NULL DEFAULT 0,  -- net funded balance held across every account
  consumer_balance                  bigint NOT NULL DEFAULT 0,
  merchant_balance                  bigint NOT NULL DEFAULT 0,
  organization_balance              bigint NOT NULL DEFAULT 0,  -- employer wallets
  merchant_debt                     bigint NOT NULL DEFAULT 0,  -- merchants below zero, positive
  pending_loads                     bigint NOT NULL DEFAULT 0,
  credit_outstanding                bigint NOT NULL DEFAULT 0,
  credit_limit                      bigint NOT NULL DEFAULT 0,
  benefits_wallet_balance           bigint NOT NULL DEFAULT 0,  -- sum of Benefits wallets (inside the balances above)
  employee_escrow                   bigint NOT NULL DEFAULT 0,  -- held for employees who have not claimed
  -- people (gauges)
  users_total                       bigint NOT NULL DEFAULT 0,
  users_active                      bigint NOT NULL DEFAULT 0,
  users_suspended                   bigint NOT NULL DEFAULT 0,
  users_closed                      bigint NOT NULL DEFAULT 0,
  wallets                           bigint NOT NULL DEFAULT 0,
  merchants_total                   bigint NOT NULL DEFAULT 0,
  merchants_active                  bigint NOT NULL DEFAULT 0,  -- approved and not suspended
  merchants_transacting             bigint NOT NULL DEFAULT 0,  -- took at least one payment in the 30 days to the end of the day
  terminals                         bigint NOT NULL DEFAULT 0,
  organizations_total               bigint NOT NULL DEFAULT 0,
  organizations_active              bigint NOT NULL DEFAULT 0,
  employees_total                   bigint NOT NULL DEFAULT 0,  -- active employees
  employees_claimed                 bigint NOT NULL DEFAULT 0,
  employees_unclaimed               bigint NOT NULL DEFAULT 0,
  -- that day
  users_new                         bigint NOT NULL DEFAULT 0,
  merchants_new                     bigint NOT NULL DEFAULT 0,
  organizations_new                 bigint NOT NULL DEFAULT 0,
  employees_added                   bigint NOT NULL DEFAULT 0,
  merchants_paid                    bigint NOT NULL DEFAULT 0,  -- merchants with at least one payment that day
  sends_count                       bigint NOT NULL DEFAULT 0,  -- wallet to wallet
  sends_volume                      bigint NOT NULL DEFAULT 0,
  taps_count                        bigint NOT NULL DEFAULT 0,  -- pay with a tag or pass
  taps_volume                       bigint NOT NULL DEFAULT 0,
  in_app_count                      bigint NOT NULL DEFAULT 0,  -- customer-confirmed pay
  in_app_volume                     bigint NOT NULL DEFAULT 0,
  agents_count                      bigint NOT NULL DEFAULT 0,  -- memo: sends and pays from agent wallets, already counted above
  agents_volume                     bigint NOT NULL DEFAULT 0,
  refunds_count                     bigint NOT NULL DEFAULT 0,
  refunds_volume                    bigint NOT NULL DEFAULT 0,
  loads_count                       bigint NOT NULL DEFAULT 0,  -- bank loads released
  loads_volume                      bigint NOT NULL DEFAULT 0,
  purchases_count                   bigint NOT NULL DEFAULT 0,  -- store purchases (bands, cards, merchandise)
  purchases_volume                  bigint NOT NULL DEFAULT 0,
  payouts_count                     bigint NOT NULL DEFAULT 0,  -- settlement payouts completed
  payouts_volume                    bigint NOT NULL DEFAULT 0,
  collections_count                 bigint NOT NULL DEFAULT 0,  -- settlement collections completed
  collections_volume                bigint NOT NULL DEFAULT 0,
  claims_count                      bigint NOT NULL DEFAULT 0,  -- employees claiming held employer credit
  claims_volume                     bigint NOT NULL DEFAULT 0,
  benefit_runs_count                bigint NOT NULL DEFAULT 0,  -- credited runs created that day (csv, api, schedule)
  benefit_credited                  bigint NOT NULL DEFAULT 0,  -- total of those runs
  benefit_sent                      bigint NOT NULL DEFAULT 0,  -- straight into Benefits wallets
  benefit_held                      bigint NOT NULL DEFAULT 0,  -- held for employees who have not claimed
  benefit_runs_missed               bigint NOT NULL DEFAULT 0,  -- scheduled runs marked missed that day
  -- lifetime, as of the end of the day
  lifetime_sends_count              bigint NOT NULL DEFAULT 0,
  lifetime_sends_volume             bigint NOT NULL DEFAULT 0,
  lifetime_taps_count               bigint NOT NULL DEFAULT 0,
  lifetime_taps_volume              bigint NOT NULL DEFAULT 0,
  lifetime_in_app_count             bigint NOT NULL DEFAULT 0,
  lifetime_in_app_volume            bigint NOT NULL DEFAULT 0,
  lifetime_refunds_count            bigint NOT NULL DEFAULT 0,
  lifetime_refunds_volume           bigint NOT NULL DEFAULT 0,
  lifetime_loads_count              bigint NOT NULL DEFAULT 0,
  lifetime_loads_volume             bigint NOT NULL DEFAULT 0,
  lifetime_purchases_count          bigint NOT NULL DEFAULT 0,
  lifetime_purchases_volume         bigint NOT NULL DEFAULT 0,
  lifetime_payouts_count            bigint NOT NULL DEFAULT 0,
  lifetime_payouts_volume           bigint NOT NULL DEFAULT 0,
  lifetime_collections_count        bigint NOT NULL DEFAULT 0,
  lifetime_collections_volume       bigint NOT NULL DEFAULT 0,
  lifetime_claims_count             bigint NOT NULL DEFAULT 0,
  lifetime_claims_volume            bigint NOT NULL DEFAULT 0,
  lifetime_agents_count             bigint NOT NULL DEFAULT 0,  -- memo, like agents_count
  lifetime_agents_volume            bigint NOT NULL DEFAULT 0,
  lifetime_benefit_credited         bigint NOT NULL DEFAULT 0,
  lifetime_benefit_runs_count       bigint NOT NULL DEFAULT 0,
  -- the ledger checks of the nightly run
  reconciled                        boolean,                       -- NULL until the check has run for this day
  reconciliation                    jsonb,
  created_at                        timestamptz NOT NULL DEFAULT now()
);

-- The day's activity is a range read of completed transactions; this index keeps it from scanning the table. (Entries are added when a
-- transaction completes, so it costs one index insert per completed money movement.)
CREATE INDEX transactions_completed_at_idx ON transactions (completed_at) WHERE status = 'completed';

COMMIT;
