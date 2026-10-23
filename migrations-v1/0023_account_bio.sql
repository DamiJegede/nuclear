-- Accounts get a short bio (people and businesses alike), set by the owner: up to 500 characters, NULL = none.
-- Physically this column is added at the end of the table; in docs/TABLES.md it sits before created_at, and the
-- pre-launch rebuild into a fresh database creates it there (see "Pre-launch rebuild" in docs/TABLES.md).
BEGIN;
ALTER TABLE accounts ADD COLUMN bio text CHECK (bio IS NULL OR length(bio) <= 500);
COMMIT;
