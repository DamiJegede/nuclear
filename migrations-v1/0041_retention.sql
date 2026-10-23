-- Immutability and retention.
--  * snapshots: a day's snapshot is final. No delete; no update except writing the ledger-check result once (reconciled, reconciliation).
--  * Indexes for the nightly purge of finished sessions and used or expired one-time links. (Logs are left alone for now: no retention.)
BEGIN;

CREATE FUNCTION snapshots_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a snapshot is final and cannot be deleted';
  END IF;
  IF (to_jsonb(NEW) - 'reconciled' - 'reconciliation') IS DISTINCT FROM (to_jsonb(OLD) - 'reconciled' - 'reconciliation') THEN
    RAISE EXCEPTION 'a snapshot is final: only its ledger-check result can be written';
  END IF;
  IF OLD.reconciled IS NOT NULL AND (NEW.reconciled IS DISTINCT FROM OLD.reconciled OR NEW.reconciliation IS DISTINCT FROM OLD.reconciliation) THEN
    RAISE EXCEPTION 'a snapshot''s ledger-check result is written once';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER snapshots_final BEFORE UPDATE OR DELETE ON snapshots FOR EACH ROW EXECUTE FUNCTION snapshots_final();

CREATE INDEX devices_revoked_idx    ON devices (revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX devices_expires_idx    ON devices (session_expires_at) WHERE session_expires_at IS NOT NULL;
CREATE INDEX devices_unredeemed_idx ON devices (created_at) WHERE session_token_hash IS NULL;
CREATE INDEX admin_sessions_expires_idx ON admin_sessions (expires_at);
CREATE INDEX account_tokens_expires_idx ON account_tokens (expires_at);

COMMIT;
