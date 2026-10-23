-- Orbs register themselves when first claimed. The Orb's own UID (its MAC address) is how a terminal
-- identifies it over BLE; id stays the primary key. Written when the orbs table had no rows.
-- Source of truth: docs/TABLES.md.

BEGIN;

-- MAC address, normalized to 12 uppercase hex characters (no separators).
ALTER TABLE orbs ADD COLUMN uid text NOT NULL;
ALTER TABLE orbs ADD CONSTRAINT orbs_uid_format CHECK (uid ~ '^[0-9A-F]{12}$');
ALTER TABLE orbs ADD CONSTRAINT orbs_uid_key UNIQUE (uid);

COMMIT;
