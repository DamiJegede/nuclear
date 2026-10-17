-- A bio is at most 128 characters (it was 500 in 0023). Shorten any longer one first (none exist in the dev data).
BEGIN;
UPDATE accounts SET bio = left(bio, 128) WHERE length(bio) > 128;
ALTER TABLE accounts DROP CONSTRAINT accounts_bio_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_bio_check CHECK (bio IS NULL OR length(bio) <= 128);
COMMIT;
