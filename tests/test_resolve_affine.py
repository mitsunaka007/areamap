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
