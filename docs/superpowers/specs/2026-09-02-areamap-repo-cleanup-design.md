# AreaMap リポジトリ整理（プランA：整理のみ・低リスク）— 設計

- 日付: 2026-09-02
- 対象: `c:\Users\mitsu\dev\areamap-main`
- リモート: `git@github.com:mitsunaka007/areamap.git`（HTTPS で操作）

## 背景 / 現状

- `areamap-main` は Git リポジトリではない（GitHub の ZIP を展開したフォルダ）。
- 親フォルダ `C:\Users\mitsu` 全体が 1 つの Git リポジトリになっており、そこに
  `origin = areamap.git` が設定されている。この状態で `git add`/`git push origin`
  を実行するとホームディレクトリ全体（`.ssh/`、各種 `.env`、GCP サービスアカウント
  鍵 JSON など）が公開リポジトリに漏れる危険がある。
  → 本作業では **`areamap-main` を独立した Git リポジトリとして扱い、親リポジトリには
  一切触れない**。
- GitHub 側 `areamap`（`origin/main`）の履歴は全て「Add files via upload」で、
  ローカルより古くファイルも少ない（`migrationmaps_basemap/geo/osm.py`、`migrations/`、
  `scripts/`、`tests/`、`docs/` が存在しない）。ローカルとは共通の祖先が無く、
  マージ不可（実質「置き換え」）。
- ローカル `.env` に本番シークレット（`DATABASE_URL` / `STRIPE_SECRET_KEY` /
  `MAIL_PASSWORD` / `CLOUDINARY_*`）。GitHub 履歴に `d430c00 Delete .env` があり、
  過去に push された形跡がある（→ キーのローテーションは本作業の対象外・別タスク）。

## ゴール

ローカルの現行ファイル一式を、散らかった非コードファイルと生成物を除いた「整理済み」
の状態にして、独立リポジトリとして `origin/main` へ force-push する。
**コード（`.py`）とテンプレート（`.html`）、`static/` は一切変更しない。**

## 非ゴール（別タスク）

- `.env` 履歴流出に伴うキーのローテーション
- `app.py`（54KB）の Blueprint 分割・モジュール再配置
- 画像（`static/img/` 9.8MB、`migrationmaps_uploads/` 4.9MB）の外部ストレージ移管
- ローカルフォルダ名 `areamap-main` の変更（GitHub リポジトリ名は `areamap` で不変）

## 変更内容

### A. 追加するファイル

1. **`.gitignore`**（新規、リポジトリ直下）
   - `__pycache__/`, `*.py[cod]`, `*.pyc`
   - `.pytest_cache/`
   - `.env`（`.env.example` は追跡する）
   - `.venv/`, `venv/`, `env/`
   - `migrationshop_uploads/`（`app.py` が実行時に `mkdir` する。誤コミット防止）
   - `.playwright-cli/`
   - `.vscode/`, `.idea/`, `.DS_Store`, `Thumbs.db`
   - `*.log`

2. **`README.md`**（新規）
   - プロジェクト概要（AreaMap / MigrationMap の 2 機能を持つ Flask アプリ）
   - 必要な環境変数一覧（`.env.example` と対応）
   - ローカル起動手順（`pip install -r requirements.txt` → `.env` 用意 →
     `flask --app app run` もしくは `gunicorn app:app`）
   - テスト実行（`pytest`）
   - Render デプロイの前提（`gunicorn`、`DATABASE_URL` 等の Environment 設定、
     `migrations/` の SQL 適用）
   - コード構成の 1 行説明（`app.py` 単一エントリ、`migrationmaps_*.py` が
     MigrationMap 用ロジック、`models.py` が SQLAlchemy モデル）

3. **`.env.example`**（既存を上書き・拡充）
   現状 3 キー（`OVERPASS_ENDPOINT` / `BASEMAP_TILE_URL` / `BASEMAP_USER_AGENT` /
   `BASEMAP_TILE_SLEEP_S`）のみ。`app.py` が `os.environ.get` で参照する全キーを
   値空（または安全なダミー）で列挙する:
   - `DATABASE_URL`（必須。未設定だと `app.py` が起動時に `ValueError`）
   - `SECRET_KEY`
   - `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_DEFAULT_SENDER_EMAIL`, `MAIL_ADMIN_TO`
   - `STRIPE_SECRET_KEY`
   - `ADMIN_EMAIL`
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`,
     `CLOUDINARY_URL`
   - `MIGRATIONMAPS_UPLOAD_DIR`, `MIGRATIONSHOP_UPLOAD_DIR`
   - `OVERPASS_ENDPOINT`, `BASEMAP_TILE_URL`, `BASEMAP_USER_AGENT`,
     `BASEMAP_TILE_SLEEP_S`
   - 実際に参照されるキー名は実装時に `app.py` / `migrationmaps_*.py` を
     `grep "os.environ"` で確定させる。

4. **`Procfile`**（新規）: `web: gunicorn app:app`
5. **`runtime.txt`**（新規）: ローカルの Python に合わせる（`__pycache__` の
   `cpython-312` より `python-3.12.x`）。実装時に正確なパッチバージョンは
   Render の対応版へ丸める。

### B. 移動するファイル（`git mv` 相当）

| 現在 | 移動先 |
|---|---|
| `migrationmap_implementation_prompt.md` | `docs/prompts/migrationmap_implementation_prompt.md` |
| `設計プロンプト.txt` | `docs/prompts/設計プロンプト.txt` |

どちらもコードから参照されていないことを確認済み。

### C. 削除するファイル（disk からも削除）

- `templates/migrationmaps/.playwright-cli/page-2026-07-20T06-01-26-900Z.yml`
- `templates/migrationmaps/.playwright-cli/page-2026-07-20T06-02-03-740Z.yml`
- （↑フォルダごと `templates/migrationmaps/.playwright-cli/` を削除）

`__pycache__/`, `.pytest_cache/`, `scripts/__pycache__/` は **disk はそのまま**、
`.gitignore` によりコミットしないだけ。

### D. 一切触らないもの

- 全 `.py`: `app.py`, `extensions.py`, `forms.py`, `models.py`,
  `migrationmaps_basemap.py`, `migrationmaps_geo.py`, `migrationmaps_osm.py`,
  `scripts/*.py`, `tests/*.py`
- 全テンプレート `templates/*.html`, `templates/migrationmaps/*.html`
  （`.playwright-cli/` を除く。すべて `app.py` のルートから参照されている）
- `static/`（`css/`, `img/`, `js/`, `migrationmaps/`）
- `migrationmaps_uploads/` の既存 5 ファイル（`.png` / `.PNG` / `.svg`）
- `migrations/*.sql`, `docs/AreaMap.md`, `docs/MigrationMap.md`,
  `docs/superpowers/plans/2026-09-02-migrationmap-osm-georef.md`
- `pytest.ini`, `requirements.txt`, `extensions.py`

## 整理後のディレクトリ構成

```
areamap-main/                       # ローカルのフォルダ名は変更しない
├── .gitignore                      # 新規
├── .env                            # disk に残す・追跡しない
├── .env.example                    # 拡充
├── README.md                       # 新規
├── Procfile                        # 新規
├── runtime.txt                     # 新規
├── app.py
├── extensions.py
├── forms.py
├── models.py
├── migrationmaps_basemap.py
├── migrationmaps_geo.py
├── migrationmaps_osm.py
├── pytest.ini
├── requirements.txt
├── docs/
│   ├── AreaMap.md
│   ├── MigrationMap.md
│   ├── prompts/                    # 新規（root から移動）
│   │   ├── migrationmap_implementation_prompt.md
│   │   └── 設計プロンプト.txt
│   └── superpowers/
│       ├── plans/2026-09-02-migrationmap-osm-georef.md
│       └── specs/2026-09-02-areamap-repo-cleanup-design.md   # 本ファイル
├── migrations/
│   ├── 001_mapproject_georef.sql
│   ├── 002_migrationshop_osm.sql
│   └── 003_buildingguide_fk_and_floor_pct.sql
├── scripts/
│   ├── backfill_building_guide_id.py
│   └── run_migration.py
├── static/
│   ├── css/            (5 files)
│   ├── img/            (25 files, ~9.8MB — 変更なし)
│   ├── js/             (3 files)
│   └── migrationmaps/  (admin.css, admin.js, public.js)
├── migrationmaps_uploads/          (既存 5 ファイルのみ・変更なし)
├── templates/
│   ├── areamap.html / areamap-lite.html / areamap-pro.html /
│   │   areamaplp.html / areamap-stores.html / areamap_thanks.html /
│   │   areamap_sbodymorita.html / mypage_sbodymorita.html /
│   │   ask.html / tilemap.html / recipe_agent.html
│   └── migrationmaps/  (admin.html, lp.html, public.html)   # .playwright-cli/ 削除
└── tests/
    ├── __init__.py
    ├── test_migrationmaps_geo.py
    ├── test_migrationmaps_osm.py
    └── test_resolve_affine.py
```

## GitHub 反映手順（force-push でクリーン置き換え）

前提: カレントは `c:\Users\mitsu\dev\areamap-main`。親 `C:\Users\mitsu` の
Git リポジトリには一切コマンドを打たない（`git -C` や `cd ..` を使わない）。

1. **変更 A〜C を先に適用**（`.gitignore` / `README.md` / `.env.example` /
   `Procfile` / `runtime.txt` 作成、`docs/prompts/` へ移動、`.playwright-cli/` 削除）。
2. `git init`（`areamap-main/.git` を新規作成。ネストした内側リポジトリになるが、
   親リポジトリはこのフォルダを追跡していないため影響なし）。
3. `git symbolic-ref HEAD refs/heads/main`（または `git branch -m main`）でブランチ名を `main` に。
4. `git add -A`。
5. **安全確認（ゲート）**: 次を実行し、いずれにも該当が無いことを目視で確認する。
   - `git ls-files | grep -E "(^|/)\.env$"` → 出力なし
   - `git ls-files | grep -E "__pycache__|\.pyc$|\.pytest_cache|\.playwright-cli"` → 出力なし
   - `git ls-files | grep -iE "secret|credential|service.?account|\.pem$|\.key$"` → 想定外の出力なし
   - `git ls-files` の総数と一覧をユーザーに提示して確認を取る。
6. 初回コミット:
   `git commit -m "chore: clean import of AreaMap/MigrationMap Flask app"`
   （Co-Authored-By 行を含める）
7. `git remote add origin https://github.com/mitsunaka007/areamap.git`
8. `git fetch origin`
9. **旧 main の退避（保険）**:
   `git push origin refs/remotes/origin/main:refs/heads/backup/old-main-20260902`
   （旧 `origin/main` の内容を `backup/old-main-20260902` ブランチとして GitHub に残す）
10. `git push --force origin main`
11. `git remote set-head origin -a` は不要。GitHub 上で `main` が更新されたことと、
    `backup/old-main-20260902` が存在することを確認して完了。

### 認証

push は HTTPS。Windows の git-credential-manager に既存の GitHub 認証が
キャッシュされていればそのまま通る。プロンプトが出た場合はユーザーが対応する
（トークン等をこちらから要求しない）。

## リスクと対策

| リスク | 対策 |
|---|---|
| `.env` など秘密情報の誤 push | 手順 5 の安全確認ゲートを必須化。`.gitignore` を `git add` 前に作成 |
| 旧 `origin/main` の内容消失 | 手順 9 で `backup/old-main-20260902` として GitHub に退避 |
| 親リポジトリの巻き込み | `areamap-main` 内でのみコマンド実行。親には触れない |
| 参照中ファイルの誤削除 | 削除対象は `.playwright-cli/` のみ（コード非参照を確認済み） |
| force-push 後に問題発覚 | ローカルの旧状態は親リポジトリと disk に残る。GitHub は退避ブランチから復元可 |

## 検証

- `git ls-files` に想定どおりのファイルのみが含まれる（`.env` / キャッシュ / 生成物なし）。
- `pytest` がローカルでこれまでどおり実行できる（コード未変更なので結果は現状維持）。
- `python -c "import app"` は `.env` 依存のため任意（`DATABASE_URL` 必須）。CI 化は非ゴール。
- GitHub 上で `main` が新コミットに置き換わり、`backup/old-main-20260902` が閲覧できる。
