-- Three changes, applied together:
--  * shop: our own merchandise for sale (one item per order, with a quantity, like tags).
--  * orders: tag_orders becomes `orders` with a type: 'tag' (a band or card, model_id) or 'shop'
--    (a merchandise item, shop_id). Existing rows are copied as type 'tag'; 0019 drops tag_orders
--    once the code that uses `orders` is deployed.
--  * logs: the audit trail (append-only, like the ledger): who did what to what, and when.
-- Uploaded images now live in the R2 bucket `nuclear-images`; the `photo` columns hold only the file name (<id>-<epoch>.png); folder and URL are rendered in the API.
BEGIN;

CREATE TABLE shop (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text,
  photo       text,                                              -- file name of the image in R2 (<id>-<epoch>.png), or NULL
  price       bigint NOT NULL CHECK (price >= 0),                -- cents
  currency    char(3) NOT NULL DEFAULT 'USD',
  stock       integer CHECK (stock IS NULL OR stock >= 0),       -- units left; NULL = not tracked
  sold        integer NOT NULL DEFAULT 0 CHECK (sold >= 0),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'available', 'closed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER shop_updated_at BEFORE UPDATE ON shop FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE orders (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  type           text NOT NULL DEFAULT 'tag' CHECK (type IN ('tag', 'shop')),
  account_id     uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  wallet_id      uuid NOT NULL,
  model_id       uuid REFERENCES tag_models (id) ON DELETE RESTRICT,   -- type 'tag'
  shop_id        uuid REFERENCES shop (id) ON DELETE RESTRICT,         -- type 'shop'
  name           text NOT NULL,                                        -- snapshot at purchase
  model_type     text CHECK (model_type IN ('band', 'card')),          -- type 'tag' only
  quantity       integer NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  unit_price     bigint NOT NULL CHECK (unit_price >= 0),              -- cents, snapshot
  total          bigint NOT NULL CHECK (total > 0),
  currency       char(3) NOT NULL DEFAULT 'USD',
  shipping       jsonb NOT NULL CHECK (jsonb_typeof(shipping) = 'object'),
  status         text NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'shipped', 'cancelled')),
  transaction_id uuid NOT NULL UNIQUE REFERENCES transactions (id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (wallet_id, account_id) REFERENCES wallets (id, account_id) ON DELETE RESTRICT,
  CHECK (total = unit_price * quantity),
  CHECK ((type = 'tag'  AND model_id IS NOT NULL AND shop_id IS NULL AND model_type IS NOT NULL)
      OR (type = 'shop' AND shop_id IS NOT NULL AND model_id IS NULL AND model_type IS NULL))
);
INSERT INTO orders (id, type, account_id, wallet_id, model_id, name, model_type, quantity, unit_price, total, currency, shipping, status, transaction_id, created_at, updated_at)
  SELECT id, 'tag', account_id, wallet_id, model_id, model_name, model_type, quantity, unit_price, total, currency, shipping, status, transaction_id, created_at, updated_at
    FROM tag_orders;
CREATE INDEX orders_account_idx ON orders (account_id, created_at DESC, id DESC);
CREATE INDEX orders_model_idx ON orders (model_id) WHERE model_id IS NOT NULL;
CREATE INDEX orders_shop_idx ON orders (shop_id) WHERE shop_id IS NOT NULL;
CREATE INDEX orders_status_idx ON orders (status) WHERE status = 'paid';
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE logs (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  actor_type   text NOT NULL CHECK (actor_type IN ('admin', 'operator', 'customer', 'agent', 'system')),
  actor_id     uuid,                                   -- admins.id or accounts.id; no foreign key, logs outlive anything
  actor_label  text,                                   -- Access ID or email, as it was at the time
  action       text NOT NULL CHECK (length(action) BETWEEN 1 AND 80),   -- e.g. 'merchant.suspended'
  target_type  text,
  target_id    uuid,
  target_label text,
  details      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX logs_created_idx ON logs (created_at DESC, id DESC);
CREATE INDEX logs_target_idx ON logs (target_id, created_at DESC) WHERE target_id IS NOT NULL;
CREATE INDEX logs_actor_idx ON logs (actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX logs_action_idx ON logs (action, created_at DESC);

CREATE FUNCTION logs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'logs is append-only';
END;
$$;
CREATE TRIGGER logs_no_update BEFORE UPDATE OR DELETE ON logs FOR EACH ROW EXECUTE FUNCTION logs_immutable();
CREATE TRIGGER logs_no_truncate BEFORE TRUNCATE ON logs FOR EACH STATEMENT EXECUTE FUNCTION logs_immutable();

-- Models that already have an uploaded picture get its file name (<id>-<upload time in ms>.png); the bytes are copied
-- to R2 under tags/<that name> by the rollout step.
UPDATE tag_models m
   SET photo = m.id::text || '-' || (extract(epoch FROM p.updated_at) * 1000)::bigint::text || '.png'
  FROM tag_model_photos p
 WHERE p.model_id = m.id;

COMMIT;
