# AreaMap / MigrationMap

福井・岡山などの商店街向けエリアマップと、イラスト地図に OSM 店舗情報を重ねる
MigrationMap 機能を持つ Flask アプリケーション。

## 構成

| パス | 役割 |
|---|---|
| `app.py` | 単一エントリポイント。AreaMap・MigrationMap・問い合わせフォームの全ルート |
| `models.py` | SQLAlchemy モデル（Shop / MapProject / MapPoint / MigrationShop ほか） |
| `migrationmaps_geo.py` | アフィン変換・緯度経度⇔ピクセル変換 |
| `migrationmaps_osm.py` | Overpass API 経由の OSM 店舗取得 |
| `migrationmaps_basemap.py` | 方式A（サーバー側タイル合成）でのベース地図生成 |
| `forms.py` / `extensions.py` | WTForms 定義 / `db` インスタンス |
| `migrations/*.sql` | 手動適用の DB マイグレーション（`scripts/run_migration.py`） |
| `templates/` `static/` | Jinja2 テンプレートと静的アセット |
| `tests/` | pytest（`migrationmaps_geo` / `migrationmaps_osm` / affine 解決） |

## セットアップ

```bash
python -m venv .venv
.venv\Scripts\activate            # Windows
pip install -r requirements.txt
cp .env.example .env               # 各値を設定（最低 DATABASE_URL は必須）
```

## ローカル起動

```bash
# 開発用
flask --app app run --debug

# 本番相当
gunicorn app:app
```

`DATABASE_URL` が未設定だと起動時に `ValueError` になる。

## 環境変数

`.env.example` を参照。必須は `DATABASE_URL`。メール通知には `MAIL_*`、
画像を Cloudinary に載せる場合は `CLOUDINARY_*` 3 種、MigrationMap の方式A には
`BASEMAP_TILE_URL` が必要。

## DB マイグレーション

`migrations/` の SQL を番号順に適用する。

```bash
python scripts/run_migration.py migrations/001_mapproject_georef.sql
python scripts/run_migration.py migrations/002_migrationshop_osm.sql
python scripts/run_migration.py migrations/003_buildingguide_fk_and_floor_pct.sql
```

## テスト

```bash
python -m pytest -q
```

## デプロイ（Render）

- `Procfile` の `web: gunicorn app:app` を使用。
- Render の Environment に `.env.example` の各キーを設定。
- `runtime.txt` で Python バージョンを固定。
- `migrations/` の SQL は接続先 DB へ手動適用。

## ドキュメント

- `docs/AreaMap.md` — AreaMap 機能仕様
- `docs/MigrationMap.md` — MigrationMap 機能仕様
- `docs/prompts/` — 実装時の作業プロンプト（履歴用）
- `docs/superpowers/` — spec / plan
