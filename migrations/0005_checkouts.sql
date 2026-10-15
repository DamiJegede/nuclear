-- Orders: checkouts (the order a payment settles) and their line items, plus item-level refunds
-- (carried on the refund transaction).
-- Source of truth: docs/TABLES.md. Requires 0001-0004.

BEGIN;

-- A checkout is created before payment and settled by one completed pay transaction. Stock is taken
-- at payment, not at checkout creation. Prices and names are snapshotted on the items.
CREATE TABLE checkouts (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,   -- the merchant
  terminal_id uuid,                                                         -- NULL = not from a terminal
  reference   text CHECK (reference IS NULL OR length(reference) BETWEEN 1 AND 64),
  currency    char(3) NOT NULL DEFAULT 'USD',
  total       bigint NOT NULL CHECK (total > 0),                            -- integer minor units
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'canceled', 'expired')),
  expires_at  timestamptz,                                                  -- NULL = never expires
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  FOREIGN KEY (terminal_id, account_id) REFERENCES terminals (id, account_id) ON DELETE RESTRICT
);
CREATE INDEX checkouts_account_idx ON checkouts (account_id, created_at DESC, id DESC);
CREATE INDEX checkouts_open_idx ON checkouts (account_id) WHERE status = 'open';
CREATE TRIGGER checkouts_business_only BEFORE INSERT OR UPDATE OF account_id ON checkouts
  FOR EACH ROW EXECUTE FUNCTION require_business_account();
CREATE TRIGGER checkouts_updated_at BEFORE UPDATE ON checkouts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Line items. A checkout may have none (a keyed-in amount). product_id is NULL for ad-hoc lines.
CREATE TABLE checkout_items (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  checkout_id uuid NOT NULL REFERENCES checkouts (id) ON DELETE RESTRICT,
  product_id  uuid REFERENCES products (id) ON DELETE RESTRICT,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),   -- snapshot
  unit_price  bigint NOT NULL CHECK (unit_price >= 0),                       -- snapshot, list price
  discount    bigint NOT NULL DEFAULT 0,                                     -- snapshot, per unit
  quantity    integer NOT NULL CHECK (quantity > 0),
  -- Per-line refund state, kept in step under the original payment's row lock:
  -- a pending item refund reserves units in refund_pending_quantity; completing it moves them to
  -- refunded_quantity; rejecting it releases them.
  refunded_quantity       integer NOT NULL DEFAULT 0 CHECK (refunded_quantity >= 0),
  refund_pending_quantity integer NOT NULL DEFAULT 0 CHECK (refund_pending_quantity >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (discount >= 0 AND discount <= unit_price),
  CHECK (refunded_quantity + refund_pending_quantity <= quantity)
);
CREATE INDEX checkout_items_checkout_idx ON checkout_items (checkout_id);
CREATE INDEX checkout_items_product_idx ON checkout_items (product_id) WHERE product_id IS NOT NULL;

-- A line's product must belong to the checkout's merchant.
CREATE FUNCTION checkout_item_same_merchant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.product_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM checkouts c JOIN products p ON p.account_id = c.account_id
        WHERE c.id = NEW.checkout_id AND p.id = NEW.product_id) THEN
    RAISE EXCEPTION 'product does not belong to the checkout merchant' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER checkout_items_same_merchant BEFORE INSERT OR UPDATE OF product_id, checkout_id ON checkout_items
  FOR EACH ROW EXECUTE FUNCTION checkout_item_same_merchant();

-- The pay transaction that settles a checkout (and failed attempts against it), and the refunds
-- against that order. The checkout must belong to the merchant: the payee of a pay, the payer of a
-- refund. At most one completed payment per checkout.
ALTER TABLE transactions ADD COLUMN checkout_id uuid REFERENCES checkouts (id) ON DELETE RESTRICT;
ALTER TABLE transactions ADD CONSTRAINT transactions_checkout_scope
  CHECK (checkout_id IS NULL OR type IN ('pay', 'refund'));

CREATE FUNCTION transactions_checkout_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.checkout_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM checkouts c
        WHERE c.id = NEW.checkout_id
          AND c.account_id = CASE NEW.type WHEN 'pay' THEN NEW.to_account_id
                                           WHEN 'refund' THEN NEW.from_account_id END) THEN
    RAISE EXCEPTION 'checkout does not belong to the merchant account'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER transactions_checkout_owner BEFORE INSERT OR UPDATE OF checkout_id ON transactions
  FOR EACH ROW EXECUTE FUNCTION transactions_checkout_owner();
CREATE UNIQUE INDEX transactions_checkout_paid_key
  ON transactions (checkout_id) WHERE type = 'pay' AND status = 'completed';
CREATE INDEX transactions_checkout_idx ON transactions (checkout_id) WHERE checkout_id IS NOT NULL;

-- Item refunds: the refund transaction records the lines it covers, as
-- [{"checkout_item_id": uuid, "quantity": int, "restock": bool}]. It is that refund's own record
-- (needed to approve, reject or audit it); the per-line totals live on checkout_items. restock puts
-- units back on the shelf when the refund completes.
ALTER TABLE transactions ADD COLUMN items jsonb;
ALTER TABLE transactions ADD CONSTRAINT transactions_items_refund_only
  CHECK (items IS NULL OR (type = 'refund' AND jsonb_typeof(items) = 'array'));

COMMIT;
