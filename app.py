from flask import Flask, render_template, request, jsonify, flash, url_for, redirect
import os
import hashlib
from sqlalchemy import func, case
from werkzeug.middleware.proxy_fix import ProxyFix
from flask_mail import Mail, Message
from models import  AreamapClickEvent, ContactInquiry
from forms import AskForm
from extensions import db
from dotenv import load_dotenv
load_dotenv()
app = Flask(__name__)

# ----------------------------
# Flask/WTForms (CSRF) 設定
# ----------------------------
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret-change-me")

# ----------------------------
# Mail 設定
# ----------------------------
app.config['MAIL_SERVER'] = 'smtp.gmail.com'
app.config['MAIL_PORT'] = 587
app.config['MAIL_USE_TLS'] = True
app.config['MAIL_USE_SSL'] = False
app.config['MAIL_USERNAME'] = os.environ.get('MAIL_USERNAME')
app.config['MAIL_PASSWORD'] = os.environ.get('MAIL_PASSWORD')
app.config['MAIL_DEFAULT_SENDER'] = ('AreaMap', os.environ.get('MAIL_DEFAULT_SENDER_EMAIL', 'mitsunaka007@gmail.com'))
app.config['MAIL_ADMIN_TO'] = os.environ.get('MAIL_ADMIN_TO', 'mitsunaka007@gmail.com')
mail = Mail(app)

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
        page_url=extra.get("page_url") or request.headers.get("Referer") or request.url_root,
        page_path=extra.get("page_path"),
        page_title=extra.get("title"),
        referrer=extra.get("referrer"),
        ref=extra.get("ref") or "",
        post=extra.get("post") or "",
        variant=extra.get("variant") or "",
    
        screen_width=extra.get("screen_width"),
        screen_height=extra.get("screen_height"),
        viewport_width=extra.get("viewport_width"),
        viewport_height=extra.get("viewport_height"),
        tz_offset_min=extra.get("tz_offset_min"),
        is_mobile=extra.get("is_mobile"),
    
        pointer_coarse=extra.get("pointer_coarse"),
        color_depth=extra.get("color_depth"),
        accept_language=extra.get("accept_language"),
        timezone=extra.get("timezone"),
    
        cookies_enabled=extra.get("cookies_enabled"),
        extra_json={"client": extra},
    )
    try:
        db.session.add(row)
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        return jsonify({"error": "db_error", "detail": repr(e)}), 500
    return jsonify({"ok": True}), 200

@app.route("/mypage_sbodymorita")
def mypage_sbodymorita():
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

    # =========================
    # 追加：ref/post 別 集計 + CVR
    # =========================
    views_expr = func.sum(
        case(
            (
                (AreamapClickEvent.event_name == "view") &
                (AreamapClickEvent.element_key == "areamap_page_view"),
                1
            ),
            else_=0
        )
    ).label("views")

    clicks_expr = func.sum(
        case(
            (
                (AreamapClickEvent.event_name == "click") &
                (AreamapClickEvent.element_key == "google_map_click"),
                1
            ),
            else_=0
        )
    ).label("clicks")

    # CVR = clicks / views（views=0 は NULL にして安全）
    cvr_expr = (
        clicks_expr.cast(db.Float) / func.nullif(views_expr.cast(db.Float), 0.0)
    ).label("cvr")

    post_stats = (
        db.session.query(
            AreamapClickEvent.ref.label("ref"),
            AreamapClickEvent.post.label("post"),
            views_expr,
            clicks_expr,
            cvr_expr,
        )
        .filter(AreamapClickEvent.page_path.ilike(path_filter))
        .group_by(AreamapClickEvent.ref, AreamapClickEvent.post)
        # PVがない(=0)行も出るので、まずはクリック多い順→CVR高い順→PV多い順
        .order_by(clicks_expr.desc(), cvr_expr.desc().nullslast(), views_expr.desc())
        .all()
    )

    # 全体CVRも表示したい場合（任意）
    overall_cvr = (google_map_clicks / page_views) if page_views else 0.0

    return render_template(
        "mypage_sbodymorita.html",
        total_events=total_events,
        page_views=page_views,
        google_map_clicks=google_map_clicks,
        overall_cvr=overall_cvr,          # 追加
        by_metric=by_metric,
        daily=daily,
        post_stats=post_stats,            # 追加
    )
# =========================
# 追加：Lite / Pro ルート
# =========================
@app.route("/areamap-lite")
def areamap_lite():
    return render_template("areamap-lite.html")

@app.route("/areamap-pro")
def areamap_pro():
    return render_template("areamap-pro.html")

# ----------------------------
# お問い合わせ
# ----------------------------
# ----------------------------
# お問い合わせ (自動補完機能付き)
# ----------------------------
@app.route("/ask", methods=["GET", "POST"])
def ask():
    form = AskForm()
    
    # クエリパラメータから plan を取得
    plan_type = request.args.get('plan', '').strip()
    
    # 初期値設定用の辞書
    initial_values = {
        'entrance': {
            'detail': '''【Entrance Pack についての相談】

現在の状況:
・お店/施設名: 
・業種: 
・場所: 

相談内容:
□ 入口が分かりにくいと言われることがある
□ 駐車場の場所を案内したい
□ 初めて来る人が迷わないようにしたい
□ HP/Instagram/チラシQRのどこから見られているか知りたい

その他、気になっていること:
'''
        },
        'last30': {
            'detail': '''【Last30 Navigator についての相談】

現在の状況:
・お店/施設名: 
・業種: 
・場所: 

相談内容:
□ Google Mapで来ても最後の数十メートルで迷う人がいる
□ 敷地内/建物内の入口のズレを解消したい
□ 裏口や駐車場入口など、複数の入口を案内したい
□ ルート検索からの来店率を上げたい
□ アクセスデータを見て改善したい

その他、気になっていること:
'''
        },
        'event': {
            'detail': '''【Event Navigator についての相談】

現在の状況:
・イベント/施設名: 
・規模(出店数など): 
・開催場所: 

相談内容:
□ 複数店舗の探索を簡単にしたい
□ 目的別のナビゲーション(子連れ向け/価格帯など)が欲しい
□ 当日情報(混雑/売切れ)を反映したい
□ 多言語対応が必要
□ 来場者の行動データを見たい

その他、気になっていること:
'''
        }
    }
    
    # GETリクエストでプランタイプが指定されている場合、初期値をセット
    if request.method == 'GET' and plan_type in initial_values:
        form.contactdetail.data = initial_values[plan_type]['detail']

    if form.validate_on_submit():
        name = form.contactname.data.strip()
        email = form.contactemail.data.strip()
        detail = form.contactdetail.data.strip()

        inquiry = ContactInquiry(
            name=name,
            email=email,
            detail=detail,
            ip=(request.headers.get("X-Forwarded-For", request.remote_addr) or "")[:64],
            user_agent=(request.headers.get("User-Agent") or "")[:255],
            mail_status="pending",
        )

        db.session.add(inquiry)
        db.session.commit()

        # --- 管理者宛メール ---
        subject = f"[AreaMap お問い合わせ] {name} さん"
        body = (
            "AreaMap お問い合わせが届きました。\n\n"
            f"ID: {inquiry.id}\n"
            f"お名前: {name}\n"
            f"メール: {email}\n"
            f"IP: {inquiry.ip}\n"
            f"UA: {inquiry.user_agent}\n"
            "--------------------\n"
            f"{detail}\n"
        )

        try:
            msg = Message(
                subject=subject,
                recipients=[app.config["MAIL_ADMIN_TO"]],
                body=body,
                reply_to=email,
            )
            mail.send(msg)

            inquiry.mail_status = "sent"
            inquiry.mail_error = None
            db.session.commit()

            flash("送信しました。お問い合わせありがとうございます。", "success")
            return redirect(url_for("ask"))

        except Exception as e:
            inquiry.mail_status = "failed"
            inquiry.mail_error = str(e)
            db.session.commit()

            flash("送信に失敗しました。時間をおいて再度お試しください。", "danger")
            return redirect(url_for("ask"))

    return render_template("ask.html", form=form)

# if __name__ == "__main__":
#     app.run(
#         host="127.0.0.1",
#         port=5050,
#         debug=True
#     )





