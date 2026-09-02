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
