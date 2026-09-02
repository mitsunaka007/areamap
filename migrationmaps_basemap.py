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
