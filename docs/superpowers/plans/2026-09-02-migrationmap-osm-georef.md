# MigrationMap: Overpass 店舗取得 + ジオリファレンス自動化 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** イラスト地図の位置合わせを「撮影時の中心・ズーム・サイズ」から計算だけで確定できるようにし、店舗情報の取得元を Google Places から OpenStreetMap Overpass API に置き換える。既存の手動対応点ワークフローは全フェーズ通して壊さない。

**Architecture:** 座標計算は Flask/DB に依存しない純関数モジュール `migrationmaps_geo.py` に集約し pytest で単体テストする。Overpass クライアントは `migrationmaps_osm.py`、方式Aのベース地図生成は `migrationmaps_basemap.py` に分離する。`app.py` は薄いルート層として新モジュールを呼ぶだけにする。スキーマ変更はハンドライトの冪等 SQL（`migrations/*.sql`）と実行スクリプト `scripts/run_migration.py` で適用する（このリポジトリに Alembic/Flask-Migrate は無い）。

**Tech Stack:** Flask 3.1 / SQLAlchemy 2.0 / Flask-SQLAlchemy / PostgreSQL (psycopg2) / Leaflet 1.9.4 / Pillow 12 / numpy 2.4 / requests 2.32 / pytest 8.3。座標系は既存どおり EPSG:3857（Web メルカトル・メートル、`_R = 6378137.0`）。

**Prerequisites:** 開始前に `pip install -r requirements.txt` を実行して仮想環境を整えること（`flask_mail` / `flask_sqlalchemy` / `flask_login` / `flask_wtf` が入っていないと `import app` も `flask run` も動かない）。座標・フィッティングの単体テスト（フェーズ1・4）は `numpy` と `pytest` だけで動くよう `migrationmaps_geo.py` に閉じている。`import app` を伴う確認手順は「フル依存が入った環境で」または「起動中の開発サーバに対して」実行する前提。

---

## File Structure

**新規作成**

| パス | 責務 |
|---|---|
| `migrationmaps_geo.py` | 座標変換と各種フィッティングの純関数。Flask/DB を import しない。`_R` / `_lonlat_to_mercator` / `_mercator_to_lonlat` / `_img_to_latlng` / `_fit_affine`（`app.py` から移設）＋ `res_at_zoom` / `affine_from_capture` / `fit_shift_only` / `fit_similarity_no_rotation` / `extract_capture` / `resolve_affine`（新規） |
| `migrationmaps_osm.py` | Overpass クエリ組み立て・POST・リトライ・24時間プロセス内キャッシュ、OSM タグ → `MigrationShop` フィールドのマッピング、`osm_level_to_floorlevel` |
| `migrationmaps_basemap.py` | タイル取得と Pillow 合成。方式A用の 1 枚 PNG 生成 |
| `tests/__init__.py` | 空ファイル（パッケージ化不要だが pytest の rootdir 明示のため） |
| `tests/test_migrationmaps_geo.py` | `migrationmaps_geo` の座標・アフィン単体テスト |
| `tests/test_resolve_affine.py` | `resolve_affine` / `extract_capture` の単体テスト（`app` を import しない） |
| `tests/test_migrationmaps_osm.py` | `migrationmaps_osm` の単体テスト（`requests` はモック） |
| `pytest.ini` | pytest 設定（testpaths, rootdir） |
| `migrations/001_mapproject_georef.sql` | `MapProject` に `georef_mode` / `georef_mode2` / `capture_*` / `capture_*2` を追加 |
| `migrations/002_migrationshop_osm.sql` | `MigrationShop` に `osm_type` / `osm_id` / `source` / `osm_synced_at` 追加、`email` を NULL 許可、`(osm_type, osm_id)` ユニーク制約 |
| `migrations/003_buildingguide_fk_and_floor_pct.sql` | `MigrationShop.building_guide_id` FK、`BuildingGuideFloor.area_*_pct`、`BuildingGuide.base_width/base_height` を追加 |
| `scripts/run_migration.py` | `DATABASE_URL` に対し 1 つの `.sql` ファイルを 1 トランザクションで適用する CLI |
| `scripts/backfill_building_guide_id.py` | 既存 `MigrationShop` に半径 30m 以内の最近傍 `BuildingGuide` を割り当てる |

**変更**

| パス | 変更内容 |
|---|---|
| `app.py` | 座標関数を `migrationmaps_geo` から import（自前定義を削除）。`_project_bbox` ヘルパ追加。`api_migrationmaps_save` / `api_migrationmaps_get` に georef_mode + capture 対応。`api_migrationmaps_shops` の bbox 絞り込みに project_id 条件追加・floors payload に pct 追加・guide 紐付けを FK 化。新エンドポイント: `GET /api/migrationmaps/basemap`、`POST /api/migrationmaps/<id>/osm/search`、`POST /api/migrationmaps/<id>/osm/import`。admin map の Leaflet 初期化に `zoomSnap:1, zoomDelta:1` |
| `static/migrationmaps/admin.js` | 方式A（ベース地図書き出し）・方式B（キャプチャ枠確定）・検証モード・OSM 取り込みセクションのロジック |
| `templates/migrationmaps/admin.html` | 上記 UI の DOM とスタイル |
| `static/migrationmaps/public.js` | `buildHotspotStyle` を pct 対応に。`TRANSITION_DURATION_MS` を 10000 に統一しコメント修正 |
| `templates/migrationmaps/public.html` | フッターとビルガイド内に ODbL 帰属表示を追加 |
| `requirements.txt` | `Pillow` / `numpy` / `pytest` を明示追加 |
| `docs/MigrationMap.md` | スキーマ表・紐付け方式・shops 絞り込み条件の記述を更新 |

---

## 進め方（フェーズ = 動作確認できる単位）

- **フェーズ 1**（Task 1–3）: `migrationmaps_geo.py` と単体テスト
- **フェーズ 2**（Task 4–7）: `MapProject` スキーマ拡張＋マイグレーション＋save/get 配線
- **フェーズ 3**（Task 8–10）: 方式A ベース地図生成エンドポイント＋管理画面 UI
- **フェーズ 4**（Task 11–14）: フォールバック 3 種（auto/shift/similar）＋検証モード
- **フェーズ 5**（Task 15–19）: Overpass 検索・取り込み API＋`MigrationShop` スキーマ変更
- **フェーズ 6**（Task 20–22）: 管理画面 OSM 取り込み UI＋帰属表示
- **フェーズ 7**（Task 23–27）: C セクションの既存不具合修正

各フェーズ完了時に「変更ファイルと変更理由」を簡潔に報告すること。

---

# フェーズ 1 — 撮影メタデータからのアフィン確定

## Task 1: `migrationmaps_geo.py` を作成（既存関数の移設＋新関数）

**Files:**
- Create: `migrationmaps_geo.py`
- Test: `tests/test_migrationmaps_geo.py`（Task 3 で作成）

- [ ] **Step 1: モジュールを作成する**

`app.py` 現行 93–132 行の `_R` / `_lonlat_to_mercator` / `_mercator_to_lonlat` / `_fit_affine` / `_img_to_latlng` をそのまま移設し、新関数を追記する。**数式・挙動は現行と一字一句同じにすること**（`_fit_affine` の numpy 遅延 import も維持）。

Create `migrationmaps_geo.py`:

```python
"""MigrationMap の座標変換とアフィン・フィッティング（純関数）。

Flask / SQLAlchemy を import しないこと。app.py と pytest の両方から使う。
座標系は EPSG:3857（Web メルカトル・メートル）。
"""
import math

# ---- 定数 ----
_R = 6378137.0
# 赤道周長 [m] = 2 * pi * _R = 40075016.68557849
_EARTH_CIRCUMFERENCE = 2.0 * math.pi * _R
_TILE_SIZE = 256


# ---- EPSG:4326 <-> EPSG:3857 ----
def _lonlat_to_mercator(lon, lat):
    x = _R * math.radians(lon)
    lat = max(min(lat, 85.05112878), -85.05112878)
    y = _R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, y


def _mercator_to_lonlat(x, y):
    lon = math.degrees(x / _R)
    lat = math.degrees(2 * math.atan(math.exp(y / _R)) - math.pi / 2)
    return lon, lat


def _img_to_latlng(a, b, c, d, e, f, x, y):
    X = a * x + b * y + c
    Y = d * x + e * y + f
    lon, lat = _mercator_to_lonlat(X, Y)
    return lat, lon


def _fit_affine(img_pts, ll_pts):
    """img_pts: [(x,y)], ll_pts: [(lat,lng)] -> (a,b,c,d,e,f)  (X,Y は WebMercator)"""
    import numpy as np
    n = len(img_pts)
    if n < 3:
        raise ValueError("アフィン変換には最低3点が必要です（中心+2点など）")
    XY = []
    for (lat, lng) in ll_pts:
        X, Y = _lonlat_to_mercator(lng, lat)
        XY.append((X, Y))

    A = np.zeros((2 * n, 6), dtype=float)
    b = np.zeros((2 * n,), dtype=float)
    for i, ((x, y), (X, Y)) in enumerate(zip(img_pts, XY)):
        A[2 * i, 0] = x
        A[2 * i, 1] = y
        A[2 * i, 2] = 1
        b[2 * i] = X
        A[2 * i + 1, 3] = x
        A[2 * i + 1, 4] = y
        A[2 * i + 1, 5] = 1
        b[2 * i + 1] = Y

    coef, *_ = np.linalg.lstsq(A, b, rcond=None)
    a, b_, c, d, e, f = coef.tolist()
    return a, b_, c, d, e, f


# ---- 新規: 撮影メタデータからのアフィン確定（B-2） ----
def res_at_zoom(z):
    """Web メルカトルの、ズーム z における 1 CSS ピクセルあたりの解像度 [m / CSS px]。

    z は float 可（Leaflet の小数ズームでも連続的に定義できる）。
    """
    return _EARTH_CIRCUMFERENCE / (_TILE_SIZE * (2.0 ** float(z)))


def _capture_scale(image_width, zoom, capture_width=None, capture_dpr=None):
    """画像 1 ピクセルあたりのメートル数 s = res(z) / k を返す。

    k = 画像幅 / 撮影時コンテナ CSS 幅（通常 devicePixelRatio と一致）。
    capture_width があればそれを優先、無ければ capture_dpr、どちらも無ければ k=1。
    """
    if capture_width:
        k = float(image_width) / float(capture_width)
    elif capture_dpr:
        k = float(capture_dpr)
    else:
        k = 1.0
    if k <= 0:
        raise ValueError("capture スケール k が 0 以下です")
    return res_at_zoom(zoom) / k


def affine_from_capture(
    center_lat, center_lng, zoom, image_width, image_height,
    capture_width=None, capture_height=None, capture_dpr=None,
):
    """撮影時の中心・ズーム・画像サイズから 6 パラメータアフィンを計算する（対応点 0 点）。

    返り値 (a, b, c, d, e, f):  X = a*x + b*y + c,  Y = d*x + e*y + f
    x は画像左上原点・右向き、y は下向き。X/Y は EPSG:3857 メートル。
    """
    s = _capture_scale(image_width, zoom, capture_width, capture_dpr)
    x0, y0 = _lonlat_to_mercator(center_lng, center_lat)
    a = s
    b = 0.0
    c = x0 - s * (float(image_width) / 2.0)
    d = 0.0
    e = -s
    f = y0 + s * (float(image_height) / 2.0)
    return a, b, c, d, e, f


# ---- 新規: 対応点フォールバック（B-5） ----
def fit_shift_only(base_affine, img_pt, ll_pt):
    """スケール（a,b,d,e）を base_affine から固定し、平行移動 c,f だけを 1 点で合わせ直す。"""
    a, b, c, d, e, f = base_affine
    x, y = img_pt
    lat, lng = ll_pt
    tx, ty = _lonlat_to_mercator(lng, lat)
    c_new = tx - a * x - b * y
    f_new = ty - d * x - e * y
    return a, b, c_new, d, e, f_new


def fit_similarity_no_rotation(img_pts, ll_pts):
    """回転を許さない相似変換を最小二乗で解く（未知数 s, tx, ty の 3 つ、最低 2 点）。

    モデル:  X_i =  s * x_i + tx
             Y_i = -s * y_i + ty
    返り値は 6 パラメータ形式 (s, 0, tx, 0, -s, ty)。
    """
    import numpy as np
    n = len(img_pts)
    if n < 2:
        raise ValueError("相似変換には最低2点が必要です")
    rows = []
    rhs = []
    for (x, y), (lat, lng) in zip(img_pts, ll_pts):
        X, Y = _lonlat_to_mercator(lng, lat)
        rows.append([x, 1.0, 0.0])
        rhs.append(X)
        rows.append([-y, 0.0, 1.0])
        rhs.append(Y)
    A = np.array(rows, dtype=float)
    bb = np.array(rhs, dtype=float)
    sol, *_ = np.linalg.lstsq(A, bb, rcond=None)
    s, tx, ty = sol.tolist()
    return s, 0.0, tx, 0.0, -s, ty


# ---- 新規: save リクエストの capture 取り出しと georef_mode 解決（B-5 / B-7） ----
def extract_capture(data, suffix=""):
    """save リクエスト dict から capture_* を取り出し正規化する。suffix は '' か '2'。

    返り値のキーは center_lat / center_lng / zoom / width / height / dpr。
    未指定・空文字は None。数値化に失敗したら ValueError。
    """
    def num(key):
        v = data.get(f"capture_{key}{suffix}")
        return None if v in (None, "") else float(v)

    def inte(key):
        v = data.get(f"capture_{key}{suffix}")
        return None if v in (None, "") else int(v)

    return {
        "center_lat": num("center_lat"),
        "center_lng": num("center_lng"),
        "zoom": num("zoom"),
        "width": inte("width"),
        "height": inte("height"),
        "dpr": num("dpr"),
    }


def resolve_affine(mode, pts_xy, pts_ll, cap, image_width, image_height):
    """georef_mode に応じて 6 パラメータアフィン (a,b,c,d,e,f) を返す。失敗時は ValueError。

    mode: "manual" | "auto" | "shift" | "similar"
    pts_xy: [(x, y), ...]（画像ピクセル）  pts_ll: [(lat, lng), ...]
    cap: extract_capture() の返り値
    """
    mode = (mode or "manual").strip().lower()
    if mode == "manual":
        if len(pts_xy) < 3:
            raise ValueError("manual モードは中心+他2点以上（合計3点以上）が必要です")
        return _fit_affine(pts_xy, pts_ll)

    if any(cap.get(k) is None for k in ("center_lat", "center_lng", "zoom")):
        raise ValueError("auto/shift/similar には capture_center_lat/lng/zoom が必要です")
    base = affine_from_capture(
        cap["center_lat"], cap["center_lng"], cap["zoom"],
        image_width, image_height,
        capture_width=cap.get("width"),
        capture_height=cap.get("height"),
        capture_dpr=cap.get("dpr"),
    )
    if mode == "auto":
        return base
    if mode == "shift":
        if len(pts_xy) < 1:
            raise ValueError("shift モードは対応点が 1 点必要です")
        return fit_shift_only(base, pts_xy[0], pts_ll[0])
    if mode == "similar":
        if len(pts_xy) < 2:
            raise ValueError("similar モードは対応点が 2 点必要です")
        return fit_similarity_no_rotation(pts_xy, pts_ll)
    raise ValueError(f"未知の georef_mode: {mode}")
```

- [ ] **Step 2: 構文チェック**

Run: `python -c "import migrationmaps_geo as g; print(g.res_at_zoom(16))"`
Expected: `2.388657133911758` に近い値（`40075016.68557849 / (256 * 65536)`）が表示され、例外が出ない。

- [ ] **Step 3: コミット**

```bash
git add migrationmaps_geo.py
git commit -m "feat(geo): add migrationmaps_geo module with capture-based affine and fallback fitters"
```

## Task 2: `app.py` を `migrationmaps_geo` に配線し直す

**Files:**
- Modify: `app.py:93-138`（座標関数の定義ブロック）と import 節

- [ ] **Step 1: import を追加する**

`app.py` の import 群（現行 12–15 行付近、`from models import ...` の直後）に追加:

```python
from migrationmaps_geo import (
    _R,
    _lonlat_to_mercator,
    _mercator_to_lonlat,
    _img_to_latlng,
    _fit_affine,
    res_at_zoom,
    affine_from_capture,
    fit_shift_only,
    fit_similarity_no_rotation,
    extract_capture,
    resolve_affine,
)
```

- [ ] **Step 2: 重複定義を削除する**

`app.py` 現行 93–138 行（`# ---- 座標変換ユーティリティ ...` コメントから `_img_to_latlng` の定義終わりまで）を削除する。**削除対象は次の 5 つの定義と直上のコメント行のみ**: `_R = 6378137.0` / `def _lonlat_to_mercator` / `def _mercator_to_lonlat` / `def _fit_affine` / `def _img_to_latlng`。前後の空行と `# ===== 既存ルート =====` の区切りコメントは残す。

- [ ] **Step 3: import 時エラーが無いことを確認する（フル依存が入った環境で）**

Run: `python -c "import os; os.environ.setdefault('DATABASE_URL','postgresql://u:p@localhost/none'); import app; print('ok', app._fit_affine([(0,0),(10,0),(0,10)], [(36.06,136.22),(36.06,136.23),(36.07,136.22)]))"`
Expected: `ok (...)` と 6 要素タプル。`ModuleNotFoundError: No module named 'flask_mail'` 等が出たら先に `pip install -r requirements.txt`。DB 接続は発生しないので `DATABASE_URL` はダミーで良い。

- [ ] **Step 4: 座標関数の往復整合（app 経由の回帰チェック、フル依存環境で）**

Run:
```bash
python -c "
import os; os.environ.setdefault('DATABASE_URL','postgresql://u:p@localhost/none')
import app
a=app._fit_affine([(0,0),(100,0),(0,100),(100,100)], [(36.0620,136.2230),(36.0620,136.2245),(36.0610,136.2230),(36.0610,136.2245)])
lat,lng=app._img_to_latlng(*a, 50, 50)
print(round(lat,5), round(lng,5))
"
```
Expected: `36.0615 136.22375` 付近（画像中心 (50,50) が 4 隅の重心緯度経度）。フル依存が無い場合はこの同値チェックを `python -m pytest tests/test_migrationmaps_geo.py` で代替する（Task 3）。

- [ ] **Step 5: コミット**

```bash
git add app.py
git commit -m "refactor(app): source coordinate helpers from migrationmaps_geo"
```

## Task 3: `migrationmaps_geo` の単体テスト

**Files:**
- Create: `pytest.ini`, `tests/__init__.py`, `tests/test_migrationmaps_geo.py`
- Modify: `requirements.txt`

- [ ] **Step 1: pytest 設定と requirements を追加する**

Create `pytest.ini`:

```ini
[pytest]
testpaths = tests
python_files = test_*.py
addopts = -q
```

Create `tests/__init__.py`: （空ファイル）

`requirements.txt` の末尾に追記:

```
Pillow==12.2.0
numpy==2.4.4
pytest==8.3.3
```

- [ ] **Step 2: 失敗するテストを書く**

Create `tests/test_migrationmaps_geo.py`:

```python
import math
import pytest
from migrationmaps_geo import (
    _lonlat_to_mercator,
    _img_to_latlng,
    res_at_zoom,
    affine_from_capture,
    fit_shift_only,
    fit_similarity_no_rotation,
)

FUKUI = (36.0619, 136.2235)  # (lat, lng)


def test_res_at_zoom_known_values():
    # 40075016.68557849 / (256 * 2**z)
    assert res_at_zoom(0) == pytest.approx(156543.03392804097, rel=1e-12)
    assert res_at_zoom(16) == pytest.approx(2.388657133911758, rel=1e-12)
    # float ズームでも連続
    assert res_at_zoom(16.5) == pytest.approx(res_at_zoom(16) / math.sqrt(2), rel=1e-9)


def test_affine_from_capture_shape():
    lat, lng = FUKUI
    a, b, c, d, e, f = affine_from_capture(lat, lng, 16, 1024, 768)
    s = res_at_zoom(16)  # k=1
    assert a == pytest.approx(s)
    assert e == pytest.approx(-s)
    assert b == 0.0 and d == 0.0
    x0, y0 = _lonlat_to_mercator(lng, lat)
    assert c == pytest.approx(x0 - s * 512)
    assert f == pytest.approx(y0 + s * 384)


def test_affine_from_capture_center_roundtrips_to_center():
    lat, lng = FUKUI
    coef = affine_from_capture(lat, lng, 17, 1200, 900)
    got_lat, got_lng = _img_to_latlng(*coef, 600, 450)  # 画像中心
    assert got_lat == pytest.approx(lat, abs=1e-9)
    assert got_lng == pytest.approx(lng, abs=1e-9)


def test_affine_from_capture_corner_ordering_matches_overlay_bounds_logic():
    """画像四隅をアフィン変換したとき、左上が北西・右下が南東になる（overlay_bounds が前提とする向き）。"""
    lat, lng = FUKUI
    coef = affine_from_capture(lat, lng, 16, 1000, 800)
    nw = _img_to_latlng(*coef, 0, 0)
    se = _img_to_latlng(*coef, 1000, 800)
    assert nw[0] > lat > se[0]      # 緯度: 上が北
    assert nw[1] < lng < se[1]      # 経度: 左が西


def test_affine_from_capture_dpr_halves_scale():
    lat, lng = FUKUI
    base = affine_from_capture(lat, lng, 16, 1024, 768)
    retina = affine_from_capture(lat, lng, 16, 1024, 768, capture_dpr=2)
    assert retina[0] == pytest.approx(base[0] / 2)
    # capture_width 指定でも同じ結果（1024 画像を 512 CSS 幅で撮影 = dpr 2）
    via_width = affine_from_capture(lat, lng, 16, 1024, 768, capture_width=512)
    assert via_width[0] == pytest.approx(retina[0])


def test_affine_ground_width_matches_resolution():
    """画像全幅のメルカトル距離 = s * 画像幅 = res(z) * コンテナ幅。"""
    lat, lng = FUKUI
    coef = affine_from_capture(lat, lng, 15, 800, 600, capture_width=800)
    xL = coef[0] * 0 + coef[2]
    xR = coef[0] * 800 + coef[2]
    assert (xR - xL) == pytest.approx(res_at_zoom(15) * 800, rel=1e-12)


def test_fit_shift_only_moves_reference_point_onto_target():
    lat, lng = FUKUI
    base = affine_from_capture(lat, lng, 16, 1000, 800)
    # 画像 (100, 100) が、狙いの緯度経度に正確に載るよう平行移動だけ直す
    target = (36.0625, 136.2240)
    coef = fit_shift_only(base, (100, 100), target)
    assert coef[0] == base[0] and coef[4] == base[4]  # スケール不変
    got = _img_to_latlng(*coef, 100, 100)
    assert got[0] == pytest.approx(target[0], abs=1e-9)
    assert got[1] == pytest.approx(target[1], abs=1e-9)


def test_fit_similarity_recovers_known_transform_from_two_points():
    # 既知の (s, tx, ty) から 2 点生成 → 完全復元
    s, tx, ty = 3.5, 15100000.0, 4300000.0
    from migrationmaps_geo import _mercator_to_lonlat
    img_pts = [(10.0, 20.0), (400.0, 550.0)]
    ll_pts = []
    for x, y in img_pts:
        X = s * x + tx
        Y = -s * y + ty
        lon, la = _mercator_to_lonlat(X, Y)
        ll_pts.append((la, lon))
    coef = fit_similarity_no_rotation(img_pts, ll_pts)
    assert coef[0] == pytest.approx(s, rel=1e-6)
    assert coef[2] == pytest.approx(tx, rel=1e-9)
    assert coef[5] == pytest.approx(ty, rel=1e-9)
    assert coef[1] == 0.0 and coef[3] == 0.0
    assert coef[4] == pytest.approx(-s, rel=1e-6)


def test_fit_similarity_least_squares_with_three_points():
    s, tx, ty = 2.0, 15100000.0, 4300000.0
    from migrationmaps_geo import _mercator_to_lonlat
    img_pts = [(0.0, 0.0), (500.0, 0.0), (0.0, 400.0)]
    ll_pts = []
    for i, (x, y) in enumerate(img_pts):
        X = s * x + tx + (1.0 if i == 1 else 0.0)   # わずかなノイズ
        Y = -s * y + ty
        lon, la = _mercator_to_lonlat(X, Y)
        ll_pts.append((la, lon))
    coef = fit_similarity_no_rotation(img_pts, ll_pts)
    assert coef[0] == pytest.approx(s, abs=0.01)


def test_acceptance_error_within_one_image_pixel_near_center():
    """B-6 受け入れ条件: 方式Aのベース地図をそのまま使うと、中心±200m の任意点で
    アフィン誤差 < 1 画像ピクセル。ここでは affine_from_capture を真値として、
    再サンプリングした点の往復誤差がピクセル解像度未満であることを確認する。"""
    lat, lng = FUKUI
    W, H, Z = 1024, 1024, 16
    coef = affine_from_capture(lat, lng, Z, W, H)
    s = res_at_zoom(Z)
    # 中心から 200m 相当 ~= 84 px。四方の点で往復
    for dx, dy in [(80, 0), (-80, 0), (0, 80), (0, -80), (60, 60)]:
        px, py = W / 2 + dx, H / 2 + dy
        la, lo = _img_to_latlng(*coef, px, py)
        # 逆算: メルカトルに戻して画像座標へ
        X, Y = _lonlat_to_mercator(lo, la)
        back_x = (X - coef[2]) / coef[0]
        back_y = (Y - coef[5]) / coef[4]
        assert abs(back_x - px) < 1.0
        assert abs(back_y - py) < 1.0
```

- [ ] **Step 3: テストを実行して失敗を確認する（依存追加前の状態なら PASS するはずだが、まずは実行して緑を確認）**

Run: `python -m pytest tests/test_migrationmaps_geo.py -v`
Expected: 全テスト PASS。もし `ModuleNotFoundError: migrationmaps_geo` なら、リポジトリルートで実行しているか確認する（`pytest.ini` の rootdir が効く）。

- [ ] **Step 4: コミット**

```bash
git add pytest.ini tests/ requirements.txt
git commit -m "test(geo): unit tests for capture affine, shift and similarity fitters"
```

**フェーズ 1 完了報告:** `migrationmaps_geo.py` 新規、`app.py` は座標関数を移設先から import、`tests/test_migrationmaps_geo.py` 11 ケース緑、`requirements.txt` に Pillow/numpy/pytest 明示。既存 `_fit_affine` / `_img_to_latlng` の呼び出し互換は Task 2 Step 4 で確認済み。

---

# フェーズ 2 — `MapProject` スキーマ拡張とマイグレーション

## Task 4: `models.py` に georef / capture カラムを追加

**Files:**
- Modify: `models.py`（`class MapProject` の定義内、現行 216 行 `f2` の直後）

- [ ] **Step 1: カラムを追加する**

`models.py` の `MapProject` クラス、`f2 = db.Column(...)` の直後（現行 215–216 行あたり）に挿入:

```python
    # ---- ジオリファレンス方式（B-4） ----
    # "auto"   : capture メタデータから解析的に算出（対応点 0）
    # "shift"  : capture のスケールを使い 1 点で平行移動のみ補正
    # "similar": 2 点でスケール+平行移動を最小二乗（回転なし）
    # "manual" : 従来の 3 点以上フルアフィン
    georef_mode = db.Column(db.String(16), nullable=False, server_default="manual")
    georef_mode2 = db.Column(db.String(16), nullable=False, server_default="manual")

    # スクリーンショット/ベース地図生成時のメタデータ（レイヤー1）
    capture_center_lat = db.Column(db.Float, nullable=True)
    capture_center_lng = db.Column(db.Float, nullable=True)
    capture_zoom = db.Column(db.Float, nullable=True)
    capture_width = db.Column(db.Integer, nullable=True)   # CSS px
    capture_height = db.Column(db.Integer, nullable=True)  # CSS px
    capture_dpr = db.Column(db.Float, nullable=True)

    # 同上（レイヤー2）
    capture_center_lat2 = db.Column(db.Float, nullable=True)
    capture_center_lng2 = db.Column(db.Float, nullable=True)
    capture_zoom2 = db.Column(db.Float, nullable=True)
    capture_width2 = db.Column(db.Integer, nullable=True)
    capture_height2 = db.Column(db.Integer, nullable=True)
    capture_dpr2 = db.Column(db.Float, nullable=True)
```

> 注: 仕様 B-4 は `georef_mode`（単数）と `capture_*` / `capture_*2` を要求している。`georef_mode2` はレイヤー2でも auto/shift/similar を選べるようにするための対称拡張。既存レイヤー2は `server_default="manual"` で従来どおり。

- [ ] **Step 2: import が通ることを確認する**

Run: `python -c "import os; os.environ.setdefault('DATABASE_URL','postgresql://u:p@localhost/none'); from models import MapProject; print([c.name for c in MapProject.__table__.columns if c.name.startswith(('georef','capture'))])"`
Expected: 14 個のカラム名リストが表示される。

- [ ] **Step 3: コミット**

```bash
git add models.py
git commit -m "feat(models): add georef_mode and capture_* columns to MapProject"
```

## Task 5: マイグレーション SQL と実行スクリプト

**Files:**
- Create: `migrations/001_mapproject_georef.sql`, `scripts/run_migration.py`

- [ ] **Step 1: 実行スクリプトを作成する**

Create `scripts/run_migration.py`:

```python
"""1 つの .sql ファイルを DATABASE_URL に対して 1 トランザクションで適用する。

使い方:  python scripts/run_migration.py migrations/001_mapproject_georef.sql
"""
import os
import sys
import pathlib

import psycopg2
from dotenv import load_dotenv

load_dotenv()


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: python scripts/run_migration.py <path-to.sql>", file=sys.stderr)
        return 2
    sql_path = pathlib.Path(sys.argv[1])
    if not sql_path.is_file():
        print(f"not found: {sql_path}", file=sys.stderr)
        return 2

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL is not set", file=sys.stderr)
        return 2
    if db_url.startswith("postgres://"):
        db_url = db_url.replace("postgres://", "postgresql://", 1)

    sql = sql_path.read_text(encoding="utf-8")
    conn = psycopg2.connect(db_url)
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(sql)
        print(f"applied: {sql_path.name}")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: マイグレーション SQL を作成する（冪等）**

Create `migrations/001_mapproject_georef.sql`:

```sql
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
```

- [ ] **Step 3: ローカル/ステージング DB に適用する**

Run: `python scripts/run_migration.py migrations/001_mapproject_georef.sql`
Expected: `applied: 001_mapproject_georef.sql`。再実行しても（`IF NOT EXISTS` により）エラーにならないことを確認する。

- [ ] **Step 4: 既存プロジェクトが従来どおり表示されることを確認する**

手動確認: 既存 `project_id` があれば `/migrationmaps/m/<id>` を開き、イラスト地図オーバーレイ・店舗マーカー・ビルガイドが今までどおり表示されること。`/migrationmaps/admin?project_id=<id>` で「編集」しても点・アフィンが変わらないこと。

- [ ] **Step 5: コミット**

```bash
git add migrations/001_mapproject_georef.sql scripts/run_migration.py
git commit -m "feat(migrations): add 001 mapproject georef columns + run_migration script"
```

## Task 6: `api_migrationmaps_save` に georef_mode 分岐を入れる（manual 挙動は不変）

**Files:**
- Modify: `app.py`（`api_migrationmaps_save`、現行 755–870 行）

`extract_capture` / `resolve_affine` は Task 1 で `migrationmaps_geo.py` に実装済み・Task 2 で `app.py` に import 済み。ここでは呼び出すだけ。

- [ ] **Step 1: `api_migrationmaps_save` に georef_mode / capture を取り込む**

現行 763 行 `points = data.get("points") or []` の直後に追加:

```python
    georef_mode = (data.get("georef_mode") or "manual").strip().lower()
    georef_mode2 = (data.get("georef_mode2") or "manual").strip().lower()
    cap1 = extract_capture(data, "")
    cap2 = extract_capture(data, "2")
```

- [ ] **Step 2: `api_migrationmaps_save` 本体を書き換える**

現行 776–777 行の**無条件 3 点チェックを削除**:

```python
    if len(points) < 3:
        return jsonify({"error": "点が少なすぎます。中心+他2点以上（合計3点以上）必要です"}), 400
```

現行 801–807 行（`if len(pts1) < 3: ... _fit_affine(pts1, ll1)` の塊）を次で置き換える:

```python
    try:
        a, b_, c, d, e, f = resolve_affine(georef_mode, pts1, ll1, cap1, int(w), int(h))
    except Exception as ex:
        return jsonify({"error": str(ex)}), 400
```

現行 809–814 行（レイヤー2 の `_fit_affine`）を次で置き換える:

```python
    a2 = b2_ = c2 = d2 = e2 = f2 = None
    layer2_active = bool(image_filename2) and (len(pts2) >= 3 or georef_mode2 != "manual")
    if layer2_active:
        try:
            a2, b2_, c2, d2, e2, f2 = resolve_affine(
                georef_mode2, pts2, ll2, cap2, int(w2 or 0), int(h2 or 0)
            )
        except Exception as ex:
            return jsonify({"error": f"レイヤー2アフィン計算エラー: {ex}"}), 400
```

`proj` の更新・新規作成ブロック（現行 821–847 行）に、`proj.switch_time_*` を設定している箇所と同じ流儀で次を追加（更新側・新規側の両方）:

```python
            proj.georef_mode = georef_mode
            proj.georef_mode2 = georef_mode2
            proj.capture_center_lat = cap1["center_lat"]
            proj.capture_center_lng = cap1["center_lng"]
            proj.capture_zoom = cap1["zoom"]
            proj.capture_width = cap1["width"]
            proj.capture_height = cap1["height"]
            proj.capture_dpr = cap1["dpr"]
            proj.capture_center_lat2 = cap2["center_lat"]
            proj.capture_center_lng2 = cap2["center_lng"]
            proj.capture_zoom2 = cap2["zoom"]
            proj.capture_width2 = cap2["width"]
            proj.capture_height2 = cap2["height"]
            proj.capture_dpr2 = cap2["dpr"]
```

新規 `MapProject(...)` コンストラクタ呼び出し（現行 835–847 行）にも同じキーワード引数を渡す。

> `_fit_affine` を直接呼んでいた箇所は `resolve_affine` 経由に一本化された。`manual` パスは `resolve_affine` 内で従来と同一の `_fit_affine(pts_xy, pts_ll)` を呼ぶため、既存の保存挙動は不変。

- [ ] **Step 3: 回帰チェック（manual、既存 JS ペイロード）**

手動確認: `/migrationmaps/admin` で従来どおり画像アップロード→中心+2点以上を設定→「DBへ保存」。成功し `project_id` が返ること。`georef_mode` を送っていない既存フロントからのリクエストでも `manual` として通ること。

- [ ] **Step 4: auto パスの手動確認（curl）**

Run（`<PID>` は既存プロジェクト、`image_filename` は既存の値に合わせる）:
```bash
curl -s -X POST http://localhost:5000/api/migrationmaps/save -H 'Content-Type: application/json' -d '{
  "project_id": <PID>, "name":"capture-test",
  "image_filename":"<既存 image_filename>", "image_width":1024, "image_height":1024,
  "georef_mode":"auto",
  "capture_center_lat":36.0619, "capture_center_lng":136.2235, "capture_zoom":16,
  "capture_width":1024, "capture_height":1024,
  "points": []
}'
```
Expected: `{"project_id": <PID>, "updated": true}`。続けて `curl -s http://localhost:5000/api/migrationmaps/<PID>/overlay_bounds` が、中心が概ね (36.0619, 136.2235)・幅が `res(16)*1024 ≒ 2446m` 相当のバウンディングボックスを返す。

- [ ] **Step 5: コミット**

```bash
git add app.py
git commit -m "feat(save): honor georef_mode (auto/shift/similar) with capture metadata; keep manual behavior"
```

## Task 7: `api_migrationmaps_get` のレスポンスに georef / capture を含める

**Files:**
- Modify: `app.py`（`api_migrationmaps_get`、現行 914–929 行の返却 dict）

- [ ] **Step 1: 返却 JSON を拡張する**

`return jsonify({...})` に次のキーを追加:

```python
        "georef_mode": proj.georef_mode,
        "georef_mode2": proj.georef_mode2,
        "capture": {
            "center_lat": proj.capture_center_lat,
            "center_lng": proj.capture_center_lng,
            "zoom": proj.capture_zoom,
            "width": proj.capture_width,
            "height": proj.capture_height,
            "dpr": proj.capture_dpr,
        },
        "capture2": {
            "center_lat": proj.capture_center_lat2,
            "center_lng": proj.capture_center_lng2,
            "zoom": proj.capture_zoom2,
            "width": proj.capture_width2,
            "height": proj.capture_height2,
            "dpr": proj.capture_dpr2,
        },
```

- [ ] **Step 2: 確認**

Run: `curl -s http://localhost:5000/api/migrationmaps/<PID> | python -m json.tool | grep -E "georef|capture"`
Expected: `georef_mode` と `capture` オブジェクトが出力される。既存プロジェクトでは `georef_mode: "manual"`、`capture` の各値は `null`。

- [ ] **Step 3: コミット**

```bash
git add app.py
git commit -m "feat(get): expose georef_mode and capture metadata in project GET"
```

**フェーズ 2 完了報告:** `models.py`（+14 カラム）、`migrations/001_*.sql` と `scripts/run_migration.py`、`api_migrationmaps_save`（`resolve_affine` 一本化・manual 不変・auto/shift/similar 追加）、`api_migrationmaps_get`（georef/capture 返却）。既存プロジェクトは `manual` のまま従来表示。

---

# フェーズ 3 — 方式A: サーバー側ベース地図生成

## Task 8: `migrationmaps_basemap.py` を作成

**Files:**
- Create: `migrationmaps_basemap.py`

- [ ] **Step 1: モジュールを作成する**

Create `migrationmaps_basemap.py`:

```python
"""方式A: OSM タイルを取得・合成して 1 枚のベース地図 PNG を返す。

tile_url は "{z}/{x}/{y}" を含むテンプレート。`{s}` サブドメインは非対応
（サーバー生成では固定ホストを使う）。BASEMAP_TILE_URL 未設定時は呼び出し側で 503。
"""
import io
import math
import time

import requests
from PIL import Image

TILE_SIZE = 256
CONNECT_TIMEOUT = 10
READ_TIMEOUT = 60
MAX_OUTPUT_PX = 4096


def _project_px(lat, lng, zoom):
    """緯度経度 -> ズーム zoom におけるグローバルピクセル座標（左上原点）。"""
    n = TILE_SIZE * (2.0 ** zoom)
    x = (lng + 180.0) / 360.0 * n
    lat_rad = math.radians(lat)
    y = (1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n
    return x, y


def generate_basemap(center_lat, center_lng, zoom, width, height,
                     tile_url, user_agent, sleep_s=0.0):
    """中心・整数ズーム・出力サイズ（px）を指定して PNG バイト列を返す。"""
    zoom = int(round(zoom))
    if width <= 0 or height <= 0 or width > MAX_OUTPUT_PX or height > MAX_OUTPUT_PX:
        raise ValueError(f"width/height は 1..{MAX_OUTPUT_PX} の範囲で指定してください")

    cx, cy = _project_px(center_lat, center_lng, zoom)
    left = cx - width / 2.0
    top = cy - height / 2.0
    right = cx + width / 2.0
    bottom = cy + height / 2.0

    tx_min = int(math.floor(left / TILE_SIZE))
    ty_min = int(math.floor(top / TILE_SIZE))
    tx_max = int(math.floor((right - 1e-6) / TILE_SIZE))
    ty_max = int(math.floor((bottom - 1e-6) / TILE_SIZE))

    max_index = 2 ** zoom
    canvas = Image.new("RGB", (
        (tx_max - tx_min + 1) * TILE_SIZE,
        (ty_max - ty_min + 1) * TILE_SIZE,
    ), (221, 221, 221))

    headers = {"User-Agent": user_agent}
    session = requests.Session()
    for tx in range(tx_min, tx_max + 1):
        for ty in range(ty_min, ty_max + 1):
            wrapped_x = tx % max_index
            if ty < 0 or ty >= max_index:
                continue
            url = tile_url.format(z=zoom, x=wrapped_x, y=ty)
            resp = session.get(url, headers=headers,
                               timeout=(CONNECT_TIMEOUT, READ_TIMEOUT))
            resp.raise_for_status()
            tile = Image.open(io.BytesIO(resp.content)).convert("RGB")
            px = (tx - tx_min) * TILE_SIZE
            py = (ty - ty_min) * TILE_SIZE
            canvas.paste(tile, (px, py))
            if sleep_s:
                time.sleep(sleep_s)

    crop_left = int(round(left - tx_min * TILE_SIZE))
    crop_top = int(round(top - ty_min * TILE_SIZE))
    out = canvas.crop((crop_left, crop_top, crop_left + width, crop_top + height))

    buf = io.BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()
```

- [ ] **Step 2: 純関数の確認（ネットワーク不要）**

Run: `python -c "from migrationmaps_basemap import _project_px; import math; x,y=_project_px(0,0,0); print(round(x,3), round(y,3))"`
Expected: `128.0 128.0`（ズーム0で赤道・本初子午線はタイル中心）。

- [ ] **Step 3: コミット**

```bash
git add migrationmaps_basemap.py
git commit -m "feat(basemap): tile fetch + Pillow compositing for method A"
```

## Task 9: `GET /api/migrationmaps/basemap` エンドポイント

**Files:**
- Modify: `app.py`（import 節、および `api_migrationmaps_upload` の直後あたりにルート追加）

- [ ] **Step 1: import と定数**

`app.py` の `from flask import ...`（現行 1 行）に `send_file` を追加。ファイル冒頭の設定セクション（現行 69–73 行、MigrationMaps 設定付近）に追加:

```python
BASEMAP_TILE_URL = os.environ.get("BASEMAP_TILE_URL", "").strip()
BASEMAP_USER_AGENT = os.environ.get(
    "BASEMAP_USER_AGENT", "MigrationMap/1.0 (+https://example.com; contact@example.com)"
)
# OSM 公式タイルを使う開発時のみ True 相当（リクエスト間スリープ）
BASEMAP_TILE_SLEEP_S = float(os.environ.get("BASEMAP_TILE_SLEEP_S", "0") or "0")
```

- [ ] **Step 2: ルートを追加する**

`api_migrationmaps_upload` 関数（現行 711–753 行）の直後に追加:

```python
@app.get("/api/migrationmaps/basemap")
def api_migrationmaps_basemap():
    if not BASEMAP_TILE_URL:
        return jsonify({
            "error": "BASEMAP_TILE_URL が未設定です。方式A（サーバー側ベース地図生成）は無効です。"
                     "自前タイルサーバー / 商用タイル / 開発用 OSM 公式タイルの URL を環境変数に設定してください。"
        }), 503

    try:
        lat = float(request.args.get("lat", ""))
        lng = float(request.args.get("lng", ""))
        zoom = int(round(float(request.args.get("zoom", ""))))
        width = int(request.args.get("width", ""))
        height = int(request.args.get("height", ""))
    except (TypeError, ValueError):
        return jsonify({"error": "lat/lng/zoom/width/height は数値で必須です"}), 400

    if not (-85.05112878 <= lat <= 85.05112878 and -180 <= lng <= 180):
        return jsonify({"error": "lat/lng が範囲外です"}), 400
    if not (0 <= zoom <= 19):
        return jsonify({"error": "zoom は 0..19 で指定してください"}), 400
    if not (1 <= width <= 4096 and 1 <= height <= 4096):
        return jsonify({"error": "width/height は 1..4096 で指定してください"}), 400

    from migrationmaps_basemap import generate_basemap
    try:
        png = generate_basemap(
            lat, lng, zoom, width, height,
            tile_url=BASEMAP_TILE_URL,
            user_agent=BASEMAP_USER_AGENT,
            sleep_s=BASEMAP_TILE_SLEEP_S,
        )
    except Exception as ex:
        current_app.logger.error("basemap generation failed: %s", ex)
        return jsonify({"error": f"ベース地図の生成に失敗しました: {ex}"}), 502

    from io import BytesIO
    resp = send_file(BytesIO(png), mimetype="image/png",
                     download_name=f"basemap_{lat:.6f}_{lng:.6f}_z{zoom}_{width}x{height}.png")
    resp.headers["X-Basemap-Center"] = f"{lat},{lng}"
    resp.headers["X-Basemap-Zoom"] = str(zoom)
    resp.headers["X-Basemap-Size"] = f"{width}x{height}"
    resp.headers["Access-Control-Expose-Headers"] = "X-Basemap-Center,X-Basemap-Zoom,X-Basemap-Size"
    return resp
```

- [ ] **Step 3: 未設定時の確認**

Run: `curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:5000/api/migrationmaps/basemap?lat=36.06&lng=136.22&zoom=16&width=800&height=600"`
Expected: `503`（`BASEMAP_TILE_URL` 未設定時）。

- [ ] **Step 4: 設定時の確認（開発用 OSM タイル）**

`.env` に一時的に追加:
```
BASEMAP_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
BASEMAP_TILE_SLEEP_S=0.1
```
Run: `curl -s "http://localhost:5000/api/migrationmaps/basemap?lat=36.0619&lng=136.2235&zoom=16&width=512&height=512" -o /tmp/basemap.png -D - | grep -i x-basemap`
Expected: `X-Basemap-Center: 36.0619,136.2235` 等のヘッダが返り、`/tmp/basemap.png` が 512×512 の PNG（`python -c "from PIL import Image; print(Image.open('/tmp/basemap.png').size)"` で確認）。

- [ ] **Step 5: コミット**

```bash
git add app.py
git commit -m "feat(api): GET /api/migrationmaps/basemap for method A base map generation"
```

## Task 10: 管理画面に「ベース地図を書き出す」UI（方式A）

**Files:**
- Modify: `templates/migrationmaps/admin.html`（中央パネル、レイヤー1操作の row 付近）
- Modify: `static/migrationmaps/admin.js`

- [ ] **Step 1: admin map の Leaflet 初期化を整数ズームに固定する**

`static/migrationmaps/admin.js` 現行 400 行:
```javascript
const map = L.map("map").setView([36.061, 136.223], 15);
```
を次に置き換える:
```javascript
const map = L.map("map", { zoomSnap: 1, zoomDelta: 1 }).setView([36.061, 136.223], 15);
```

- [ ] **Step 2: DOM を追加する**

`admin.html` 現行 246–252 行の「レイヤー1（主レイヤー）」ヘッダと file 行の間（`<div class="layer-panel-header">レイヤー1...</div>` の直後）に追加:

```html
        <div class="capture-box" id="captureBox1">
          <div class="capture-box-title">ジオリファレンス（右のOSM地図に合わせてから）</div>
          <div class="row" style="gap:6px; flex-wrap:wrap;">
            <label>出力サイズ
              <input type="number" id="basemapW" value="1024" min="256" max="4096" step="128" style="width:80px;" /> ×
              <input type="number" id="basemapH" value="1024" min="256" max="4096" step="128" style="width:80px;" />
            </label>
            <button type="button" id="btnExportBasemap" class="small-btn">① ベース地図PNGを書き出す</button>
            <button type="button" id="btnCaptureFrame" class="small-btn">① 代わりに現在の表示をキャプチャ枠に確定</button>
          </div>
          <div class="muted" id="captureStatus1">未確定（確定するとレイヤー1は対応点なしで保存できます）</div>
        </div>
```

`admin.html` の `<style>` 内に追加:
```css
    .capture-box { border:1px solid #bfdbfe; background:#eff6ff; border-radius:8px; padding:8px 10px; margin-bottom:8px; }
    .capture-box-title { font-size:12px; font-weight:700; color:#1d4ed8; margin-bottom:6px; }
    #captureGuideFrame { position:absolute; border:2px dashed #2563eb; pointer-events:none; z-index:500; }
```

- [ ] **Step 3: admin.js に capture 状態と方式A/Bのハンドラを追加する**

`static/migrationmaps/admin.js` の「レイヤー状態管理」付近（`let currentProjectId = null;` の後、現行 75 行あたり）に追加:

```javascript
// ジオリファレンス capture メタデータ（レイヤー別）。null = 未確定（= manual）
const captureMeta = { 1: null, 2: null };

function captureFromCurrentMap() {
  const cont = map.getContainer();
  return {
    center_lat: map.getCenter().lat,
    center_lng: map.getCenter().lng,
    zoom: map.getZoom(),
    width: cont.clientWidth,
    height: cont.clientHeight,
    dpr: window.devicePixelRatio || 1,
  };
}

function setCaptureStatus(layerNum) {
  const el = $(`captureStatus${layerNum}`);
  if (!el) return;
  const m = captureMeta[layerNum];
  el.textContent = m
    ? `確定: 中心 ${m.center_lat.toFixed(5)}, ${m.center_lng.toFixed(5)} / z${m.zoom} / ${m.width}×${m.height}px @dpr${m.dpr}`
    : "未確定（確定するとレイヤー1は対応点なしで保存できます）";
}

function showGuideFrame() {
  const mapEl = $("map");
  let frame = $("captureGuideFrame");
  if (!frame) {
    frame = document.createElement("div");
    frame.id = "captureGuideFrame";
    mapEl.parentElement.appendChild(frame);
  }
  frame.style.left = mapEl.offsetLeft + "px";
  frame.style.top = mapEl.offsetTop + "px";
  frame.style.width = mapEl.clientWidth + "px";
  frame.style.height = mapEl.clientHeight + "px";
}

$("btnCaptureFrame")?.addEventListener("click", () => {
  captureMeta[activeLayer] = captureFromCurrentMap();
  setCaptureStatus(activeLayer);
  showGuideFrame();
  log(`[CAPTURE] L${activeLayer} キャプチャ枠を確定。この枠のとおりにスクショ→イラスト化→アップロードしてください`);
  setDirty(true);
});

$("btnExportBasemap")?.addEventListener("click", async () => {
  const w = parseInt($("basemapW").value, 10);
  const h = parseInt($("basemapH").value, 10);
  const c = map.getCenter();
  const z = map.getZoom();
  const url = `/api/migrationmaps/basemap?lat=${c.lat}&lng=${c.lng}&zoom=${z}&width=${w}&height=${h}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || `ベース地図の取得に失敗しました (${res.status})`);
      return;
    }
    // capture メタデータはサーバーが生成に使った値（= リクエスト値）で確定
    captureMeta[activeLayer] = {
      center_lat: c.lat, center_lng: c.lng, zoom: z,
      width: w, height: h, dpr: 1,
    };
    setCaptureStatus(activeLayer);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `basemap_z${z}_${w}x${h}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
    log(`[CAPTURE] L${activeLayer} ベース地図PNGを書き出し。上からイラストを描いて同サイズでアップロードしてください`);
    setDirty(true);
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
  }
});
```

`switchActiveLayer` 関数末尾（現行 101 行 `log(...)` の前）に `setCaptureStatus(layerNum);` を追加。

- [ ] **Step 4: 保存ペイロードに georef_mode / capture_* を載せる**

`static/migrationmaps/admin.js` の `$("btnSave")` ハンドラ内、`const body = {` の直前（現行 616 行付近）に追加:

```javascript
  function georefFieldsFor(layerNum, readyCount) {
    const m = captureMeta[layerNum];
    if (!m) return { mode: "manual", cap: {} };
    let mode = "manual";
    if (readyCount === 0) mode = "auto";
    else if (readyCount === 1) mode = "shift";
    else if (readyCount === 2) mode = "similar";
    return {
      mode,
      cap: {
        center_lat: m.center_lat, center_lng: m.center_lng, zoom: m.zoom,
        width: m.width, height: m.height, dpr: m.dpr,
      },
    };
  }
  const g1 = georefFieldsFor(1, ready1.length);
  const g2 = georefFieldsFor(2, ready2.length);
```

現行 598–599 行の「レイヤー1に 3 点未満なら弾く」チェックを、capture 確定時は通すよう緩める:

```javascript
  const ready1 = ls1.points.filter((p) => p.img_ok && p.ll_ok);
  if (!captureMeta[1] && ready1.length < 3) {
    alert("レイヤー1に中心+他2点以上（合計3点以上）を設定するか、①でキャプチャ枠を確定してください");
    return;
  }
```

`const body = { ... }` に次のキーを追加:

```javascript
    georef_mode: g1.mode,
    georef_mode2: g2.mode,
    capture_center_lat: g1.cap.center_lat ?? null,
    capture_center_lng: g1.cap.center_lng ?? null,
    capture_zoom: g1.cap.zoom ?? null,
    capture_width: g1.cap.width ?? null,
    capture_height: g1.cap.height ?? null,
    capture_dpr: g1.cap.dpr ?? null,
    capture_center_lat2: g2.cap.center_lat ?? null,
    capture_center_lng2: g2.cap.center_lng ?? null,
    capture_zoom2: g2.cap.zoom ?? null,
    capture_width2: g2.cap.width ?? null,
    capture_height2: g2.cap.height ?? null,
    capture_dpr2: g2.cap.dpr ?? null,
```

`hasLayer2` の判定（現行 603 行）を `const hasLayer2 = ls2.uploaded && (ready2.length >= 3 || !!captureMeta[2]);` に変更。

- [ ] **Step 5: `loadProject` で capture を復元する**

`static/migrationmaps/admin.js` の `loadProject`（現行 692 行〜）、`currentAffineL2 = proj.affine2 || null;` の直後に追加:

```javascript
  captureMeta[1] = proj.capture && proj.capture.center_lat != null ? {
    center_lat: proj.capture.center_lat, center_lng: proj.capture.center_lng,
    zoom: proj.capture.zoom, width: proj.capture.width,
    height: proj.capture.height, dpr: proj.capture.dpr || 1,
  } : null;
  captureMeta[2] = proj.capture2 && proj.capture2.center_lat != null ? {
    center_lat: proj.capture2.center_lat, center_lng: proj.capture2.center_lng,
    zoom: proj.capture2.zoom, width: proj.capture2.width,
    height: proj.capture2.height, dpr: proj.capture2.dpr || 1,
  } : null;
```

`loadProject` 末尾（`setDirty(false);` の前）に `setCaptureStatus(1); setCaptureStatus(2);` を追加。

- [ ] **Step 6: 手動確認**

1. `/migrationmaps/admin` を開き地図名を入力。
2. 右OSM地図を福井駅前・z16 に合わせ「代わりに現在の表示をキャプチャ枠に確定」→ 破線枠が地図全体を囲み、ステータスが「確定: …」になる。
3. スクショを撮る代わりに、任意の画像（枠と同じ縦横比）を「画像を選択」でアップロード。点は 1 つも設定しない。
4. 「DBへ保存」→ 成功。`/api/migrationmaps/<id>` を見ると `georef_mode: "auto"`、`capture.center_lat` 等が入っている。
5. 「重ね合わせプレビュー」で、イラストが概ね正しい位置・縮尺で OSM に載る。
6. `BASEMAP_TILE_URL` 設定時: 「ベース地図PNGを書き出す」で PNG がダウンロードされ、`captureStatus1` が確定表示になる。

- [ ] **Step 7: コミット**

```bash
git add templates/migrationmaps/admin.html static/migrationmaps/admin.js
git commit -m "feat(admin): method A base map export + method B capture-frame UI, send georef_mode on save"
```

**フェーズ 3 完了報告:** `migrationmaps_basemap.py` 新規、`GET /api/migrationmaps/basemap`（`BASEMAP_TILE_URL` 未設定なら 503）、admin 画面に方式A/Bの「①」操作と capture 状態表示・保存時 `georef_mode` 送信。admin map は整数ズーム固定。

---

# フェーズ 4 — フォールバック（shift / similar）と検証モード

## Task 11: `resolve_affine` / `extract_capture` の単体テスト

**Files:**
- Create: `tests/test_resolve_affine.py`
- Modify: なし（`resolve_affine` / `extract_capture` はフェーズ1で `migrationmaps_geo.py` に実装済み）

- [ ] **Step 1: テストを書く（`migrationmaps_geo` だけを import — フル依存不要）**

Create `tests/test_resolve_affine.py`:

```python
import pytest
from migrationmaps_geo import (
    _img_to_latlng, _fit_affine, extract_capture, resolve_affine,
)

FUKUI = (36.0619, 136.2235)
CAP = {"center_lat": FUKUI[0], "center_lng": FUKUI[1], "zoom": 16,
       "width": 1024, "height": 1024, "dpr": 1}


def test_extract_capture_normalizes_keys_and_blanks():
    data = {
        "capture_center_lat": "36.5", "capture_center_lng": "",
        "capture_zoom": 16, "capture_width": "1024", "capture_height": None,
    }
    cap = extract_capture(data, "")
    assert cap["center_lat"] == 36.5
    assert cap["center_lng"] is None
    assert cap["zoom"] == 16.0
    assert cap["width"] == 1024
    assert cap["height"] is None and cap["dpr"] is None


def test_extract_capture_suffix2():
    cap = extract_capture({"capture_center_lat2": "1.0"}, "2")
    assert cap["center_lat"] == 1.0


def test_manual_mode_matches_fit_affine():
    xy = [(0, 0), (100, 0), (0, 100)]
    ll = [(36.0625, 136.2230), (36.0625, 136.2245), (36.0615, 136.2230)]
    got = resolve_affine("manual", xy, ll, {}, 1024, 1024)
    want = _fit_affine(xy, ll)
    assert got == pytest.approx(want)


def test_manual_mode_under_three_points_raises():
    with pytest.raises(ValueError):
        resolve_affine("manual", [(0, 0), (1, 1)], [FUKUI, FUKUI], {}, 1024, 1024)


def test_auto_mode_uses_capture_only():
    got = resolve_affine("auto", [], [], CAP, 1024, 1024)
    lat, lng = _img_to_latlng(*got, 512, 512)
    assert lat == pytest.approx(FUKUI[0], abs=1e-9)
    assert lng == pytest.approx(FUKUI[1], abs=1e-9)


def test_shift_mode_pins_the_single_point():
    target = (36.0630, 136.2250)
    got = resolve_affine("shift", [(200, 200)], [target], CAP, 1024, 1024)
    lat, lng = _img_to_latlng(*got, 200, 200)
    assert lat == pytest.approx(target[0], abs=1e-9)
    assert lng == pytest.approx(target[1], abs=1e-9)


def test_similar_mode_needs_two_points():
    with pytest.raises(ValueError):
        resolve_affine("similar", [(10, 10)], [FUKUI], CAP, 1024, 1024)


def test_auto_mode_missing_capture_raises():
    with pytest.raises(ValueError):
        resolve_affine("auto", [], [], {}, 1024, 1024)


def test_unknown_mode_raises():
    with pytest.raises(ValueError):
        resolve_affine("bogus", [], [], CAP, 1024, 1024)
```

- [ ] **Step 2: 実行**

Run: `python -m pytest tests/test_resolve_affine.py -v`
Expected: 10 ケース PASS。（`import app` 不要。`numpy` + `pytest` のみで動く。）

- [ ] **Step 3: コミット**

```bash
git add tests/test_resolve_affine.py
git commit -m "test(geo): resolve_affine and extract_capture cover manual/auto/shift/similar"
```

## Task 12: 検証モード（管理画面）— DOM とスタイル

**Files:**
- Modify: `templates/migrationmaps/admin.html`

- [ ] **Step 1: DOM を追加する**

`admin.html` の `#captureBox1`（Task 10 で追加）内、`#captureStatus1` の直後に追加:

```html
          <div class="row" style="margin-top:6px; gap:6px;">
            <button type="button" id="btnVerifyMode" class="small-btn">② 検証モード：イラストをクリック→OSMに変換点を表示</button>
            <span class="muted" id="verifyStatus"></span>
          </div>
```

- [ ] **Step 2: コミット**

```bash
git add templates/migrationmaps/admin.html
git commit -m "feat(admin): verification mode toggle DOM"
```

## Task 13: 検証モードのロジック

**Files:**
- Modify: `static/migrationmaps/admin.js`

- [ ] **Step 1: `res_at_zoom` 相当と検証状態を追加する**

`static/migrationmaps/admin.js` の captureMeta 定義付近に追加:

```javascript
const EARTH_CIRCUMFERENCE_M = 40075016.68557849;
function resAtZoom(z) { return EARTH_CIRCUMFERENCE_M / (256 * Math.pow(2, z)); }

// 画像座標 -> 緯度経度（アフィン係数はロード済みプロジェクトのもの）
function imgToLatLng(affine, x, y) {
  const { a, b, c, d, e, f } = affine;
  const R = 6378137;
  const X = a * x + b * y + c;
  const Y = d * x + e * y + f;
  const lng = (X / R) * 180 / Math.PI;
  const lat = (2 * Math.atan(Math.exp(Y / R)) - Math.PI / 2) * 180 / Math.PI;
  return [lat, lng];
}

let verifyMode = false;
let verifyMarker = null;     // OSM 上の「変換結果」
let verifyExpected = null;   // OSM 上の「本来あるべき位置」
```

- [ ] **Step 2: 検証モードのトグルとクリック処理**

`static/migrationmaps/admin.js` の末尾付近（`refreshShopList()` 呼び出しの前）に追加:

```javascript
$("btnVerifyMode")?.addEventListener("click", () => {
  verifyMode = !verifyMode;
  $("btnVerifyMode").classList.toggle("is-active", verifyMode);
  $("verifyStatus").textContent = verifyMode
    ? "イラスト地図をクリックしてください"
    : "";
  if (!verifyMode) {
    [verifyMarker, verifyExpected].forEach((m) => { if (m) map.removeLayer(m); });
    verifyMarker = verifyExpected = null;
  }
});

// イラストキャンバス側クリック（検証モードのみ）
[1, 2].forEach((layerNum) => {
  getCanvas(layerNum)?.addEventListener("click", (ev) => {
    if (!verifyMode) return;
    const affine = layerNum === 1 ? currentAffineL1 : currentAffineL2;
    if (!affine) { $("verifyStatus").textContent = "先に保存済みプロジェクトを読み込んでください"; return; }
    const ls = LAYERS[layerNum];
    const { cx, cy } = getCanvasPos(ev, getCanvas(layerNum));
    const imgX = cx / ls.canvasScale;
    const imgY = cy / ls.canvasScale;
    const [lat, lng] = imgToLatLng(affine, imgX, imgY);
    if (verifyMarker) map.removeLayer(verifyMarker);
    verifyMarker = L.circleMarker([lat, lng], {
      radius: 7, color: "#16a34a", fillColor: "#16a34a", fillOpacity: 0.8,
    }).addTo(map).bindPopup("変換結果").openPopup();
    map.panTo([lat, lng]);
    $("verifyStatus").textContent = "OSM 側で「本来あるべき位置」をクリックしてください";
  }, true);  // capture フェーズで、既存の点編集 click より先に拾う
});

// OSM 側クリック（検証モードのみ、対応点割当より優先）
map.on("click", (e) => {
  if (!verifyMode || !verifyMarker) return;
  if (verifyExpected) map.removeLayer(verifyExpected);
  verifyExpected = L.circleMarker(e.latlng, {
    radius: 7, color: "#dc2626", fillColor: "#dc2626", fillOpacity: 0.8,
  }).addTo(map).bindPopup("本来あるべき位置").openPopup();
  const a = verifyMarker.getLatLng();
  const dist = map.distance(a, e.latlng);  // メートル
  const tol = resAtZoom(map.getZoom()) * 3;
  const ok = dist <= tol;
  $("verifyStatus").textContent =
    `誤差 ${dist.toFixed(2)} m（許容 ${tol.toFixed(2)} m）${ok ? " ✓ OK" : " ⚠ 対応点モードでの補正を推奨"}`;
  $("verifyStatus").style.color = ok ? "#16a34a" : "#b02a37";
});
```

> 既存の `map.on("click", ...)`（対応点割当、現行 434 行）は `pendingAssign` が無ければ即 return するので、この追加ハンドラと共存する。検証モード中は対応点割当を開始しない運用とする。

- [ ] **Step 3: 手動確認**

1. 保存済みプロジェクト（`georef_mode: "auto"` で作ったもの）を「編集」で読み込む。
2. 「② 検証モード」を押す → キャンバスクリックで OSM に緑マーカー、地図がその点にパン。
3. OSM 上で対応する実際の位置をクリック → 「誤差 X m（許容 Y m）」表示。方式Aベース地図由来なら中心付近で誤差 < `res(z)` ≈ 2.4m（z16）に収まる。
4. もう一度「② 検証モード」で OFF、マーカーが消える。

- [ ] **Step 4: コミット**

```bash
git add static/migrationmaps/admin.js
git commit -m "feat(admin): affine verification mode with res(z)*3 tolerance warning"
```

## Task 14: 「1点/2点だけ設定して保存」経路の手動確認

**Files:**
- なし（フェーズ3の保存ロジック + フェーズ4のテストで実装済み。ここは E2E 確認のみ）

- [ ] **Step 1: shift（1点）**

1. capture 枠を確定（方式B）。
2. イラスト画像をアップロードし、中心だけ（=1点）画像座標＋OSM 緯度経度を設定。
3. 「DBへ保存」→ 成功。`/api/migrationmaps/<id>` で `georef_mode: "shift"`。
4. 検証モードで、設定した中心点の誤差がほぼ 0 m。

- [ ] **Step 2: similar（2点）**

1. capture 枠を確定。
2. 画像に 2 点設定 → 保存 → `georef_mode: "similar"`。
3. 検証モードで 2 点とも小さい誤差。回転しているイラストを入れても結果が回転しない（相似変換なので）ことを目視。

- [ ] **Step 3: manual（3点以上）が従来どおり**

capture を確定せずに 3 点設定 → 保存 → `georef_mode: "manual"`、従来と同じ結果。

- [ ] **Step 4: 報告のみ（コミット不要）**

**フェーズ 4 完了報告:** `resolve_affine` の auto/shift/similar/manual を単体テストで固定（`tests/test_resolve_affine.py`）。管理画面に検証モード（イラストクリック→OSM変換点表示→2点間距離→`res(z)*3` 超で警告）。0/1/2/3点それぞれの保存経路を E2E 確認。

---

# フェーズ 5 — Overpass 検索・取り込み API

## Task 15: `migrationmaps_osm.py` — タグ変換とレベル変換

**Files:**
- Create: `migrationmaps_osm.py`
- Create: `tests/test_migrationmaps_osm.py`

- [ ] **Step 1: レベル変換とタグ抽出の純関数を書く**

Create `migrationmaps_osm.py`:

```python
"""OpenStreetMap Overpass API から店舗候補を取得し、MigrationShop 形式に整形する。"""
import re
import time
import hashlib

import requests

# --- 対象タグ（あとから増減できるようにトップレベル定数に） ---
OSM_AMENITY_VALUES = [
    "restaurant", "cafe", "fast_food", "bar", "pub",
    "ice_cream", "bakery", "food_court",
]

OVERPASS_DEFAULT_ENDPOINT = "https://overpass-api.de/api/interpreter"
USER_AGENT = "MigrationMap/1.0 (+https://example.com; contact@example.com)"
CONNECT_TIMEOUT = 10
READ_TIMEOUT = 60
MAX_RETRIES = 3
CACHE_TTL_SECONDS = 24 * 60 * 60
_BBOX_ROUND = 5  # bbox を丸める小数桁（キャッシュキー用）

# プロセス内キャッシュ  key -> (epoch_seconds, candidates)
_CACHE: dict[str, tuple[float, list]] = {}


class OverpassBusy(Exception):
    """Overpass が 429/504 を返し続けた場合。"""


def build_overpass_ql(south, west, north, east) -> str:
    amenity_re = "|".join(OSM_AMENITY_VALUES)
    bbox = f"{south},{west},{north},{east}"
    return (
        "[out:json][timeout:30];\n"
        "(\n"
        f'  nwr["amenity"~"^({amenity_re})$"]({bbox});\n'
        f'  nwr["shop"]({bbox});\n'
        ");\n"
        "out center tags;"
    )


def _element_latlon(el: dict):
    """node の lat/lon、way/relation の center.lat/center.lon を吸収する。"""
    if el.get("lat") is not None and el.get("lon") is not None:
        return float(el["lat"]), float(el["lon"])
    center = el.get("center") or {}
    if center.get("lat") is not None and center.get("lon") is not None:
        return float(center["lat"]), float(center["lon"])
    return None, None


def osm_level_to_floorlevel(level_raw):
    """OSM の level タグ（地上階=0）を日本式の階数表記に変換する。

    "0" -> "1F", "1" -> "2F", "-1" -> "B1F", "1;2" -> "2F"（先頭のみ採用）
    変換できない値・None は None。
    """
    if level_raw is None:
        return None
    head = str(level_raw).split(";")[0].strip()
    if head == "":
        return None
    try:
        n = int(float(head))
    except ValueError:
        return None
    if n >= 0:
        return f"{n + 1}F"
    return f"B{abs(n)}F"


def _floorlevel_from_tags(tags: dict):
    if "level" in tags:
        converted = osm_level_to_floorlevel(tags.get("level"))
        if converted:
            return converted
    if tags.get("addr:floor"):
        # addr:floor はすでに日本式表記であることが多い。変換せずそのまま。
        return str(tags["addr:floor"]).strip()
    return None


def _instagram_account(raw):
    if not raw:
        return None
    raw = str(raw).strip()
    m = re.search(r"instagram\.com/([^/?#]+)", raw)
    if m:
        return m.group(1).lstrip("@")
    return raw.lstrip("@") or None


def _first(tags: dict, *keys):
    for k in keys:
        v = tags.get(k)
        if v:
            return v
    return None


def _build_address(tags: dict):
    if tags.get("addr:full"):
        return str(tags["addr:full"]).strip()
    parts = [
        tags.get("addr:postcode"),
        tags.get("addr:province"), tags.get("addr:state"),
        tags.get("addr:city"),
        tags.get("addr:suburb"), tags.get("addr:quarter"),
        tags.get("addr:neighbourhood"),
        tags.get("addr:block_number"),
        tags.get("addr:housenumber"),
    ]
    joined = "".join(p for p in parts if p)
    return joined or None


def _build_description(tags: dict):
    bits = []
    if tags.get("cuisine"):
        bits.append(f"cuisine: {tags['cuisine']}")
    if tags.get("opening_hours"):
        bits.append(str(tags["opening_hours"]))
    return " / ".join(bits) or None


def element_to_candidate(el: dict):
    """Overpass element -> 候補 dict。name 系がすべて無ければ None（取り込み対象外）。"""
    tags = el.get("tags") or {}
    shopname = _first(tags, "name:ja", "name", "name:en")
    if not shopname:
        return None
    lat, lng = _element_latlon(el)
    if lat is None:
        return None
    return {
        "osm_type": el.get("type"),
        "osm_id": el.get("id"),
        "shopname": shopname,
        "address": _build_address(tags),
        "floorlevel": _floorlevel_from_tags(tags),
        "tel": _first(tags, "phone", "contact:phone"),
        "website_url": _first(tags, "website", "contact:website"),
        "instagram_account": _instagram_account(
            _first(tags, "contact:instagram", "brand:instagram")
        ),
        "description": _build_description(tags),
        "lat": lat,
        "lng": lng,
        "raw_tags": tags,
    }


def _cache_key(south, west, north, east) -> str:
    rounded = ",".join(f"{v:.{_BBOX_ROUND}f}" for v in (south, west, north, east))
    return hashlib.sha256(rounded.encode("utf-8")).hexdigest()


def search_candidates(south, west, north, east, endpoint=None, _now=None):
    """(candidates, cached) を返す。cached=True ならキャッシュヒット。"""
    now = _now if _now is not None else time.time()
    key = _cache_key(south, west, north, east)
    hit = _CACHE.get(key)
    if hit and (now - hit[0]) < CACHE_TTL_SECONDS:
        return hit[1], True

    endpoint = endpoint or OVERPASS_DEFAULT_ENDPOINT
    ql = build_overpass_ql(south, west, north, east)
    data = _post_overpass(endpoint, ql)
    candidates = []
    seen = set()
    for el in data.get("elements", []):
        cand = element_to_candidate(el)
        if not cand:
            continue
        dedup = (cand["osm_type"], cand["osm_id"])
        if dedup in seen:
            continue
        seen.add(dedup)
        candidates.append(cand)
    _CACHE[key] = (now, candidates)
    return candidates, False


def _post_overpass(endpoint: str, ql: str) -> dict:
    headers = {"User-Agent": USER_AGENT}
    delay = 1.0
    last_status = None
    for attempt in range(MAX_RETRIES):
        resp = requests.post(
            endpoint, data={"data": ql}, headers=headers,
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
        )
        last_status = resp.status_code
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code in (429, 504):
            if attempt < MAX_RETRIES - 1:
                time.sleep(delay)
                delay *= 2
                continue
        resp.raise_for_status()
    raise OverpassBusy(f"Overpass busy (last status {last_status})")
```

- [ ] **Step 2: テストを書く**

Create `tests/test_migrationmaps_osm.py`:

```python
import pytest
import migrationmaps_osm as osm


@pytest.mark.parametrize("raw,expected", [
    ("0", "1F"), ("1", "2F"), ("-1", "B1F"), ("2", "3F"),
    ("1;2", "2F"), ("-2;-1", "B2F"), ("", None), (None, None), ("abc", None),
    ("1.0", "2F"),
])
def test_osm_level_to_floorlevel(raw, expected):
    assert osm.osm_level_to_floorlevel(raw) == expected


def test_floorlevel_prefers_level_then_addr_floor():
    assert osm._floorlevel_from_tags({"level": "1"}) == "2F"
    assert osm._floorlevel_from_tags({"addr:floor": "3F"}) == "3F"      # 変換しない
    assert osm._floorlevel_from_tags({"level": "x", "addr:floor": "4F"}) == "4F"
    assert osm._floorlevel_from_tags({}) is None


def test_element_to_candidate_node():
    el = {"type": "node", "id": 42, "lat": 36.06, "lon": 136.22,
          "tags": {"name": "テスト食堂", "amenity": "restaurant",
                   "phone": "0776-0-0", "level": "1",
                   "cuisine": "japanese", "opening_hours": "09:00-18:00"}}
    c = osm.element_to_candidate(el)
    assert c["osm_type"] == "node" and c["osm_id"] == 42
    assert c["shopname"] == "テスト食堂"
    assert c["floorlevel"] == "2F"
    assert c["tel"] == "0776-0-0"
    assert c["description"] == "cuisine: japanese / 09:00-18:00"
    assert c["lat"] == 36.06 and c["lng"] == 136.22


def test_element_to_candidate_way_uses_center():
    el = {"type": "way", "id": 7, "center": {"lat": 35.0, "lon": 135.0},
          "tags": {"name:ja": "和カフェ", "shop": "coffee"}}
    c = osm.element_to_candidate(el)
    assert (c["lat"], c["lng"]) == (35.0, 135.0)
    assert c["shopname"] == "和カフェ"


def test_element_without_name_is_dropped():
    assert osm.element_to_candidate(
        {"type": "node", "id": 1, "lat": 1, "lon": 1, "tags": {"shop": "yes"}}
    ) is None


def test_instagram_account_extraction():
    assert osm._instagram_account("https://www.instagram.com/foo_bar/") == "foo_bar"
    assert osm._instagram_account("@foo") == "foo"
    assert osm._instagram_account("") is None


def test_build_overpass_ql_contains_bbox_and_amenities():
    ql = osm.build_overpass_ql(1.0, 2.0, 3.0, 4.0)
    assert "1.0,2.0,3.0,4.0" in ql
    assert "restaurant|cafe|fast_food" in ql
    assert 'nwr["shop"]' in ql
    assert "out center tags;" in ql


def test_search_candidates_uses_cache(monkeypatch):
    calls = {"n": 0}

    def fake_post(endpoint, ql):
        calls["n"] += 1
        return {"elements": [
            {"type": "node", "id": 1, "lat": 36.0, "lon": 136.0,
             "tags": {"name": "A", "amenity": "cafe"}},
            {"type": "node", "id": 1, "lat": 36.0, "lon": 136.0,
             "tags": {"name": "A", "amenity": "cafe"}},  # 重複
        ]}

    monkeypatch.setattr(osm, "_post_overpass", fake_post)
    osm._CACHE.clear()
    c1, cached1 = osm.search_candidates(36.0, 136.0, 36.1, 136.1, _now=1000)
    c2, cached2 = osm.search_candidates(36.0, 136.0, 36.1, 136.1, _now=1000 + 3600)
    assert len(c1) == 1 and cached1 is False       # 重複排除
    assert cached2 is True and calls["n"] == 1     # 2 回目はキャッシュ
    c3, cached3 = osm.search_candidates(36.0, 136.0, 36.1, 136.1,
                                       _now=1000 + osm.CACHE_TTL_SECONDS + 1)
    assert cached3 is False and calls["n"] == 2    # TTL 超で再取得


def test_post_overpass_retries_then_raises(monkeypatch):
    class Resp:
        status_code = 429
        def raise_for_status(self): raise AssertionError("should not be called for 429")
        def json(self): return {}

    monkeypatch.setattr(osm.time, "sleep", lambda *_: None)
    monkeypatch.setattr(osm.requests, "post", lambda *a, **k: Resp())
    with pytest.raises(osm.OverpassBusy):
        osm._post_overpass("http://x", "ql")
```

- [ ] **Step 3: 実行**

Run: `python -m pytest tests/test_migrationmaps_osm.py -v`
Expected: 全ケース PASS。

- [ ] **Step 4: コミット**

```bash
git add migrationmaps_osm.py tests/test_migrationmaps_osm.py
git commit -m "feat(osm): Overpass client, tag mapping, level conversion, 24h cache + tests"
```

## Task 16: `MigrationShop` スキーマ変更（OSM 由来カラム）

**Files:**
- Modify: `models.py`（`class MigrationShop`）
- Create: `migrations/002_migrationshop_osm.sql`

- [ ] **Step 1: モデルにカラムを追加する**

`models.py` の `MigrationShop`、`website_url = db.Column(...)`（現行 272 行）の直後に追加:

```python
    # --- OSM (Overpass) 由来 ---
    osm_type = db.Column(db.String(8))                 # "node" | "way" | "relation"
    osm_id = db.Column(db.BigInteger)                  # OSM 要素 ID
    source = db.Column(db.String(16), nullable=False, server_default="manual")  # "manual" | "osm"
    osm_synced_at = db.Column(db.DateTime)
```

`MigrationShop` クラス内に `__table_args__` を追加（既存には無い）:

```python
    __table_args__ = (
        db.UniqueConstraint("osm_type", "osm_id", name="uq_migrationshop_osm"),
    )
```

`email` カラム定義（現行 259 行 `email = db.Column(db.String(255))`）は**すでに nullable**（`nullable=False` が無い）なのでモデル変更は不要。DB 側の NOT NULL 制約だけ 002 で外す。

- [ ] **Step 2: マイグレーション SQL**

Create `migrations/002_migrationshop_osm.sql`:

```sql
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
```

- [ ] **Step 3: 適用**

Run: `python scripts/run_migration.py migrations/002_migrationshop_osm.sql`
Expected: `applied: 002_migrationshop_osm.sql`。再実行してもエラーにならない。

- [ ] **Step 4: 既存の手動店舗登録が通ることを確認する**

`/migrationmaps/admin` の「店舗を登録・編集する」で新規店舗を登録（email 必須のまま）→ 成功。`api_migrationshop_register` は未変更なので email 必須バリデーションは維持されている。

- [ ] **Step 5: コミット**

```bash
git add models.py migrations/002_migrationshop_osm.sql
git commit -m "feat(models): MigrationShop OSM columns, nullable email, (osm_type,osm_id) unique"
```

## Task 17: `_project_bbox` ヘルパの切り出し

**Files:**
- Modify: `app.py`

- [ ] **Step 1: ヘルパを追加する**

`app.py` の `_image_url_from_filename` 付近（座標系ユーティリティの近く、現行 91 行の後）に追加:

```python
def _project_bbox(proj):
    """イラスト地図（レイヤー1）四隅をアフィンで緯度経度化した bbox。

    returns (sw_lat, sw_lng, ne_lat, ne_lng)
    """
    corners_xy = [
        (0, 0),
        (proj.image_width, 0),
        (proj.image_width, proj.image_height),
        (0, proj.image_height),
    ]
    latlngs = [
        _img_to_latlng(proj.a, proj.b, proj.c, proj.d, proj.e, proj.f, x, y)
        for (x, y) in corners_xy
    ]
    lats = [p[0] for p in latlngs]
    lngs = [p[1] for p in latlngs]
    return min(lats), min(lngs), max(lats), max(lngs)
```

- [ ] **Step 2: `api_migrationmaps_shops` を差し替える**

`app.py` 現行 1023–1035 行（`corners_xy = [...]` から `ne_lat, ne_lng = max(lats), max(lngs)` まで）を次で置き換える:

```python
    sw_lat, sw_lng, ne_lat, ne_lng = _project_bbox(proj)
```

- [ ] **Step 3: 回帰チェック**

Run: `curl -s http://localhost:5000/api/migrationmaps/<PID>/shops | python -m json.tool | head`
Expected: 既存と同じ店舗一覧が返る（bbox 計算結果は同一）。

- [ ] **Step 4: コミット**

```bash
git add app.py
git commit -m "refactor(app): extract _project_bbox shared by shops and osm endpoints"
```

## Task 18: `POST /osm/search` と `POST /osm/import`

**Files:**
- Modify: `app.py`（`api_migrationmaps_shops` の後にルート追加）

- [ ] **Step 1: search ルート**

`api_migrationmaps_shops`（現行 1101 行で終わる）の直後に追加:

```python
OSM_SEARCH_ENDPOINT_ENV = "OVERPASS_ENDPOINT"


@app.post("/api/migrationmaps/<int:project_id>/osm/search")
def api_migrationmaps_osm_search(project_id: int):
    proj = MapProject.query.get(project_id)
    if not proj:
        abort(404)

    import migrationmaps_osm as osm
    sw_lat, sw_lng, ne_lat, ne_lng = _project_bbox(proj)
    endpoint = os.environ.get(OSM_SEARCH_ENDPOINT_ENV) or None
    try:
        candidates, cached = osm.search_candidates(
            sw_lat, sw_lng, ne_lat, ne_lng, endpoint=endpoint
        )
    except osm.OverpassBusy:
        return jsonify({
            "error": "Overpass サーバーが混雑しています。時間をおいて再試行してください"
        }), 503
    except Exception as ex:
        current_app.logger.error("osm search failed: %s", ex)
        return jsonify({"error": f"Overpass 検索に失敗しました: {ex}"}), 502

    existing = {
        (s.osm_type, s.osm_id)
        for s in MigrationShop.query
        .filter(MigrationShop.osm_type.isnot(None))
        .with_entities(MigrationShop.osm_type, MigrationShop.osm_id)
        .all()
    }

    payload = []
    for c in candidates:
        payload.append({
            **{k: c[k] for k in (
                "osm_type", "osm_id", "shopname", "address", "floorlevel",
                "tel", "website_url", "instagram_account", "description",
                "lat", "lng", "raw_tags",
            )},
            "already_imported": (c["osm_type"], c["osm_id"]) in existing,
        })

    return jsonify({
        "bbox": [sw_lat, sw_lng, ne_lat, ne_lng],
        "cached": cached,
        "candidates": payload,
    })
```

- [ ] **Step 2: import ルート**

続けて追加:

```python
@app.post("/api/migrationmaps/<int:project_id>/osm/import")
def api_migrationmaps_osm_import(project_id: int):
    proj = MapProject.query.get(project_id)
    if not proj:
        abort(404)

    data = request.get_json(force=True) or {}
    items = data.get("items") or []
    if not isinstance(items, list) or not items:
        return jsonify({"error": "items が空です"}), 400

    import migrationmaps_osm as osm
    from datetime import datetime

    sw_lat, sw_lng, ne_lat, ne_lng = _project_bbox(proj)
    endpoint = os.environ.get(OSM_SEARCH_ENDPOINT_ENV) or None
    try:
        candidates, _ = osm.search_candidates(
            sw_lat, sw_lng, ne_lat, ne_lng, endpoint=endpoint
        )
    except Exception as ex:
        return jsonify({"error": f"候補データの取得に失敗しました: {ex}"}), 502

    by_key = {(c["osm_type"], c["osm_id"]): c for c in candidates}
    requested = {(str(i.get("osm_type")), int(i.get("osm_id")))
                 for i in items if i.get("osm_type") and i.get("osm_id")}

    created = updated = skipped = 0
    now = datetime.now()
    try:
        for key in requested:
            cand = by_key.get(key)
            if not cand:
                skipped += 1
                continue
            shop = MigrationShop.query.filter_by(
                osm_type=key[0], osm_id=key[1]
            ).first()
            if shop is None:
                shop = MigrationShop(
                    osm_type=key[0], osm_id=key[1], source="osm",
                    lat=cand["lat"], lng=cand["lng"],
                )
                db.session.add(shop)
                created += 1
            else:
                if shop.source == "manual":
                    skipped += 1          # 手動レコードは絶対に上書きしない
                    continue
                updated += 1

            shop.shopname = cand["shopname"]
            shop.address = cand["address"] or ""
            shop.floorlevel = cand["floorlevel"]
            shop.tel = cand["tel"]
            shop.website_url = cand["website_url"]
            shop.instagram_account = cand["instagram_account"]
            shop.description = cand["description"]
            shop.lat = cand["lat"]
            shop.lng = cand["lng"]
            shop.source = "osm"
            shop.osm_synced_at = now
            shop.updated_at = now
            shop.map_project_id = project_id
            if shop.is_active is None:
                shop.is_active = True

        db.session.commit()
    except Exception as ex:
        db.session.rollback()
        current_app.logger.error("osm import failed: %s", ex)
        return jsonify({"error": f"取り込みに失敗しました: {ex}"}), 500

    return jsonify({"created": created, "updated": updated, "skipped": skipped})
```

> 仕様 A-5: import はクライアントから店舗内容を受け取らず、サーバー側でキャッシュ済み候補を引き当てて保存する（改ざん防止）。`address` は NOT NULL（`migrationshop.address`）なので `None` は空文字にフォールバック。

- [ ] **Step 3: 手動確認（Overpass 実アクセス）**

`.env` に `OVERPASS_ENDPOINT` は未設定（デフォルト公開インスタンス）でよい。既存プロジェクトで:

Run:
```bash
curl -s -X POST http://localhost:5000/api/migrationmaps/<PID>/osm/search | python -m json.tool | head -40
```
Expected: `bbox`、`cached: false`、`candidates` 配列（各要素に `osm_type/osm_id/shopname/floorlevel/lat/lng/already_imported`）。2 回目の呼び出しで `cached: true`。

Run（`candidates` から 1〜2 件選んで）:
```bash
curl -s -X POST http://localhost:5000/api/migrationmaps/<PID>/osm/import \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"osm_type":"node","osm_id":<ID>}]}'
```
Expected: `{"created": 1, "updated": 0, "skipped": 0}`。再実行で `{"created":0,"updated":1,"skipped":0}`。取り込んだ店舗が `/api/migrationmaps/<PID>/shops` に現れる（bbox 内なら）。

- [ ] **Step 4: コミット**

```bash
git add app.py
git commit -m "feat(api): POST osm/search and osm/import (Overpass -> MigrationShop upsert)"
```

## Task 19: `.env.example` とドキュメントに環境変数を追記

**Files:**
- Modify: `docs/MigrationMap.md`
- Create または Modify: `.env.example`（無ければ作成）

- [ ] **Step 1: 環境変数を記載する**

`.env.example`（無ければ新規）に追加:

```
# Overpass API（店舗取得）。未設定なら overpass-api.de の公開インスタンス
OVERPASS_ENDPOINT=

# 方式A ベース地図生成用タイル URL テンプレート（{z}/{x}/{y}）。未設定なら方式Aは 503
BASEMAP_TILE_URL=
BASEMAP_USER_AGENT=MigrationMap/1.0 (+https://example.com; contact@example.com)
BASEMAP_TILE_SLEEP_S=0
```

`docs/MigrationMap.md` の該当箇所（環境変数一覧・API 一覧）に `OVERPASS_ENDPOINT` / `BASEMAP_TILE_URL` と新エンドポイント 3 本（`GET /api/migrationmaps/basemap`、`POST .../osm/search`、`POST .../osm/import`）を追記する。

- [ ] **Step 2: コミット**

```bash
git add .env.example docs/MigrationMap.md
git commit -m "docs: document OVERPASS_ENDPOINT / BASEMAP_TILE_URL and new endpoints"
```

**フェーズ 5 完了報告:** `migrationmaps_osm.py`（Overpass QL 生成・POST・指数バックオフ 3 回・24h プロセス内キャッシュ・タグ→フィールド変換・`osm_level_to_floorlevel`）＋単体テスト。`MigrationShop` に OSM 4 カラム＋ユニーク制約、`email` NOT NULL 解除（`migrations/002`）。`_project_bbox` 共通化。`POST /osm/search`（DB 保存なし）と `POST /osm/import`（サーバー側キャッシュ引き当て・`source=='manual'` は上書きしない）。

---

# フェーズ 6 — 管理画面 OSM 取り込み UI と帰属表示

## Task 20: 取り込みセクションの DOM

**Files:**
- Modify: `templates/migrationmaps/admin.html`

- [ ] **Step 1: 左パネルの店舗登録トグルの「上」に折りたたみセクションを追加する**

`admin.html` 現行 140 行 `<div class="registform shop-panel">` の**直前**に挿入:

```html
    <div class="registform osm-import-panel">
      <button type="button" id="osmImportToggle" class="shop-menu-toggle" aria-expanded="false">
        <span>🗺 このエリアの店舗を OSM から取得</span>
        <span id="osmImportToggleIcon">＋</span>
      </button>
      <div id="osmImportBody" class="shop-menu-body" hidden>
        <div class="shop-toolbar">
          <div class="muted">保存済みプロジェクトの表示範囲内を Overpass で検索します。</div>
          <button type="button" id="btnOsmSearch" class="small-btn">取得</button>
        </div>
        <div id="osmSearchStatus" class="muted"></div>
        <div class="row" style="gap:6px; margin:6px 0;">
          <button type="button" id="btnOsmSelectAll" class="small-btn">全選択</button>
          <button type="button" id="btnOsmSelectNone" class="small-btn">全解除</button>
          <button type="button" id="btnOsmImport" class="small-btn">選択した <span id="osmSelCount">0</span> 件を取り込む</button>
        </div>
        <div id="osmCandidateList" class="registered-shop-list"></div>
      </div>
    </div>
```

`<style>` に追加:

```css
    .osm-cand { display:flex; gap:8px; align-items:flex-start; border:1px solid #e5e7eb; border-radius:8px; background:#fff; padding:6px 8px; }
    .osm-cand.imported { opacity:.5; }
    .osm-cand .cand-main { flex:1; font-size:12px; }
    .osm-cand .cand-name { font-weight:700; }
    .osm-cand .cand-meta { color:#666; }
```

- [ ] **Step 2: コミット**

```bash
git add templates/migrationmaps/admin.html
git commit -m "feat(admin): OSM import section DOM"
```

## Task 21: 取り込みセクションのロジック

**Files:**
- Modify: `static/migrationmaps/admin.js`

- [ ] **Step 1: セクションのハンドラを追加する**

`static/migrationmaps/admin.js` の「店舗管理」セクション付近（`refreshShopList` の後、現行 930 行あたり）に追加:

```javascript
// ---- OSM 取り込み ----
let osmCandidates = [];

$("osmImportToggle")?.addEventListener("click", () => {
  const expanded = $("osmImportToggle").getAttribute("aria-expanded") === "true";
  $("osmImportToggle").setAttribute("aria-expanded", expanded ? "false" : "true");
  $("osmImportBody").hidden = expanded;
  if ($("osmImportToggleIcon")) $("osmImportToggleIcon").textContent = expanded ? "＋" : "－";
});

function renderOsmCandidates() {
  const listEl = $("osmCandidateList");
  listEl.innerHTML = "";
  if (!osmCandidates.length) {
    listEl.innerHTML = `<div class="muted">候補がありません</div>`;
    updateOsmSelCount();
    return;
  }
  osmCandidates.forEach((c, idx) => {
    const row = document.createElement("label");
    row.className = "osm-cand" + (c.already_imported ? " imported" : "");
    row.innerHTML = `
      <input type="checkbox" class="osm-cb" data-idx="${idx}" ${c.already_imported ? "disabled" : ""} />
      <div class="cand-main">
        <div class="cand-name">${escapeHtmlLocal(c.shopname || "(名称なし)")}</div>
        <div class="cand-meta">${escapeHtmlLocal(c.floorlevel || "-")} / ${escapeHtmlLocal(c.address || "-")}</div>
        <div class="cand-meta">${Number(c.lat).toFixed(5)}, ${Number(c.lng).toFixed(5)}${c.already_imported ? " ・取り込み済み" : ""}</div>
      </div>`;
    listEl.appendChild(row);
  });
  listEl.querySelectorAll(".osm-cb").forEach((cb) =>
    cb.addEventListener("change", updateOsmSelCount));
  updateOsmSelCount();
}

function escapeHtmlLocal(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]
  ));
}

function selectedOsmIdxs() {
  return [...$("osmCandidateList").querySelectorAll(".osm-cb:checked")]
    .map((cb) => parseInt(cb.dataset.idx, 10));
}

function updateOsmSelCount() {
  if ($("osmSelCount")) $("osmSelCount").textContent = String(selectedOsmIdxs().length);
}

$("btnOsmSelectAll")?.addEventListener("click", () => {
  $("osmCandidateList").querySelectorAll(".osm-cb:not(:disabled)").forEach((cb) => { cb.checked = true; });
  updateOsmSelCount();
});
$("btnOsmSelectNone")?.addEventListener("click", () => {
  $("osmCandidateList").querySelectorAll(".osm-cb").forEach((cb) => { cb.checked = false; });
  updateOsmSelCount();
});

$("btnOsmSearch")?.addEventListener("click", async () => {
  if (!currentProjectId) { alert("先にプロジェクトを保存/読み込みしてください"); return; }
  $("osmSearchStatus").textContent = "Overpass 検索中…";
  try {
    const res = await fetch(`/api/migrationmaps/${currentProjectId}/osm/search`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) { $("osmSearchStatus").textContent = data.error || `失敗 (${res.status})`; return; }
    osmCandidates = data.candidates || [];
    $("osmSearchStatus").textContent =
      `${osmCandidates.length} 件${data.cached ? "（キャッシュ）" : ""}`;
    renderOsmCandidates();
  } catch (err) {
    $("osmSearchStatus").textContent = `通信エラー: ${err.message}`;
  }
});

$("btnOsmImport")?.addEventListener("click", async () => {
  const idxs = selectedOsmIdxs();
  if (!idxs.length) { alert("取り込む候補を選択してください"); return; }
  const items = idxs.map((i) => ({
    osm_type: osmCandidates[i].osm_type, osm_id: osmCandidates[i].osm_id,
  }));
  try {
    const res = await fetch(`/api/migrationmaps/${currentProjectId}/osm/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || `失敗 (${res.status})`); return; }
    $("osmSearchStatus").textContent =
      `取り込み: 新規 ${data.created} / 更新 ${data.updated} / スキップ ${data.skipped}`;
    // 取り込み済みフラグを更新して再描画
    idxs.forEach((i) => { osmCandidates[i].already_imported = true; });
    renderOsmCandidates();
    if (typeof refreshShopList === "function") await refreshShopList();
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
  }
});
```

- [ ] **Step 2: 手動確認**

1. 保存済みプロジェクトを読み込む。
2. 「🗺 このエリアの店舗を OSM から取得」→「取得」→ 候補リストがチェックボックス付きで出る。取り込み済みはグレー＆チェック不可。
3. 「全選択」→「選択した N 件を取り込む」→ ステータスに `新規 X / 更新 Y / スキップ Z`。下の「登録済み店舗」一覧が更新される。
4. もう一度「取得」→ `（キャッシュ）` 表示、さっき取り込んだものが `already_imported`。

- [ ] **Step 3: コミット**

```bash
git add static/migrationmaps/admin.js
git commit -m "feat(admin): OSM candidate search / select / import UI wired to endpoints"
```

## Task 22: 帰属表示（ODbL）

**Files:**
- Modify: `templates/migrationmaps/public.html`
- Modify: `static/migrationmaps/public.js`

- [ ] **Step 1: フッターとビルガイド内クレジットを追加する**

`public.html` 現行 390 行（ビルガイドの `</div>` の後、`<script>` の前）に追加:

```html
<footer id="siteFooter">
  地図タイル: © OpenStreetMap contributors ・
  店舗情報: © OpenStreetMap contributors (ODbL)
</footer>
```

`public.html` のビルガイド `.building-guide-inner`（現行 385–389 行）内、`<div id="floorShopGrid"></div>` の直後に追加:

```html
    <div class="osm-credit">店舗情報: © OpenStreetMap contributors (ODbL)</div>
```

`public.html` の `<style>` に追加:

```css
  #siteFooter { padding: 8px 12px; font-size: 11px; color: #666; background: #f2f2f3; border-top: 1px solid #ddd; text-align: center; }
  .osm-credit { margin-top: 8px; font-size: 10px; color: #888; }
```

- [ ] **Step 2: タイル attribution の文言を整える**

`static/migrationmaps/public.js` 現行 34–38 行の `L.tileLayer(...)` の `attribution` を次にする（タイルの帰属。取り込みデータの帰属はフッター/ビルガイドで別途明示済み）:

```javascript
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxNativeZoom: 19,
  maxZoom: 22,
}).addTo(map);
```

- [ ] **Step 3: 手動確認**

`/migrationmaps/m/<id>` を開き、ページ下部フッターに「店舗情報: © OpenStreetMap contributors (ODbL)」、店舗マーカーをタップして出るビルガイド下部にも同じクレジットが出ることを確認。

- [ ] **Step 4: コミット**

```bash
git add templates/migrationmaps/public.html static/migrationmaps/public.js
git commit -m "feat(public): ODbL attribution for imported shop data (footer + building guide)"
```

**フェーズ 6 完了報告:** 管理画面左パネルに OSM 取り込みセクション（検索→チェックボックス選択→取り込み→`refreshShopList`）。公開ページのフッターとビルガイド内に ODbL 帰属表示。

---

# フェーズ 7 — C セクションの既存不具合修正

## Task 23: ビルガイドのホットスポット座標をパーセント対応にする

**Files:**
- Modify: `models.py`（`BuildingGuideFloor`, `BuildingGuide`）
- Create: `migrations/003_buildingguide_fk_and_floor_pct.sql`
- Modify: `app.py`（`api_migrationmaps_shops` の floors payload）
- Modify: `static/migrationmaps/public.js`（`buildHotspotStyle`）

- [ ] **Step 1: モデルにカラムを追加する**

`models.py` の `BuildingGuideFloor`、`sort_order` の直後（現行 351 行）に追加:

```python
    # パーセント（0〜100 の float）。非 null ならこちらを優先して描画する（C-1）
    area_x_pct = db.Column(db.Float, nullable=True)
    area_y_pct = db.Column(db.Float, nullable=True)
    area_width_pct = db.Column(db.Float, nullable=True)
    area_height_pct = db.Column(db.Float, nullable=True)
```

`models.py` の `BuildingGuide`、`image_url` の直後（現行 323 行）に追加:

```python
    # ホットスポット px→% 換算の基準（作図時のガイド画像サイズ）。任意
    base_width = db.Column(db.Integer, nullable=True)
    base_height = db.Column(db.Integer, nullable=True)
```

- [ ] **Step 2: マイグレーション SQL（FK と pct をまとめて）**

Create `migrations/003_buildingguide_fk_and_floor_pct.sql`:

```sql
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
```

- [ ] **Step 3: `MigrationShop` に FK カラムを追加する（models.py）**

`models.py` の `MigrationShop`、`map_project_id` の relationship 定義の後（現行 279 行付近）に追加:

```python
    # 明示的なビルガイド紐付け（C-2）。緯度経度文字列一致をやめる
    building_guide_id = db.Column(
        db.Integer,
        db.ForeignKey("building_guides.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
```

- [ ] **Step 4: 適用**

Run: `python scripts/run_migration.py migrations/003_buildingguide_fk_and_floor_pct.sql`
Expected: `applied: 003_buildingguide_fk_and_floor_pct.sql`。

- [ ] **Step 5: `api_migrationmaps_shops` の floors payload に pct を追加する**

`app.py` の `shop_to_dict` 内 `floors` リスト内包（現行 1087–1097 行）を次に置き換える:

```python
                "floors": [
                    {
                        "floorlevel": fl.floorlevel,
                        "area_x": fl.area_x,
                        "area_y": fl.area_y,
                        "area_width": fl.area_width,
                        "area_height": fl.area_height,
                        "area_x_pct": fl.area_x_pct,
                        "area_y_pct": fl.area_y_pct,
                        "area_width_pct": fl.area_width_pct,
                        "area_height_pct": fl.area_height_pct,
                        "sort_order": fl.sort_order,
                    }
                    for fl in guide.floors
                ],
```

（内包変数が既存で `f` だがモジュールに `_fit_affine` 由来の `f` 影響は無い。可読性のため `fl` に改名。）

- [ ] **Step 6: `public.js` の `buildHotspotStyle` を pct 優先にする**

`static/migrationmaps/public.js` 現行 272–278 行を次に置き換える:

```javascript
function buildHotspotStyle(floor) {
  const hasPct = floor.area_x_pct != null && floor.area_y_pct != null
    && floor.area_width_pct != null && floor.area_height_pct != null;
  if (hasPct) {
    const w = Math.max(Number(floor.area_width_pct), 4);
    const h = Math.max(Number(floor.area_height_pct), 3);
    return `left:${Number(floor.area_x_pct)}%;top:${Number(floor.area_y_pct)}%;width:${w}%;height:${h}%;`;
  }
  const x = Number(floor.area_x || 0);
  const y = Number(floor.area_y || 0);
  const w = Math.max(Number(floor.area_width || 72), 48);
  const h = Math.max(Number(floor.area_height || 36), 28);
  return `left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;
}
```

`getFloorDisplayOrder`（現行 289 行）のフォールバック floor 生成にも pct を持たせておく:

```javascript
      floorMap.set(key, { floorlevel: key, area_x_pct: 4, area_y_pct: 4, area_width_pct: 16, area_height_pct: 10 });
```

- [ ] **Step 7: 手動確認**

1. 既存のビルガイド（px のみ）を持つプロジェクトの公開ページをスマホ幅で開く → 従来どおり px フォールバックで表示（回帰なし）。
2. テスト用に 1 フロアだけ `area_*_pct` を SQL で入れる（例: `UPDATE building_guide_floors SET area_x_pct=10, area_y_pct=60, area_width_pct=25, area_height_pct=12 WHERE id=<FID>;`）→ 公開ページを PC 幅とスマホ幅で開き、ホットスポットが画像に対して同じ相対位置に乗る。

- [ ] **Step 8: コミット**

```bash
git add models.py migrations/003_buildingguide_fk_and_floor_pct.sql app.py static/migrationmaps/public.js
git commit -m "fix(C-1): percent-based building guide hotspots with px fallback"
```

## Task 24: 店舗⇔ビルガイドを外部キー紐付けに変更

**Files:**
- Modify: `app.py`（`api_migrationmaps_shops`）
- Create: `scripts/backfill_building_guide_id.py`

- [ ] **Step 1: `shop_to_dict` の guide 解決を FK 化する**

`app.py` の `api_migrationmaps_shops` 内、`guide_map`（現行 1059–1063 行）を削除し、代わりに guides を id 引きの dict にする:

```python
    guides_by_id = {g.id: g for g in guides}
```

`shop_to_dict` 冒頭（現行 1066–1067 行の `key = ...` / `guide = guide_map.get(key)`）を次に置き換える:

```python
    def shop_to_dict(s):
        guide = guides_by_id.get(s.building_guide_id)
```

（`building_guide` payload を組む後半はそのまま。`guide` が `None` なら従来どおり `building_guide: None`。）

- [ ] **Step 2: backfill スクリプト**

Create `scripts/backfill_building_guide_id.py`:

```python
"""既存 MigrationShop に、半径 30m 以内で最も近い BuildingGuide を割り当てる（C-2 移行）。

すでに building_guide_id が入っている店舗はスキップ。
使い方:  python scripts/backfill_building_guide_id.py [--dry-run]
"""
import os
import sys
import math

os.environ.setdefault("DATABASE_URL", os.environ.get("DATABASE_URL", ""))

from app import app, db          # noqa: E402
from models import MigrationShop, BuildingGuide  # noqa: E402

RADIUS_M = 30.0


def haversine_m(lat1, lng1, lat2, lng2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def main():
    dry = "--dry-run" in sys.argv
    with app.app_context():
        guides = BuildingGuide.query.filter(BuildingGuide.is_active.is_(True)).all()
        shops = MigrationShop.query.filter(MigrationShop.building_guide_id.is_(None)).all()
        assigned = 0
        for s in shops:
            best = None
            best_d = RADIUS_M
            for g in guides:
                d = haversine_m(float(s.lat), float(s.lng), float(g.lat), float(g.lng))
                if d <= best_d:
                    best_d, best = d, g
            if best is not None:
                print(f"shop {s.id} ({s.shopname}) -> guide {best.id} ({best_d:.1f} m)")
                if not dry:
                    s.building_guide_id = best.id
                assigned += 1
        if not dry:
            db.session.commit()
        print(f"{'[dry-run] ' if dry else ''}assigned {assigned} / {len(shops)} shops")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: 実行**

Run: `python scripts/backfill_building_guide_id.py --dry-run`
Expected: 割り当て候補のリストと `assigned N / M shops`。問題なければ Run: `python scripts/backfill_building_guide_id.py`。

- [ ] **Step 4: 手動確認**

backfill 後、公開ページで従来ビルガイドが出ていた店舗タップ時に、これまでと同じビルガイドが出ること。OSM 取り込み店舗（同一ビル内で座標が微妙に違うもの）でも、`building_guide_id` が入っていればビルガイドが出る。

- [ ] **Step 5: コミット**

```bash
git add app.py scripts/backfill_building_guide_id.py
git commit -m "fix(C-2): link shops to building guides via FK instead of latlng string match"
```

## Task 25: `api_migrationmaps_shops` を当該プロジェクト所属に限定する

**Files:**
- Modify: `app.py`（`api_migrationmaps_shops` の shops クエリ）
- Modify: `docs/MigrationMap.md`

- [ ] **Step 1: クエリに project_id 条件を足す**

`app.py` の `shops` クエリ（現行 1038–1049 行）の `filter(...)` に追加:

```python
    shops = (
        MigrationShop.query
        .filter(
            MigrationShop.map_project_id == project_id,
            MigrationShop.is_active.is_(True),
            MigrationShop.lat >= sw_lat,
            MigrationShop.lat <= ne_lat,
            MigrationShop.lng >= sw_lng,
            MigrationShop.lng <= ne_lng,
        )
        .order_by(MigrationShop.id.asc())
        .all()
    )
```

- [ ] **Step 2: ドキュメントの記述を直す**

`docs/MigrationMap.md` 2.5 節と 3 節の「`map_project_id` の紐付けではなく…bbox で絞り込む」という記述を「**当該プロジェクト所属（`map_project_id == project_id`）かつ表示範囲（bbox）内**の稼働中店舗」に更新する。

- [ ] **Step 3: 手動確認**

複数プロジェクトがあり座標が近接している場合、`/api/migrationmaps/<PID>/shops` が他プロジェクト所属の店舗を含まないこと。OSM 取り込み店舗は import 時に `map_project_id` を当該プロジェクトに設定済みなので表示される。

- [ ] **Step 4: コミット**

```bash
git add app.py docs/MigrationMap.md
git commit -m "fix(C-3): scope api_migrationmaps_shops to project_id AND bbox"
```

## Task 26: 切替時間の説明文とコードの数値を揃える

**Files:**
- Modify: `static/migrationmaps/public.js`
- Modify: `templates/migrationmaps/admin.html`

- [ ] **Step 1: `public.js` を 10 秒に統一する**

`static/migrationmaps/public.js` 現行 45 行:
```javascript
const TRANSITION_DURATION_MS = 3000; // 3秒フェード
```
を次に:
```javascript
const TRANSITION_DURATION_MS = 10000; // 10秒フェード（admin.html の説明文と一致させる）
```

同ファイル現行 146–149 行のコメント `/** 10秒かけてレイヤーを切り替える ... */` は正しいので変更不要。現行 45 行以外に「3秒」表記があれば同様に修正する（`grep -n "3秒\|3000" static/migrationmaps/public.js` で確認）。

- [ ] **Step 2: admin.html の文言を確認する**

`templates/migrationmaps/admin.html` 現行 300 行「公開ページでは10秒かけてゆっくり切り替わります」は 10 秒のままでよい（コード側を合わせたため）。変更不要。

- [ ] **Step 3: 手動確認**

Layer2 と切替時刻を設定したプロジェクトの公開ページで、手動切替ボタンを押すとフェードが約 10 秒かけて進むこと。

- [ ] **Step 4: コミット**

```bash
git add static/migrationmaps/public.js
git commit -m "fix(C-4): align layer transition duration with the documented 10 seconds"
```

## Task 27: フルスイート実行とフェーズ回帰確認

**Files:**
- なし（検証のみ）

- [ ] **Step 1: 全単体テスト**

Run: `python -m pytest -q`
Expected: `tests/test_migrationmaps_geo.py` / `tests/test_resolve_affine.py` / `tests/test_migrationmaps_osm.py` 全 PASS。

- [ ] **Step 2: 既存手動ワークフローの通し確認**

1. `/migrationmaps/admin` 新規: 画像アップロード → 中心+2点 → 保存（`georef_mode: "manual"`）→ 公開ページ表示 OK。
2. 既存プロジェクト編集 → 点・アフィン不変 → 保存 → 表示不変。
3. capture 枠確定 → 0/1/2 点で保存（auto/shift/similar）→ 検証モードで誤差確認。
4. OSM 取得 → 取り込み → 登録済み一覧更新 → 公開ページに店舗表示 → フッターに ODbL 帰属。

- [ ] **Step 3: マイグレーション再適用の冪等性**

Run:
```bash
python scripts/run_migration.py migrations/001_mapproject_georef.sql
python scripts/run_migration.py migrations/002_migrationshop_osm.sql
python scripts/run_migration.py migrations/003_buildingguide_fk_and_floor_pct.sql
```
Expected: 3 本ともエラーなく `applied: ...`（2 回目以降でも）。

- [ ] **Step 4: 完了報告**

変更ファイル一覧と各フェーズの要約を報告。`superpowers:finishing-a-development-branch` に従い統合方法を提示。

**フェーズ 7 完了報告:** C-1 ホットスポット %（px フォールバック維持）、C-2 `building_guide_id` FK＋backfill、C-3 `shops` を project_id＋bbox に限定、C-4 切替時間 10 秒統一。`migrations/003`。全単体テスト緑。

---

## Self-Review

**1. 仕様カバレッジ**

| 仕様 | 対応 Task |
|---|---|
| A-2 Overpass クエリ（nwr, out center tags, 定数リスト） | Task 15 `build_overpass_ql` / `OSM_AMENITY_VALUES` |
| A-2 同時1本・User-Agent・429/504 指数バックオフ3回・混雑時 JSON・24h キャッシュ・接続10/読込60秒 | Task 15 `_post_overpass` / `search_candidates` / `_CACHE` / `OverpassBusy`、Task 18 で 503 変換 |
| A-3 タグ→フィールド優先順マッピング | Task 15 `element_to_candidate` / `_first` / `_build_address` / `_instagram_account` / `_build_description` |
| A-3 level→floorlevel（+1、`1;2`先頭、`addr:floor`はそのまま、両方無しは None） | Task 15 `osm_level_to_floorlevel` / `_floorlevel_from_tags` ＋ Task 15 テスト |
| A-4 `osm_type/osm_id/source/osm_synced_at`、`UniqueConstraint`、email nullable、manual 非上書き | Task 16（モデル+SQL）、Task 18（import で `source=='manual'` skip） |
| A-5 `_project_bbox` 共通化、search は DB 保存なし、import はサーバー側引き当て、レスポンス形式 | Task 17 / Task 18 |
| A-6 管理画面 折りたたみ・チェックボックス一覧・取り込み済みグレー・全選択/解除・N件取り込み・`refreshShopList` | Task 20 / Task 21 |
| A-7 ODbL 帰属（フッター＋ビルガイド、tileLayer attribution とは別） | Task 22 |
| B-2 `res(z)` / `k` / `s` / 6パラメータ、`affine_from_capture` | Task 1 ＋ Task 3 テスト |
| B-3 方式A（`GET /basemap`、`BASEMAP_TILE_URL` 未設定で 503、メタデータをヘッダ返却） | Task 8 / Task 9 |
| B-3 方式B（キャプチャ枠確定、`map.getCenter/getZoom/clientWidth/clientHeight/devicePixelRatio`、ガイド枠、`zoomSnap:1, zoomDelta:1`、計算側 float z） | Task 10（`captureFromCurrentMap` / `showGuideFrame` / Leaflet 初期化）、Task 1 `res_at_zoom(float)` |
| B-4 `MapProject` スキーマ（`georef_mode` + `capture_*` + `capture_*2`）、既存は manual | Task 4 / Task 5 |
| B-5 フォールバック 0/1/2/3点 → auto/shift/similar/manual、`_fit_shift_only` / `_fit_similarity_no_rotation`、回転なし相似 | Task 1（`fit_shift_only` / `fit_similarity_no_rotation` / `resolve_affine`）、Task 6（`resolve_affine` 呼び出し）、Task 11 テスト、Task 10（クライアント側 mode 判定）、Task 14（E2E） |
| B-6 検証モード（イラストクリック→OSM変換点、OSMクリック→距離、`res(z)*3` 超で警告） | Task 12 / Task 13 |
| B-6 受け入れ条件（中心±200m で誤差 < 1画像px、z16≈2.4m） | Task 3 `test_acceptance_error_within_one_image_pixel_near_center` |
| B-7 `save` の 3点未満バリデーションを manual 限定に、`GET` に georef/capture、`overlay_bounds` 変更不要 | Task 6 / Task 7（`overlay_bounds` は未変更） |
| C-1 ホットスポット % 化（前者推奨）＋任意 `base_width/base_height` | Task 23 |
| C-2 `building_guide_id` FK ＋ 30m 最近傍 backfill スクリプト | Task 23（カラム/SQL）、Task 24（配線＋スクリプト） |
| C-3 `shops` に `map_project_id == project_id` | Task 25 |
| C-4 切替時間の数値統一 | Task 26 |
| D 各フェーズで動作確認、手動対応点ワークフロー維持 | 全フェーズに手動確認 Step、Task 2 Step 4 / Task 6 Step 3 / Task 27 Step 2 で回帰確認 |

未カバーの仕様項目なし。

**2. プレースホルダ走査**

`<PID>` / `<ID>` / `<FID>` / `<既存 image_filename>` は「エンジニアが自分の DB の実値に置き換える」意図の明示プレースホルダ（手動確認コマンド内のみ）。コード中に TBD/TODO/「適切なエラー処理」等の未記述箇所は無し。全コードステップは完全なコードブロックを含む。

**3. 型・名称の一貫性**

- `migrationmaps_geo`: `affine_from_capture` / `fit_shift_only` / `fit_similarity_no_rotation` / `res_at_zoom` / `resolve_affine` / `extract_capture` — Task 1 定義、Task 2 で `app.py` に import、Task 3・11 テスト、すべて同名。
- 6パラメータの順序は全所で `(a, b, c, d, e, f)` = `X=a*x+b*y+c, Y=d*x+e*y+f`（既存 `models.py` コメントと一致）。
- `resolve_affine(mode, pts_xy, pts_ll, cap, image_width, image_height)` — Task 1 で `migrationmaps_geo.py` に定義、Task 6 本体・Task 11 テストで同シグネチャ。
- capture キー名: サーバーは `capture_center_lat/lng`, `capture_zoom`, `capture_width/height`, `capture_dpr`（+ `2` サフィックス）。`extract_capture` は内部 dict キーを `center_lat/center_lng/zoom/width/height/dpr` に正規化。`affine_from_capture` の引数は `capture_width/capture_height/capture_dpr`。admin.js の送信ボディも `capture_center_lat` 等で一致。`GET` レスポンスは入れ子 `capture: {center_lat, ...}` で、admin.js `loadProject` は `proj.capture.center_lat` を読む — 一致。
- `migrationmaps_osm`: `search_candidates` は `(candidates, cached)` を返す。Task 18 の search は `candidates, cached = ...`、import は `candidates, _ = ...` — 一致。`element_to_candidate` の dict キー（`osm_type/osm_id/shopname/address/floorlevel/tel/website_url/instagram_account/description/lat/lng/raw_tags`）を Task 18 payload と import upsert が同名参照。
- `OverpassBusy` — Task 15 定義、Task 18 で `except osm.OverpassBusy`。
- floors payload: サーバーが `area_x_pct` 等を返し、`public.js buildHotspotStyle` が同名参照。内包変数を `f`→`fl` に改名（Task 23 Step 5）して 6パラメータの `f` と混同しないようにした。
- `_project_bbox(proj)` → `(sw_lat, sw_lng, ne_lat, ne_lng)` — Task 17 定義、Task 18（search/import）と Task 25（shops）で同じ順序の 4-tuple 展開。
- マイグレーション連番 001→002→003、`scripts/run_migration.py` の使い方は各 Task で同一。

不整合なし。
