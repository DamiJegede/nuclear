-- A general key/value table for system-level state, replacing the one-row daily_reset table.
-- Keys in use: daily_reset_day (the New York date the daily counters were last reset) and
-- cron_last_run (when the daily job last ran).
BEGIN;

CREATE TABLE system (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER system_updated_at BEFORE UPDATE ON system FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO system (key, value) SELECT 'daily_reset_day', last_day::text FROM daily_reset;
DROP TABLE daily_reset;

COMMIT;
