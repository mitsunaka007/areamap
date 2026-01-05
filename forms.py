# forms.py
from flask_wtf import FlaskForm
from wtforms import StringField, TextAreaField, SubmitField
from wtforms.validators import DataRequired, Email, Length

class AskForm(FlaskForm):
    contactname = StringField(
        "お名前",
        validators=[DataRequired(), Length(max=80)]
    )
    contactemail = StringField(
        "メールアドレス",
        validators=[DataRequired(), Email(), Length(max=120)]
    )
    contactdetail = TextAreaField(
        "お問い合わせ内容",
        validators=[DataRequired(), Length(max=4000)]
    )
    submit = SubmitField("送信する")
