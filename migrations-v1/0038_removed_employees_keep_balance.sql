-- Removing an employee only hides them. Credit held for them stays theirs, and their claim link keeps working, so a removed employee may
-- hold a balance and a claim token (docs/ORGANIZATIONS.md). Drops the check that forbade it (migration 0031).
ALTER TABLE employees DROP CONSTRAINT employees_removed_holds_nothing;
