# AreaMap 仕様書

## 1. 概要

AreaMap は、来店客が「入口・駐車場・目印が分からず迷う」ことによる離脱（迷い電話・迷いDM・当日キャンセル・取りこぼし）を減らすための、店舗向けアクセス案内ツールである。

Google マップだけではカバーしきれない「最後の30m」（敷地内・共同駐車場・裏口・入口のズレなど）を、店舗側がイラスト地図・写真・注意書きでコントロールして提示する。単なる地図表示ではなく、流入元（HP／Instagram／チラシQRなど）別にURLを発行してアクセス・クリックを計測し、継続的に迷いポイントを改善していくことを前提とした設計になっている。

## 2. 提供プラン

LP（`templates/areamaplp.html`）上で2プラン構成として案内されている。

### 2.1 Entrance Pack（Lite 版 / 実装: `/areamap-lite`）

「迷わない固定導線（入口・駐車場・料金）」を作ることに特化した静止画ベースの案内ページ。

- 初期費用 10,000円 / 月額 3,000円
- イラスト地図上のホットスポット：最大3点
- 重点画像：最大3枚（タップで拡大表示）
- 流入元別URL：最大5本（HP / Instagram / チラシQR など）
- mypage で確認可能な指標：PV/UU、URL別アクセス、画像タップ、CTAクリック
- 初回修正1回＋月1回までの軽微更新

### 2.2 Last30 Navigator（Pro 版 / 実装: `/areamap-pro`）

「最後の30m」を現地目線でナビゲーションする、地図連動型の案内ページ。

- 初期費用 29,800円 / 月額 10,000円
- ホットスポット：最大10点（クリックでモーダル表示）
- Leaflet 地図＋イラスト地図オーバーレイ
- 現在地からお店までのルート表示（方角別ルート候補の自動選択を含む）
- 計測：PV/UU、URL別、CTA、画像／スポット反応
- 月1回のミニレポート＋改善提案（最大3件）
- 初回修正2回＋月2回までの軽微更新

## 3. 画面・ルーティング一覧（`app.py`）

| メソッド | パス | 実装関数 | 内容 |
|---|---|---|---|
| GET | `/` | `index` | LP（`areamaplp.html`）を表示 |
| GET | `/areamap` | `areamap` | 汎用デモ用の地図表示（エリア・スポットは現状ハードコードの仮データ） |
| GET | `/areamap_sbodymorita` | `areamapsbodymorita` | 導入事例「S・BODY」向け専用アクセス案内ページ |
| GET | `/areamap-lite` | `areamap_lite` | Entrance Pack のサンプル（`areamap-lite.html`） |
| GET | `/areamap-pro` | `areamap_pro` | Last30 Navigator のサンプル（`areamap-pro.html`） |
| GET | `/tilemap` | `tilemap` | 「秘書問題×回収判定」を使った必要性訴求デモ（LPに埋め込み表示） |
| GET | `/thanks` | `thanks` | お問い合わせ送信後のサンクスページ。`plan` クエリ（`entrance` / `last30`）でメッセージ出し分け |
| GET/POST | `/ask` | `ask` | 相談・問い合わせフォーム。POST時に `ContactInquiry` を保存しメール通知、完了後 `/thanks` へ303リダイレクト |
| POST | `/api/metrics/log` | `log_metric` | クリック・表示イベントのログ保存API（下記4章） |
| GET | `/mypage_sbodymorita` | `mypage_sbodymorita` | S・BODY 向け計測ダッシュボード |
| GET | `/api/shops` | `api_shops` | `Shop` テーブルの緯度経度のみを匿名で返すAPI（店名等は含まない） |

> 補足: `templates/areamap-stores.html` はテンプレートとして存在するが、対応する Flask ルートが定義されておらず、現状は配信されていない（未使用テンプレート）。

## 4. 計測（アクセス解析）機能

### 4.1 概要

`areamap_sbodymorita.html` などのページに埋め込まれたJSが、閲覧・クリックイベントを `/api/metrics/log`（POST）へ送信し、`AreamapClickEvent` テーブルに保存する。

### 4.2 リクエスト仕様

```json
{
  "event_name": "view | click",
  "metric_id": "areamap_page_view / google_map_click / hotspot_xxx など",
  "extra": {
    "page_url": "...", "page_path": "...", "title": "...", "referrer": "...",
    "ref": "...", "post": "...", "variant": "...",
    "session_id": "...", "user_agent": "...",
    "viewport_width": 0, "viewport_height": 0,
    "screen_width": 0, "screen_height": 0,
    "device_pixel_ratio": 0, "tz_offset_min": 0,
    "language": "...", "languages": ["..."], "platform": "...",
    "max_touch_points": 0, "hover_none": true,
    "device_memory_gb": 0, "hardware_concurrency": 0,
    "connection_effective_type": "...", "connection_rtt_ms": 0,
    "connection_downlink_mbps": 0, "connection_save_data": false,
    "cookies_enabled": true, "do_not_track": "...",
    "prefers_reduced_motion": false, "prefers_color_scheme": "...",
    "href": "...", "modal_img": "...", "action_value": "..."
  }
}
```

- `event_name` と `metric_id` は必須（未指定時は400を返す）。
- クライアントIPは `X-Forwarded-For` を優先して取得（`_get_client_ip`）。IPのハッシュ化関数（`_ip_to_hash_bytes`、SHA-256＋Salt）も実装済みだが、現状の保存処理では未使用。
- 端末情報・UTM・ジオ情報など、Web解析に必要な項目を広く受け取れるスキーマになっているが、ジオ情報（`geo_lat` 等）とUTM系カラムは現行の `log_metric` 実装では保存されていない（テーブル定義には存在）。
- 生のクライアント送信値は `extra_json` (`{"client": extra}`) にもJSONBとして丸ごと保存される。

### 4.3 集計ダッシュボード（`/mypage_sbodymorita`）

`AreamapClickEvent` を `page_path` が `%areamap_sbodymorita%` に一致するものに絞り込み、以下を集計して表示する。

- 総イベント数
- ページビュー数（`event_name=view` かつ `metric_id=areamap_page_view`）
- Googleマップクリック数（`event_name=click` かつ `metric_id=google_map_click`）
- 全体CVR（クリック数 / PV数）
- 指標（`metric_id`）別イベント数ランキング
- 日別イベント推移
- 流入元（`ref`）× 施策（`post`）別の PV・クリック・CVR 集計（クリック数降順 → CVR降順 → PV数降順）

## 5. お問い合わせ機能（`/ask`）

- フォーム定義：`forms.py` の `AskForm`（お名前・メールアドレス・お問い合わせ内容、CSRF保護あり）
- POST時、`plan` クエリパラメータと本文から `_infer_plan` によりプラン（`entrance` / `last30`）を推定し保存
- `ContactInquiry` に保存後、Flask-Mail（Gmail SMTP）で管理者宛（`MAIL_ADMIN_TO`）に通知メールを送信
- 送信結果は `mail_status`（`pending` / `sent` / `failed`）、`mail_error` に記録
- 完了後は `/thanks?plan=...` へ 303 リダイレクト（POST→GET切り替え）

## 6. データモデル（`models.py`）

| モデル | テーブル名 | 用途 |
|---|---|---|
| `Shop` | `shop` | ショップ（旧アカウント系）情報。ログイン用の `UserMixin` を継承。メール／パスワード等を保持。※`Shop` は本ファイル内でもう一箇所（`shops` テーブル）と同名クラスが再定義されており、実質的に後者の定義（緯度経度のみ）で上書きされる点に注意 |
| `PasswordResetToken` | `password_reset_tokens` | パスワード再設定用トークン発行・検証 |
| `AreaMapLinks` | `areamaplinks` | ショップとAreaMapコンテンツの紐付け（現状ルート未実装、将来のマルチテンプレート対応を想定した設計と思われる） |
| `AreaMapContents` | `areamapcontents` | AreaMapのコンテンツ情報（`template_id`, `maplayer_id` を保持。現状ルート未実装） |
| `AreaMapTemplate` | `areamaptemplate` | 個人店向け／商店街向け／イベント向けなどのテンプレート種別マスタ（現状ルート未実装） |
| `AreamapClickEvent` | `areamap_click_events` | 4章の計測イベントログ本体 |
| `ContactInquiry` | `contact_inquiries` | `/ask` からの問い合わせ内容とメール送信ステータス |
| `Shop`（2回目の定義） | `shops` | `id`, `lat`, `lng` のみを持つ軽量モデル。`/api/shops` の匿名座標配信に使用 |

> `AreaMapLinks` / `AreaMapContents` / `AreaMapTemplate` は、テンプレート種別（個人店・商店街・イベント）を切り替える多店舗対応の下地として定義されているが、2026年時点の `app.py` にはこれらを操作するルートが実装されておらず、現状は `areamap-lite` / `areamap-pro` の静的テンプレートで代替運用されている。

## 7. 技術構成

- バックエンド: Flask（`app.py`）、SQLAlchemy（`extensions.py`, `models.py`）
- DB: PostgreSQL（`DATABASE_URL` 環境変数必須。`postgres://` は `postgresql://` に自動補正）
- フロント: Jinja2テンプレート＋Leaflet（Pro版の地図表示）、素のJS（ホットスポット・モーダル・ルート選択・計測送信）
- メール: Flask-Mail（Gmail SMTP、`MAIL_USERNAME` / `MAIL_PASSWORD` 環境変数）
- リバースプロキシ対応: `ProxyFix`（Render等の配下でクライアントIP／プロトコルを正しく取得）

## 8. 未確定・要整理事項

- `Shop` クラスの二重定義（`shop` テーブル版と `shops` テーブル版）は、後の定義が有効になるため実質的に前者は使われていない可能性が高く、整理が望ましい。
- `AreaMapLinks` / `AreaMapContents` / `AreaMapTemplate` を利用する管理画面・APIが未実装。
- `areamap-stores.html` は未ルーティングの孤立テンプレート。
- `AreamapClickEvent` のジオ情報・UTM系カラムは、テーブル定義はあるが `log_metric` の保存処理では未セット。
