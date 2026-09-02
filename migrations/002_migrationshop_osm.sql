-- MigrationShop: OSM 由来カラム + email を NULL 許可 + (osm_type, osm_id) ユニーク
ALTER TABLE migrationshop ADD COLUMN IF NOT EXISTS osm_type       varchar(8);
ALTER TABLE migrationshop ADD COLUMN IF NOT EXISTS osm_id         bigint;
ALTER TABLE migrationshop ADD COLUMN IF NOT EXISTS source         varchar(16) NOT NULL DEFAULT 'manual';
ALTER TABLE migrationshop ADD COLUMN IF NOT EXISTS osm_synced_at  timestamp without time zone;

UPDATE migrationshop SET source = 'manual' WHERE source IS NULL;

ALTER TABLE migrationshop ALTER COLUMN email DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_migrationshop_osm'
  ) THEN
    ALTER TABLE migrationshop
      ADD CONSTRAINT uq_migrationshop_osm UNIQUE (osm_type, osm_id);
  END IF;
END $$;
