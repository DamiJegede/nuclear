-- Admin roles decide which screens (and the matching API routes) a person can use. Existing admins
-- keep full access. The role is added at the end of the table (documented there in docs/TABLES.md).
BEGIN;

ALTER TABLE admins ADD COLUMN role text NOT NULL DEFAULT 'admin'
  CHECK (role IN ('admin', 'accounting', 'sales', 'support', 'tags', 'merchants'));

COMMIT;
