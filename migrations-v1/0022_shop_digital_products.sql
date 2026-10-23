-- Shop items are either physical (shipped, needs a shipping address) or digital (a file the buyer downloads after paying).
--  * shop.kind: 'physical' (default) or 'digital'. A digital item has no stock and needs its file before it can be available.
--  * shop.file: the key of the downloadable file in the private bucket nuclear-uploads (downloads/<item id>-<epoch ms>.<ext>).
--  * orders.delivery: 'ship' (needs shipping) or 'download'; shipping is NULL exactly when delivery = 'download'.
BEGIN;

ALTER TABLE shop ADD COLUMN kind text NOT NULL DEFAULT 'physical' CHECK (kind IN ('physical', 'digital'));
ALTER TABLE shop ADD COLUMN file text CHECK (file IS NULL OR file ~ '^downloads/[0-9a-f-]{36}-[0-9]+\.[a-z0-9]{1,5}$');
ALTER TABLE shop ADD CONSTRAINT shop_file_digital CHECK (kind = 'digital' OR file IS NULL);
ALTER TABLE shop ADD CONSTRAINT shop_digital_no_stock CHECK (kind = 'physical' OR stock IS NULL);
ALTER TABLE shop ADD CONSTRAINT shop_digital_needs_file CHECK (kind = 'physical' OR status <> 'available' OR file IS NOT NULL);

ALTER TABLE orders ADD COLUMN delivery text NOT NULL DEFAULT 'ship' CHECK (delivery IN ('ship', 'download'));
ALTER TABLE orders ALTER COLUMN shipping DROP NOT NULL;
ALTER TABLE orders ADD CONSTRAINT orders_delivery_shipping CHECK ((delivery = 'ship') = (shipping IS NOT NULL));
ALTER TABLE orders ADD CONSTRAINT orders_download_is_shop CHECK (delivery = 'ship' OR type = 'shop');

COMMIT;
