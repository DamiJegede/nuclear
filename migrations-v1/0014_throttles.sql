-- Rate limiting: one counter per key (e.g. "login:ada@example.com", "ip:signup:203.0.113.9",
-- "agent:<wallet id>") in a fixed window that starts at its first hit. Rows older than a day are
-- removed by the daily cron.
BEGIN;

CREATE TABLE throttles (
  key          text PRIMARY KEY,
  count        integer NOT NULL CHECK (count >= 0),
  window_start timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX throttles_window_idx ON throttles (window_start);

COMMIT;
