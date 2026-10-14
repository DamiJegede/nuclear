-- Merchant product catalogue: categories and products.
-- Source of truth: docs/TABLES.md. Requires require_business_account() from 0002.

BEGIN;

CREATE TABLE categories (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,   -- the business
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id)                             -- composite ownership FK target for products
);
CREATE INDEX categories_account_id_idx ON categories (account_id);
CREATE TRIGGER categories_business_only BEFORE INSERT OR UPDATE OF account_id ON categories
  FOR EACH ROW EXECUTE FUNCTION require_business_account();
CREATE TRIGGER categories_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,  -- the business
  category_id uuid,                                                        -- NULL = uncategorised
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  currency    char(3) NOT NULL DEFAULT 'USD',
  price       bigint NOT NULL CHECK (price >= 0),                          -- integer minor units
  photo       text,                                                        -- image reference, not binary data
  stock       integer CHECK (stock >= 0),                                  -- NULL = stock not tracked
  active      boolean NOT NULL DEFAULT true,                               -- false = hidden from sale
  status      text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'sold_out')),
  total_sold  bigint NOT NULL DEFAULT 0 CHECK (total_sold >= 0),           -- units, all time
  sold_today  integer NOT NULL DEFAULT 0 CHECK (sold_today >= 0),          -- units, reset 00:00 Eastern
  discount    bigint NOT NULL DEFAULT 0,                                   -- minor units off price
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (discount >= 0 AND discount <= price),
  -- Tracked stock and status never disagree: sold_out exactly when stock is 0.
  CHECK (stock IS NULL OR ((stock = 0) = (status = 'sold_out'))),
  -- A product's category must belong to the same business.
  FOREIGN KEY (category_id, account_id) REFERENCES categories (id, account_id) ON DELETE RESTRICT
);
CREATE INDEX products_account_id_idx ON products (account_id);
CREATE INDEX products_category_id_idx ON products (category_id) WHERE category_id IS NOT NULL;
CREATE TRIGGER products_business_only BEFORE INSERT OR UPDATE OF account_id ON products
  FOR EACH ROW EXECUTE FUNCTION require_business_account();

-- With tracked stock, status follows it: reaching 0 flags sold_out, restocking above 0 makes the
-- product available again. Untracked products (stock NULL) keep a manually set status.
CREATE FUNCTION products_sync_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stock IS NOT NULL THEN
    NEW.status := CASE WHEN NEW.stock = 0 THEN 'sold_out' ELSE 'available' END;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER products_sync_status BEFORE INSERT OR UPDATE OF stock, status ON products
  FOR EACH ROW EXECUTE FUNCTION products_sync_status();
CREATE TRIGGER products_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
