-- Photos are stored as R2 keys only (`<folder>/<id>-<epoch ms>.<png|jpg>` in the bucket nuclear-images); the API builds the full URL.
--  * tag_models.photo and shop.photo held just the file name: the folder is now part of the key.
--  * Anything that is not a key (old free-text addresses) is cleared.
--  * A CHECK on every photo column keeps it that way.
BEGIN;

UPDATE tag_models SET photo = 'tags/' || photo WHERE photo ~ '^[0-9a-f-]{36}-[0-9]+\.png$';
UPDATE shop       SET photo = 'shop/' || photo WHERE photo ~ '^[0-9a-f-]{36}-[0-9]+\.png$';

UPDATE tag_models SET photo = NULL WHERE photo IS NOT NULL AND photo !~ '^tags/[0-9a-f-]{36}-[0-9]+\.(png|jpg)$';
UPDATE shop       SET photo = NULL WHERE photo IS NOT NULL AND photo !~ '^shop/[0-9a-f-]{36}-[0-9]+\.(png|jpg)$';
UPDATE accounts   SET photo = NULL WHERE photo IS NOT NULL AND photo !~ '^accounts/[0-9a-f-]{36}-[0-9]+\.(png|jpg)$';
UPDATE wallets    SET photo = NULL WHERE photo IS NOT NULL AND photo !~ '^wallets/[0-9a-f-]{36}-[0-9]+\.(png|jpg)$';
UPDATE products   SET photo = NULL WHERE photo IS NOT NULL AND photo !~ '^products/[0-9a-f-]{36}-[0-9]+\.(png|jpg)$';

ALTER TABLE tag_models ADD CONSTRAINT tag_models_photo_key CHECK (photo IS NULL OR photo ~ '^tags/[0-9a-f-]{36}-[0-9]+\.(png|jpg)$');
ALTER TABLE shop       ADD CONSTRAINT shop_photo_key       CHECK (photo IS NULL OR photo ~ '^shop/[0-9a-f-]{36}-[0-9]+\.(png|jpg)$');
ALTER TABLE accounts   ADD CONSTRAINT accounts_photo_key   CHECK (photo IS NULL OR photo ~ '^accounts/[0-9a-f-]{36}-[0-9]+\.(png|jpg)$');
ALTER TABLE wallets    ADD CONSTRAINT wallets_photo_key    CHECK (photo IS NULL OR photo ~ '^wallets/[0-9a-f-]{36}-[0-9]+\.(png|jpg)$');
ALTER TABLE products   ADD CONSTRAINT products_photo_key   CHECK (photo IS NULL OR photo ~ '^products/[0-9a-f-]{36}-[0-9]+\.(png|jpg)$');

COMMIT;
