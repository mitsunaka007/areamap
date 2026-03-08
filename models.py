import os
from flask_login import UserMixin
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime, timedelta
import pytz
from uuid import uuid4
from sqlalchemy import func, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.dialects.postgresql import ARRAY, INET, JSONB, BYTEA
from extensions import db  # db = SQLAlchemy() がある前提

# タイムゾーンを指定
timezone = pytz.timezone('Asia/Tokyo')

class Shop(db.Model, UserMixin):
    __tablename__       = 'shop'
    id                  = db.Column(db.Integer, primary_key=True, autoincrement=True)
    shopname            = db.Column(db.String(150), unique=True, nullable=False)
    email               = db.Column(db.String(64), unique=True, index=True, nullable=False)
    password            = db.Column(db.String(128), nullable=True)
    shopaddress         = db.Column(db.String(256), nullable=False)
    # ショップ情報の確認画面に遷移する段階でshopaddressから緯度と経度に変換する。
    shops_lat           = db.Column(db.Integer, nullable=False)
    shops_lng           = db.Column(db.Integer, nullable=False)
    shoptell            = db.Column(db.String(100), unique=True, nullable=False)
    shopemail           = db.Column(db.String(64), unique=True, nullable=True)
    created_at          = db.Column(db.DateTime, default=datetime.now(), nullable=False)

    def set_password(self, password):
        self.password   = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password, password)
    
    @classmethod
    def select_user_by_email(cls, email):
        return cls.query.filter_by(email=email).first()
    
# パスワードリセット時に利用する
class PasswordResetToken(db.Model):
    __tablename__       = 'password_reset_tokens'
    id                  = db.Column(db.Integer, primary_key=True)
    token               = db.Column(db.String(64), unique=True, index=True, server_default=str(uuid4))
    shop_id             = db.Column(db.Integer, db.ForeignKey('shop.id'), nullable=False)
    expire_at           = db.Column(db.DateTime, default=datetime.now)
    create_at           = db.Column(db.DateTime, default=datetime.now)
    update_at           = db.Column(db.DateTime, default=datetime.now)

    def __init__(self, token, user_id, expire_at):
        self.token      = token
        self.user_id    = user_id
        self.expire_at  = expire_at

    @classmethod
    def publish_token(cls, user):
        # パスワード設定用のURLを生成
        token       = str(uuid4())
        new_token   = cls(
            token,
            user.id,
            datetime.now() + timedelta(days=1)
        )
        db.session.add(new_token)
        return token
    
    @classmethod
    def get_user_id_by_token(cls, token):
        now     = datetime.now()
        record  = cls.query.filter_by(token=str(token)).filter(cls.expire_at > now).first()
        if record:
            return record.user_id
        else:
            return None
    
    @classmethod
    def delete_token(cls, token):
        cls.query.filter_by(token=str(token)).delete()

class AreaMapLinks(db.Model):
    __tablename__               = 'areamaplinks'
    id                          = db.Column(db.Integer, primary_key=True)
    shop_id                     = db.Column(db.Integer, db.ForeignKey('shop.id'), nullable=False)
    areamapcontent_id           = db.Column(db.Integer, db.ForeignKey('areamapcontents.id'), nullable=False)
    areamap                     = db.relationship('AreaMapContents', backref='links', lazy=True)

class AreaMapContents(db.Model):
    """ AreaMapのコンテンツ情報"""
    __tablename__               = 'areamapcontents'
    id                          = db.Column(db.Integer, primary_key=True, autoincrement=True)
    shop_id                     = db.Column(db.Integer, db.ForeignKey('shop.id'), nullable=False)
    template_id                 = db.Column(db.Integer, nullable=False)
    maplayer_id                 = db.Column(db.Integer, nullable=False)

class AreaMapTemplate(db.Model):
    """ 個人店向け/商店街向け/イベント向けのテンプレート情報 """
    __tablename__               = 'areamaptemplate'
    id                          = db.Column(db.Integer, primary_key=True, autoincrement=True)
    templatetype                = db.Column(db.String(100), nullable=False)

class AreamapClickEvent(db.Model):
    __tablename__               = "areamap_click_events"

    id                          = db.Column(db.BigInteger, primary_key=True, autoincrement=True, nullable=False)
    occurred_at                 = db.Column(db.DateTime(timezone=True), nullable=False, server_default=func.now())
    event_name                  = db.Column(db.Text, nullable=False)
    element_key                 = db.Column(db.Text, nullable=False)
    element_id                  = db.Column(db.Text)
    element_tag                 = db.Column(db.Text)
    element_text                = db.Column(db.Text)
    action_value                = db.Column(db.Text)
    page_url                    = db.Column(db.Text, nullable=False)
    page_path                   = db.Column(db.Text)
    page_title                  = db.Column(db.Text)
    referrer                    = db.Column(db.Text)
    ref                         = db.Column(db.Text)
    post                        = db.Column(db.Text)
    variant                     = db.Column(db.Text)
    utm_source                  = db.Column(db.Text)
    utm_medium                  = db.Column(db.Text)
    utm_campaign                = db.Column(db.Text)
    utm_content                 = db.Column(db.Text)
    utm_term                    = db.Column(db.Text)
    session_id                  = db.Column(db.Text)
    visitor_id                  = db.Column(db.Text)
    user_agent                  = db.Column(db.Text)
    accept_language             = db.Column(db.Text)
    language                    = db.Column(db.Text)
    languages                   = db.Column(ARRAY(db.Text))
    platform                    = db.Column(db.Text)
    is_bot                      = db.Column(db.Boolean)
    is_mobile                   = db.Column(db.Boolean)
    timezone                    = db.Column(db.Text)
    tz_offset_min               = db.Column(db.Integer)
    screen_width                = db.Column(db.Integer)
    screen_height               = db.Column(db.Integer)
    viewport_width              = db.Column(db.Integer)
    viewport_height             = db.Column(db.Integer)
    device_pixel_ratio          = db.Column(db.Numeric)
    color_depth                 = db.Column(db.Integer)
    max_touch_points            = db.Column(db.Integer)
    pointer_coarse              = db.Column(db.Boolean)
    hover_none                  = db.Column(db.Boolean)
    device_memory_gb            = db.Column(db.Numeric)
    hardware_concurrency        = db.Column(db.Integer)
    connection_effective_type   = db.Column(db.Text)
    connection_rtt_ms           = db.Column(db.Integer)
    connection_downlink_mbps    = db.Column(db.Numeric)
    connection_save_data        = db.Column(db.Boolean)
    cookies_enabled             = db.Column(db.Boolean)
    do_not_track                = db.Column(db.Text)
    prefers_reduced_motion      = db.Column(db.Boolean)
    prefers_color_scheme        = db.Column(db.Text)
    geo_lat                     = db.Column(db.Numeric)
    geo_lng                     = db.Column(db.Numeric)
    geo_accuracy_m              = db.Column(db.Numeric)
    geo_country                 = db.Column(db.Text)
    geo_region                  = db.Column(db.Text)
    geo_city                    = db.Column(db.Text)
    ip_addr                     = db.Column(INET)
    ip_hash                     = db.Column(BYTEA)
    extra_json                  = db.Column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))

class ContactInquiry(db.Model):
    __tablename__               = "contact_inquiries"
    id                          = db.Column(db.Integer, primary_key=True, autoincrement=True)
    name                        = db.Column(db.String(80), nullable=False)
    email                       = db.Column(db.String(120), nullable=False, index=True)
    detail                      = db.Column(db.Text, nullable=False)
    created_at                  = db.Column(db.DateTime, nullable=False, default=datetime.utcnow, index=True)
    ip                          = db.Column(db.String(64), nullable=True)
    user_agent                  = db.Column(db.String(255), nullable=True)
    mail_status                 = db.Column(db.String(20), nullable=False, default="pending")  # pending/sent/failed
    mail_error                  = db.Column(db.Text, nullable=True)
    
class Shop(db.Model):
    __tablename__ = "shops"
    id = db.Column(db.BigInteger, primary_key=True)
    # name / category 等はDBにはある前提。APIでは返さない。
    lat = db.Column(db.Float, nullable=False)
    lng = db.Column(db.Float, nullable=False)

# =========================
# MigrationMaps (イラスト地図→OSM重ね合わせ) 用モデル
# =========================
class MapProject(db.Model):
    __tablename__ = "map_projects"
    id = db.Column(db.Integer, primary_key=True)

    name = db.Column(db.Text, nullable=False)  # 地図名
    image_filename = db.Column(db.Text, nullable=False)
    image_width = db.Column(db.Integer, nullable=False)
    image_height = db.Column(db.Integer, nullable=False)

    # 画像->WebMercator(3857) アフィン変換係数
    # X = a*x + b*y + c
    # Y = d*x + e*y + f
    a = db.Column(db.Float, nullable=False)
    b = db.Column(db.Float, nullable=False)
    c = db.Column(db.Float, nullable=False)
    d = db.Column(db.Float, nullable=False)
    e = db.Column(db.Float, nullable=False)
    f = db.Column(db.Float, nullable=False)

    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    points = db.relationship("MapPoint", backref="project", cascade="all, delete-orphan")
    shops = db.relationship(
        "MigrationShop",
        backref="map_project",
        passive_deletes=True
    )

class MapPoint(db.Model):
    __tablename__ = "map_points"
    id = db.Column(db.Integer, primary_key=True)

    project_id = db.Column(db.Integer, db.ForeignKey("map_projects.id", ondelete="CASCADE"), nullable=False)

    label = db.Column(db.Text, nullable=False)  # center / p1 / p2 / ...
    kind = db.Column(db.Text, nullable=False)   # center or point

    # 画像内ピクセル座標
    img_x = db.Column(db.Float, nullable=False)
    img_y = db.Column(db.Float, nullable=False)

    # 緯度経度
    lat = db.Column(db.Float, nullable=False)
    lng = db.Column(db.Float, nullable=False)

from datetime import datetime
from extensions import db

class MigrationShop(db.Model):
    __tablename__ = "migrationshop"

    id = db.Column(db.Integer, primary_key=True)

    shopname = db.Column(db.Text, nullable=False)
    address = db.Column(db.Text, nullable=False)
    floorlevel = db.Column(db.String(20))
    tel = db.Column(db.String(50))
    email = db.Column(db.String(255))
    instagram_account = db.Column(db.String(255))

    # 緯度経度
    lat = db.Column(db.Numeric(10, 7), nullable=False)
    lng = db.Column(db.Numeric(11, 7), nullable=False)

    is_active = db.Column(db.Boolean, nullable=False, default=True)

    created_at = db.Column(db.DateTime, default=datetime.now, nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.now, nullable=False)

    description = db.Column(db.Text)
    website_url = db.Column(db.String(255))

    # どの MapProject に紐づく店か
    map_project_id = db.Column(
        db.Integer,
        db.ForeignKey("map_projects.id", ondelete="SET NULL"),
        nullable=True
    )

    # 親 -> 子（1対多）
    shopimages = db.relationship(
        "MapShopImages",
        backref="shop",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="MapShopImages.sort_order"
    )


class MapShopImages(db.Model):
    __tablename__ = "mapshopimages"

    id = db.Column(db.Integer, primary_key=True)

    migrationshop_id = db.Column(
        db.Integer,
        db.ForeignKey("migrationshop.id", ondelete="CASCADE"),
        nullable=False
    )

    image_url = db.Column(db.String(255), nullable=False)

    # 1〜5を想定
    sort_order = db.Column(db.Integer, nullable=False, default=1)

    created_at = db.Column(db.DateTime, default=datetime.now, nullable=False)

    __table_args__ = (
        db.UniqueConstraint("migrationshop_id", "sort_order", name="uq_mapshopimages_shop_sort"),
        db.CheckConstraint("sort_order >= 1 AND sort_order <= 5", name="ck_mapshopimages_sort_order_1_5"),
    )

class BuildingGuide(db.Model):
    __tablename__ = "building_guides"

    id = db.Column(db.Integer, primary_key=True)
    map_project_id = db.Column(db.Integer, db.ForeignKey("map_projects.id", ondelete="SET NULL"))
    lat = db.Column(db.Numeric(10, 7), nullable=False)
    lng = db.Column(db.Numeric(11, 7), nullable=False)

    building_name = db.Column(db.String(255))
    image_url = db.Column(db.String(255), nullable=False)   # ビル全体写真
    is_active = db.Column(db.Boolean, nullable=False, default=True)

    created_at = db.Column(db.DateTime, default=datetime.now, nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.now, nullable=False)
    floors = db.relationship(
        "BuildingGuideFloor",
        backref="building_guide",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="BuildingGuideFloor.sort_order"
    )

class BuildingGuideFloor(db.Model):
    __tablename__ = "building_guide_floors"

    id = db.Column(db.Integer, primary_key=True)
    building_guide_id = db.Column(
        db.Integer,
        db.ForeignKey("building_guides.id", ondelete="CASCADE"),
        nullable=False
    )

    floorlevel = db.Column(db.String(20), nullable=False)   # 1F / 2F / 3F
    area_x = db.Column(db.Integer, nullable=False)          # 画像左上X
    area_y = db.Column(db.Integer, nullable=False)          # 画像左上Y
    area_width = db.Column(db.Integer, nullable=False)
    area_height = db.Column(db.Integer, nullable=False)
    sort_order = db.Column(db.Integer, nullable=False, default=1)