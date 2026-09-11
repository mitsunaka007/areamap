# MigrationMaps 仕様書

> 対象コミット: `git@github.com:mitsunaka007/areamap.git` / `main`（`1ca71e1 chore: clean import of AreaMap/MigrationMap Flask app` ＋ 作業ツリー変更: テナントビル既定画像対応、および公開ページのナビゲーション拡張〔現在地FAB・目的地設定・OSRM経路案内・方向通知・マーカー展開表示〕）
> このドキュメントはリポジトリ内の実装（`app.py` / `models.py` / `migrationmaps_*.py` / `migrations/*.sql` / `templates/migrationmaps/` / `static/migrationmaps/` / `tests/`）から起こした現状仕様である。

---

## 1. 概要

MigrationMaps（コード上のプレフィックスは `migrationmaps_`、機能名としては MigrationMap）は、**手描き・印刷済みの「イラスト地図」画像を描き直すことなく実世界の地図（OpenStreetMap / Leaflet）へ位置合わせして重ね合わせ**、スマートフォンで開くと GPS 連動で現在地をイラスト地図上に表示する「歩ける案内MAP」を作成・公開する機能である。

観光マップ・商店街の回遊マップ・商業施設のフロア案内など、紙の地図資産をそのままナビゲーションUIとして再利用することを目的とする。AreaMap 本体と同じ Flask アプリ（`app.py`、Blueprint 不使用の単一ファイル）に同居する。

主要素:

- **ジオリファレンス**: イラスト地図ピクセル座標 → 実世界座標（EPSG:3857）へのアフィン変換係数 `a〜f` を推定する。4つの方式（`manual` / `auto` / `shift` / `similar`）をサポート。
- **2レイヤー**: 1プロジェクトに画像＋アフィン係数を最大2セット保持し、時刻で自動切り替え（昼夜・時間帯マップ）。
- **公開ページの現在地連動**: `navigator.geolocation.watchPosition` でイラスト地図上にリアルタイムマーカー表示。地図右下の現在地 FAB とヘッダーボタンの両方で ON/OFF できる。
- **目的地設定と経路案内**: ボトムシートから店舗（テナントビル）を目的地に設定すると、OSRM（`router.project-osrm.org`、徒歩プロファイル）に問い合わせて現在地からの経路線を地図上に描画。取得できない場合は目的地までの直線（点線）にフォールバックする。クライアント JS 完結の機能で、サーバー側 API・DB スキーマの変更はない。
- **接近時の方向通知・マーカー展開**: 目的地に近づくと「正面 / 右斜め前 / 左側」などの相対方角つきトーストと振動で知らせ、到着（10m以内）で自動解除。現在地から20m以内の店舗マーカーは店名ラベルを自動展開する。
- **店舗（テナント）管理**: イラスト地図に紐づく店舗を登録し、公開ページにマーカー表示。手動登録と OSM（Overpass API）からの取り込みの両方に対応。
- **建物ガイド**: 1棟に複数フロアがある建物向けの、フロア別ホットスポット付き案内画像。`BuildingGuide` レコードが無くても、同一緯度経度に複数店舗が入居するテナントビルなら既定のビル画像（`static/img/migrationmaps_buildingimage.jpg`）でフロア案内を表示する。

---

## 2. アーキテクチャ / ファイル構成

座標計算は Flask/DB に依存しない純関数モジュールに切り出し、`app.py` は薄いルート層とする。スキーマ変更は手書きの冪等 SQL（`migrations/*.sql`）＋実行スクリプトで適用する（Alembic / Flask-Migrate は不使用）。

| パス | 責務 |
|---|---|
| `app.py` | 全ルート。MigrationMaps のルートは `/migrationmaps/*` と `/api/migrationmaps/*`。`_project_bbox` / `_project_bbox_padded`（OSM 検索用の外周マージン付き bbox）/ `_image_url_from_filename` ヘルパを持つ |
| `models.py` | SQLAlchemy モデル。MigrationMaps 用: `MapProject` / `MapPoint` / `MigrationShop` / `MapShopImages` / `BuildingGuide` / `BuildingGuideFloor` |
| `migrationmaps_geo.py` | 座標変換・アフィン/相似フィッティングの純関数（Flask/DB 非依存、pytest 対象）。座標系は EPSG:3857（Web メルカトル・メートル、`_R = 6378137.0`）。`bbox_with_margin(...)` で bbox の外周マージン換算も担う |
| `migrationmaps_osm.py` | Overpass API のクエリ組み立て・POST・リトライ・24時間プロセス内キャッシュ、OSM タグ → `MigrationShop` フィールドのマッピング |
| `migrationmaps_basemap.py` | 方式A: OSM タイル取得＋Pillow 合成による 1 枚のベース地図 PNG 生成 |
| `extensions.py` | `db = SQLAlchemy()` インスタンス |
| `templates/migrationmaps/` | `lp.html`（サービス紹介LP）/ `admin.html`（管理画面）/ `public.html`（公開ページ） |
| `static/migrationmaps/` | `admin.css` / `admin.js` / `public.js`（公開ページのクライアント挙動〔ナビゲーション拡張含む〕は 5.1 参照） |
| `static/img/migrationmaps_buildingimage.jpg` | `BuildingGuide` 未登録のテナントビル向けの既定ビル画像（`public.js` の `DEFAULT_BUILDING_IMAGE_URL`） |
| `migrations/001_mapproject_georef.sql` | `MapProject` に georef / capture カラムを追加 |
| `migrations/002_migrationshop_osm.sql` | `MigrationShop` に OSM 由来カラム追加、`email` を NULL 許可、`(osm_type, osm_id)` ユニーク制約 |
| `migrations/003_buildingguide_fk_and_floor_pct.sql` | `MigrationShop.building_guide_id` FK、`BuildingGuideFloor.area_*_pct`、`BuildingGuide.base_width/base_height` を追加 |
| `scripts/run_migration.py` | 1 つの `.sql` を `DATABASE_URL` に 1 トランザクションで適用する CLI |
| `scripts/backfill_building_guide_id.py` | 既存店舗に半径30m以内の最近傍 `BuildingGuide` を割り当てる移行スクリプト |
| `tests/test_migrationmaps_geo.py` / `tests/test_resolve_affine.py` / `tests/test_migrationmaps_osm.py` | pytest 単体テスト（`app` を import しない。`requests` はモック）。全体で 42 passed |

### 技術構成

- バックエンド: Python Flask 3.1 / SQLAlchemy 2.0 / Flask-SQLAlchemy / PostgreSQL（psycopg2）
- フロント: Jinja2 テンプレート＋素の JS。地図表示は Leaflet 1.9.4（+ ImageOverlay / DistortableImage 拡張）
- 数値計算: NumPy（`numpy.linalg.lstsq`。`migrationmaps_geo` 内で遅延 import）
- 画像処理: Pillow（アップロード画像のサイズ取得、方式A のタイル合成）
- 店舗取得: OpenStreetMap Overpass API（`requests`）
- 画像保存: ローカルディレクトリ（既定）／ Cloudinary（環境変数が揃った場合）

---

## 3. データモデル（`models.py`）

### 3.1 `MapProject` — `map_projects`

イラスト地図プロジェクト本体。

| カラム | 型 / 制約 | 用途 |
|---|---|---|
| `id` | PK | |
| `name` | Text, NOT NULL | 地図名 |
| `image_filename` | Text, NOT NULL | レイヤー1画像。ローカル保存名、または Cloudinary のフルURL |
| `image_width` / `image_height` | Integer, NOT NULL | レイヤー1画像のピクセルサイズ |
| `a` `b` `c` `d` `e` `f` | Float, NOT NULL | レイヤー1のアフィン係数（画像 px → EPSG:3857 m） |
| `image_filename2` / `image_width2` / `image_height2` | nullable | レイヤー2画像（任意） |
| `a2`〜`f2` | Float, nullable | レイヤー2のアフィン係数（任意） |
| `georef_mode` / `georef_mode2` | String(16), NOT NULL, default `'manual'` | ジオリファレンス方式（`manual` / `auto` / `shift` / `similar`） |
| `capture_center_lat` / `capture_center_lng` / `capture_zoom` | Float, nullable | 撮影／ベース地図生成時の中心・ズーム（レイヤー1） |
| `capture_width` / `capture_height` | Integer, nullable | 撮影時コンテナの CSS px（レイヤー1） |
| `capture_dpr` | Float, nullable | 撮影時 devicePixelRatio（レイヤー1） |
| `capture_*2`（同6項目） | nullable | 同上（レイヤー2） |
| `switch_time_1to2` / `switch_time_2to1` | String(5), nullable | レイヤー自動切替時刻 `"HH:MM"`（JST） |
| `created_at` | DateTime, NOT NULL, default `utcnow` | |

リレーション: `points`（`MapPoint`, cascade all/delete-orphan）、`shops`（`MigrationShop`, `passive_deletes=True`）。

### 3.2 `MapPoint` — `map_points`

アフィン推定に用いる、画像座標 ⇔ 実座標の対応点。

| カラム | 型 / 制約 | 用途 |
|---|---|---|
| `project_id` | FK `map_projects.id` ON DELETE CASCADE, NOT NULL | |
| `label` | Text, NOT NULL | `center` / `p1` / `p2` / … |
| `kind` | Text, NOT NULL | `center` または `point` |
| `layer` | Integer, NOT NULL, server_default `'1'` | 1 or 2 |
| `img_x` / `img_y` | Float, NOT NULL | 画像内ピクセル座標 |
| `lat` / `lng` | Float, NOT NULL | 対応する緯度経度 |

### 3.3 `MigrationShop` — `migrationshop`

イラスト地図に紐づく店舗（テナント）。

| カラム | 型 / 制約 | 用途 |
|---|---|---|
| `id` | PK | |
| `shopname` | Text, NOT NULL | 店名 |
| `address` | Text, NOT NULL | 住所 |
| `floorlevel` | String(20) | 階層表記（例 `1F` / `B1F`） |
| `tel` | String(50) | |
| `email` | String(255), **NULL 許可**（002 で NOT NULL 解除） | |
| `instagram_account` | String(255) | アカウント名（URL からは末尾を抽出） |
| `lat` | Numeric(10,7), NOT NULL | |
| `lng` | Numeric(11,7), NOT NULL | |
| `is_active` | Boolean, NOT NULL, default `True` | 稼働中フラグ |
| `description` | Text | |
| `website_url` | String(255) | |
| `osm_type` | String(8) | `node` / `way` / `relation`（OSM 由来のみ） |
| `osm_id` | BigInteger | OSM 要素 ID |
| `source` | String(16), NOT NULL, server_default `'manual'` | `manual` / `osm` |
| `osm_synced_at` | DateTime | 最終 OSM 同期時刻 |
| `map_project_id` | FK `map_projects.id` ON DELETE SET NULL, nullable | 紐づくイラスト地図 |
| `building_guide_id` | FK `building_guides.id` ON DELETE SET NULL, nullable, index | 建物ガイドとの明示的な紐付け（C-2。緯度経度文字列一致は廃止） |
| `created_at` / `updated_at` | DateTime, NOT NULL, default `now` | |

制約: `UniqueConstraint(osm_type, osm_id)` = `uq_migrationshop_osm`。
リレーション: `shopimages`（`MapShopImages`, cascade all/delete-orphan, `order_by=sort_order`）。

### 3.4 `MapShopImages` — `mapshopimages`

店舗画像（最大5枚）。

| カラム | 型 / 制約 | 用途 |
|---|---|---|
| `migrationshop_id` | FK `migrationshop.id` ON DELETE CASCADE, NOT NULL | |
| `image_url` | String(255), NOT NULL | 配信URL（`/migrationshop_uploads/<file>`） |
| `sort_order` | Integer, NOT NULL, default 1 | 1〜5 |
| `created_at` | DateTime, NOT NULL, default `now` | |

制約: `UniqueConstraint(migrationshop_id, sort_order)` = `uq_mapshopimages_shop_sort`、`CheckConstraint(1 <= sort_order <= 5)` = `ck_mapshopimages_sort_order_1_5`。

### 3.5 `BuildingGuide` — `building_guides`

建物単位の全体案内図（フロアガイドの親）。

| カラム | 型 / 制約 | 用途 |
|---|---|---|
| `map_project_id` | FK `map_projects.id` ON DELETE SET NULL | |
| `lat` / `lng` | Numeric, NOT NULL | 建物位置 |
| `building_name` | String(255) | |
| `image_url` | String(255), NOT NULL | ビル全体写真 |
| `base_width` / `base_height` | Integer, nullable | ホットスポット px→% 換算の基準（作図時のガイド画像サイズ） |
| `is_active` | Boolean, NOT NULL, default `True` | |
| `created_at` / `updated_at` | DateTime, NOT NULL, default `now` | |

リレーション: `floors`（`BuildingGuideFloor`, cascade all/delete-orphan, `order_by=sort_order`）。

### 3.6 `BuildingGuideFloor` — `building_guide_floors`

建物ガイド画像内の、フロアごとのホットスポット領域。

| カラム | 型 / 制約 | 用途 |
|---|---|---|
| `building_guide_id` | FK `building_guides.id` ON DELETE CASCADE, NOT NULL | |
| `floorlevel` | String(20), NOT NULL | `1F` / `2F` / `3F` … |
| `area_x` / `area_y` / `area_width` / `area_height` | Integer, NOT NULL | 画像内の矩形（px） |
| `area_x_pct` / `area_y_pct` / `area_width_pct` / `area_height_pct` | Float, nullable | 同矩形の % 表現（0〜100）。**非 null ならこちらを優先描画（C-1）** |
| `sort_order` | Integer, NOT NULL, default 1 | |

---

## 4. ジオリファレンス（`migrationmaps_geo.py`）

### 4.1 座標系と基本変換

内部計算は非線形性を避けるため、緯度経度（EPSG:4326）を Web メルカトル（EPSG:3857、メートル）に変換してから行う。地球半径 `_R = 6378137.0`、赤道周長 `_EARTH_CIRCUMFERENCE = 2πR`、`_TILE_SIZE = 256`、緯度1度の距離 `_M_PER_DEG_LAT = 111320.0`。

| 関数 | 内容 |
|---|---|
| `_lonlat_to_mercator(lon, lat)` | EPSG:4326 → EPSG:3857。緯度は ±85.05112878° でクリップ |
| `_mercator_to_lonlat(x, y)` | EPSG:3857 → EPSG:4326 |
| `_img_to_latlng(a,b,c,d,e,f, x, y)` | アフィン係数で画像座標 → `(lat, lng)`。`X = a·x + b·y + c`, `Y = d·x + e·y + f` |
| `res_at_zoom(z)` | ズーム `z`（float 可）での 1 CSS px あたりの解像度 [m/px] = `_EARTH_CIRCUMFERENCE / (256·2^z)` |
| `bbox_with_margin(sw_lat, sw_lng, ne_lat, ne_lng, margin_m)` | bbox を四方へ `margin_m` メートル拡張。緯度は `_M_PER_DEG_LAT` 換算、経度は bbox 中心緯度の `cos` 補正、緯度 ±90 / 経度 ±180 クランプ、中心が極の真上（`cos≈0`）なら経度は `±180`。`margin_m <= 0` は入力 bbox をそのまま返す。OSM 検索 bbox（`_project_bbox_padded`）専用 |

アフィン変換式（`(x, y)` = 画像ピクセル、`(X, Y)` = WebMercator メートル）:

```
X = a*x + b*y + c
Y = d*x + e*y + f
```

係数 `a〜f` により縮尺・回転・平行移動をまとめて決定する。

### 4.2 4つの `georef_mode`

`resolve_affine(mode, pts_xy, pts_ll, cap, image_width, image_height)` が方式に応じて 6 パラメータを返す（失敗時 `ValueError`）。

| mode | 必要な対応点 | 計算 | 実装 |
|---|---|---|---|
| `manual` | 中心＋他2点以上（合計 **3点以上**） | WebMercator 空間でフルアフィンを最小二乗（3点ちょうどは連立、4点以上は `numpy.linalg.lstsq`） | `_fit_affine` |
| `auto` | 0点 | 撮影メタデータ（`capture_center_lat/lng/zoom` ＋ 画像サイズ）から解析的に算出。回転なし・スケールは `res(z)/k`（`k` = 画像幅 / 撮影コンテナ CSS 幅、`capture_width` 優先、なければ `capture_dpr`、どちらもなければ 1） | `affine_from_capture` |
| `shift` | 1点 | `auto` のスケールを固定し、平行移動 `c, f` だけを 1 点で合わせ直す | `fit_shift_only` |
| `similar` | 2点 | 回転を許さない相似変換（未知数 `s, tx, ty`）を最小二乗。返り値は `(s, 0, tx, 0, -s, ty)` | `fit_similarity_no_rotation` |

- `auto` / `shift` / `similar` は `cap` に `center_lat` / `center_lng` / `zoom` が揃っていないと `ValueError`。
- `extract_capture(data, suffix)` が save リクエスト dict から `capture_*{suffix}`（`suffix` は `""` か `"2"`）を取り出し、`center_lat` / `center_lng` / `zoom` / `width` / `height` / `dpr` に正規化する。空文字・未指定は `None`。

### 4.3 2レイヤー（昼夜／時間帯切り替え）

- 1プロジェクトに画像＋アフィン係数の組を最大2セット。**レイヤー1は必須**、レイヤー2は任意。
- レイヤー2が有効化される条件（`api_migrationmaps_save`）: `image_filename2` があり、かつ `(レイヤー2の対応点が3点以上 または georef_mode2 != "manual")`。条件を満たさなければ `a2〜f2` は `null` のまま保存。
- `switch_time_1to2` / `switch_time_2to1`（`"HH:MM"` JST）を設定すると、公開ページ側 JS が現在時刻から表示レイヤーを判定し、アニメーション付きで切り替える。

### 4.4 方式A: サーバー側ベース地図生成（`migrationmaps_basemap.py`）

イラストを描き起こす前の「下絵」として、中心・整数ズーム・出力サイズから OSM タイルを合成した 1 枚の PNG を生成する。作図者はこの PNG の上にイラストを描いて同サイズでアップロードすれば、`georef_mode = "auto"` で対応点なしに位置合わせできる。

- `generate_basemap(center_lat, center_lng, zoom, width, height, tile_url, user_agent, sleep_s=0.0)` → PNG バイト列。
- `tile_url` は `{z}/{x}/{y}` を含むテンプレート（`{s}` サブドメイン非対応）。
- `_project_px(lat, lng, zoom)` で緯度経度をグローバルピクセルへ、必要なタイル範囲を計算し `requests.Session` で取得、`Image.paste` でキャンバスに貼り、中心基準でクロップ。
- 出力上限 `MAX_OUTPUT_PX = 4096`。タイル取得タイムアウトは connect 10s / read 60s。`sleep_s > 0` でタイル取得ごとにスリープ（OSM 公式タイルを開発利用する場合の礼儀）。
- `BASEMAP_TILE_URL` 未設定時、エンドポイント `/api/migrationmaps/basemap` は **503**。

---

## 5. 画面・ルーティング（`app.py`）

| メソッド | パス | 実装関数 | 内容 |
|---|---|---|---|
| GET | `/migrationmaps/lp` | `migrationmaps_lp` | サービス紹介 LP（`templates/migrationmaps/lp.html`） |
| GET | `/migrationmaps/admin` | `migrationmaps_admin` | 管理画面（地図アップロード・点登録・店舗登録）。`?project_id=` で編集 |
| GET | `/migrationmaps/m/<int:project_id>` | `migrationmaps_public` | 公開ページ（イラスト地図＋現在地連動表示） |
| GET | `/migrationmaps/uploads/<path:filename>` | `migrationmaps_uploaded_file` | ローカル保存されたイラスト地図画像の配信 |
| GET | `/migrationmaps/shop_uploads/<path:filename>` | `migrationshop_uploaded_file` | 店舗画像の配信 |

### 5.1 公開ページのクライアント挙動（`static/migrationmaps/public.js`）

`/migrationmaps/m/<project_id>` を開くと、`public.js` が `/api/migrationmaps/<id>` と `/api/migrationmaps/<id>/overlay_bounds` を並列取得し、続いて `/api/migrationmaps/<id>/shops` を読み込む。

- **Leaflet ペイン構成（z-index 順）**: 200 OSM タイル / 300 `maskPane`（イラスト地図の外側を隠すマスク）/ 450 `layer1OverlayPane` / 451 `layer2OverlayPane` / 600 `routePane`（経路線、`pointerEvents: none`）/ 650 `migrationMarkerPane`（店舗・現在地マーカー）。`routePane` はオーバーレイ（451）より上・マーカー（650）より下に置かないと、経路線がイラスト地図の下に隠れる。
- **オーバーレイ配置**: `distortable_corners`（無ければ `image_corners`）から `L.imageOverlay` を作成（不透明度 `OVERLAY_OPACITY = 0.88`）。イラスト地図四隅の外側はマスクポリゴンで塗り潰す。画像アスペクト比と表示範囲に合わせて `applyMapSize()` / `fitMapForViewport()` が地図の高さ・ズーム・`maxBounds` を固定する。
- **2レイヤーの時刻切替**: `computeTargetLayer()` が `switch_time_1to2` / `switch_time_2to1` と現在時刻から対象レイヤーを判定（日またぎ対応）。`transitionToLayer()` が `TRANSITION_DURATION_MS = 10000`（10 秒）の `requestAnimationFrame` フェードで切り替える。起動 2 秒後に一度チェックし、以後毎分 `setInterval`。レイヤー2が存在するときのみ右上に手動切替ボタンを表示。
- **店舗マーカーとグルーピング**: 店舗を `latLngGroupKey`（`lat` / `lng` を小数7桁に丸めた文字列）でグループ化し、**グループごとに 1 マーカー**を立てる。各マーカーの状態は `markerStates: Map<groupKey, {mode, expanded}>` で保持し、`buildMarkerIcon()` が `mode`（`normal` / `active` / `dimmed`）と `expanded`（店名ラベル表示）を合成して1つの `L.divIcon` を作る。マーカークリックで当該マーカーを ★ アイコン（active）、他をドット（dimmed）にし（`setMarkerMode()`）、`showBuildingGuide()` でボトムシートを開く。`setIcon` は状態が変化したときだけ呼ぶ（毎回呼ぶとチラつき・クリック取りこぼしが起きるため）。
  - **近接時の店名展開**: 現在地から `MARKER_EXPAND_METERS = 20`m 以内の店舗マーカーは、位置更新のたびに `updateMarkerExpansion()` が `expanded = true` にし、店名（複数店舗なら `+N` 件数付き）を吹き出しラベルで表示する。ボトムシートを閉じても（`resetMarkerIcons()` は選択状態＝`mode`のみを戻す）展開表示は保持される。現在地表示を OFF にすると `collapseAllMarkers()` で全て畳む。
- **ビルガイド（ボトムシート `#buildingGuide`）**: グループ先頭店舗の `building_guide` を参照して表示内容を決める。
  - `building_guide.image_url` があればそれをビル画像として表示。
  - `building_guide` が無くても、**同一緯度経度に複数店舗が入居するテナントビル（グループ 2 件以上）なら既定画像 `/static/img/migrationmaps_buildingimage.jpg`（`DEFAULT_BUILDING_IMAGE_URL`）を使い**、フロアホットスポット表示に切り替える。グループが 1 件だけのときは従来どおり店舗カードのみ。
  - **フロアホットスポット**: `building_guide.floors` の矩形は `area_*_pct`（0〜100）を優先、無ければ `area_*`（px）。ガイドに無いフロア（店舗の `floorlevel` から補完）は、ビル画像の左端に縦へ等間隔で自動配置する（`getFloorDisplayOrder()`）。フロアはフロア番号の昇順にソート。ホットスポットをクリックすると、その階の店舗カード群（店名・階・住所・TEL・Instagram ＋ 画像グリッド最大5枚）を下部に描画する。
  - シートを開くと表示中グループを `guideGroupKey` / `guideGroupShops` に記憶し、目的地ボタン（`#btnSetDestination`、後述）の表示・ラベルを同期する（`syncDestinationButton()`）。
- **現在地連動**: `navigator.geolocation.watchPosition`（`enableHighAccuracy`, `maximumAge: 1000`）。位置更新は `onGeoPosition()` が入口となり、既存の現在地表示処理（`updateLocationInsideBounds()`）→ ナビ拡張処理（進行方向・マーカー展開・目的地通知・経路再取得）の順で呼ぶ。現在地がイラスト地図の bbox 内なら現在地マーカー＋精度円を表示、範囲外は非表示。`PROXIMITY_METERS = 50` 以内に店舗グループがあれば自動でビルガイドを開く（`checkProximityToShops()`、ナビ拡張前から不変）。ユーザーが × でガイドを閉じると、離れるまで自動再表示を抑制する。
  - **ON/OFF の入口が2つ**: ヘッダーの `#btnToggleLocation` と、地図右下の Leaflet コントロール（`.location-fab`、`LocationToggleControl`）。どちらも `setLocationEnabled()` を経由し、`updateLocationButtons()` が両方の表示（テキスト・`is-on` クラス）を同期する。既定 OFF。
  - OFF にすると（`stopLocationWatch()`）、現在地マーカーに加えて **経路線・展開マーカー・通知トーストもまとめてクリア**する。**目的地の設定自体は解除しない**（再度 ON にすると経路が引き直される）。
- **目的地設定と経路案内**（ナビゲーション拡張。サーバー API・DB 変更なし、`public.js` / `public.html` のみで完結）:
  - ボトムシートの `#btnSetDestination` ボタンで、表示中のグループ（テナントビル）を目的地に設定／解除する（`setDestination()` / `clearDestination()`）。目的地は `{ key, lat, lng, name }` で保持し、`name` は `building_guide.building_name` → `shopname` の順に採用。
  - 目的地が設定されると画面上部に `#navBanner`（目的地名と概算距離、現在地 OFF 時はその旨を表示、`#navBannerClear` で解除）を表示する。
  - **経路取得**: `fetchRoute()` が OSRM（`https://router.project-osrm.org/route/v1/foot/...`、`overview=full&geometries=geojson`、8秒でタイムアウト）に問い合わせ、成功すれば `drawRoute()` が `routePane` に実線ポリラインを描画。失敗時は現在地→目的地の直線を点線で描き、`#navToast` で「経路が取得できないため直線で表示しています」と通知する。
  - **公開デモサーバへの配慮**: `refreshRoute()` が `ROUTE_MIN_INTERVAL_MS = 15000`（15秒）かつ `ROUTE_MIN_MOVE_M = 25`（25m以上移動）を満たすまで再問い合わせを間引く（`force=true` の目的地設定直後のみ即時取得）。リクエストには連番 `routeSeq` を振り、古い応答は破棄する。
  - **方向通知**: `updateHeading()` が端末の `coords.heading`（多くの端末で `null`）を優先し、無ければ直近の座標差分（`HEADING_MIN_MOVE_M = 5`m 以上の移動）から `bearingDeg()` で進行方向を推定する。`HEADING_STALE_MS = 20000` を超えると方向情報を「古い」とみなす。
  - **接近時のトースト**: 目的地まで `ARRIVE_NOTICE_METERS = 30`m 以内で、進行方向が新鮮なら「〇〇は右斜め前です（約15m）」のように `relativeSideLabel()`（正面/右斜め前/右側/右斜め後ろ/後ろ…の8方位相当）付きで、古ければ「〇〇まで約15m」で通知（`NOTICE_REPEAT_MS = 10000` ごと・内容変化時に振動 `navigator.vibrate`）。`ARRIVED_METERS = 10`m 以内で到着トースト＋振動＋目的地自動解除。
  - **既知の注意点**: `router.project-osrm.org` は実運用では car プロファイル中心のため `/foot/` でも車道ベースの経路が返ることがある（実測して歩行者向けでなければ直線フォールバックに寄せる、または OpenRouteService 等への差し替えを検討）。近接自動表示（`checkProximityToShops`, 50m）とマーカー展開（20m）は独立ロジックのため、目的地へ移動中に別ビルのシートが自動で開くことがある。
- **帰属表示**: フッターとビルガイド内に OpenStreetMap / ODbL クレジットを常時表示。

---

## 6. API 仕様（`app.py`、すべて Blueprint 不使用）

### 6.1 画像・Cloudinary

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/migrationmaps/cloudinary-folders` | Cloudinary のルートフォルダ一覧（`{name, path}`）。Cloudinary 未設定時は 503 |
| GET | `/api/migrationmaps/cloudinary-images?folder=` | 指定フォルダ（省略時は全体）の画像一覧（`secure_url` / `public_id` / `width` / `height` / `display_name`）。新形式 `resources_by_asset_folder` を試し、失敗時 `prefix` にフォールバック。未設定時 503 |
| POST | `/api/migrationmaps/upload` | `multipart/form-data`（`file`, `name`）。拡張子は `.png/.jpg/.jpeg/.webp`。Cloudinary 有効時は `folder="migrationmaps"` にアップロードしフル URL を `image_filename` に、無効時はローカル `MIGRATIONMAPS_UPLOAD_DIR` に `<stem>_<uuid><ext>` で保存。返却: `image_url` / `image_filename` / `image_width` / `image_height` |

### 6.2 プロジェクト

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/migrationmaps/save` | プロジェクトの新規作成／更新。JSON で `name` / `image_filename` / `image_width` / `image_height`（必須）、`points`、`georef_mode` / `georef_mode2`、`capture_*` / `capture_*2`、`image_filename2` ほか、`switch_time_1to2` / `switch_time_2to1` を受け取る。レイヤー別に `resolve_affine` でアフィン係数を計算。`project_id` 指定時は更新（既存 `MapPoint` を全削除→再登録）。必須欠落・アフィン計算失敗は **400**、DB 失敗は **500**、更新対象なしは **404**。返却: `{project_id, updated}` |
| GET | `/api/migrationmaps/projects` | 直近100件（`id` の降順）。各要素 `id` / `name` / `image_url` / `created_at` / `public_url`（`/migrationmaps/m/<id>`）/ `admin_url`（`/migrationmaps/admin?project_id=<id>`）。DB エラー時 500＋`projects: []` |
| GET | `/api/migrationmaps/<int:project_id>` | プロジェクト詳細。`affine` / `affine2`（`image_filename2` かつ `a2` 非 null のときのみ）/ `image_url` / `image_url2` / `switch_time_*` / `georef_mode` / `georef_mode2` / `capture` / `capture2` / 全登録 `points`（`layer` 含む）。存在しなければ **404** |
| GET | `/api/migrationmaps/<int:project_id>/overlay_bounds` | 画像4隅をアフィンで実座標へ変換し、Leaflet `ImageOverlay` 用の `bounds`（`[sw, ne]`）、`image_corners`（TL/TR/BR/BL）、`distortable_corners`（NW/NE/SW/SE、Leaflet.DistortableImage 用に緯度→経度でソートして決定）、`image_size` を返す。レイヤー2があれば `layer2` に同構造。存在しなければ 404 |

### 6.3 店舗（テナント）

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/migrationmaps/<int:project_id>/shops` | **`map_project_id == project_id` かつ `is_active` かつ `_project_bbox` 内** の店舗を `id` 昇順で返す。各店舗に `images`（`sort_order` 順）と `building_guide`（`building_guide_id` FK で解決、`floors` に `area_*` px と `area_*_pct` の両方）を含める。存在しなければ 404 |
| POST | `/api/migrationmaps/shop/register` | 店舗の新規登録／更新（`multipart/form-data`）。`shop_id` があれば更新、なければ新規。必須: `shopname` / `address` / `email` / `map_project_id`（実在する `MapProject`）/ `lat` / `lng`。エラーは `{error, fields}` で **400**。画像は `shop_image_1`〜`shop_image_5` を受け取り、拡張子チェック後 `MIGRATIONSHOP_UPLOAD_DIR` に `shop_<id>_<n>_<uuid><ext>` で保存、`sort_order` ごとに upsert。返却: `{ok, shop_id, image_count, updated}` |
| GET | `/api/migrationmaps/shops?project_id=` | 店舗一覧（`updated_at` 降順 → `id` 降順）。`project_id` 指定で `map_project_id` 絞り込み。各要素 `id` / `shopname` / `address` / `floorlevel` / `map_project_id` / `is_active` / `updated_at` |
| GET | `/api/migrationmaps/shops/<int:shop_id>` | 店舗詳細（`images` 含む全項目）。存在しなければ **404** |

### 6.4 方式A ベース地図

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/migrationmaps/basemap?lat=&lng=&zoom=&width=&height=` | OSM タイルを合成した 1 枚の PNG（`image/png`）。`BASEMAP_TILE_URL` 未設定は **503**。数値欠落は 400、`lat/lng` 範囲外は 400、`zoom` は 0..19、`width/height` は 1..4096。生成失敗は **502**。応答に `X-Basemap-Center` / `X-Basemap-Zoom` / `X-Basemap-Size` ヘッダ（`Access-Control-Expose-Headers` 済み） |

### 6.5 OSM（Overpass）取り込み

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/migrationmaps/<int:project_id>/osm/search` | `_project_bbox_padded(proj, margin_m)`（`_project_bbox` を四方に `margin_m` メートル拡張した bbox）を Overpass API で検索し店舗候補を返す（**DB 保存なし**）。リクエスト JSON の任意パラメータ `margin_m`（既定 **50**、許容 **0..500**、範囲外・非数値は **400**）。各候補に `osm_type` / `osm_id` / `shopname` / `address` / `floorlevel` / `tel` / `website_url` / `instagram_account` / `description` / `lat` / `lng` / `raw_tags` ＋ `already_imported`（DB 内の `(osm_type, osm_id)` と突き合わせ）。応答に **実際に検索に使った拡張後の** `bbox` ＋ `margin_m` ＋ `cached`（24h キャッシュヒット可否）。Overpass 混雑（429/504 リトライ切れ）は **503**、その他失敗は **502**。存在しないプロジェクトは 404 |
| POST | `/api/migrationmaps/<int:project_id>/osm/import` | `{"items":[{"osm_type","osm_id"}, ...], "margin_m": 50}` を受け取り、サーバー側キャッシュ済み候補を引き当てて `MigrationShop` に upsert。候補の引き直しは検索と同じ `_project_bbox_padded(proj, margin_m)`（`margin_m` 既定 50 / 許容 0..500 / 範囲外 400）で行い、マージン内で選んだ候補が skip されないようにする。**`source == "manual"` のレコードは絶対に上書きしない**（skip）。取り込みレコードは `source="osm"` / `osm_synced_at` / `map_project_id` を設定。`items` 空は 400、候補取得失敗は 502、DB 失敗は 500。返却: `{created, updated, skipped}` |

**管理画面 UI（`admin.html` / `admin.js`）**: 「取得」ボタンの横に外周マージン `select`（`0 / 50 / 100 / 200 m`、既定 50）。取得実行時にその値を `margin_m` で POST し、応答の `bbox` を右の OSM マップに `L.rectangle`（薄い青の破線）で描画（再検索時は `clearOsmSearchRect()` で消してから描き直す）。取り込み時も直近マージン `lastOsmMarginM` を一緒に送る。候補リスト UI（`#osmCandidateList`、全選択 / 全解除 / 一括取り込み）は不変。

### 6.6 サーバー側ヘルパ

| 関数 | 内容 |
|---|---|
| `_project_bbox(proj)` | レイヤー1画像の四隅をアフィンで緯度経度化し `(sw_lat, sw_lng, ne_lat, ne_lng)` を返す。**シグネチャ・挙動とも不変**（公開ページ `GET /<id>/shops` の絞り込みが依存） |
| `_project_bbox_padded(proj, margin_m)` | `_project_bbox` の結果を四方へ `margin_m` メートル拡張して返す。OSM 検索の「候補取りこぼし」対策専用。**表示範囲ではなく候補取得範囲**であり、マージン分だけ外側の店舗を取り込むと公開ページの（拡張しない）bbox フィルタで弾かれ得る（コード内コメントに明記）。実体は `migrationmaps_geo.bbox_with_margin` |
| `bbox_with_margin(sw_lat, sw_lng, ne_lat, ne_lng, margin_m)` | 純関数（`migrationmaps_geo.py`）。緯度は 1度≒111,320m 換算、経度は bbox 中心緯度の `cos` 補正。緯度 ±90 / 経度 ±180 でクランプ。`margin_m <= 0` は入力 bbox をそのまま返す |
| `_parse_osm_margin_m(data)` | リクエスト JSON から `margin_m` を取り出し `float` 化・範囲検証（0..500）。不正時は `(jsonify(...), 400)` を返す |
| `_image_url_from_filename(image_filename)` | `http` 始まりなら Cloudinary 等のフル URL としてそのまま、それ以外は `/migrationmaps/uploads/<file>` に組み立て |

---

## 7. OSM / Overpass 連携（`migrationmaps_osm.py`）

- **対象タグ**: `amenity` が `restaurant` / `cafe` / `fast_food` / `bar` / `pub` / `ice_cream` / `bakery` / `food_court` のいずれか、または `shop` タグを持つ `node` / `way` / `relation`。
- **クエリ**: `build_overpass_ql(south, west, north, east)` が `[out:json][timeout:30]` の QL を生成。`out center tags;` で way/relation の重心も取得。
- **POST とリトライ**: `_post_overpass` が `MAX_RETRIES = 3`、429/504 は指数バックオフ（1s → 2s → 4s）でリトライ。使い切ると `OverpassBusy`。それ以外の非 200 は `raise_for_status()`。connect 10s / read 60s、`User-Agent = "MigrationMap/1.0 (...)"`。
- **キャッシュ**: プロセス内 dict `_CACHE`。キーは bbox を小数5桁に丸めた SHA-256。TTL `CACHE_TTL_SECONDS = 24h`。`search_candidates(...)` は `(candidates, cached)` を返す。`osm/search` からは **拡張後（マージン適用済み）の bbox** が渡るため、キーもその bbox から生成され、`margin_m` 違い（例: 0 と 100）は別キーになる（衝突しない）。`migrationmaps_osm.py` 側は変更不要。
- **エンドポイント**: 環境変数 `OVERPASS_ENDPOINT`。未設定なら `https://overpass-api.de/api/interpreter`。
- **タグ → フィールド変換**（`element_to_candidate`）:
  - `shopname`: `name:ja` → `name` → `name:en` の順。すべて無ければ候補から除外。
  - `address`: `addr:full`、なければ `addr:postcode/province/state/city/suburb/quarter/neighbourhood/block_number/housenumber` を連結。
  - `floorlevel`: `level` タグを `osm_level_to_floorlevel` で日本式に変換（`"0"→"1F"`、`"-1"→"B1F"`、`"1;2"→"2F"`（先頭のみ））。無ければ `addr:floor` をそのまま。
  - `tel`: `phone` → `contact:phone`。
  - `website_url`: `website` → `contact:website`。
  - `instagram_account`: `contact:instagram` / `brand:instagram` から URL 末尾 or `@` 除去。
  - `description`: `cuisine` と `opening_hours` を ` / ` 連結。
  - 重複（`(osm_type, osm_id)`）は除去。

### 帰属表示

OSM データ・タイルを使うため、公開ページと建物ガイド内に ODbL（OpenStreetMap contributors）帰属表示を置く。

---

## 8. 画像ストレージ

- 既定: ローカルディレクトリ。イラスト地図は `MIGRATIONMAPS_UPLOAD_DIR`（既定 `migrationmaps_uploads/`、リポジトリに既存画像5点をトラッキング）、店舗画像は `MIGRATIONSHOP_UPLOAD_DIR`（既定 `migrationshop_uploads/`、ランタイム生成のため `.gitignore` 済み）。いずれも起動時に `mkdir(parents=True, exist_ok=True)`。
- `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` が **3つ揃うと** `CLOUDINARY_ENABLED`。イラスト地図アップロードが Cloudinary 経由になり、フォルダ／画像ブラウズ API も有効化。
- 許可拡張子（イラスト地図・店舗画像とも）: `.png` / `.jpg` / `.jpeg` / `.webp`。

---

## 9. 環境変数

| 変数 | 既定 | 用途 |
|---|---|---|
| `DATABASE_URL` | （必須。未設定は起動時 `ValueError`） | PostgreSQL 接続 URL。`postgres://` は `postgresql://` に自動補正 |
| `SECRET_KEY` | `dev-secret-change-me` | Flask セッション / CSRF |
| `MIGRATIONMAPS_UPLOAD_DIR` | `migrationmaps_uploads` | イラスト地図のローカル保存先 |
| `MIGRATIONSHOP_UPLOAD_DIR` | `migrationshop_uploads` | 店舗画像のローカル保存先 |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | （未設定） | 3つ揃うと Cloudinary 有効化 |
| `OVERPASS_ENDPOINT` | `https://overpass-api.de/api/interpreter` | 店舗取得に使う Overpass API エンドポイント |
| `BASEMAP_TILE_URL` | （未設定） | 方式A のタイル URL テンプレート（`{z}/{x}/{y}`）。未設定なら `/api/migrationmaps/basemap` は 503 |
| `BASEMAP_USER_AGENT` | `MigrationMap/1.0 (+https://example.com; contact@example.com)` | タイル取得時の User-Agent |
| `BASEMAP_TILE_SLEEP_S` | `0` | タイル取得リクエスト間のスリープ秒 |

（`.env.example` も参照。メール通知には別途 `MAIL_*` が必要。）

---

## 10. DB マイグレーション

Alembic は無い。`migrations/` の冪等 SQL を番号順に適用する。

```bash
python scripts/run_migration.py migrations/001_mapproject_georef.sql
python scripts/run_migration.py migrations/002_migrationshop_osm.sql
python scripts/run_migration.py migrations/003_buildingguide_fk_and_floor_pct.sql
```

`scripts/run_migration.py` は `DATABASE_URL` に対し 1 ファイルを 1 トランザクションで適用（`postgres://` 補正あり、`ADD COLUMN IF NOT EXISTS` 等で再実行可能）。

| ファイル | 変更 |
|---|---|
| `001_mapproject_georef.sql` | `map_projects` に `georef_mode` / `georef_mode2`（default `'manual'`）、`capture_*` / `capture_*2`（各6カラム）を追加。既存行を明示的に `manual` に埋める |
| `002_migrationshop_osm.sql` | `migrationshop` に `osm_type` / `osm_id` / `source`（default `'manual'`）/ `osm_synced_at` を追加。`email` の NOT NULL を解除。`uq_migrationshop_osm (osm_type, osm_id)` を追加 |
| `003_buildingguide_fk_and_floor_pct.sql` | `building_guide_floors` に `area_*_pct`（4カラム）、`building_guides` に `base_width` / `base_height` を追加。`base_*` が揃うフロアは px→% を自動換算（未設定の pct のみ）。`migrationshop.building_guide_id` ＋ FK `fk_migrationshop_building_guide` (ON DELETE SET NULL) ＋ index を追加 |

移行補助: `scripts/backfill_building_guide_id.py [--dry-run]` — `building_guide_id` 未設定の店舗に、Haversine 距離で半径 **30m** 以内かつ最近傍のアクティブな `BuildingGuide` を割り当てる。

---

## 11. テスト（`tests/`、`pytest.ini`）

`app` を import せず（`migrationmaps_geo` は Flask/DB 非依存、`migrationmaps_osm` は `requests` をモック）、`python -m pytest -q` で **42 passed**。

| ファイル | 対象 |
|---|---|
| `tests/test_migrationmaps_geo.py` | `res_at_zoom` の既知値、`affine_from_capture` の形・中心往復・四隅の向き（左上=北西）・dpr でスケール半減、`fit_shift_only`、`fit_similarity_no_rotation`（既知変換の復元・最小二乗）、中心±200m でアフィン誤差 < 1 画像ピクセル、`bbox_with_margin`（`margin_m=0` は恒等 / 緯度36°で南北≒100m・東西 cos(36°)補正 / 北極・日付変更線でクランプ / 極真上でゼロ除算なし） |
| `tests/test_resolve_affine.py` | `resolve_affine` の各 mode 分岐、`extract_capture` の正規化 |
| `tests/test_migrationmaps_osm.py` | `build_overpass_ql`、`osm_level_to_floorlevel`、`element_to_candidate`、キャッシュ TTL、429/504 リトライ → `OverpassBusy` |

---

## 12. 制約・バリデーションまとめ

- `/api/migrationmaps/save`: `name` / `image_filename` / `image_width` / `image_height` 必須（欠落は 400）。
  - `georef_mode == "manual"`: レイヤー1の対応点が **3点以上**（中心＋2点以上）必須。不足は 400。
  - `auto` / `shift` / `similar`: `capture_center_lat` / `capture_center_lng` / `capture_zoom` 必須。`shift` は対応点1点、`similar` は2点必要。
  - レイヤー2は `image_filename2` があり、かつ対応点3点以上または `georef_mode2 != "manual"` のときだけ係数保存。満たさなければ `a2〜f2 = null`。
- `/api/migrationmaps/shop/register`: `shopname` / `address` / `email` / `map_project_id`（実在 `MapProject`）/ `lat` / `lng` 必須。画像拡張子は `.png/.jpg/.jpeg/.webp` のみ。
- `/api/migrationmaps/basemap`: `BASEMAP_TILE_URL` 未設定は 503。`zoom` 0..19、`width/height` 1..4096。
- `/api/migrationmaps/<id>/osm/search`・`/osm/import`: `margin_m` は任意（既定 50）。`0..500` の数値のみ。非数値・範囲外は 400。検索は `_project_bbox_padded` を使い、公開ページの表示範囲（`_project_bbox`）は広げない。
- OSM 取り込み: `source == "manual"` のレコードは上書きしない。`(osm_type, osm_id)` はユニーク。
- 公開ページの店舗表示: `map_project_id` 一致 ∧ `is_active` ∧ レイヤー1四隅の bbox 内（**マージン非適用**。`osm/search` のマージンで拾って取り込んだ「端の外側」店舗はここで弾かれ得る）。
- 公開ページのビルガイド: 店舗マーカーは `lat`/`lng`（小数7桁）でグループ化。クリック時、`building_guide` があればその画像、無くても**同一緯度経度に複数店舗**があれば既定画像 `static/img/migrationmaps_buildingimage.jpg` でフロア案内を表示（グループ 1 件のみなら店舗カードのみ）。
- 公開ページのナビゲーション拡張（目的地設定・経路案内）: サーバー API・DB を一切使わないクライアント完結機能。経路取得先は外部の OSRM 公開デモサーバ（`https://router.project-osrm.org`）で、可用性・精度（歩行者向けでない場合がある）はこちら側で制御できない。取得失敗時は直線表示にフォールバックするため機能自体は落ちない。位置更新のたびに問い合わせないよう `ROUTE_MIN_INTERVAL_MS` / `ROUTE_MIN_MOVE_M` で間引いており、公開デモサーバの利用規約（ヘビーユース禁止）に配慮した実装になっている。
