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
    user_agent                  = db.Column(db.Text)
    session_id                  = db.Column(db.Text)
    visitor_id                  = db.Column(db.Text)
    is_bot                      = db.Column(db.Boolean)
    viewport_w                  = db.Column(db.Integer)
    viewport_h                  = db.Column(db.Integer)
    screen_w                    = db.Column(db.Integer)
    screen_h                    = db.Column(db.Integer)
    device_pixel_ratio          = db.Column(db.Numeric(precision=6, scale=3))
    timezone_offset_min         = db.Column(db.Integer)
    language                    = db.Column(db.Text)
    languages                   = db.Column(ARRAY(db.Text))
    platform                    = db.Column(db.Text)
    mobile                      = db.Column(db.Boolean)
    cookie_enabled              = db.Column(db.Boolean)
    touch_support               = db.Column(db.Boolean)
    max_touch_points            = db.Column(db.Integer)
    app_name                    = db.Column(db.Text)
    app_version                 = db.Column(db.Text)
    vendor                      = db.Column(db.Text)
    connection_type             = db.Column(db.Text)
    downlink                    = db.Column(db.Numeric(precision=6, scale=2))
    effective_type              = db.Column(db.Text)
    rtt                         = db.Column(db.Integer)
    save_data                   = db.Column(db.Boolean)
    memory_gb                   = db.Column(db.Numeric(precision=4, scale=1))
    cpu_cores                   = db.Column(db.Integer)
    battery_level               = db.Column(db.Numeric(precision=4, scale=1))
    battery_charging            = db.Column(db.Boolean)
    visibility_state            = db.Column(db.Text)
    page_load_ms                = db.Column(db.Numeric(precision=6, scale=2))
    first_paint_ms              = db.Column(db.Numeric(precision=6, scale=2))
    first_contentful_paint_ms   = db.Column(db.Numeric(precision=6, scale=2))
    largest_contentful_paint_ms = db.Column(db.Numeric(precision=6, scale=2))
    cumulative_layout_shift     = db.Column(db.Numeric(precision=6, scale=3))
    inp_ms                      = db.Column(db.Numeric(precision=6, scale=2))
    hover_none                  = db.Column(db.Boolean)
    device_memory_gb            = db.Column(db.Numeric(precision=4, scale=1))
    hardware_concurrency        = db.Column(db.Integer)
    connection_effective_type   = db.Column(db.Text)
    connection_rtt_ms           = db.Column(db.Integer)
    connection_downlink_mbps    = db.Column(db.Numeric(precision=6, scale=2))
    connection_save_data        = db.Column(db.Boolean)
    cookies_enabled             = db.Column(db.Boolean)
    do_not_track                = db.Column(db.Text)
    prefers_reduced_motion      = db.Column(db.Boolean)
    prefers_color_scheme        = db.Column(db.Text)
    geo_lat                     = db.Column(db.Numeric(precision=10, scale=7))
    geo_lng                     = db.Column(db.Numeric(precision=10, scale=7))
    geo_accuracy_m              = db.Column(db.Numeric(precision=10, scale=2))
    ip_addr                     = db.Column(INET)
    ip_hash                     = db.Column(BYTEA)
    utm_source                  = db.Column(db.Text)
    utm_medium                  = db.Column(db.Text)
    utm_campaign                = db.Column(db.Text)
    utm_term                    = db.Column(db.Text)
    utm_content                 = db.Column(db.Text)
    extra_json                  = db.Column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
 