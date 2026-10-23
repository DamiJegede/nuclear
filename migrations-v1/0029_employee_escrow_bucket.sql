-- New ledger bucket for employer-funded credits held for employees who have not claimed them yet (docs/BRAIN-DUMP.md, docs/ADOPTION-STRATEGY.md).
-- Debit/credit pairing: the company's funded_balance is debited and employee_escrow is credited when funds are held; the reverse when the
-- employee claims (then funded_balance of the employee is credited) or the hold is returned. Nothing posts to it yet.
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_bucket_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_bucket_check CHECK (bucket IN (
  'funded_balance', 'credit_receivable', 'pending_funding', 'bank_settlement', 'platform_clearing', 'employee_escrow'));
