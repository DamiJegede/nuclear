-- Business approval and uploaded documents.
--  * uploads: one row per file a customer or business uploaded (the file itself is in the R2 bucket
--    `nuclear-uploads`; `path` is its key inside that bucket: <account id>/<upload id>.<ext>).
--  * businesses.business_doc is dropped: the document is now an `uploads` row (type 'business_document').
--  * accounts.status gains 'pending' (a new business waiting for approval) and 'declined' (refused, may upload again).
BEGIN;

CREATE TABLE uploads (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id  uuid NOT NULL REFERENCES accounts (id),
  type        text NOT NULL CHECK (type ~ '^[a-z_]{1,40}$'),
  path        text NOT NULL UNIQUE CHECK (length(path) BETWEEN 1 AND 300),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX uploads_account_idx ON uploads (account_id, created_at DESC);

ALTER TABLE businesses DROP COLUMN business_doc;

ALTER TABLE accounts DROP CONSTRAINT accounts_status_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_status_check CHECK (status IN ('active', 'pending', 'declined', 'suspended', 'closed'));

COMMIT;
