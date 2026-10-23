-- Organizations (employers): a new account type 'O', employee records, credit batches, and the two transaction types that hold and release
-- employer credits for employees who have not claimed them (docs/ADOPTION-STRATEGY.md, docs/ORGANIZATIONS.md).
BEGIN;

ALTER TABLE accounts DROP CONSTRAINT accounts_type_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_type_check CHECK (type IN ('C', 'B', 'O'));

-- allocate: organization -> held for an employee (no destination account; the other side is employee_escrow).
-- claim:    held for an employee -> the employee's account (no source account; the source side is employee_escrow).
ALTER TABLE transactions DROP CONSTRAINT transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('fund', 'send', 'pay', 'settle', 'refund', 'adjustment', 'purchase', 'allocate', 'claim'));
ALTER TABLE transactions DROP CONSTRAINT transactions_endpoints_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_endpoints_check CHECK (CASE type
  WHEN 'fund' THEN from_account_id IS NOT NULL AND to_account_id IS NOT NULL
                   AND from_bank_account_id IS NOT NULL AND to_bank_account_id IS NULL
                   AND from_wallet_id IS NULL AND to_wallet_id IS NULL
  WHEN 'send' THEN from_account_id IS NOT NULL AND to_account_id IS NOT NULL
                   AND from_wallet_id IS NOT NULL AND to_wallet_id IS NOT NULL
                   AND from_bank_account_id IS NULL AND to_bank_account_id IS NULL
  WHEN 'pay' THEN from_account_id IS NOT NULL AND to_account_id IS NOT NULL
                  AND from_wallet_id IS NOT NULL AND to_wallet_id IS NULL
                  AND from_bank_account_id IS NULL AND to_bank_account_id IS NULL
  WHEN 'settle' THEN from_account_id IS NOT NULL AND to_account_id IS NOT NULL
                     AND from_wallet_id IS NULL AND to_wallet_id IS NULL
                     AND num_nonnulls(from_bank_account_id, to_bank_account_id) = 1
  WHEN 'refund' THEN from_account_id IS NOT NULL AND to_account_id IS NOT NULL
                     AND from_wallet_id IS NULL AND to_wallet_id IS NOT NULL
                     AND from_bank_account_id IS NULL AND to_bank_account_id IS NULL
                     AND related_transaction_id IS NOT NULL
  WHEN 'purchase' THEN from_account_id IS NOT NULL AND from_wallet_id IS NOT NULL
                       AND to_account_id IS NULL AND to_wallet_id IS NULL
                       AND from_bank_account_id IS NULL AND to_bank_account_id IS NULL
  WHEN 'allocate' THEN from_account_id IS NOT NULL AND from_wallet_id IS NOT NULL
                       AND to_account_id IS NULL AND to_wallet_id IS NULL
                       AND from_bank_account_id IS NULL AND to_bank_account_id IS NULL
  WHEN 'claim' THEN to_account_id IS NOT NULL AND to_wallet_id IS NOT NULL
                    AND from_account_id IS NULL AND from_wallet_id IS NULL
                    AND from_bank_account_id IS NULL AND to_bank_account_id IS NULL
  ELSE true  -- adjustment: endpoints to be defined
END);

-- employees: one row per person an organization credits. Created from the first CSV that mentions the employee_id. employee_account_id is
-- set when the person claims (links a consumer account). balance is money held for them while they have no account (ledger bucket
-- employee_escrow); it is 0 once claimed. claim_token_hash is the SHA-256 of the emailed token (the token itself is never stored).
CREATE TABLE employees (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  org_account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  employee_account_id uuid REFERENCES accounts (id) ON DELETE RESTRICT,
  employee_id         text NOT NULL CHECK (employee_id ~ '^[A-Za-z0-9]{1,64}$'),
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  email               text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  balance             bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
  claim_token_hash    text,
  reminded_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_account_id, employee_id),
  CHECK (employee_account_id IS NULL OR balance = 0),         -- held money exists only while unclaimed
  CHECK (employee_account_id IS NULL OR claim_token_hash IS NULL)
);
CREATE UNIQUE INDEX employees_claim_token_key ON employees (claim_token_hash) WHERE claim_token_hash IS NOT NULL;
CREATE INDEX employees_account_idx ON employees (employee_account_id) WHERE employee_account_id IS NOT NULL;
CREATE INDEX employees_unclaimed_idx ON employees (reminded_at NULLS FIRST) WHERE employee_account_id IS NULL AND balance > 0;
CREATE TRIGGER employees_updated_at BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- credit_batches: one row per CSV run. The whole batch is one database transaction, so a batch is either fully applied or not at all
-- (a batch the wallet cannot cover is refused and nothing is recorded). idempotency_key makes a retried upload safe.
CREATE TABLE credit_batches (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  row_count       integer NOT NULL CHECK (row_count > 0),
  total           bigint NOT NULL CHECK (total > 0),
  sent            bigint NOT NULL CHECK (sent >= 0),           -- credited straight to employees who already have an account
  held            bigint NOT NULL CHECK (held >= 0),           -- held for employees who have not claimed
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_account_id, idempotency_key),
  CHECK (sent + held = total)
);
CREATE INDEX credit_batches_org_idx ON credit_batches (org_account_id, created_at DESC, id DESC);

-- credit_batch_rows: what each CSV row did.
CREATE TABLE credit_batch_rows (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  batch_id       uuid NOT NULL REFERENCES credit_batches (id) ON DELETE RESTRICT,
  employee_ref   uuid NOT NULL REFERENCES employees (id) ON DELETE RESTRICT,
  amount         bigint NOT NULL CHECK (amount > 0),
  mode           text NOT NULL CHECK (mode IN ('sent', 'held')),
  transaction_id uuid NOT NULL UNIQUE REFERENCES transactions (id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_batch_rows_batch_idx ON credit_batch_rows (batch_id, id);
CREATE INDEX credit_batch_rows_employee_idx ON credit_batch_rows (employee_ref, id DESC);

COMMIT;
