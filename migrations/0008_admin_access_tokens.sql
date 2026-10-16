-- Admin credentials become an uppercase Access ID and a 32-character Access token, and the portal can
-- create admins. Source of truth: docs/TABLES.md. 0007 is applied and frozen, so this is a new file.
--
-- NOTE: DROP CONSTRAINT trips the CLI's destructive-SQL guard; it needs the owner's approval to run
-- with --force. Nothing but a check constraint is dropped, and it is recreated in this transaction.

BEGIN;

-- Access IDs are uppercase everywhere. Convert what exists, then replace the lowercase rule.
ALTER TABLE admins DROP CONSTRAINT admins_access_id_check;
UPDATE admins SET access_id = upper(access_id);
ALTER TABLE admins ADD CONSTRAINT admins_access_id_check
  CHECK (access_id ~ '^[A-Z0-9][A-Z0-9._-]{2,31}$');

-- "Password" is now "access token": the hash column and the first-sign-in flag follow.
ALTER TABLE admins RENAME COLUMN password_hash TO access_token_hash;
ALTER TABLE admins RENAME COLUMN must_change_password TO must_change_access_token;

-- Who created each admin (NULL when the operator did, via the scripts).
ALTER TABLE admins ADD COLUMN created_by uuid REFERENCES admins (id) ON DELETE RESTRICT;

COMMIT;
