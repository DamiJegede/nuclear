-- employees.status: an organization can remove an employee so they stop showing (docs/ORGANIZATIONS.md). Removal is refused while money is
-- held for them (the CHECK), their claim token is dropped, and a later CSV that mentions the employee_id makes them active again.
-- Logical position: before created_at (physically last until the pre-launch rebuild).
ALTER TABLE employees ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed'));
ALTER TABLE employees ADD CONSTRAINT employees_removed_holds_nothing CHECK (status = 'active' OR (balance = 0 AND claim_token_hash IS NULL));
CREATE INDEX employees_org_active_idx ON employees (org_account_id, created_at DESC, id DESC) WHERE status = 'active';
