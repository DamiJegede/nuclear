-- Buying bands/cards from the store: a 'purchase' transaction (wallet balance -> platform) and a
-- tag_orders row per purchase (price snapshot, shipping address, fulfilment status).
BEGIN;

-- 'purchase' joins the transaction types. Source: the buyer's account and wallet. No destination
-- account: the platform is not an account, its side of the posting is a platform_clearing entry.
ALTER TABLE transactions DROP CONSTRAINT transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('fund', 'send', 'pay', 'settle', 'refund', 'adjustment', 'purchase'));

ALTER TABLE transactions DROP CONSTRAINT transactions_check3;
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
  ELSE true  -- adjustment: endpoints to be defined
END);

CREATE TABLE tag_orders (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id     uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  wallet_id      uuid NOT NULL,
  model_id       uuid NOT NULL REFERENCES tag_models (id) ON DELETE RESTRICT,
  model_name     text NOT NULL,                              -- snapshot at purchase
  model_type     text NOT NULL CHECK (model_type IN ('band', 'card')),
  quantity       integer NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  unit_price     bigint NOT NULL CHECK (unit_price >= 0),    -- cents, snapshot at purchase
  total          bigint NOT NULL CHECK (total > 0),          -- unit_price * quantity
  currency       char(3) NOT NULL DEFAULT 'USD',
  shipping       jsonb NOT NULL CHECK (jsonb_typeof(shipping) = 'object'),
  status         text NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'shipped', 'cancelled')),
  transaction_id uuid NOT NULL UNIQUE REFERENCES transactions (id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (wallet_id, account_id) REFERENCES wallets (id, account_id) ON DELETE RESTRICT,
  CHECK (total = unit_price * quantity)
);
CREATE INDEX tag_orders_account_idx ON tag_orders (account_id, created_at DESC, id DESC);
CREATE INDEX tag_orders_model_idx ON tag_orders (model_id);
CREATE INDEX tag_orders_status_idx ON tag_orders (status) WHERE status = 'paid';
CREATE TRIGGER tag_orders_updated_at BEFORE UPDATE ON tag_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Uploaded model photos (resized to 256 x 256 by the admin portal before upload) live in the database,
-- served publicly by GET /v1/shop/models/:id/photo. tag_models.photo stays for an external URL.
CREATE TABLE tag_model_photos (
  model_id     uuid PRIMARY KEY REFERENCES tag_models (id) ON DELETE CASCADE,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  data         bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 262144),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMIT;
