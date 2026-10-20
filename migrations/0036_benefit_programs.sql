-- Benefit programs (docs/ORGANIZATIONS.md, "Benefit programs"): an organization chooses Fixed Benefits (a schedule that credits each
-- employee's fixed amount automatically) or Flexible Benefits (credit when and how much it wants, by CSV or API). One program row per
-- organization, created at sign-up (mode flexible, chosen_at NULL until the organization picks one in the portal).
--   employees.fixed_benefit: NULL, or the fixed amount (cents) the schedule credits that employee. Logically before created_at.
BEGIN;

ALTER TABLE employees ADD COLUMN fixed_benefit bigint CHECK (fixed_benefit IS NULL OR (fixed_benefit > 0 AND fixed_benefit <= 10000000));

CREATE TABLE benefit_programs (
  org_account_id  uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE RESTRICT,
  mode            text NOT NULL DEFAULT 'flexible' CHECK (mode IN ('fixed', 'flexible')),
  cadence         text CHECK (cadence IN ('monthly', 'weekly', 'biweekly')),
  day_of_month    smallint CHECK (day_of_month BETWEEN 1 AND 28),
  weekday         smallint CHECK (weekday BETWEEN 0 AND 6),            -- 0 = Sunday ... 6 = Saturday
  start_date      date,                                                -- biweekly: the first payment date; every 14 days from it
  next_run_date   date,                                                -- the next payment date (America/New_York); NULL when flexible
  warned_for      date,                                                -- the payment date the low-funds warning was already sent for
  last_attempt_at timestamptz,                                         -- claim for the scheduler (two crons, one run)
  chosen_at       timestamptz,                                         -- NULL until the organization has picked a mode
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (mode = 'flexible' OR (cadence IS NOT NULL AND next_run_date IS NOT NULL)),
  CHECK (cadence IS DISTINCT FROM 'monthly' OR day_of_month IS NOT NULL),
  CHECK (cadence IS NULL OR cadence = 'monthly' OR weekday IS NOT NULL),
  CHECK (cadence IS DISTINCT FROM 'biweekly' OR start_date IS NOT NULL)
);
CREATE INDEX benefit_programs_due_idx ON benefit_programs (next_run_date) WHERE mode = 'fixed';
CREATE TRIGGER benefit_programs_updated_at BEFORE UPDATE ON benefit_programs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Every existing organization gets its row (Flexible, not chosen yet: the portal asks on the next sign-in).
INSERT INTO benefit_programs (org_account_id) SELECT id FROM accounts WHERE type = 'O';

COMMIT;
