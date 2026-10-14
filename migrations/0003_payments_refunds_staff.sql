-- Merchant payment attribution, refund approval, and staff.
-- Source of truth: docs/TABLES.md.

BEGIN;

-- Terminal attribution and merchant order reference. For a pay the terminal belongs to the payee
-- (to_account_id); for a refund it belongs to the payer of the refund, the merchant (from_account_id).
ALTER TABLE transactions ADD COLUMN terminal_id uuid REFERENCES terminals (id) ON DELETE RESTRICT;
ALTER TABLE transactions ADD COLUMN reference text;
ALTER TABLE transactions ADD COLUMN approved_by_account_id uuid REFERENCES accounts (id) ON DELETE RESTRICT;
ALTER TABLE transactions ADD CONSTRAINT transactions_terminal_scope
  CHECK (terminal_id IS NULL OR type IN ('pay', 'refund'));
ALTER TABLE transactions ADD CONSTRAINT transactions_reference_pay_only
  CHECK (reference IS NULL OR (type = 'pay' AND length(reference) BETWEEN 1 AND 64));
ALTER TABLE transactions ADD CONSTRAINT transactions_approval_refund_only
  CHECK (approved_by_account_id IS NULL OR type = 'refund');

CREATE FUNCTION transactions_terminal_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.terminal_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM terminals t
        WHERE t.id = NEW.terminal_id
          AND t.account_id = CASE NEW.type WHEN 'pay' THEN NEW.to_account_id
                                           WHEN 'refund' THEN NEW.from_account_id END) THEN
    RAISE EXCEPTION 'terminal does not belong to the merchant account'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER transactions_terminal_owner BEFORE INSERT OR UPDATE OF terminal_id ON transactions
  FOR EACH ROW EXECUTE FUNCTION transactions_terminal_owner();
CREATE INDEX transactions_terminal_idx ON transactions (terminal_id, "timestamp" DESC, id DESC)
  WHERE terminal_id IS NOT NULL;

-- Idempotency scope: payments are keyed per merchant (the POS is the actor); every other operation
-- stays keyed per source account. The two scopes never overlap.
DROP INDEX transactions_idempotency_key;
CREATE UNIQUE INDEX transactions_idempotency_key
  ON transactions (type, from_account_id, idempotency_key)
  WHERE from_account_id IS NOT NULL AND type <> 'pay';
CREATE UNIQUE INDEX transactions_pay_idempotency_key
  ON transactions (to_account_id, idempotency_key) WHERE type = 'pay';

-- Staff of a business. A staff member is a consumer account; role write may approve refunds by
-- tapping any of their own credentials. bank_account_id is the staff member's own bank account.
CREATE TABLE staff (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,   -- the business
  staff_account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  bank_account_id  uuid,
  role             text NOT NULL CHECK (role IN ('read', 'write')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, staff_account_id),
  CHECK (account_id <> staff_account_id),
  -- The bank account must belong to the staff member.
  FOREIGN KEY (bank_account_id, staff_account_id) REFERENCES bank_accounts (id, account_id) ON DELETE RESTRICT
);
CREATE INDEX staff_staff_account_idx ON staff (staff_account_id);

CREATE FUNCTION staff_account_types() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND type = 'B') THEN
    RAISE EXCEPTION 'staff.account_id requires a business (type B) account'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.staff_account_id AND type = 'C') THEN
    RAISE EXCEPTION 'staff.staff_account_id requires a consumer (type C) account'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER staff_account_types BEFORE INSERT OR UPDATE OF account_id, staff_account_id ON staff
  FOR EACH ROW EXECUTE FUNCTION staff_account_types();
CREATE TRIGGER staff_updated_at BEFORE UPDATE ON staff
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
