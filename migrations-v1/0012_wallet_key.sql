-- One API key per agent wallet, for machine callers (an MCP server) that cannot use a magic link.
-- Only the SHA-256 of the key is stored; the key itself is shown once when it is created.
BEGIN;

ALTER TABLE wallets ADD COLUMN key_hash text UNIQUE;
ALTER TABLE wallets ADD COLUMN key_hint text;              -- last 4 characters, to tell keys apart
ALTER TABLE wallets ADD COLUMN key_last_used_at timestamptz;
ALTER TABLE wallets ADD CONSTRAINT wallets_key_consistent CHECK ((key_hash IS NULL) = (key_hint IS NULL));
ALTER TABLE wallets ADD CONSTRAINT wallets_key_agent_only CHECK (key_hash IS NULL OR type = 'agent');

COMMIT;
