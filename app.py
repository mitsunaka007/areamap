from flask import Flask, render_template, request, jsonify, flash, url_for, redirect, current_app, send_from_directory, abort
import os
import uuid
import hashlib
import math
from pathlib import Path
from sqlalchemy import func, case
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.utils import secure_filename
from PIL import Image
from flask_mail import Mail, Message
from models import  AreamapClickEvent, ContactInquiry, Shop, MapProject, MapPoint, MigrationShop, MapShopImages, BuildingGuide
from forms import AskForm
from extensions import db
from dotenv import load_dotenv

load_dotenv()
app = Flask(__name__)
MIGRATIONSHOP_ALLOWED_EXT = {".png", ".jpg", ".jpeg", ".webp"}
app.config["MIGRATIONSHOP_UPLOAD_DIR"] = os.environ.get(
    "MIGRATIONSHOP_UPLOAD_DIR", "migrationshop_uploads"
)
Path(app.config["MIGRATIONSHOP_UPLOAD_DIR"]).mkdir(parents=True, exist_ok=True)

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
# MigrationMaps 設定
# =========================
MIGRATIONMAPS_ALLOWED_EXT = {".png", ".jpg", ".jpeg", ".webp"}

# 画像保存先（migrationmaps専用）
app.config["MIGRATIONMAPS_UPLOAD_DIR"] = os.environ.get("MIGRATIONMAPS_UPLOAD_DIR", "migrationmaps_uploads")
Path(app.config["MIGRATIONMAPS_UPLOAD_DIR"]).mkdir(parents=True, exist_ok=True)

# Cloudinary 設定（環境変数が揃っている場合のみ有効）
_cld_cloud = os.environ.get("CLOUDINARY_CLOUD_NAME", "")
_cld_key   = os.environ.get("CLOUDINARY_API_KEY", "")
_cld_secret = os.environ.get("CLOUDINARY_API_SECRET", "")
CLOUDINARY_ENABLED = bool(_cld_cloud and _cld_key and _cld_secret)
if CLOUDINARY_ENABLED:
    import cloudinary
    import cloudinary.uploader
    cloudinary.config(cloud_name=_cld_cloud, api_key=_cld_key, api_secret=_cld_secret)


def _image_url_from_filename(image_filename: str) -> str:
    """image_filename がフルURL(Cloudinary等)ならそのまま、そうでなければローカルパスに変換"""
    if image_filename and image_filename.startswith("http"):
        return image_filename
    return f"/migrationmaps/uploads/{image_filename}"

# ---- 座標変換ユーティリティ（EPSG:4326 -> EPSG:3857）----
_R = 6378137.0

def _lonlat_to_mercator(lon, lat):
    x = _R * math.radians(lon)
    lat = max(min(lat, 85.05112878), -85.05112878)
    y = _R * math.log(math.tan(math.pi/4 + math.radians(lat)/2))
    return x, y

def _mercator_to_lonlat(x, y):
    lon = math.degrees(x / _R)
    lat = math.degrees(2 * math.atan(math.exp(y / _R)) - math.pi/2)
    return lon, lat

def _fit_affine(img_pts, ll_pts):
    """img_pts: [(x,y)], ll_pts: [(lat,lng)] -> (a,b,c,d,e,f)  (X,YはWebMercator)"""
    import numpy as np
    n = len(img_pts)
    if n < 3:
        raise ValueError("アフィン変換には最低3点が必要です（中心+2点など）")
    XY = []
    for (lat, lng) in ll_pts:
        X, Y = _lonlat_to_mercator(lng, lat)
        XY.append((X, Y))

    A = np.zeros((2*n, 6), dtype=float)
    b = np.zeros((2*n,), dtype=float)
    for i, ((x, y), (X, Y)) in enumerate(zip(img_pts, XY)):
        A[2*i,   0] = x
        A[2*i,   1] = y
        A[2*i,   2] = 1
        b[2*i]      = X
        A[2*i+1, 3] = x
        A[2*i+1, 4] = y
        A[2*i+1, 5] = 1
        b[2*i+1]    = Y

    coef, *_ = np.linalg.lstsq(A, b, rcond=None)
    a,b_,c,d,e,f = coef.tolist()
    return a,b_,c,d,e,f

def _img_to_latlng(a,b,c,d,e,f, x, y):
    X = a*x + b*y + c
    Y = d*x + e*y + f
    lon, lat = _mercator_to_lonlat(X, Y)
    return lat, lon


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
from flask import (
    Flask, render_template, request, jsonify,
    flash, url_for, redirect, current_app
)

# 既存の app / db / mail / Message / AskForm / ContactInquiry は定義済み前提

@app.route("/ask", methods=["GET", "POST"])
def ask():
    form = AskForm()

    # クエリパラメータから plan を取得（GETでは来るが、POSTでは消えやすい）
    plan_type = (request.args.get("plan", "") or "").strip()

    # POST時はクエリが消えるので、本文の先頭テンプレから推定して復元
    def _infer_plan(plan_from_query: str, detail_text: str) -> str:
        if plan_from_query in ("entrance", "last30", "event"):
            return plan_from_query
        t = (detail_text or "").lstrip()
        if t.startswith("【Entrance Pack"):
            return "entrance"
        if t.startswith("【Last30 Navigator"):
            return "last30"
        if t.startswith("【Event Navigator"):
            return "event"
        return "entrance"

    initial_values = {
        "entrance": {
            "detail": """【Entrance Pack についての相談】

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
"""
        },
        "last30": {
            "detail": """【Last30 Navigator についての相談】

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
"""
        },
        "event": {
            "detail": """【Event Navigator についての相談】

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
"""
        },
    }

    # GETで plan が来ていたら初期値をセット（表示用）
    if request.method == "GET" and plan_type in initial_values:
        form.contactdetail.data = initial_values[plan_type]["detail"]

    if form.validate_on_submit():
        name = (form.contactname.data or "").strip()
        email = (form.contactemail.data or "").strip()
        detail = (form.contactdetail.data or "").strip()

        # POST時でも plan を確定（thanks に渡す）
        plan_type_effective = _infer_plan(plan_type, detail)

        # 1) まずDB保存（ここが成功したら「送信成功」扱いにする）
        inquiry = ContactInquiry(
            name=name,
            email=email,
            detail=detail,
            ip=(request.headers.get("X-Forwarded-For", request.remote_addr) or "")[:64],
            user_agent=(request.headers.get("User-Agent") or "")[:255],
            mail_status="pending",
        )

        try:
            db.session.add(inquiry)
            db.session.commit()
        except Exception:
            # DB保存そのものが失敗した場合は、ユーザーにも失敗表示
            db.session.rollback()
            current_app.logger.exception("ContactInquiry DB save failed")
            flash("送信に失敗しました。時間をおいて再度お試しください。", "danger")
            # planを維持して戻す
            return redirect(url_for("ask", plan=plan_type_effective), code=303)

        # 2) DB保存が成功したので、ユーザーには成功表示（メール失敗でもここは変えない）
        flash("送信しました。お問い合わせありがとうございます。", "success")

        # 3) 管理者宛メール送信（失敗してもユーザー表示は成功のまま）
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
        except Exception as e:
            inquiry.mail_status = "failed"
            inquiry.mail_error = str(e)[:4000]
            current_app.logger.exception(
                "Admin mail send failed (ContactInquiry id=%s)", inquiry.id
            )
        finally:
            try:
                db.session.commit()
            except Exception:
                db.session.rollback()
                current_app.logger.exception(
                    "Failed to update mail_status for ContactInquiry id=%s", inquiry.id
                )

        # ✅ 送信後は /thanks へ（POST→GETに切替えるため303推奨）:contentReference[oaicite:1]{index=1}
        return redirect(url_for("thanks", plan=plan_type_effective), code=303)

    return render_template("ask.html", form=form)

@app.get("/tilemap")
def tilemap():
    return render_template("tilemap.html")

@app.get("/recipe_agent")
def recipe_agent():
    return render_template("recipe_agent.html")

@app.get("/thanks")
def thanks():
    plan = (request.args.get("plan") or "entrance").strip()
    if plan not in ("entrance", "last30"):
        plan = "entrance"
    # サンクス画面HTML（あなたが作ったやつ）を templates に置いた前提
    return render_template("areamap_thanks.html", plan=plan)

@app.get("/api/shops")
def api_shops():
    # 店名等を返さず、座標だけ返す（匿名表示）
    shops = Shop.query.with_entities(Shop.lat, Shop.lng).all()
    payload = [{"lat": float(s.lat), "lng": float(s.lng)} for s in shops]
    return jsonify({"shops": payload})

# if __name__ == "__main__":
#     app.run(
#         host="127.0.0.1",
#         port=5050,
#         debug=True
#     )








# =========================
# MigrationMaps ルート（管理画面 + API + 公開ページ）
# =========================
@app.get("/migrationmaps/admin")
def migrationmaps_admin():
    return render_template("migrationmaps/admin.html")

@app.get("/migrationmaps/m/<int:project_id>")
def migrationmaps_public(project_id: int):
    return render_template("migrationmaps/public.html", project_id=project_id)

@app.get("/migrationmaps/uploads/<path:filename>")
def migrationmaps_uploaded_file(filename):
    return send_from_directory(app.config["MIGRATIONMAPS_UPLOAD_DIR"], filename)

@app.post("/api/migrationmaps/upload")
def api_migrationmaps_upload():
    f = request.files.get("file")
    name = request.form.get("name", "").strip()
    if not f or not name:
        return jsonify({"error": "file と name は必須です"}), 400

    ext = Path(f.filename).suffix.lower()
    if ext not in MIGRATIONMAPS_ALLOWED_EXT:
        return jsonify({"error": f"拡張子が不正です: {ext}"}), 400

    safe = secure_filename(Path(f.filename).stem)
    unique_stem = f"{safe}_{uuid.uuid4().hex}"

    if CLOUDINARY_ENABLED:
        # Cloudinary にアップロード
        result = cloudinary.uploader.upload(
            f,
            public_id=unique_stem,
            folder="migrationmaps",
            resource_type="image",
        )
        image_url = result["secure_url"]
        image_filename = image_url  # フルURLをそのまま保存

        # 画像サイズは Cloudinary のレスポンスから取得
        w = result.get("width", 0)
        h = result.get("height", 0)
    else:
        filename = f"{unique_stem}{ext}"
        save_path = Path(app.config["MIGRATIONMAPS_UPLOAD_DIR"]) / filename
        f.save(save_path)
        with Image.open(save_path) as im:
            w, h = im.size
        image_url = f"/migrationmaps/uploads/{filename}"
        image_filename = filename

    return jsonify({
        "image_url": image_url,
        "image_filename": image_filename,
        "image_width": w,
        "image_height": h
    })

@app.post("/api/migrationmaps/save")
def api_migrationmaps_save():
    data = request.get_json(force=True)
    project_id = data.get("project_id")
    name = (data.get("name") or "").strip()
    image_filename = data.get("image_filename")
    w = data.get("image_width")
    h = data.get("image_height")
    points = data.get("points") or []

    if not name or not image_filename or not w or not h:
        return jsonify({"error": "name/image_filename/image_width/image_height は必須です"}), 400
    if len(points) < 3:
        return jsonify({"error": "点が少なすぎます。中心+他2点以上（合計3点以上）必要です"}), 400

    # 手入力フォームの空文字対策
    normalized_points = []
    for p in points:
        try:
            normalized_points.append({
                "label": p["label"],
                "kind": p["kind"],
                "img_x": float(p["img_x"]),
                "img_y": float(p["img_y"]),
                "lat": float(p["lat"]),
                "lng": float(p["lng"]),
            })
        except Exception:
            return jsonify({"error": f"点 {p.get('label', '?')} の値が不正です"}), 400

    img_pts = [(p["img_x"], p["img_y"]) for p in normalized_points]
    ll_pts  = [(p["lat"], p["lng"]) for p in normalized_points]
    try:
        a,b_,c,d,e,f = _fit_affine(img_pts, ll_pts)
    except Exception as ex:
        return jsonify({"error": str(ex)}), 400

    try:
        if project_id:
            proj = MapProject.query.get(int(project_id))
            if not proj:
                return jsonify({"error": "更新対象のプロジェクトが見つかりません"}), 404
            proj.name = name
            proj.image_filename = image_filename
            proj.image_width = int(w)
            proj.image_height = int(h)
            proj.a, proj.b, proj.c, proj.d, proj.e, proj.f = a, b_, c, d, e, f
            MapPoint.query.filter_by(project_id=proj.id).delete()
        else:
            proj = MapProject(
                name=name,
                image_filename=image_filename,
                image_width=int(w),
                image_height=int(h),
                a=a, b=b_, c=c, d=d, e=e, f=f,
            )
            db.session.add(proj)
            db.session.flush()

        for p in normalized_points:
            db.session.add(MapPoint(
                project_id=proj.id,
                label=p["label"],
                kind=p["kind"],
                img_x=p["img_x"],
                img_y=p["img_y"],
                lat=p["lat"],
                lng=p["lng"],
            ))

        db.session.commit()
        return jsonify({"project_id": proj.id, "updated": bool(project_id)})
    except Exception as ex:
        db.session.rollback()
        return jsonify({
            "error": "DB保存に失敗しました。テーブル未作成・スキーマ不一致・権限不足などを確認してください。",
            "detail": str(ex),
        }), 500

@app.get("/api/migrationmaps/projects")
def api_migrationmaps_projects():
    rows = MapProject.query.order_by(MapProject.created_at.desc(), MapProject.id.desc()).limit(100).all()
    return jsonify({
        "projects": [
            {
                "id": p.id,
                "name": p.name,
                "image_url": _image_url_from_filename(p.image_filename),
                "created_at": p.created_at.isoformat() if p.created_at else None,
                "public_url": f"/migrationmaps/m/{p.id}",
                "admin_url": f"/migrationmaps/admin?project_id={p.id}",
            }
            for p in rows
        ]
    })

@app.get("/api/migrationmaps/<int:project_id>")
def api_migrationmaps_get(project_id: int):
    proj = MapProject.query.get(project_id)
    if not proj:
        abort(404)

    pts = []
    for p in proj.points:
        pts.append({
            "id": p.id,
            "label": p.label,
            "kind": p.kind,
            "img_x": p.img_x,
            "img_y": p.img_y,
            "lat": p.lat,
            "lng": p.lng,
        })

    return jsonify({
        "id": proj.id,
        "name": proj.name,
        "image_url": _image_url_from_filename(proj.image_filename),
        "image_width": proj.image_width,
        "image_height": proj.image_height,
        "affine": {"a":proj.a,"b":proj.b,"c":proj.c,"d":proj.d,"e":proj.e,"f":proj.f},
        "points": pts
    })

@app.get("/api/migrationmaps/<int:project_id>/overlay_bounds")
def api_migrationmaps_overlay_bounds(project_id: int):
    proj = MapProject.query.get(project_id)
    if not proj:
        abort(404)

    # 元画像の四隅（TL, TR, BR, BL）
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
    # latlngs = [TL, TR, BR, BL]

    lats = [lat for lat, lng in latlngs]
    lngs = [lng for lat, lng in latlngs]
    sw = [min(lats), min(lngs)]
    ne = [max(lats), max(lngs)]

    pts = [{"lat": lat, "lng": lng} for (lat, lng) in latlngs]

    # DistortableImage 用: NW, NE, SW, SE
    by_lat = sorted(pts, key=lambda p: p["lat"], reverse=True)
    top2 = sorted(by_lat[:2], key=lambda p: p["lng"])
    bottom2 = sorted(by_lat[2:], key=lambda p: p["lng"])

    distortable_corners = [
        top2[0],     # NW
        top2[1],     # NE
        bottom2[0],  # SW
        bottom2[1],  # SE
    ]

    return jsonify({
        "bounds": [sw, ne],
        "image_corners": [
            {"lat": latlngs[0][0], "lng": latlngs[0][1]},  # TL
            {"lat": latlngs[1][0], "lng": latlngs[1][1]},  # TR
            {"lat": latlngs[2][0], "lng": latlngs[2][1]},  # BR
            {"lat": latlngs[3][0], "lng": latlngs[3][1]},  # BL
        ],
        "distortable_corners": distortable_corners,
        "image_size": {
            "width": proj.image_width,
            "height": proj.image_height,
        }
    })

@app.get("/api/migrationmaps/<int:project_id>/shops")
def api_migrationmaps_shops(project_id: int):
    proj = MapProject.query.get(project_id)
    if not proj:
        abort(404)

    shops = (
        MigrationShop.query
        .filter(
            MigrationShop.map_project_id == project_id,
            MigrationShop.is_active.is_(True)
        )
        .order_by(MigrationShop.id.asc())
        .all()
    )

    guides = (
        BuildingGuide.query
        .filter(
            BuildingGuide.map_project_id == project_id,
            BuildingGuide.is_active.is_(True)
        )
        .all()
    )
    # (lat, lng) をキーにした BuildingGuide マップ（小数点 7 桁で正規化）
    guide_map = {
        f"{float(g.lat):.7f},{float(g.lng):.7f}": g
        for g in guides
    }

    def shop_to_dict(s):
        key = f"{float(s.lat):.7f},{float(s.lng):.7f}"
        guide = guide_map.get(key)
        return {
            "id": s.id,
            "shopname": s.shopname,
            "address": s.address,
            "floorlevel": s.floorlevel,
            "tel": s.tel,
            "instagram_account": s.instagram_account,
            "description": s.description,
            "website_url": s.website_url,
            "lat": float(s.lat),
            "lng": float(s.lng),
            "images": [
                {"id": img.id, "image_url": img.image_url, "sort_order": img.sort_order}
                for img in s.shopimages
            ],
            "building_guide": {
                "id": guide.id,
                "building_name": guide.building_name,
                "image_url": guide.image_url,
                "floors": [
                    {
                        "floorlevel": f.floorlevel,
                        "area_x": f.area_x,
                        "area_y": f.area_y,
                        "area_width": f.area_width,
                        "area_height": f.area_height,
                        "sort_order": f.sort_order,
                    }
                    for f in guide.floors
                ],
            } if guide else None,
        }

    return jsonify({"shops": [shop_to_dict(s) for s in shops]})

# ----------------------------------------------------------------
# 【2】ルート定義（既存の MigrationMaps ルート群の末尾に追加）
# ----------------------------------------------------------------

@app.post("/api/migrationmaps/shop/register")
def api_migrationshop_register():
    from datetime import datetime

    shop_id_raw        = (request.form.get("shop_id") or "").strip()
    shopname           = (request.form.get("shopname") or "").strip()
    address            = (request.form.get("address") or "").strip()
    floorlevel         = (request.form.get("floorlevel") or "").strip() or None
    tel                = (request.form.get("tel") or "").strip() or None
    email              = (request.form.get("email") or "").strip()
    instagram_account  = (request.form.get("instagram_account") or "").strip() or None
    description        = (request.form.get("description") or "").strip() or None
    website_url        = (request.form.get("website_url") or "").strip() or None
    map_project_id_raw = (request.form.get("map_project_id") or "").strip()
    lat_raw            = (request.form.get("lat") or "").strip()
    lng_raw            = (request.form.get("lng") or "").strip()
    is_active          = request.form.get("is_active") == "1"

    errors = {}
    if not shopname:
        errors["shopname"] = "店名は必須です"
    if not address:
        errors["address"] = "住所は必須です"
    if not email:
        errors["email"] = "メールアドレスは必須です"
    if not map_project_id_raw:
        errors["map_project_id"] = "イラスト地図IDは必須です"
    if not lat_raw:
        errors["lat"] = "緯度は必須です"
    if not lng_raw:
        errors["lng"] = "経度は必須です"

    try:
        map_project_id = int(map_project_id_raw)
    except Exception:
        map_project_id = None
        errors["map_project_id"] = "イラスト地図IDが不正です"

    try:
        lat = float(lat_raw)
    except Exception:
        lat = None
        errors["lat"] = "緯度が不正です"

    try:
        lng = float(lng_raw)
    except Exception:
        lng = None
        errors["lng"] = "経度が不正です"

    if map_project_id is not None:
        proj = MapProject.query.get(map_project_id)
        if not proj:
            errors["map_project_id"] = "指定したイラスト地図IDが存在しません"

    if errors:
        return jsonify({"error": "入力エラー", "fields": errors}), 400

    try:
        if shop_id_raw:
            shop = MigrationShop.query.get(int(shop_id_raw))
            if not shop:
                return jsonify({"error": "更新対象の店舗が見つかりません"}), 404
            is_update = True
        else:
            shop = MigrationShop()
            db.session.add(shop)
            is_update = False

        shop.shopname = shopname
        shop.address = address
        shop.floorlevel = floorlevel
        shop.tel = tel
        shop.email = email
        shop.instagram_account = instagram_account
        shop.lat = lat
        shop.lng = lng
        shop.is_active = is_active
        shop.description = description
        shop.website_url = website_url
        shop.map_project_id = map_project_id
        shop.updated_at = datetime.now()

        db.session.flush()

        image_count = 0
        for sort_order in range(1, 6):
            f = request.files.get(f"shop_image_{sort_order}")
            if not f or not f.filename:
                continue

            ext = Path(f.filename).suffix.lower()
            if ext not in MIGRATIONSHOP_ALLOWED_EXT:
                db.session.rollback()
                return jsonify({"error": f"画像{sort_order}の拡張子が不正です: {ext}"}), 400

            safe = secure_filename(Path(f.filename).stem)
            filename = f"shop_{shop.id}_{sort_order}_{uuid.uuid4().hex}{ext}"
            save_path = Path(app.config["MIGRATIONSHOP_UPLOAD_DIR"]) / filename
            f.save(save_path)
            image_url = f"/migrationshop_uploads/{filename}"

            existing = MapShopImages.query.filter_by(
                migrationshop_id=shop.id,
                sort_order=sort_order
            ).first()

            if existing:
                existing.image_url = image_url
            else:
                db.session.add(MapShopImages(
                    migrationshop_id=shop.id,
                    image_url=image_url,
                    sort_order=sort_order,
                ))
            image_count += 1

        db.session.commit()
        return jsonify({
            "ok": True,
            "shop_id": shop.id,
            "image_count": image_count,
            "updated": is_update,
        })
    except Exception as e:
        db.session.rollback()
        return jsonify({"error": f"db_error: {repr(e)}"}), 500

@app.get("/api/migrationmaps/shops")
def api_migrationshop_list():
    project_id = request.args.get("project_id", type=int)

    q = MigrationShop.query.order_by(MigrationShop.updated_at.desc(), MigrationShop.id.desc())
    if project_id:
        q = q.filter(MigrationShop.map_project_id == project_id)

    shops = q.all()
    return jsonify({
        "shops": [
            {
                "id": s.id,
                "shopname": s.shopname,
                "address": s.address,
                "floorlevel": s.floorlevel,
                "map_project_id": s.map_project_id,
                "is_active": bool(s.is_active),
                "updated_at": s.updated_at.isoformat() if s.updated_at else None,
            }
            for s in shops
        ]
    })

@app.get("/api/migrationmaps/shops/<int:shop_id>")
def api_migrationshop_detail(shop_id: int):
    shop = MigrationShop.query.get(shop_id)
    if not shop:
        return jsonify({"error": "店舗が見つかりません"}), 404

    return jsonify({
        "shop": {
            "id": shop.id,
            "shopname": shop.shopname,
            "address": shop.address,
            "floorlevel": shop.floorlevel,
            "tel": shop.tel,
            "email": shop.email,
            "instagram_account": shop.instagram_account,
            "lat": float(shop.lat) if shop.lat is not None else None,
            "lng": float(shop.lng) if shop.lng is not None else None,
            "is_active": bool(shop.is_active),
            "description": shop.description,
            "website_url": shop.website_url,
            "map_project_id": shop.map_project_id,
            "images": [
                {
                    "id": img.id,
                    "image_url": img.image_url,
                    "sort_order": img.sort_order,
                }
                for img in shop.shopimages
            ]
        }
    })

@app.get("/migrationmaps/shop_uploads/<path:filename>")
def migrationshop_uploaded_file(filename):
    """ショップ画像の配信ルート"""
    upload_dir = app.config.get("MIGRATIONSHOP_UPLOAD_DIR", "migrationshop_uploads")
    return send_from_directory(upload_dir, filename)
