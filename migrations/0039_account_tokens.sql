-- Email verification and password reset. One-time tokens are random, emailed as a link, and only their SHA-256 is stored.
-- A token is bound to the address it was sent to (verify) so a later email change cannot be verified by an old link.
ALTER TABLE accounts ADD COLUMN email_verified_at timestamptz;

CREATE TABLE account_tokens (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  kind        text NOT NULL CHECK (kind IN ('verify_email', 'reset_password')),
  email       text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_tokens_account_idx ON account_tokens (account_id, kind, created_at DESC);
