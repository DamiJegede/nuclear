-- One record for every benefits run, whoever starts it (the portal's CSV, the Benefits API, and later the scheduler): benefit_runs replaces
-- credit_batches, benefit_run_rows replaces credit_batch_rows (docs/ORGANIZATIONS.md). Existing rows are copied with their ids, then the old
-- tables are dropped. A scheduled run that is waiting for funds or missed has credited nothing yet, so sent + held = total applies only once credited.
BEGIN;

CREATE TABLE benefit_runs (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  source          text NOT NULL DEFAULT 'csv' CHECK (source IN ('csv', 'api', 'schedule')),
  run_date        date NOT NULL,                                  -- the program day (America/New_York) the run is for
  status          text NOT NULL DEFAULT 'credited' CHECK (status IN ('credited', 'waiting_for_funds', 'missed')),
  idempotency_key text NOT NULL,
  row_count       integer NOT NULL CHECK (row_count > 0),
  total           bigint NOT NULL CHECK (total > 0),
  sent            bigint NOT NULL DEFAULT 0 CHECK (sent >= 0),    -- credited straight into employees' Benefits wallets
  held            bigint NOT NULL DEFAULT 0 CHECK (held >= 0),    -- held for employees who have not claimed
  failure_code    text,
  attempts        integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_account_id, idempotency_key),
  CHECK (status <> 'credited' OR sent + held = total)
);
CREATE INDEX benefit_runs_org_idx ON benefit_runs (org_account_id, created_at DESC, id DESC);
CREATE TRIGGER benefit_runs_updated_at BEFORE UPDATE ON benefit_runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE benefit_run_rows (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  run_id         uuid NOT NULL REFERENCES benefit_runs (id) ON DELETE RESTRICT,
  employee_ref   uuid NOT NULL REFERENCES employees (id) ON DELETE RESTRICT,
  amount         bigint NOT NULL CHECK (amount > 0),
  mode           text NOT NULL CHECK (mode IN ('sent', 'held')),
  transaction_id uuid NOT NULL UNIQUE REFERENCES transactions (id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX benefit_run_rows_run_idx ON benefit_run_rows (run_id, id);
CREATE INDEX benefit_run_rows_employee_idx ON benefit_run_rows (employee_ref, id DESC);

INSERT INTO benefit_runs (id, org_account_id, source, run_date, status, idempotency_key, row_count, total, sent, held, created_at, updated_at)
  SELECT id, org_account_id, 'csv', (created_at AT TIME ZONE 'America/New_York')::date, 'credited', idempotency_key, row_count, total, sent, held, created_at, created_at
    FROM credit_batches;
INSERT INTO benefit_run_rows (id, run_id, employee_ref, amount, mode, transaction_id, created_at)
  SELECT id, batch_id, employee_ref, amount, mode, transaction_id, created_at FROM credit_batch_rows;

DROP TABLE credit_batch_rows;
DROP TABLE credit_batches;

COMMIT;
