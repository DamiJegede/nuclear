-- Merchant devices: terminals (a POS/checkout point) and orbs (the NFC reader hardware).
-- Source of truth: docs/TABLES.md.

BEGIN;

-- Only business (type B) accounts may own terminals or orbs. Trigger instead of a helper column so
-- the tables keep exactly the specified columns.
CREATE FUNCTION require_business_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND type = 'B') THEN
    RAISE EXCEPTION '% requires a business (type B) account', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE terminals (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id         uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  -- SHA-256 of the terminal's current session JWT. The JWT carries its own expiry; this hash makes
  -- it revocable and single-active. NULL = no active session.
  session_token_hash text UNIQUE,
  -- true: the terminal may refund directly; false: each refund needs a staff (write) tap approval.
  allow_refunds      boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id)                             -- composite ownership FK target for orbs
);
CREATE INDEX terminals_account_id_idx ON terminals (account_id);
CREATE TRIGGER terminals_business_only BEFORE INSERT OR UPDATE OF account_id ON terminals
  FOR EACH ROW EXECUTE FUNCTION require_business_account();
CREATE TRIGGER terminals_updated_at BEFORE UPDATE ON terminals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE orbs (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  model       text NOT NULL,
  software    text NOT NULL,                          -- firmware/software version
  account_id  uuid REFERENCES accounts (id) ON DELETE RESTRICT,   -- NULL = unassigned
  terminal_id uuid,                                                -- NULL = unassigned
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- A terminal assignment implies an owner, and the terminal must belong to that same account.
  CHECK (terminal_id IS NULL OR account_id IS NOT NULL),
  FOREIGN KEY (terminal_id, account_id) REFERENCES terminals (id, account_id) ON DELETE RESTRICT
);
CREATE INDEX orbs_account_id_idx ON orbs (account_id) WHERE account_id IS NOT NULL;
-- A terminal holds at most one Orb (pairing another unpairs the first).
CREATE UNIQUE INDEX orbs_terminal_id_key ON orbs (terminal_id) WHERE terminal_id IS NOT NULL;
CREATE TRIGGER orbs_business_only BEFORE INSERT OR UPDATE OF account_id ON orbs
  FOR EACH ROW EXECUTE FUNCTION require_business_account();
CREATE TRIGGER orbs_updated_at BEFORE UPDATE ON orbs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
