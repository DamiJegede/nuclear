-- One row per settlement run (the daily cutoff). The run claims its cutoff date (unique), records the net totals it processed and
-- the bank batch reference, and each per-merchant `settle` transaction points back to it. The settlement job itself is not built yet.
BEGIN;

CREATE TABLE settlements (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  cutoff_date        date NOT NULL UNIQUE,                         -- the program date (America/New_York) being settled; one run per date
  cutoff_at          timestamptz NOT NULL,                         -- the exact cutoff instant the nets were computed at (immutable)
  status             text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'submitted', 'completed', 'failed')),
  merchants          integer NOT NULL DEFAULT 0 CHECK (merchants >= 0),
  payout_total       bigint NOT NULL DEFAULT 0 CHECK (payout_total >= 0),       -- cents paid out to merchants' banks
  collection_total   bigint NOT NULL DEFAULT 0 CHECK (collection_total >= 0),   -- cents collected from merchants' banks
  provider_reference text,                                         -- the bank / ACH batch identifier
  failure_code       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);
CREATE TRIGGER settlements_updated_at BEFORE UPDATE ON settlements FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE transactions ADD COLUMN settlement_id uuid REFERENCES settlements (id) ON DELETE RESTRICT;
ALTER TABLE transactions ADD CONSTRAINT transactions_settlement_only CHECK (settlement_id IS NULL OR type = 'settle');
CREATE INDEX transactions_settlement_idx ON transactions (settlement_id) WHERE settlement_id IS NOT NULL;

COMMIT;
