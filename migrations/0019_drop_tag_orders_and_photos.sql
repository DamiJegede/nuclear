-- Run after the code that uses `orders` and R2 images is deployed (and the uploaded images were copied to R2).
BEGIN;
DROP TABLE tag_orders;
DROP TABLE tag_model_photos;
COMMIT;
