-- Wallet balance: earmarked funds. NULL (the default) = the wallet draws on the account's shared
-- funds, as before. A number = money the owner has set aside for this wallet: the wallet can spend
-- only up to it (a hard limit, no credit), and the rest of the account cannot spend it. The amount
-- stays part of balances.balance (earmarking moves nothing in the ledger); sum(wallets.balance)
-- never exceeds the account's balance because every money movement locks the balances row first.
BEGIN;

ALTER TABLE wallets ADD COLUMN balance bigint CHECK (balance IS NULL OR balance >= 0);

-- Every change to a wallet's earmark: a signed amount (positive = set aside, negative = returned to
-- the shared funds) and the balance afterwards (NULL = released back to shared funds).
CREATE TABLE wallet_allocations (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  wallet_id     uuid NOT NULL,
  account_id    uuid NOT NULL,
  amount        bigint NOT NULL CHECK (amount <> 0),
  balance_after bigint CHECK (balance_after IS NULL OR balance_after >= 0),
  device_id     uuid REFERENCES devices (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (wallet_id, account_id) REFERENCES wallets (id, account_id) ON DELETE RESTRICT
);
CREATE INDEX wallet_allocations_wallet_idx ON wallet_allocations (wallet_id, created_at DESC, id DESC);

COMMIT;
