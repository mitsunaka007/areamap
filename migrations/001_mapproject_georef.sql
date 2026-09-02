-- MapProject: ジオリファレンス方式 + 撮影メタデータ
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS georef_mode        varchar(16) NOT NULL DEFAULT 'manual';
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS georef_mode2       varchar(16) NOT NULL DEFAULT 'manual';

ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS capture_center_lat  double precision;
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS capture_center_lng  double precision;
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS capture_zoom        double precision;
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS capture_width       integer;
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS capture_height      integer;
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS capture_dpr         double precision;

ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS capture_center_lat2 double precision;
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS capture_center_lng2 double precision;
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS capture_zoom2       double precision;
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS capture_width2      integer;
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS capture_height2     integer;
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS capture_dpr2        double precision;

-- 既存行は明示的に manual（server_default では既存行に入らない環境向けの保険）
UPDATE map_projects SET georef_mode  = 'manual' WHERE georef_mode  IS NULL;
UPDATE map_projects SET georef_mode2 = 'manual' WHERE georef_mode2 IS NULL;
