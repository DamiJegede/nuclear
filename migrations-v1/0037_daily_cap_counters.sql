-- One daily-value rule for every ordinary addition (docs/ORGANIZATIONS.md, BALANCE-POLICY.md): headroom = cap - ordinary_opening - added_today -
-- balance_pending, for consumer accounts only. The numbers live on the balances row every money movement already locks.
--   ordinary_opening: ordinary funded money (balance minus Benefits wallets) at the start of the program day (America/New_York).
--   opening_day:      the program day those numbers are for (rolled once a day by ensureDay; a stale row rolls itself when next locked).
--   added_today:      ordinary money added today: released bank loads, incoming sends, Benefits-to-ordinary moves. Never refunds, claims or
--                     employer credits into Benefits wallets; spending, sending and reversals never reduce it.
-- Logically after balance_pending (physically last today).
BEGIN;

ALTER TABLE balances ADD COLUMN ordinary_opening bigint NOT NULL DEFAULT 0;
ALTER TABLE balances ADD COLUMN opening_day date NOT NULL DEFAULT ((now() AT TIME ZONE 'America/New_York')::date);
ALTER TABLE balances ADD COLUMN added_today bigint NOT NULL DEFAULT 0 CHECK (added_today >= 0);

-- Backfill consumer accounts with today's real numbers, from the ledger and transactions.
WITH start AS (SELECT date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York' AS t)
UPDATE balances b SET
  ordinary_opening = COALESCE((SELECT SUM(CASE WHEN l.wallet_id IS NULL THEN (CASE l.direction WHEN 'credit' THEN l.amount ELSE -l.amount END) ELSE 0 END)
                                 FROM ledger_entries l, start
                                WHERE l.account_id = b.account_id AND l.bucket = 'funded_balance' AND l.created_at < start.t), 0),
  added_today = COALESCE((SELECT SUM(t.amount) FROM transactions t, start
                           WHERE t.to_account_id = b.account_id AND t.status = 'completed' AND t.completed_at >= start.t
                             AND ((t.type = 'send' AND NOT EXISTS (SELECT 1 FROM wallets w WHERE w.id = t.to_wallet_id AND w.type = 'benefits')) OR t.type = 'move')), 0)
              + COALESCE((SELECT SUM(f.amount) FROM fundings f, start WHERE f.account_id = b.account_id AND f.released_at >= start.t), 0),
  opening_day = (now() AT TIME ZONE 'America/New_York')::date
 FROM accounts a
WHERE a.id = b.account_id AND a.type = 'C';

COMMIT;
