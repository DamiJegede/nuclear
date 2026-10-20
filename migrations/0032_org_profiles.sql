-- Organizations keep their legal details (legal name, tax ID, address, website) in the same `businesses` table as merchants, so the
-- organization portal can reuse the business profile (docs/ORGANIZATIONS.md). Only the allowed account types change: B or O.
ALTER TABLE businesses DROP CONSTRAINT businesses_account_type_check;
ALTER TABLE businesses ADD CONSTRAINT businesses_account_type_check CHECK (account_type IN ('B', 'O'));
