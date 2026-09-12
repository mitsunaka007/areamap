-- capture-first ジオリファレンス: 枠を先に確定して draft プロジェクトを作る方式
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS basemap_name varchar(64);
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'ready';
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS corner_nw_lat double precision;
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS corner_nw_lng double precision;
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS corner_ne_lat double precision;
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS corner_ne_lng double precision;
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS corner_se_lat double precision;
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS corner_se_lng double precision;
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS corner_sw_lat double precision;
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS corner_sw_lng double precision;
ALTER TABLE map_projects ADD COLUMN IF NOT EXISTS captured_at timestamp;

-- basemap_name は「未設定(NULL)は何個あってもよいが、設定したら重複禁止」
CREATE UNIQUE INDEX IF NOT EXISTS uq_map_projects_basemap_name
  ON map_projects (basemap_name)
  WHERE basemap_name IS NOT NULL;

-- 既存行はすべて 'ready'（DEFAULT により ADD COLUMN 時点で自動的に埋まるが明示しておく）
UPDATE map_projects SET status = 'ready' WHERE status IS NULL;
