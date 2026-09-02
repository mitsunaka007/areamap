# MigrationMap 仕様書

## 1. 概要

MigrationMap は、手描き・印刷済みの「イラスト地図」画像を描き直すことなく、実世界の地図（OpenStreetMap／Leaflet）に位置合わせして重ね合わせ、スマートフォンで開くと GPS 連動でユーザーの現在地がイラスト地図上に表示される「歩ける案内MAP」を作成・公開する機能である。

観光マップ・商店街の回遊マップ・商業施設のフロア案内など、紙の地図資産をそのままデジタルのナビゲーションUIとして再利用することを目的とする。

## 2. コア機能

### 2.1 イラスト地図の位置合わせ（アフィン変換）

管理画面で、イラスト地図画像上の点（中心＋任意の複数地点）と、それに対応する実世界の緯度経度（OSM上でのクリック）をペアとして登録する。3点以上（中心＋2点以上）が揃うと、画像ピクセル座標→実世界座標への変換をアフィン変換として最小二乗推定する。

- 内部計算は非線形性を避けるため、緯度経度（EPSG:4326）を一度 WebMercator（EPSG:3857、メートル単位）に変換してから行う。
- 変換式：
  - `X = a*x + b*y + c`
  - `Y = d*x + e*y + f`
  - `(X, Y)`：WebMercatorメートル座標、`(x, y)`：画像ピクセル座標
- 3点ちょうどの場合は連立方程式として解き、4点以上の場合は `numpy.linalg.lstsq` による最小二乗推定を行う（実装: `_fit_affine`, `app.py`）。
- 係数 `a〜f` を求めることで、縮尺・回転・平行移動をまとめて自動決定でき、「中心から各点までの距離を一致させる」要件を満たす。
- 緯度は WebMercatorの上限（±85.05112878°）でクリップする。

### 2.2 2レイヤー対応（昼夜／時間帯切り替え）

1つのプロジェクトに対し、画像・アフィン係数の組を最大2セット（レイヤー1・レイヤー2）まで保持できる。

- レイヤー1は必須（最低3点でアフィン推定）、レイヤー2は任意（画像とレイヤー2側3点以上が揃った場合のみ推定）。
- `switch_time_1to2` / `switch_time_2to1`（`"HH:MM"`, JST）を設定することで、公開ページ側で時刻に応じて自動的に表示レイヤーを切り替えられる（例: 昼の観光マップ／夜のライトアップマップの切り替えなど）。
- 公開画面側の実装（`static/migrationmaps/admin.js` の `computeTargetLayer` / `transitionToLayer` 相当のロジック、および `public.js`）で、現在時刻から対象レイヤーを判定し、アニメーション付きで切り替える。

### 2.3 画像ストレージ

- デフォルトではローカルディレクトリ（`MIGRATIONMAPS_UPLOAD_DIR`、既定値 `migrationmaps_uploads/`）に保存。
- 環境変数 `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` が揃っている場合は Cloudinary 経由のアップロード・フォルダ／画像ブラウズが有効化される（`CLOUDINARY_ENABLED`）。
- 許可拡張子: `.png` / `.jpg` / `.jpeg` / `.webp`

### 2.4 公開ページの現在地連動

`templates/migrationmaps/public.html` ＋ `static/migrationmaps/public.js` により、以下を実現する。

- `navigator.geolocation.watchPosition` で現在地を継続取得し、イラスト地図（Leaflet ImageOverlay／DistortableImage）上にリアルタイムでマーカー表示。
- 現在地表示のON/OFFをユーザー側で切り替え可能。
- 店舗（`MigrationShop`）とのニアミス判定（`checkProximityToShops`）。
- 店舗マーカーは緯度経度をキーにグルーピングして表示し（`latLngGroupKey`）、クリックでアクティブ状態のアイコンに切り替え、他は非強調（ドット）表示にする。
- 建物ガイド（`BuildingGuide` / `BuildingGuideFloor`）がある店舗グループでは、フロア別のホットスポット付き案内画像を表示する。

### 2.5 店舗（テナント）管理

イラスト地図（`MapProject`）に紐づく店舗情報を、管理画面から登録・一覧・詳細取得できる。

- 店名、住所、階層（フロアレベル）、電話番号、メールアドレス、Instagramアカウント、説明文、Webサイトリンクを保持。
- 店舗画像は最大5枚（`sort_order` 1〜5、DB制約で範囲チェック）。
- 公開ページでの店舗一覧は、**当該プロジェクト所属（`map_project_id == project_id`）かつ表示範囲（イラスト地図4隅を実座標に変換したバウンディングボックス）内**の稼働中店舗で絞り込む（`api_migrationmaps_shops`）。

## 3. 画面・ルーティング一覧（`app.py`）

| メソッド | パス | 実装関数 | 内容 |
|---|---|---|---|
| GET | `/migrationmaps/lp` | `migrationmaps_lp` | サービス紹介LP |
| GET | `/migrationmaps/admin` | `migrationmaps_admin` | 管理画面（地図アップロード・点登録・店舗登録） |
| GET | `/migrationmaps/m/<int:project_id>` | `migrationmaps_public` | 公開ページ（指定プロジェクトのイラスト地図＋現在地連動表示） |
| GET | `/migrationmaps/uploads/<path:filename>` | `migrationmaps_uploaded_file` | ローカル保存されたイラスト地図画像の配信 |
| GET | `/migrationmaps/shop_uploads/<path:filename>` | `migrationshop_uploaded_file` | 店舗画像の配信 |

## 4. API仕様

すべて `app.py` に実装（Blueprint未使用）。

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/migrationmaps/cloudinary-folders` | Cloudinary上のフォルダ一覧を取得（Cloudinary未設定時は503） |
| GET | `/api/migrationmaps/cloudinary-images?folder=` | 指定フォルダ（省略時は全体）の画像一覧を取得 |
| POST | `/api/migrationmaps/upload` | `multipart/form-data`（`file`, `name`）で画像をアップロードし、`image_url` / `image_filename` / `image_width` / `image_height` を返す |
| POST | `/api/migrationmaps/save` | プロジェクトの新規作成／更新。名前・画像情報・点リスト（`points`）を受け取り、レイヤー別にアフィン係数を計算してDB保存。`project_id` を指定すると更新（既存の点は全削除→再登録）。点が3点未満、またはレイヤー1が3点未満の場合は400 |
| GET | `/api/migrationmaps/projects` | 直近100件のプロジェクト一覧（id, name, 画像URL, 作成日時, 公開URL, 管理URL） |
| GET | `/api/migrationmaps/<int:project_id>` | プロジェクト詳細（画像情報・アフィン係数・レイヤー2情報・切替時刻・全登録点）を取得。存在しなければ404 |
| GET | `/api/migrationmaps/<int:project_id>/overlay_bounds` | 画像4隅を実座標へ変換し、Leaflet `ImageOverlay` 用の `bounds`、`image_corners`（TL/TR/BR/BL）、`distortable_corners`（NW/NE/SW/SE、Leaflet.DistortableImage用）を算出して返す。レイヤー2がある場合は `layer2` に同様の情報を含める |
| GET | `/api/migrationmaps/<int:project_id>/shops` | **当該プロジェクト所属（`map_project_id == project_id`）かつ表示範囲（画像4隅のバウンディングボックス）内**の稼働中店舗と、対応する建物ガイド（`building_guide_id` FK で解決、フロア情報含む）を返す。フロアの矩形は `area_*_pct`（0〜100）優先、無ければ `area_*`（px）にフォールバック |
| POST | `/api/migrationmaps/shop/register` | 店舗の新規登録／更新（`multipart/form-data`）。`shop_id` があれば更新、なければ新規。必須項目（店名・住所・メール・地図ID・緯度・経度）のバリデーションあり。店舗画像は `shop_image_1`〜`shop_image_5` として最大5枚受け取り、`sort_order` ごとに upsert |
| GET | `/api/migrationmaps/shops?project_id=` | 店舗一覧（`project_id` 指定時は絞り込み）。更新日時降順 |
| GET | `/api/migrationmaps/shops/<int:shop_id>` | 店舗詳細（画像一覧含む）。存在しなければ404 |
| GET | `/api/migrationmaps/basemap?lat=&lng=&zoom=&width=&height=` | 方式A：中心・整数ズーム・出力サイズから OSM タイルを合成した 1 枚の PNG を返す。`BASEMAP_TILE_URL` 未設定時は503。生成に使った中心/ズーム/サイズを `X-Basemap-*` ヘッダで返す |
| POST | `/api/migrationmaps/<int:project_id>/osm/search` | プロジェクトの表示範囲（`_project_bbox`）を Overpass API で検索し、店舗候補（`osm_type/osm_id/shopname/floorlevel/lat/lng/already_imported` ほか）を返す。DB 保存はしない。24時間プロセス内キャッシュ。混雑時は503 |
| POST | `/api/migrationmaps/<int:project_id>/osm/import` | `{"items":[{"osm_type,"osm_id"}]}` を受け取り、サーバー側のキャッシュ済み候補を引き当てて `MigrationShop` に upsert（`source='manual'` のレコードは上書きしない）。`{"created","updated","skipped"}` を返す |

## 5. データモデル（`models.py`）

| モデル | テーブル名 | 主なカラム | 用途 |
|---|---|---|---|
| `MapProject` | `map_projects` | `name`, `image_filename`, `image_width/height`, `a〜f`（レイヤー1アフィン係数）, `image_filename2`, `image_width2/height2`, `a2〜f2`（レイヤー2アフィン係数）, `switch_time_1to2`, `switch_time_2to1`, `created_at` | イラスト地図プロジェクト本体。レイヤー2関連カラムはすべて任意（nullable） |
| `MapPoint` | `map_points` | `project_id`（FK, CASCADE）, `label`, `kind`（`center`/`point`）, `layer`（1 or 2, 既定1）, `img_x`, `img_y`, `lat`, `lng` | アフィン推定に用いる画像座標⇔実座標の対応点 |
| `MigrationShop` | `migrationshop` | `shopname`, `address`, `floorlevel`, `tel`, `email`（NULL 許可）, `instagram_account`, `lat`, `lng`, `is_active`, `description`, `website_url`, `osm_type`, `osm_id`, `source`（`manual`/`osm`）, `osm_synced_at`, `map_project_id`（FK, SET NULL）, `building_guide_id`（FK, SET NULL）, `created_at`, `updated_at`。`(osm_type, osm_id)` にユニーク制約 | イラスト地図に紐づく店舗（テナント）情報。`source='osm'` は Overpass 取り込み由来 |
| `MapShopImages` | `mapshopimages` | `migrationshop_id`（FK, CASCADE）, `image_url`, `sort_order`（1〜5, CHECK制約）, `created_at` | 店舗画像。`(migrationshop_id, sort_order)` にユニーク制約 |
| `BuildingGuide` | `building_guides` | `map_project_id`（FK, SET NULL）, `lat`, `lng`, `building_name`, `image_url`, `is_active`, `created_at`, `updated_at` | 建物単位の全体案内図（フロアガイドの親） |
| `BuildingGuideFloor` | `building_guide_floors` | `building_guide_id`（FK, CASCADE）, `floorlevel`, `area_x/y/width/height`（画像内の矩形領域）, `sort_order` | 建物ガイド画像内の、フロアごとのホットスポット領域定義 |

`BuildingGuide` と店舗（`MigrationShop`）は `MigrationShop.building_guide_id`（FK, ON DELETE SET NULL）で明示的に紐付ける（C-2）。既存データは `scripts/backfill_building_guide_id.py` が半径30m以内の最近傍ガイドを割り当てる。`BuildingGuideFloor` は `area_*`（px）に加えて `area_*_pct`（0〜100 の float、非 null なら優先）を持ち、`BuildingGuide.base_width/base_height` があれば px→% を自動換算できる（C-1）。

## 6. 座標変換ユーティリティ（`app.py`）

| 関数 | 内容 |
|---|---|
| `_lonlat_to_mercator(lon, lat)` | EPSG:4326 → EPSG:3857（メートル）変換。地球半径 `R=6378137.0`。緯度は±85.05112878°でクリップ |
| `_mercator_to_lonlat(x, y)` | EPSG:3857 → EPSG:4326 変換 |
| `_fit_affine(img_pts, ll_pts)` | 画像座標群と緯度経度群から、WebMercator空間でのアフィン係数 `a〜f` を最小二乗推定。3点未満はエラー |
| `_img_to_latlng(a,b,c,d,e,f,x,y)` | アフィン係数を用いて画像座標→緯度経度に変換 |
| `_image_url_from_filename(image_filename)` | 保存されている画像ファイル名から配信URLを組み立て（`http` から始まる場合はCloudinary等のフルURLとしてそのまま返す） |

## 7. 管理画面（`templates/migrationmaps/admin.html`, `static/migrationmaps/admin.js`）の主な操作

- 画像アップロード（ローカル or Cloudinaryから選択）をレイヤー1／レイヤー2それぞれ独立して実施
- Canvas上でのクリックにより画像ピクセル座標を取得し、OSM（Leaflet）側のクリックと同じラベル（`center`, `p1`, `p2`...）でペアリング
- 点一覧テーブルでラベル・画像座標・緯度経度・完了状態を確認
- レイヤー切替時刻（`switch_time_1to2` / `switch_time_2to1`）の入力
- 「重ね合わせプレビュー」で保存済み `overlay_bounds` を取得し、ImageOverlayとして確認
- プロジェクト保存後に発行される公開URL（`/migrationmaps/m/<id>`）の確認
- 店舗の新規登録・一覧・編集（画像最大5枚、フロア情報を含む）

## 8. 技術構成

- バックエンド: Python Flask（`app.py`、Blueprint不使用の単一ファイル構成）
- DB: PostgreSQL + SQLAlchemy
- 画像保存: ローカルディレクトリ（既定）／Cloudinary（環境変数設定時）
- フロント: Jinja2テンプレート＋素のJS、地図表示は Leaflet（+ ImageOverlay／DistortableImage拡張）
- 数値計算: NumPy（`numpy.linalg.lstsq` によるアフィン推定）
- 画像処理: Pillow（アップロード画像のサイズ取得、方式A ベース地図のタイル合成）
- 店舗取得: OpenStreetMap Overpass API（`requests`）
- 座標計算: `migrationmaps_geo.py`（Flask/DB 非依存の純関数モジュール、pytest 対象）

### 追加環境変数

| 変数 | 既定 | 用途 |
|---|---|---|
| `OVERPASS_ENDPOINT` | `https://overpass-api.de/api/interpreter` | 店舗取得に使う Overpass API エンドポイント |
| `BASEMAP_TILE_URL` | （未設定） | 方式A ベース地図生成用タイル URL テンプレート（`{z}/{x}/{y}`）。未設定なら `/api/migrationmaps/basemap` は503 |
| `BASEMAP_USER_AGENT` | `MigrationMap/1.0 (...)` | タイル取得時の User-Agent |
| `BASEMAP_TILE_SLEEP_S` | `0` | タイル取得リクエスト間のスリープ秒（OSM 公式タイルを開発利用する場合など） |

## 9. 制約・バリデーション

- `/api/migrationmaps/save` は、`name` / `image_filename` / `image_width` / `image_height` が必須。未入力時は400。
- 登録点の総数が3点未満の場合、および レイヤー1の点が3点未満の場合はいずれも400（「中心＋2点以上」が必須）。
- レイヤー2はアフィン推定に必要な3点＋`image_filename2` が揃っていない場合、係数は保存されず `null` のままとなる。
- 店舗登録（`/api/migrationmaps/shop/register`）は、店名・住所・メール・地図ID・緯度・経度が必須。地図ID（`map_project_id`）は実在する `MapProject` である必要がある。
- 店舗画像の拡張子は `.png` / `.jpg` / `.jpeg` / `.webp` のみ許可。
