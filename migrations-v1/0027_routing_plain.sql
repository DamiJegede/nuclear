-- Routing numbers are public (the Federal Reserve publishes the directory), so they are stored as plain 9-digit text again; only the
-- account number stays encrypted. The new CHECK is added NOT VALID so existing encrypted routing values can be converted
-- (scripts/encrypt-bank-numbers.mts --apply decrypts them); 0028 validates it once they are.
BEGIN;
ALTER TABLE bank_accounts DROP CONSTRAINT bank_routing_encrypted;
ALTER TABLE bank_accounts ADD CONSTRAINT bank_routing_format CHECK (routing_number ~ '^([0-9]{9}|SANDBOX)$') NOT VALID;
COMMIT;
