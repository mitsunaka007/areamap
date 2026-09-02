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
            break  # 混雑ステータスでリトライを使い切った -> OverpassBusy へ
        resp.raise_for_status()
    raise OverpassBusy(f"Overpass busy (last status {last_status})")
