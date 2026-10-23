-- API keys (docs/ORGANIZATIONS.md, "Benefits API"). The first user is the organization Benefits API: one active key per organization,
-- shown once when it is generated; only its SHA-256 is stored. Generic table so other account types can reuse it later.
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  name         text NOT NULL DEFAULT 'Default' CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  key_hash     text NOT NULL UNIQUE,
  key_hint     text NOT NULL CHECK (length(key_hint) = 4),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
-- One live key per account: generating a new one revokes the old one in the same transaction.
CREATE UNIQUE INDEX api_keys_one_active_per_account ON api_keys (account_id) WHERE revoked_at IS NULL;
CREATE INDEX api_keys_account_idx ON api_keys (account_id, created_at DESC);
