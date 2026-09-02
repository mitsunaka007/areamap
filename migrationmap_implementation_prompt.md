# MigrationMap 実装依頼プロンプト

## 0. 前提となるコードベース

Flask + SQLAlchemy + PostgreSQL + Leaflet.js のイラスト地図重ね合わせアプリ。既存の構成:

- `app.py` — MigrationMaps 系ルート（`/api/migrationmaps/*`）、アフィン変換ユーティリティ（`_lonlat_to_mercator` / `_mercator_to_lonlat` / `_fit_affine` / `_img_to_latlng`）
- `templates/migrationmaps/admin.html`, `static/migrationmaps/admin.js` — 管理画面（画像アップロード、対応点の手動設定、店舗登録フォーム）
- `templates/migrationmaps/public.html`, `static/migrationmaps/public.js` — 公開ページ（イラスト地図オーバーレイ、店舗マーカー、ビルガイド、現在地表示）
- モデル: `MapProject`, `MapPoint`, `MigrationShop`, `MapShopImages`, `BuildingGuide`（+ floors）

既存の座標系は **EPSG:3857（Web メルカトル・メートル）** で統一されている。`_fit_affine` は画像 xy → 3857 の 6 パラメータアフィンを最小二乗で解いている。この方針は維持すること。

今回の依頼は次の 2 つ。

- **A. 店舗情報の取得元を Google Places API から OpenStreetMap Overpass API に変更する**
- **B. イラスト地図のジオリファレンス（xy ↔ 緯度経度の対応付け）を自動化し、手作業の対応点入力を原則ゼロにする**

---

# A. Overpass API による店舗情報取得

## A-1. 要件

イラスト地図の表示範囲（既存の `overlay_bounds` 相当のバウンディングボックス）内にある飲食店・店舗を Overpass API から取得し、管理画面でプレビュー・選別したうえで `MigrationShop` に取り込む。

Google Places API は使わない。理由は、Places のコンテンツを 30 日を超えて自前 DB に保存することが Google Maps Platform の規約で制限されているため。OSM のデータは ODbL であり、帰属表示さえ行えば恒久保存・改変が可能。

## A-2. Overpass クエリ

エンドポイントは `https://overpass-api.de/api/interpreter`（環境変数 `OVERPASS_ENDPOINT` で差し替え可能にする）。POST で以下の Overpass QL を送る。

```
[out:json][timeout:30];
(
  nwr["amenity"~"^(restaurant|cafe|fast_food|bar|pub|ice_cream|bakery|food_court)$"]({{south}},{{west}},{{north}},{{east}});
  nwr["shop"]({{south}},{{west}},{{north}},{{east}});
);
out center tags;
```

- `nwr` は node / way / relation をまとめて検索する省略記法。
- `out center` により、way / relation でも重心座標が `center.lat` / `center.lon` として返る。node は `lat` / `lon` に入るため、**両方を吸収する取り出し関数を書くこと**。
- 対象タグの種類は定数リストとしてコード上部に切り出し、あとから増減できるようにする。

### 実装上の注意

- Overpass の公開インスタンスには利用制限がある。**同時リクエストは 1 本まで**、`User-Agent` に連絡先を含めたアプリ名を設定する（例: `MigrationMap/1.0 (contact@example.com)`）。
- HTTP 429 / 504 が返ったら指数バックオフで最大 3 回リトライ。それでも失敗したら「Overpass サーバーが混雑しています。時間をおいて再試行してください」を JSON で返す。
- 同一 bbox に対する結果を **24 時間キャッシュ**する（`bbox` を丸めた文字列のハッシュをキーにしたテーブル、または `functools` ベースのプロセス内キャッシュ + DB 保存のいずれか）。管理画面から連打されても Overpass を叩かないこと。
- タイムアウトは接続 10 秒 / 読み込み 60 秒。

## A-3. タグ → MigrationShop のマッピング

| MigrationShop | OSM タグ（優先順） | 備考 |
|---|---|---|
| `shopname` | `name:ja` → `name` → `name:en` | すべて無い要素は取り込み候補から除外 |
| `address` | `addr:full` → `addr:postcode`〜`addr:housenumber` を連結して組み立て | 日本の OSM は `addr:full` が入っていることが多い |
| `tel` | `phone` → `contact:phone` | |
| `website_url` | `website` → `contact:website` | |
| `instagram_account` | `contact:instagram` → `brand:instagram` | URL 形式なら末尾のアカウント名を抽出 |
| `floorlevel` | `level` → `addr:floor` | **変換に注意（下記）** |
| `description` | `cuisine`, `opening_hours` を整形して連結 | |
| `lat` / `lng` | `lat`/`lon` または `center.lat`/`center.lon` | |

### `level` → `floorlevel` の変換

OSM の `level` は **地上階が 0** である。日本の慣習（地上階 = 1F）と 1 ずれるため、必ず変換関数を通すこと。

```python
def osm_level_to_floorlevel(level_raw: str | None) -> str | None:
    """OSM の level タグ（地上階=0）を日本式の階数表記に変換する。
    "0" -> "1F", "1" -> "2F", "-1" -> "B1F", "1;2" -> "2F"（先頭のみ採用）
    """
```

- `level` が `"1;2"` のように複数階にまたがる場合は先頭の値のみ採用する。
- `level` が無く `addr:floor` がある場合、`addr:floor` は**すでに日本式表記であることが多い**ため、そのまま文字列として採用する（変換しない）。
- どちらも無い場合は `None`（= 1F 相当として扱わない。ビルガイドの対象外）。

## A-4. スキーマ変更

`MigrationShop` に以下を追加する。マイグレーションスクリプトも生成すること。

```python
osm_type = db.Column(db.String(8))       # "node" | "way" | "relation"
osm_id   = db.Column(db.BigInteger)      # OSM 要素 ID
source   = db.Column(db.String(16), nullable=False, server_default="manual")  # "manual" | "osm"
osm_synced_at = db.Column(db.DateTime)
```

- `UniqueConstraint("osm_type", "osm_id")` を張り、重複取り込みを防ぐ。
- **`MigrationShop.email` を nullable に変更する。** OSM には email が入っていないことがほとんどで、現行の必須制約のままでは取り込みが通らない。既存の手動登録フォーム側のバリデーション（`api_migrationshop_register`）では必須のままでよい。
- 再取り込み時、`source == "manual"` のレコードは**絶対に上書きしない**。`source == "osm"` のレコードのみ更新対象とする。

## A-5. API エンドポイント

### `POST /api/migrationmaps/<int:project_id>/osm/search`

Overpass を叩いて候補を返す。**この時点では DB に保存しない。**

レスポンス:

```json
{
  "bbox": [sw_lat, sw_lng, ne_lat, ne_lng],
  "cached": true,
  "candidates": [
    {
      "osm_type": "node",
      "osm_id": 1234567890,
      "shopname": "○○カフェ",
      "address": "福井県福井市大手1-1-1",
      "floorlevel": "2F",
      "tel": "0776-00-0000",
      "website_url": null,
      "instagram_account": null,
      "description": "cuisine: coffee_shop / 09:00-18:00",
      "lat": 36.0619,
      "lng": 136.2235,
      "already_imported": false,
      "raw_tags": { }
    }
  ]
}
```

bbox は既存の `api_migrationmaps_overlay_bounds` と同じロジック（イラスト地図四隅をアフィンで緯度経度化）で算出する。**この処理は共通関数 `_project_bbox(proj)` に切り出し、両エンドポイントから呼ぶこと。**

### `POST /api/migrationmaps/<int:project_id>/osm/import`

選択された候補を `MigrationShop` に upsert する。

リクエスト: `{"items": [{"osm_type": "node", "osm_id": 123}, ...]}`

サーバー側でキャッシュ済みの候補データを引き当てて保存する（クライアントから店舗内容をそのまま受け取って保存しない。改ざん防止のため）。

レスポンス: `{"created": 12, "updated": 3, "skipped": 1}`

## A-6. 管理画面 UI

`admin.html` の左パネル「店舗を登録・編集する」の上に、折りたたみ式のセクションを追加する。

- 「このエリアの店舗を OSM から取得」ボタン → `osm/search` を叩く
- 取得結果をチェックボックス付きリストで表示。1 行に「店名 / 階層 / 住所 / 緯度経度」。すでに取り込み済みのものはチェック不可でグレー表示
- 「全選択 / 全解除」と「選択した N 件を取り込む」ボタン
- 取り込み後は既存の `refreshShopList()` を呼んで下の一覧を更新

## A-7. 帰属表示

公開ページのフッター、およびビルガイド内に以下を表示すること（ODbL の要件）。

```
店舗情報: © OpenStreetMap contributors (ODbL)
```

`public.js` の `L.tileLayer` の attribution だけでは、**タイル画像ではなく取り込んだ属性データの出典表示として不十分**なので、独立した表記を必ず追加する。

---

# B. ジオリファレンスの自動化

## B-1. 現状の運用と、自動化できる根拠

現在の運用は次のとおり。

1. 下レイヤの OSM 地図を画面に表示し、スクリーンショットを撮る
2. その画像をもとにイラスト地図を作成する。**幅・高さは変更せず、回転もさせない**
3. 管理画面で、イラスト地図上の xy 座標と OSM 上の緯度経度を 3 点以上手作業で対応付ける

ここで重要なのは、条件 2 により **イラスト地図と元スクリーンショットのピクセル座標が完全に一致している**という点である。したがって「スクリーンショットを撮った瞬間の地図の中心緯度経度・ズームレベル・表示サイズ」さえ記録しておけば、アフィン変換の 6 パラメータは**計算だけで確定する**。対応点の手入力は本来不要である。

## B-2. 数式

Web メルカトル（EPSG:3857）における、ズーム `z` での 1 CSS ピクセルあたりの解像度は緯度に依存せず次で与えられる。

```
C   = 2 * π * 6378137.0 = 40075016.68557849   # 赤道周長 [m]
res(z) = C / (256 * 2^z)                      # [m / CSS px]
```

イラスト画像のピクセル寸法を `(Wi, Hi)`、スクリーンショット時の地図コンテナの CSS ピクセル寸法を `(Wc, Hc)` とすると、Retina 環境などで両者が一致しないことがある。倍率を

```
k = Wi / Wc          # 通常は devicePixelRatio と一致する
s = res(z) / k       # 画像 1 ピクセルあたりのメートル数
```

とする。スクリーンショット時の地図中心 `(lat0, lng0)` をメルカトルに変換して `(X0, Y0)` とすると、画像座標 `(x, y)` から 3857 座標への写像は

```
X = X0 + s * (x - Wi / 2)
Y = Y0 - s * (y - Hi / 2)      # 画像 y は下向き、メルカトル Y は上向きなので符号反転
```

よって既存の 6 パラメータ表現 `X = a·x + b·y + c`, `Y = d·x + e·y + f` に対して

```
a = s
b = 0
c = X0 - s * Wi / 2
d = 0
e = -s
f = Y0 + s * Hi / 2
```

**対応点は 1 点も必要ない。** これを `_affine_from_capture(...)` として実装する。

## B-3. 実装方式

以下の 2 方式を実装し、管理画面で選べるようにする。**方式 A を既定とする。**

### 方式 A（推奨）— サーバー側でベース地図画像を生成する

管理画面から「ベース地図画像を書き出す」を実行すると、サーバーが OSM タイルを取得・合成して 1 枚の PNG を返す。ユーザーはその PNG をダウンロードし、上からイラストを描いてアップロードする。

- エンドポイント: `GET /api/migrationmaps/basemap?lat=&lng=&zoom=&width=&height=`
- 指定された中心・ズーム・サイズをカバーするタイル範囲を計算し、Pillow で貼り合わせて中心基準にクロップして返す
- 同時に、生成に使ったメタデータ（中心・ズーム・幅・高さ）をレスポンスヘッダまたは同梱 JSON で返し、管理画面の状態に保持する

この方式では、**ブラウザのスクリーンショット操作に起因するクロップずれ・DPI ずれが原理的に発生しない**ため、位置合わせ誤差はゼロになる。

タイル取得先には注意が必要。`tile.openstreetmap.org` は大量の自動取得を利用規約で禁止している。以下のいずれかを環境変数 `BASEMAP_TILE_URL` で指定できるようにし、既定値は空（未設定なら方式 A を無効化してエラーメッセージを返す）とすること。

- 自前ホストのタイルサーバー
- API キーを伴う商用タイルサービス
- 開発・少量利用に限り OSM 公式タイル（`User-Agent` 必須、リクエスト間に 100ms のスリープを挟む）

### 方式 B — ブラウザでスクリーンショットを撮る現行フローの支援

既存の運用を維持したい場合のための経路。

1. 管理画面右パネルの OSM 地図を目的の位置・ズームに合わせる
2. 「この表示をキャプチャ枠として確定」ボタンを押す
3. クリック時点の `map.getCenter()`, `map.getZoom()`, 地図コンテナの `clientWidth` / `clientHeight`, `window.devicePixelRatio` を記録し、画面に「この枠のとおりにスクリーンショットを撮ってください」というガイド枠（地図コンテナ全体を囲む破線ボーダー）を表示する
4. ユーザーがスクリーンショット → イラスト加工 → アップロード
5. アップロード時に取得した `image_width` / `image_height` と記録済みメタデータから `_affine_from_capture` でアフィンを確定する

**Leaflet のズームは既定で小数値を取りうる**ため、地図の初期化オプションに `zoomSnap: 1, zoomDelta: 1` を指定して整数ズームに固定する。ただし `res(z)` は小数ズームでも連続的に定義できるので、計算側は float の `z` を受け付けられるようにしておくこと。

## B-4. スキーマ変更

`MapProject` に以下を追加する。レイヤー 2 用も同様に `capture_*2` を用意する。

```python
georef_mode        = db.Column(db.String(16), nullable=False, server_default="manual")
# "auto"   : capture メタデータから解析的に算出
# "shift"  : capture のスケールを使い、1点で平行移動のみ補正
# "similar": 2点でスケール+平行移動を最小二乗
# "manual" : 従来の3点以上フルアフィン

capture_center_lat = db.Column(db.Float)
capture_center_lng = db.Column(db.Float)
capture_zoom       = db.Column(db.Float)
capture_width      = db.Column(db.Integer)   # CSS px
capture_height     = db.Column(db.Integer)   # CSS px
capture_dpr        = db.Column(db.Float)
```

既存プロジェクトは `georef_mode = "manual"` のままとし、**現行の挙動を一切変えないこと**（後方互換）。

## B-5. 対応点が必要になるケースへのフォールバック

ユーザーが画像をクロップしたり、余白を足したりした場合には中心がずれる。対応点の数に応じて解法を切り替える。

| 対応点の数 | モード | 解く自由度 | 実装する関数 |
|---|---|---|---|
| 0 点 | `auto` | なし（完全に確定） | `_affine_from_capture()` |
| 1 点 | `shift` | 平行移動 2 | `_fit_shift_only()` |
| 2 点 | `similar` | スケール 1 + 平行移動 2 | `_fit_similarity_no_rotation()` |
| 3 点以上 | `manual` | フルアフィン 6 | 既存 `_fit_affine()` |

`shift` は、スケール `s` を capture のズームから確定させたうえで、対応点 1 点が一致するように `c` と `f` だけを解き直す。

`similar` は回転を許さない相似変換で、次のモデルを最小二乗で解く（未知数は `s`, `tx`, `ty` の 3 つ）。

```
X_i =  s * x_i + tx
Y_i = -s * y_i + ty
```

回転を含む一般のヘルマート変換にはしないこと。**「回転させない」という運用条件を制約として明示的に組み込むことで、点が少なくても解が安定する**のが本設計の狙いである。

## B-6. 検証機能

自動算出されたアフィンが正しいことをユーザーが確認できるよう、管理画面に検証モードを設ける。

- イラスト地図上の任意の点をクリック → その点をアフィンで緯度経度に変換 → 右パネルの OSM 地図に検証マーカーを表示
- ユーザーが OSM 側で「本来あるべき位置」をクリック → 2 点間の距離をメートルで表示
- 誤差が `res(z) * 3`（= 3 CSS ピクセル相当）を超えたら警告を出し、対応点モードへのフォールバックを促す

### 受け入れ条件

方式 A で生成したベース地図をそのままアップロードした場合、画像中心から半径 200m 以内の任意の点について、**アフィン変換の誤差が 1 画像ピクセル相当以下**であること。z=16 なら約 2.4m。

## B-7. 既存 API への影響

- `POST /api/migrationmaps/save` — リクエストに `georef_mode` と `capture_*` を受け付ける。`points` が 3 点未満でも `georef_mode` が `auto` / `shift` / `similar` なら保存を通す。**現在の「3 点未満はエラー」というバリデーションは `manual` モードのときだけ適用する**よう条件を変更すること。
- `GET /api/migrationmaps/<id>` — レスポンスに `georef_mode` と capture メタデータを含める。
- `GET /api/migrationmaps/<id>/overlay_bounds` — 変更不要。アフィン 6 パラメータさえ確定していれば従来どおり動く。

---

# C. 同時に修正してほしい既存の不具合

上記の作業でどうせ同じファイルを触るため、以下もあわせて直すこと。

1. **ビルガイドのホットスポット座標が px 固定でスマホ表示時にずれる。** `public.js` の `buildHotspotStyle()` は `left:${x}px` を出力するが、`.building-photo` は `width:100%` で縮小されるため、管理画面で座標を取ったときの画像幅と表示幅が違うとホットスポットが正しい位置に乗らない。**`BuildingGuide` の floors の座標をパーセント（0〜100 の float）で保持するようスキーマとロジックを変更する**か、`BuildingGuide` に `base_width` / `base_height` を追加して描画時に比率換算する。前者を推奨。

2. **店舗とビルガイドの紐付けが緯度経度の文字列一致になっている。** `app.py` の `api_migrationmaps_shops` 内の以下の処理は、OSM から取り込んだ座標が同一ビル内でも店舗ごとに微妙に異なるため、まず一致しない。

   ```python
   guide_map = {f"{float(g.lat):.7f},{float(g.lng):.7f}": g for g in guides}
   ```

   `MigrationShop.building_guide_id` の外部キーを追加し、明示的な紐付けに変更すること。移行時は、既存データについては半径 30m 以内の最近傍 `BuildingGuide` を自動で割り当てるスクリプトを用意する。

3. **`api_migrationmaps_shops` が bbox のみで絞り込んでおり、別プロジェクトの店舗が混入する。** `MigrationShop.map_project_id == project_id` の条件を加える（または「bbox 内かつ当該プロジェクト所属」のどちらを意図しているのか確認したうえで統一する）。

4. **`admin.html` の説明文とコードの数値が食い違っている。** 「公開ページでは10秒かけてゆっくり切り替わります」とあるが、`public.js` の `TRANSITION_DURATION_MS` は 3000（3秒）。どちらかに揃える。

---

# D. 進め方

以下の順で、**各フェーズごとに動作確認できる状態にしてから次に進むこと**。

1. **フェーズ 1** — B-2 の数式を `_affine_from_capture()` として実装し、単体テストを書く。既知の中心・ズーム・画像サイズに対して、画像中心が中心緯度経度に、画像四隅が既存 `overlay_bounds` の計算結果と整合することを確認する。
2. **フェーズ 2** — `MapProject` のスキーマ拡張とマイグレーション。既存プロジェクトが `manual` モードで従来どおり表示されることを確認する。
3. **フェーズ 3** — 方式 A のベース地図生成エンドポイントと管理画面 UI。
4. **フェーズ 4** — B-5 のフォールバック 3 種と B-6 の検証モード。
5. **フェーズ 5** — Overpass 検索・取り込み API とスキーマ変更。
6. **フェーズ 6** — 管理画面の OSM 取り込み UI と帰属表示。
7. **フェーズ 7** — C の既存不具合修正。

各フェーズで、変更したファイルと変更理由を簡潔に報告すること。既存の手動対応点ワークフローは最後まで動作したまま残すこと。
