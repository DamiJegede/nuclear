-- The program day (America/New_York) on which the daily counters (wallets.spent_today,
-- products.sold_today) were last reset. The reset runs when the first thing after midnight asks for it
-- (the cron or, if the cron was missed, the first money request), so a missed cron cannot leave
-- yesterday's limits in force.
BEGIN;

CREATE TABLE daily_reset (
  id       boolean PRIMARY KEY DEFAULT true CHECK (id),     -- one row
  last_day date NOT NULL
);
INSERT INTO daily_reset (id, last_day) VALUES (true, (now() AT TIME ZONE 'America/New_York')::date);

COMMIT;
