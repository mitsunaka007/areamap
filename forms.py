# forms.py
from flask_wtf import FlaskForm
from wtforms import StringField, TextAreaField, SubmitField, BooleanField, IntegerField
from wtforms.validators import DataRequired, Email, Length

class AskForm(FlaskForm):
    contactname         = StringField("お名前", validators=[DataRequired(), Length(max=80)])
    contactemail        = StringField("メールアドレス", validators=[DataRequired(), Email(), Length(max=120)])
    contactdetail       = TextAreaField("お問い合わせ内容", validators=[DataRequired(), Length(max=4000)])
    submit              = SubmitField("送信する")

class RegistShopForm(FlaskForm):
    shopname            = StringField("店名", validators=[DataRequired(), Length(max=100)])
    address             = StringField("住所", validators=[DataRequired(), Length(max=255)])
    floorlevel          = StringField("階層", validators=[DataRequired(), Length(max=10)])
    tel                 = StringField("電話番号", validators=[DataRequired(), Length(max=50)])
    email               = StringField("メールアドレス", validators=[DataRequired(), Email(), Length(max=120)])
    instagram_account   = StringField("インスタアカウント", validators=[DataRequired(), Length(max=120)])
    lat                 = IntegerField("緯度", validators=[DataRequired(), Length(max=100)])
    lng                 = IntegerField("経度", validators=[DataRequired(), Length(max=100)])
    is_active           = BooleanField("営業中", validators=[DataRequired(), Length(max=20)])
    description         = StringField("詳細", validators=[DataRequired(), Length(max=255)])
    website_url         = StringField("サイトURL", validators=[DataRequired(), Length(max=255)])
    map_project_id      = IntegerField("イラスト地図ID", validators=[DataRequired(), Length(max=50)])
    shopimages_id       = IntegerField("ショップ画像ID", validators=[DataRequired(), Length(max=100)])
    submit              = SubmitField("登録する")