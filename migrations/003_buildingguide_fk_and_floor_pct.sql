-- C-1: フロアホットスポットをパーセント保持できるように
ALTER TABLE building_guide_floors ADD COLUMN IF NOT EXISTS area_x_pct       double precision;
ALTER TABLE building_guide_floors ADD COLUMN IF NOT EXISTS area_y_pct       double precision;
ALTER TABLE building_guide_floors ADD COLUMN IF NOT EXISTS area_width_pct   double precision;
ALTER TABLE building_guide_floors ADD COLUMN IF NOT EXISTS area_height_pct  double precision;

ALTER TABLE building_guides ADD COLUMN IF NOT EXISTS base_width  integer;
ALTER TABLE building_guides ADD COLUMN IF NOT EXISTS base_height integer;

-- base_width/base_height が両方あるフロアは px から % を自動換算（未設定の pct のみ）
UPDATE building_guide_floors f
SET area_x_pct      = f.area_x::float      / g.base_width  * 100,
    area_y_pct      = f.area_y::float      / g.base_height * 100,
    area_width_pct  = f.area_width::float  / g.base_width  * 100,
    area_height_pct = f.area_height::float / g.base_height * 100
FROM building_guides g
WHERE f.building_guide_id = g.id
  AND g.base_width IS NOT NULL AND g.base_width > 0
  AND g.base_height IS NOT NULL AND g.base_height > 0
  AND f.area_x_pct IS NULL;

-- C-2: 店舗とビルガイドを外部キーで明示的に紐付ける
ALTER TABLE migrationshop ADD COLUMN IF NOT EXISTS building_guide_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_migrationshop_building_guide'
  ) THEN
    ALTER TABLE migrationshop
      ADD CONSTRAINT fk_migrationshop_building_guide
      FOREIGN KEY (building_guide_id)
      REFERENCES building_guides(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_migrationshop_building_guide_id
  ON migrationshop (building_guide_id);
