-- The model the device reports about itself (iOS machine identifier such as iPhone16,2; on Android the manufacturer and Build.MODEL).
-- Unverified text for support screens: the admin portal maps known identifiers to their printed names.
ALTER TABLE public.devices ADD COLUMN model text;
ALTER TABLE public.devices ADD CONSTRAINT devices_model_check CHECK (model IS NULL OR length(model) BETWEEN 1 AND 64);
