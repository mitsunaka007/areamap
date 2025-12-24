from flask import Flask, render_template, request, jsonify
import os
import hashlib
from sqlalchemy import func
from werkzeug.middleware.proxy_fix import ProxyFix
from dotenv import load_dotenv
load_dotenv()

# models.py に db / AreamapClickEvent がある前提
from models import  AreamapClickEvent
from extensions import db
app = Flask(__name__)

# ----------------------------
# DB 設定
# ----------------------------
db_url = os.environ.get("DATABASE_URL")
if not db_url:
    raise ValueError("DATABASE_URL is not set (RenderのEnvironmentまたは .env を確認)")

# 環境によっては postgres:// が来ることがあるので補正（念のため）
if db_url.startswith("postgres://"):
    db_url = db_url.replace("postgres://", "postgresql://", 1)

app.config["SQLALCHEMY_DATABASE_URI"] = db_url
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

# Render等のリバースプロキシ配下でIP等を正しく取るため
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)

db.init_app(app)

# =========================
# 既存ルート
# =========================
@app.route("/")
def index():
    return render_template("areamaplp.html")


@app.route("/areamap")
def areamap():
    # 仮データ（後でDB化）
    area = {
        "id": "fukui-sta",
        "name": "福井駅前エリア",
        "center": [36.0619, 136.2235],
        "zoom": 16
    }
    spots = [
        {
            "id": 1,
            "type": "shop",
            "name": "○○カフェ",
            "lat": 36.0623,
            "lng": 136.2231,
            "status": "open"
        },
        {
            "id": 2,
            "type": "event",
            "name": "駅前マルシェ",
            "lat": 36.0615,
            "lng": 136.2240,
            "status": "now"
        }
    ]
    return render_template("areamap.html", area=area, spots=spots)


@app.route("/areamap_sbodymorita")
def areamapsbodymorita():
    # 仮データ（後でDB化）
    area = {
        "id": "sbody-morita",
        "name": "パーソナルトレーニング＆コンディショニングジム S・BODY",
        "center": [36.107958796048855, 136.22480066137308],
        "zoom": 20
    }
    spots = [
        {
            "id": 1,
            "type": "shop",
            "name": "パーソナルトレーニング＆コンディショニングジム S・BODY",
            "lat": 36.107958796048855,
            "lng": 136.22480066137308,
            "status": "open"
        }
    ]
    return render_template("areamap_sbodymorita.html", area=area, spots=spots)


# =========================
# 追加：計測API
# =========================
def _get_client_ip():
    xff = request.headers.get("X-Forwarded-For", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.remote_addr


def _ip_to_hash_bytes(ip: str):
    """IPを匿名化してBYTEAで保存したい場合のハッシュ（任意）"""
    if not ip:
        return None
    salt = os.environ.get("IP_HASH_SALT", "change-me")
    return hashlib.sha256((salt + ip).encode("utf-8")).digest()


@app.route("/api/metrics/log", methods=["POST"])
def log_metric():
    """
    areamap_sbodymorita.html 側の JS から送られたクリック/表示ログをDBに保存する
    期待JSON:
    {
      "event_name": "view" or "click",
      "metric_id": "areamap_page_view" / "google_map_click" / ...
      "extra": {...}
    }
    """
    data = request.get_json(silent=True) or {}
    event_name = (data.get("event_name") or "").strip()
    metric_id = (data.get("metric_id") or "").strip()
    extra = data.get("extra") or {}

    if not event_name or not metric_id:
        return jsonify({"error": "event_name と metric_id は必須です"}), 400

    # JSが送ってくるキー（areamap_sbodymorita.html と一致させる）
    page_url = extra.get("page_url") or ""
    page_path = extra.get("page_path")
    page_title = extra.get("title")  # JSでは title で送ってる
    referrer = extra.get("referrer")

    ref = extra.get("ref") or ""
    post = extra.get("post") or ""
    variant = extra.get("variant") or ""

    user_agent = extra.get("user_agent") or request.headers.get("User-Agent", "")
    session_id = extra.get("session_id")

    viewport_w = extra.get("viewport_width")
    viewport_h = extra.get("viewport_height")
    screen_w = extra.get("screen_width")
    screen_h = extra.get("screen_height")
    device_pixel_ratio = extra.get("device_pixel_ratio")
    tz_offset_min = extra.get("tz_offset_min")

    language = extra.get("language")
    languages = extra.get("languages") if isinstance(extra.get("languages"), list) else []
    platform = extra.get("platform")

    max_touch_points = extra.get("max_touch_points")
    hover_none = extra.get("hover_none")
    device_memory_gb = extra.get("device_memory_gb")
    hardware_concurrency = extra.get("hardware_concurrency")

    connection_effective_type = extra.get("connection_effective_type")
    connection_rtt_ms = extra.get("connection_rtt_ms")
    connection_downlink_mbps = extra.get("connection_downlink_mbps")
    connection_save_data = extra.get("connection_save_data")

    cookies_enabled = extra.get("cookies_enabled")
    do_not_track = extra.get("do_not_track")
    prefers_reduced_motion = extra.get("prefers_reduced_motion")
    prefers_color_scheme = extra.get("prefers_color_scheme")

    # クリックの具体値（google: href / hotspot: modal_img など）
    action_value = (
        extra.get("href")
        or extra.get("modal_img")
        or extra.get("action_value")
    )

    ip = _get_client_ip()

    row = AreamapClickEvent(
        event_name=event_name,
        element_key=metric_id,
        action_value=action_value,

        page_url=page_url,
        page_path=page_path,
        page_title=page_title,
        referrer=referrer,

        ref=ref,
        post=post,
        variant=variant,

        user_agent=user_agent,
        session_id=session_id,

        viewport_w=viewport_w,
        viewport_h=viewport_h,
        screen_w=screen_w,
        screen_h=screen_h,
        device_pixel_ratio=device_pixel_ratio,
        timezone_offset_min=tz_offset_min,

        language=language,
        languages=languages,
        platform=platform,

        max_touch_points=max_touch_points,
        hover_none=hover_none,

        device_memory_gb=device_memory_gb,
        hardware_concurrency=hardware_concurrency,

        connection_effective_type=connection_effective_type,
        connection_rtt_ms=connection_rtt_ms,
        connection_downlink_mbps=connection_downlink_mbps,
        connection_save_data=connection_save_data,

        cookies_enabled=cookies_enabled,
        do_not_track=do_not_track,
        prefers_reduced_motion=prefers_reduced_motion,
        prefers_color_scheme=prefers_color_scheme,

        # 生IPを保存したい場合（不要なら消してOK）
        ip_addr=ip,
        # 匿名化も残したい場合（不要なら消してOK）
        ip_hash=_ip_to_hash_bytes(ip),

        # 将来の解析用に丸ごと保存（JSONB）
        extra_json={"client": extra},
    )

    try:
        db.session.add(row)
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        return jsonify({"error": "db_error", "detail": repr(e)}), 500
    return jsonify({"ok": True}), 200


# =========================
# 追加：S・BODY 集計ページ
# =========================
@app.route("/mypage_sbodymorita")
def mypage_sbodymorita():
    """
    areamap_sbodymorita の計測結果を表示
    - ページ表示回数（areamap_page_view）
    - GoogleMapクリック回数（google_map_click）
    - metric別カウント
    - 日別推移
    """
    # /areamap_sbodymorita と /areamap_sbodymorita.html どっちでも拾う
    path_filter = "%areamap_sbodymorita%"

    base = db.session.query(AreamapClickEvent).filter(
        AreamapClickEvent.page_path.ilike(path_filter)
    )

    total_events = base.count()

    page_views = base.filter(
        AreamapClickEvent.event_name == "view",
        AreamapClickEvent.element_key == "areamap_page_view",
    ).count()

    google_map_clicks = base.filter(
        AreamapClickEvent.event_name == "click",
        AreamapClickEvent.element_key == "google_map_click",
    ).count()

    by_metric = (
        db.session.query(
            AreamapClickEvent.element_key.label("metric_id"),
            func.count(AreamapClickEvent.id).label("cnt"),
        )
        .filter(AreamapClickEvent.page_path.ilike(path_filter))
        .group_by(AreamapClickEvent.element_key)
        .order_by(func.count(AreamapClickEvent.id).desc())
        .all()
    )

    daily = (
        db.session.query(
            func.date_trunc("day", AreamapClickEvent.occurred_at).label("day"),
            func.count(AreamapClickEvent.id).label("cnt"),
        )
        .filter(AreamapClickEvent.page_path.ilike(path_filter))
        .group_by(func.date_trunc("day", AreamapClickEvent.occurred_at))
        .order_by(func.date_trunc("day", AreamapClickEvent.occurred_at).asc())
        .all()
    )

    return render_template(
        "mypage_sbodymorita.html",
        total_events=total_events,
        page_views=page_views,
        google_map_clicks=google_map_clicks,
        by_metric=by_metric,
        daily=daily,
    )


# if __name__ == "__main__":
#     app.run(
#         host="127.0.0.1",
#         port=5050,
#         debug=True
#     )


