-- Nuclear initial schema (twelve tables). Source of truth: TABLES.md.
-- PostgreSQL 18: uuidv7() is built in. Money is bigint minor units (USD cents).
-- Status vocabularies are CHECK constraints so they can be changed cheaply.

BEGIN;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- accounts ---------------------------------------------------------------

CREATE TABLE accounts (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  type          char(1) NOT NULL CHECK (type IN ('C', 'B')),
  handle        text CHECK (handle ~ '^[a-z0-9]{4,12}$'),            -- NULL until set from a session; lowercase
  name          text NOT NULL,
  phone         text,
  email         text,
  password_hash text,
  photo         text,
  tier          text NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'plus', 'insider')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, type)                                   -- target for businesses type-B enforcement
);
CREATE UNIQUE INDEX accounts_handle_key ON accounts (handle);
CREATE UNIQUE INDEX accounts_email_key ON accounts (lower(email)) WHERE email IS NOT NULL;
CREATE TRIGGER accounts_updated_at BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- balances ---------------------------------------------------------------

CREATE TABLE balances (
  account_id      uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE RESTRICT,
  balance         bigint NOT NULL DEFAULT 0,          -- may be negative (merchant refunds, returned funding)
  balance_pending bigint NOT NULL DEFAULT 0 CHECK (balance_pending >= 0),
  credit_limit    bigint NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  credit_spent    bigint NOT NULL DEFAULT 0 CHECK (credit_spent >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER balances_updated_at BEFORE UPDATE ON balances FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- wallets ----------------------------------------------------------------

CREATE TABLE wallets (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  photo        text,
  type         text NOT NULL CHECK (type IN ('default', 'agent', 'person')),
  daily_limit  bigint CHECK (daily_limit >= 0),       -- NULL = no additional wallet cap
  spent_today  bigint NOT NULL DEFAULT 0 CHECK (spent_today >= 0), -- reset 00:00 Eastern by job
  allow_pay    boolean NOT NULL DEFAULT true,
  allow_send   boolean NOT NULL DEFAULT true,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id)                             -- composite ownership FK target
);
CREATE INDEX wallets_account_id_idx ON wallets (account_id);
-- One default wallet per account.
CREATE UNIQUE INDEX wallets_one_default_per_account ON wallets (account_id) WHERE type = 'default';
CREATE TRIGGER wallets_updated_at BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- devices (device registration + current session) ------------------------

CREATE TABLE devices (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id         uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  wallet_id          uuid,
  platform           text CHECK (platform IN ('ios', 'android', 'web')),
  push_token         text,
  session_token_hash text UNIQUE,                     -- NULL only before redemption; never reset to NULL
  session_expires_at timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_accessed_at   timestamptz,
  FOREIGN KEY (wallet_id, account_id) REFERENCES wallets (id, account_id) ON DELETE RESTRICT,
  CHECK ((session_token_hash IS NULL) = (session_expires_at IS NULL))
);
CREATE INDEX devices_account_id_idx ON devices (account_id);
CREATE INDEX devices_wallet_id_idx ON devices (wallet_id) WHERE wallet_id IS NOT NULL;

-- bank_accounts ----------------------------------------------------------

CREATE TABLE bank_accounts (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  routing_number      text NOT NULL,                  -- protect/encrypt per banking integration
  account_number      text NOT NULL,                  -- encrypted if retained
  last4               char(4) NOT NULL,
  provider_account_id text UNIQUE,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'removed')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id)
);
CREATE INDEX bank_accounts_account_id_idx ON bank_accounts (account_id);
CREATE TRIGGER bank_accounts_updated_at BEFORE UPDATE ON bank_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- businesses -------------------------------------------------------------

CREATE TABLE businesses (
  account_id      uuid PRIMARY KEY,
  account_type    char(1) NOT NULL DEFAULT 'B' CHECK (account_type = 'B'),
  legal_name      text NOT NULL,
  display_name    text NOT NULL,
  tax_id          text,                               -- restrict access / encrypt
  business_doc    text,
  bank_account_id uuid,
  address         text,                               -- line 1 and optional line 2, newline-separated
  city            text,
  state           text,
  post_code       text,
  country         char(2),
  website         text,
  latitude        double precision,
  longitude       double precision,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, account_type) REFERENCES accounts (id, type) ON DELETE RESTRICT,
  FOREIGN KEY (bank_account_id, account_id) REFERENCES bank_accounts (id, account_id) ON DELETE RESTRICT
);
CREATE TRIGGER businesses_updated_at BEFORE UPDATE ON businesses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- tag_models -------------------------------------------------------------

CREATE TABLE tag_models (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  type       text NOT NULL CHECK (type IN ('band', 'card')),
  name       text NOT NULL,
  photo      text,
  currency   char(3) NOT NULL DEFAULT 'USD',
  price      bigint NOT NULL CHECK (price >= 0),
  country    char(2),
  quantity   integer NOT NULL CHECK (quantity >= 0),
  sold       integer NOT NULL DEFAULT 0 CHECK (sold >= 0),
  limited    boolean NOT NULL DEFAULT false,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'preorder', 'available', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),      -- not bumped by sold-only updates (app-managed)
  CHECK (sold <= quantity)
);

-- tags (physical NTAG 424 inventory + wallet assignment) ----------------

CREATE TABLE tags (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  uid               text NOT NULL UNIQUE CHECK (uid = upper(uid)),
  model_id          uuid NOT NULL REFERENCES tag_models (id) ON DELETE RESTRICT,
  wallet_id         uuid REFERENCES wallets (id) ON DELETE RESTRICT,
  label             text,
  counter           bigint CHECK (counter >= 0),      -- last consumed verified SDM counter; never reset
  last_read_at      timestamptz,
  locked            boolean NOT NULL DEFAULT false,
  transaction_limit bigint CHECK (transaction_limit > 0), -- NULL = no additional tag ceiling
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tags_wallet_id_idx ON tags (wallet_id) WHERE wallet_id IS NOT NULL;
CREATE INDEX tags_model_id_idx ON tags (model_id);
CREATE TRIGGER tags_updated_at BEFORE UPDATE ON tags FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- passes (Apple/Google) --------------------------------------------------

CREATE TABLE passes (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),       -- NFC payload identifier
  wallet_id  uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
  platform   text NOT NULL CHECK (platform IN ('ios', 'android')),
  locked     boolean NOT NULL DEFAULT false,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX passes_wallet_id_idx ON passes (wallet_id);
CREATE TRIGGER passes_updated_at BEFORE UPDATE ON passes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- transactions -----------------------------------------------------------

CREATE TABLE transactions (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  type                 text NOT NULL CHECK (type IN ('fund', 'send', 'pay', 'settle', 'refund', 'adjustment')),
  from_account_id      uuid REFERENCES accounts (id) ON DELETE RESTRICT,
  to_account_id        uuid REFERENCES accounts (id) ON DELETE RESTRICT,
  from_wallet_id       uuid,
  to_wallet_id         uuid,
  from_bank_account_id uuid,
  to_bank_account_id   uuid,
  amount               bigint NOT NULL CHECK (amount > 0),
  related_transaction_id uuid REFERENCES transactions (id) ON DELETE RESTRICT,
  tag_id               uuid REFERENCES tags (id) ON DELETE RESTRICT,
  pass_id              uuid REFERENCES passes (id) ON DELETE RESTRICT,
  status               text NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'returned')),
  status_code          text,
  idempotency_key      text NOT NULL,
  provider_reference   text,
  "timestamp"          timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz,

  -- Ownership consistency: wallet/bank endpoints must belong to the stated account.
  FOREIGN KEY (from_wallet_id, from_account_id) REFERENCES wallets (id, account_id) ON DELETE RESTRICT,
  FOREIGN KEY (to_wallet_id, to_account_id) REFERENCES wallets (id, account_id) ON DELETE RESTRICT,
  FOREIGN KEY (from_bank_account_id, from_account_id) REFERENCES bank_accounts (id, account_id) ON DELETE RESTRICT,
  FOREIGN KEY (to_bank_account_id, to_account_id) REFERENCES bank_accounts (id, account_id) ON DELETE RESTRICT,

  -- Credentials: mutually exclusive, pay only.
  CHECK (tag_id IS NULL OR pass_id IS NULL),
  CHECK ((tag_id IS NULL AND pass_id IS NULL) OR type = 'pay'),
  CHECK (related_transaction_id IS NULL OR type IN ('refund', 'adjustment')),

  -- Type-specific endpoint rules.
  CHECK (CASE type
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
    ELSE true  -- adjustment: endpoints to be defined
  END),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);
-- Idempotency scope (finalize with API design): per source account and operation type.
CREATE UNIQUE INDEX transactions_idempotency_key
  ON transactions (type, from_account_id, idempotency_key) WHERE from_account_id IS NOT NULL;
CREATE INDEX transactions_from_account_idx ON transactions (from_account_id, "timestamp" DESC, id DESC);
CREATE INDEX transactions_to_account_idx ON transactions (to_account_id, "timestamp" DESC, id DESC);
CREATE INDEX transactions_related_idx ON transactions (related_transaction_id) WHERE related_transaction_id IS NOT NULL;
CREATE INDEX transactions_tag_idx ON transactions (tag_id) WHERE tag_id IS NOT NULL;
CREATE INDEX transactions_pass_idx ON transactions (pass_id) WHERE pass_id IS NOT NULL;
CREATE INDEX transactions_from_wallet_idx ON transactions (from_wallet_id) WHERE from_wallet_id IS NOT NULL;
CREATE INDEX transactions_to_wallet_idx ON transactions (to_wallet_id) WHERE to_wallet_id IS NOT NULL;
CREATE INDEX transactions_provider_ref_idx ON transactions (provider_reference) WHERE provider_reference IS NOT NULL;

-- fundings ---------------------------------------------------------------

CREATE TABLE fundings (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id         uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  bank_account_id    uuid NOT NULL,
  amount             bigint NOT NULL CHECK (amount > 0),
  status             text NOT NULL DEFAULT 'created'
                     CHECK (status IN ('created', 'pending', 'completed', 'failed', 'canceled', 'returned')),
  failure_code       text,
  idempotency_key    text NOT NULL,
  provider_reference text,
  transaction_id     uuid UNIQUE REFERENCES transactions (id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  released_at        timestamptz,
  returned_at        timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (bank_account_id, account_id) REFERENCES bank_accounts (id, account_id) ON DELETE RESTRICT,
  UNIQUE (account_id, idempotency_key),
  CHECK (transaction_id IS NULL OR released_at IS NOT NULL),
  CHECK (returned_at IS NULL OR released_at IS NOT NULL)
);
CREATE INDEX fundings_account_idx ON fundings (account_id, created_at DESC, id DESC);
CREATE INDEX fundings_bank_account_idx ON fundings (bank_account_id);
CREATE INDEX fundings_provider_ref_idx ON fundings (provider_reference) WHERE provider_reference IS NOT NULL;
CREATE INDEX fundings_open_idx ON fundings (status) WHERE status IN ('created', 'pending');
CREATE TRIGGER fundings_updated_at BEFORE UPDATE ON fundings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ledger_entries (append-only, internal; bigint id) ----------------------

CREATE TABLE ledger_entries (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id uuid REFERENCES transactions (id) ON DELETE RESTRICT,
  funding_id     uuid REFERENCES fundings (id) ON DELETE RESTRICT,
  posting_key    text NOT NULL,
  line_no        smallint NOT NULL CHECK (line_no > 0),
  account_id     uuid REFERENCES accounts (id) ON DELETE RESTRICT, -- NULL = platform/system entry
  -- Initial bucket set; extend via migration as the accounting model is finalized.
  bucket         text NOT NULL CHECK (bucket IN (
                   'funded_balance', 'credit_receivable', 'pending_funding',
                   'bank_settlement', 'platform_clearing')),
  direction      text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount         bigint NOT NULL CHECK (amount > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(transaction_id, funding_id) = 1)
);
CREATE UNIQUE INDEX ledger_entries_txn_line_key
  ON ledger_entries (transaction_id, posting_key, line_no) WHERE transaction_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_entries_funding_line_key
  ON ledger_entries (funding_id, posting_key, line_no) WHERE funding_id IS NOT NULL;
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, id DESC) WHERE account_id IS NOT NULL;

CREATE FUNCTION ledger_entries_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only; post a reversing entry instead';
END;
$$;
CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_immutable();

-- Every posting event must balance (checked at commit).
CREATE FUNCTION ledger_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  net bigint;
BEGIN
  SELECT COALESCE(SUM(CASE direction WHEN 'debit' THEN amount ELSE -amount END), 0)
    INTO net
    FROM ledger_entries
   WHERE posting_key = NEW.posting_key
     AND transaction_id IS NOT DISTINCT FROM NEW.transaction_id
     AND funding_id IS NOT DISTINCT FROM NEW.funding_id;
  IF net <> 0 THEN
    RAISE EXCEPTION 'unbalanced ledger posting % (net %)', NEW.posting_key, net;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();

COMMIT;
