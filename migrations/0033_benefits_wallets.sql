-- Benefits wallets (docs/ORGANIZATIONS.md, "Finalized Benefits wallet program"). Forward-only: nothing existing is reclassified or rewritten.
--  * wallets.type gains 'benefits'; wallets.org_account_id binds the wallet to ONE employer, permanently. A Benefits wallet's funded money
--    lives in wallets.balance (the same compartment mechanism as an earmark, so no other wallet can spend it) and inside balances.balance
--    (the account total). One live Benefits wallet per (consumer account, employer).
--  * transactions.type gains 'move': a same-account move between two wallets of one account (Benefits -> ordinary).
--  * ledger_entries.wallet_id attributes a funded_balance posting to a Benefits wallet, so each compartment reconciles to the ledger.
BEGIN;

ALTER TABLE wallets DROP CONSTRAINT wallets_type_check;
ALTER TABLE wallets ADD CONSTRAINT wallets_type_check CHECK (type IN ('default', 'agent', 'person', 'benefits'));
ALTER TABLE wallets ADD COLUMN org_account_id uuid REFERENCES accounts (id) ON DELETE RESTRICT;
ALTER TABLE wallets ADD CONSTRAINT wallets_benefits_binding CHECK ((type = 'benefits') = (org_account_id IS NOT NULL));
ALTER TABLE wallets ADD CONSTRAINT wallets_benefits_funded CHECK (type <> 'benefits' OR balance IS NOT NULL);
CREATE UNIQUE INDEX wallets_one_benefits_per_employer ON wallets (account_id, org_account_id) WHERE type = 'benefits' AND status <> 'closed';
CREATE INDEX wallets_org_idx ON wallets (org_account_id) WHERE org_account_id IS NOT NULL;

-- The wallet's type, owner and employer never change after creation.
CREATE FUNCTION wallets_benefits_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type IS DISTINCT FROM OLD.type OR NEW.org_account_id IS DISTINCT FROM OLD.org_account_id OR NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'a wallet''s type, owner and employer cannot change';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wallets_benefits_immutable BEFORE UPDATE OF type, org_account_id, account_id ON wallets
  FOR EACH ROW EXECUTE FUNCTION wallets_benefits_immutable();

ALTER TABLE transactions DROP CONSTRAINT transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('fund', 'send', 'pay', 'settle', 'refund', 'adjustment', 'purchase', 'allocate', 'claim', 'move'));
ALTER TABLE transactions DROP CONSTRAINT transactions_endpoints_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_endpoints_check CHECK (CASE type
  WHEN 'fund' THEN from_account_id IS NOT NULL AND to_account_id IS NOT NULL
                   AND from_bank_account_id IS NOT NULL AND to_bank_account_id IS NULL
                   AND from_wallet_id IS NULL AND to_wallet_id IS NULL
  WHEN 'send' THEN from_account_id IS NOT NULL AND to_account_id IS NOT NULL
                   AND from_wallet_id IS NOT NULL AND to_wallet_id IS NOT NULL
                   AND from_bank_account_id IS NULL AND to_bank_account_id IS NULL
  WHEN 'pay' THEN from_account_id IS NOT NULL AND to_account_id IS NOT NULL
                  AND from_wallet_id IS NOT NULL AND to_wallet_id IS NULL
                  AND from_bank_account_id IS NULL AND to_bank_account_id IS NULL
  WHEN 'settle' THEN from_account_id IS NOT NULL AND to_account_id IS NOT NULL
                     AND from_wallet_id IS NULL AND to_wallet_id IS NULL
                     AND num_nonnulls(from_bank_account_id, to_bank_account_id) = 1
  WHEN 'refund' THEN from_account_id IS NOT NULL AND to_account_id IS NOT NULL
                     AND from_wallet_id IS NULL AND to_wallet_id IS NOT NULL
                     AND from_bank_account_id IS NULL AND to_bank_account_id IS NULL
                     AND related_transaction_id IS NOT NULL
  WHEN 'purchase' THEN from_account_id IS NOT NULL AND from_wallet_id IS NOT NULL
                       AND to_account_id IS NULL AND to_wallet_id IS NULL
                       AND from_bank_account_id IS NULL AND to_bank_account_id IS NULL
  WHEN 'allocate' THEN from_account_id IS NOT NULL AND from_wallet_id IS NOT NULL
                       AND to_account_id IS NULL AND to_wallet_id IS NULL
                       AND from_bank_account_id IS NULL AND to_bank_account_id IS NULL
  WHEN 'claim' THEN to_account_id IS NOT NULL AND to_wallet_id IS NOT NULL
                    AND from_account_id IS NULL AND from_wallet_id IS NULL
                    AND from_bank_account_id IS NULL AND to_bank_account_id IS NULL
  WHEN 'move' THEN from_account_id IS NOT NULL AND to_account_id = from_account_id
                   AND from_wallet_id IS NOT NULL AND to_wallet_id IS NOT NULL AND from_wallet_id <> to_wallet_id
                   AND from_bank_account_id IS NULL AND to_bank_account_id IS NULL
  ELSE true  -- adjustment: endpoints to be defined
END);

ALTER TABLE ledger_entries ADD COLUMN wallet_id uuid REFERENCES wallets (id) ON DELETE RESTRICT;
CREATE INDEX ledger_entries_wallet_idx ON ledger_entries (wallet_id, id DESC) WHERE wallet_id IS NOT NULL;

COMMIT;
