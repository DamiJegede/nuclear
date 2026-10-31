-- merchant_snapshots: one final row per merchant per program day (America/New_York) with that day's payment, refund and tip counts and volumes, so the
-- merchant transaction list reads its counts and totals from a few rows per day instead of scanning every transaction of the period. Written by the
-- nightly cron (app_merchant_snapshot) for the day that just ended; the days before this migration are backfilled below. Only days with activity have a row.
-- Refund REQUESTS (pending or rejected, the `refunds` table) are not in it: a pending request changes state, so they are always counted live.

CREATE TABLE merchant_snapshots (
  id uuid DEFAULT uuidv7() NOT NULL,
  merchant_account_id uuid NOT NULL,
  snapshot_date date NOT NULL,
  pay_n bigint NOT NULL DEFAULT 0,          -- payments into the merchant's wallets, completed or declined
  pay_done_n bigint NOT NULL DEFAULT 0,     -- completed payments
  pay_v bigint NOT NULL DEFAULT 0,          -- their volume (tips included)
  refund_n bigint NOT NULL DEFAULT 0,       -- refund transactions out of the merchant's wallets, completed or declined
  refund_done_n bigint NOT NULL DEFAULT 0,
  refund_v bigint NOT NULL DEFAULT 0,
  tips_n bigint NOT NULL DEFAULT 0,         -- payments that carried a tip
  tips_v bigint NOT NULL DEFAULT 0,         -- tips given that day, net of tips returned with refunds
  taken_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merchant_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT merchant_snapshots_day_key UNIQUE (merchant_account_id, snapshot_date),
  CONSTRAINT merchant_snapshots_account_fkey FOREIGN KEY (merchant_account_id) REFERENCES accounts(id) ON DELETE RESTRICT
);

CREATE FUNCTION merchant_snapshots_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a merchant snapshot is final';
END;
$$;
CREATE TRIGGER merchant_snapshots_final BEFORE UPDATE OR DELETE ON merchant_snapshots FOR EACH ROW EXECUTE FUNCTION merchant_snapshots_final();

-- Open and rejected refund requests of one merchant (the pending-only index cannot serve rejected ones).
CREATE INDEX refunds_open_idx ON refunds (merchant_account_id, created_at DESC, id DESC) WHERE status <> 'approved';

-- Writes the days from..to (inclusive program dates); a day already written is left alone. Returns the number of rows written.
CREATE FUNCTION app_merchant_snapshot(p_from date, p_to date) RETURNS bigint LANGUAGE sql AS $$
  WITH rng AS (
    SELECT (p_from::timestamp AT TIME ZONE 'America/New_York') AS lo, ((p_to + 1)::timestamp AT TIME ZONE 'America/New_York') AS hi
  ), ev AS (
    SELECT tw.account_id AS m, (t.created_at AT TIME ZONE 'America/New_York')::date AS d,
           1 AS pay_n, (t.status = 'completed')::int AS pay_done_n, CASE WHEN t.status = 'completed' THEN t.amount ELSE 0 END AS pay_v,
           0 AS refund_n, 0 AS refund_done_n, 0 AS refund_v, 0 AS tips_n, 0::bigint AS tips_v
      FROM transactions t JOIN wallets tw ON tw.id = t.to_wallet_id, rng
     WHERE t.type = 'pay' AND t.created_at >= rng.lo AND t.created_at < rng.hi
    UNION ALL
    SELECT fw.account_id, (t.created_at AT TIME ZONE 'America/New_York')::date,
           0, 0, 0, 1, (t.status = 'completed')::int, CASE WHEN t.status = 'completed' THEN t.amount ELSE 0 END, 0, 0
      FROM transactions t JOIN wallets fw ON fw.id = t.from_wallet_id, rng
     WHERE t.type = 'refund' AND t.created_at >= rng.lo AND t.created_at < rng.hi
    UNION ALL
    SELECT tp.account_id, (tp.created_at AT TIME ZONE 'America/New_York')::date, 0, 0, 0, 0, 0, 0, (tp.amount > 0)::int, tp.amount
      FROM tips tp, rng
     WHERE tp.created_at >= rng.lo AND tp.created_at < rng.hi
  ), ins AS (
    INSERT INTO merchant_snapshots (merchant_account_id, snapshot_date, pay_n, pay_done_n, pay_v, refund_n, refund_done_n, refund_v, tips_n, tips_v)
    SELECT m, d, sum(pay_n), sum(pay_done_n), sum(pay_v), sum(refund_n), sum(refund_done_n), sum(refund_v), sum(tips_n), sum(tips_v)
      FROM ev GROUP BY m, d
    ON CONFLICT (merchant_account_id, snapshot_date) DO NOTHING
    RETURNING 1
  ) SELECT count(*) FROM ins;
$$;

-- Backfill every finished day before today, then mark how far the snapshots go (the reader uses them up to this day and counts live after it).
SELECT app_merchant_snapshot(
  coalesce((SELECT (min(created_at) AT TIME ZONE 'America/New_York')::date FROM transactions), program_today()),
  program_today() - 1) WHERE program_today() - 1 >= coalesce((SELECT (min(created_at) AT TIME ZONE 'America/New_York')::date FROM transactions), program_today());
INSERT INTO system (key, value) VALUES ('merchant_snapshot_day', (program_today() - 1)::text)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now();
