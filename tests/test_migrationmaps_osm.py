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
