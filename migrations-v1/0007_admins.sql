-- Admin portal accounts: per-person sign-in with an access id and password, and their sessions.
-- Source of truth: docs/TABLES.md.

BEGIN;

CREATE TABLE admins (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  -- Lowercase sign-in name, 3-32 characters: letters, digits, '.', '_' or '-', starting with a letter or digit.
  access_id            text NOT NULL UNIQUE CHECK (access_id ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
  name                 text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  password_hash        text NOT NULL,                      -- scrypt, never a plaintext password
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- Set when an operator creates the account or resets its password: the person must choose their
  -- own password before doing anything else.
  must_change_password boolean NOT NULL DEFAULT true,
  failed_attempts      integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until         timestamptz,                        -- sign-in refused until then
  -- Multi-factor (TOTP authenticator app). Mandatory: an admin without it can only enroll.
  mfa_secret           text,                               -- AES-GCM encrypted base32 secret; never plaintext
  mfa_enabled_at       timestamptz,                        -- NULL = not enrolled (secret, if any, is pending)
  mfa_last_step        bigint,                             -- last accepted 30 s time step: a code works once
  mfa_recovery         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(mfa_recovery) = 'array'),  -- SHA-256 of unused recovery codes
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER admins_updated_at BEFORE UPDATE ON admins
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE admin_sessions (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  admin_id     uuid NOT NULL REFERENCES admins (id) ON DELETE RESTRICT,
  token_hash   text NOT NULL UNIQUE,                       -- SHA-256 of the random session token
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX admin_sessions_admin_idx ON admin_sessions (admin_id) WHERE revoked_at IS NULL;

COMMIT;
