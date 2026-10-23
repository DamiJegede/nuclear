-- Bank routing and account numbers are stored encrypted (AES-256-GCM with the Worker secret BANK_ENCRYPTION_KEY, "v1." prefix); the only
-- other value allowed is the sandbox placeholder used by simulated customer loads. Convert any plain-digit rows first (scripts/encrypt-bank-numbers.mts).
BEGIN;
ALTER TABLE bank_accounts ADD CONSTRAINT bank_routing_encrypted CHECK (routing_number ~ '^(v1\.[A-Za-z0-9_-]{20,}|SANDBOX)$');
ALTER TABLE bank_accounts ADD CONSTRAINT bank_account_encrypted CHECK (account_number ~ '^(v1\.[A-Za-z0-9_-]{20,}|SANDBOX)$');
COMMIT;
