import math
import pytest
from migrationmaps_geo import (
    _lonlat_to_mercator,
    _img_to_latlng,
    res_at_zoom,
    affine_from_capture,
    fit_shift_only,
    fit_similarity_no_rotation,
    bbox_with_margin,
    _M_PER_DEG_LAT,
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


# ---- bbox_with_margin（検索用 bbox の外周マージン） ----
def test_bbox_with_margin_zero_is_identity():
    box = (36.0500, 136.2000, 36.0800, 136.2400)
    assert bbox_with_margin(*box, 0) == box
    assert bbox_with_margin(*box, 0.0) == box


def test_bbox_with_margin_ns_meters_and_ew_cos_correction_at_lat36():
    # 中心緯度がちょうど 36.0 になる bbox
    sw_lat, sw_lng, ne_lat, ne_lng = 35.9900, 136.2000, 36.0100, 136.2400
    margin = 100.0
    s, w, n, e = bbox_with_margin(sw_lat, sw_lng, ne_lat, ne_lng, margin)

    # 南北: 各辺の拡張量が緯度換算でちょうど margin / 111320 度
    d_lat_south = sw_lat - s
    d_lat_north = n - ne_lat
    assert d_lat_south == pytest.approx(margin / _M_PER_DEG_LAT, rel=1e-9)
    assert d_lat_north == pytest.approx(margin / _M_PER_DEG_LAT, rel=1e-9)
    # メートルに戻すと約 100m
    assert d_lat_south * _M_PER_DEG_LAT == pytest.approx(100.0, rel=1e-9)

    # 東西: cos(36°) 補正が入っている（= 緯度方向より 1/cos(36°) 倍広い）
    d_lng_west = sw_lng - w
    d_lng_east = e - ne_lng
    expected_d_lng = margin / (_M_PER_DEG_LAT * math.cos(math.radians(36.0)))
    assert d_lng_west == pytest.approx(expected_d_lng, rel=1e-9)
    assert d_lng_east == pytest.approx(expected_d_lng, rel=1e-9)
    assert d_lng_west / d_lat_south == pytest.approx(
        1.0 / math.cos(math.radians(36.0)), rel=1e-9
    )
    # 経度方向の実距離（中心緯度換算）も約 100m
    assert d_lng_west * _M_PER_DEG_LAT * math.cos(math.radians(36.0)) == pytest.approx(
        100.0, rel=1e-9
    )


def test_bbox_with_margin_clamps_near_north_pole():
    s, w, n, e = bbox_with_margin(89.9990, 10.0, 89.9995, 20.0, 500.0)
    assert n == 90.0
    assert -90.0 <= s <= 90.0
    # 極近傍では経度方向の拡張が全周を超え、±180 でクランプされる
    assert w == -180.0 and e == 180.0


def test_bbox_with_margin_exact_pole_no_zero_division():
    s, w, n, e = bbox_with_margin(90.0, -10.0, 90.0, 10.0, 200.0)
    assert n == 90.0
    assert w == -180.0 and e == 180.0


def test_bbox_with_margin_clamps_near_dateline():
    s, w, n, e = bbox_with_margin(0.0, 179.9990, 0.0010, 179.99999, 500.0)
    assert e == 180.0
    assert -180.0 <= w <= 180.0


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
