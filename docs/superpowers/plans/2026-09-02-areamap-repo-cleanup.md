# AreaMap リポジトリ整理 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `areamap-main` の散らかった非コードファイルと生成物を除いた整理済みツリーを作り、独立 Git リポジトリとして `git@github.com:mitsunaka007/areamap.git` の `main` へ force-push する。

**Architecture:** コード（`.py`）・テンプレート（`.html`）・`static/` には一切触れない。追加するのは `.gitignore` / `README.md` / `Procfile` / `runtime.txt` と `.env.example` の拡充のみ。置きっぱなしのプロンプト 2 ファイルを `docs/prompts/` へ移動し、Playwright CLI の一時出力フォルダを削除する。`areamap-main` 内でのみ Git を操作し、親リポジトリ `C:\Users\mitsu` には一切コマンドを打たない。旧 `origin/main` は退避ブランチとして GitHub に残してから force-push する。

**Tech Stack:** Flask 3.1 / SQLAlchemy 2.0 / gunicorn / pytest 8.3 / Python 3.12.8 / Git（HTTPS remote）

**Baseline（作業前に確認済み）:**
- `python -m pytest -q` → 37 passed
- Python 3.12.8
- `areamap-main` に `.git` は無い。親 `C:\Users\mitsu` が Git リポジトリで `origin=areamap.git`。
- コードが参照する環境変数キー（`grep os.environ` で確定）:
  `DATABASE_URL`（未設定だと `app.py` が起動時 `ValueError`）, `SECRET_KEY`,
  `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_DEFAULT_SENDER_EMAIL`, `MAIL_ADMIN_TO`,
  `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`,
  `IP_HASH_SALT`, `MIGRATIONMAPS_UPLOAD_DIR`, `MIGRATIONSHOP_UPLOAD_DIR`,
  `OVERPASS_ENDPOINT`, `BASEMAP_TILE_URL`, `BASEMAP_USER_AGENT`, `BASEMAP_TILE_SLEEP_S`
- `.env` にあるがコード未参照: `STRIPE_SECRET_KEY`, `ADMIN_EMAIL`, `CLOUDINARY_URL`

---

## File Structure

| ファイル | 責務 | 操作 |
|---|---|---|
| `.gitignore` | 追跡除外（秘密情報・生成物・仮想環境・IDE） | 新規 |
| `.env.example` | 必要な環境変数の網羅リスト（値は空/ダミー） | 上書き |
| `README.md` | 概要・環境変数・起動・テスト・デプロイ手順 | 新規 |
| `Procfile` | Render/Heroku 形式の起動コマンド | 新規 |
| `runtime.txt` | Python バージョン固定 | 新規 |
| `docs/prompts/migrationmap_implementation_prompt.md` | 作業メモ（root から移動） | 移動 |
| `docs/prompts/設計プロンプト.txt` | 作業メモ（root から移動） | 移動 |
| `templates/migrationmaps/.playwright-cli/` | Playwright CLI 一時出力 | 削除 |

**触らないもの:** 全 `.py`、全 `templates/*.html`（`.playwright-cli/` 除く）、`static/`、`migrationmaps_uploads/` の既存 5 ファイル、`migrations/`、`scripts/`、`tests/`、`docs/*.md`、`docs/superpowers/plans/2026-09-02-migrationmap-osm-georef.md`、`pytest.ini`、`requirements.txt`。

---

## Task 1: `.gitignore` を作成

**Files:**
- Create: `c:\Users\mitsu\dev\areamap-main\.gitignore`

- [ ] **Step 1: ファイル作成**

内容（そのまま）:

```gitignore
# --- Python ---
__pycache__/
*.py[cod]
*.pyc
*.egg-info/
.eggs/
build/
dist/

# --- Virtualenv ---
.venv/
venv/
env/
ENV/

# --- Test / tooling caches ---
.pytest_cache/
.ruff_cache/
.mypy_cache/
.playwright-cli/
.coverage
htmlcov/

# --- Secrets / local config ---
.env
.env.*
!.env.example

# --- Runtime upload dirs (app.py が mkdir する。誤コミット防止) ---
/migrationshop_uploads/

# --- Editor / OS ---
.vscode/
.idea/
*.swp
.DS_Store
Thumbs.db

# --- Logs ---
*.log
```

- [ ] **Step 2: 検証**

Run: `cat .gitignore | head -5`
Expected: `# --- Python ---` で始まり `__pycache__/` が出力される

注: `migrationmaps_uploads/`（既存 5 枚を追跡し続ける）は **ignore しない**。
`migrationshop_uploads/`（別ディレクトリ・実行時生成のみ）だけ ignore する。

---

## Task 2: `.env.example` を拡充

**Files:**
- Modify（全置換）: `c:\Users\mitsu\dev\areamap-main\.env.example`

- [ ] **Step 1: 現行内容を確認**

Run: `cat .env.example`
Expected: `OVERPASS_ENDPOINT` / `BASEMAP_TILE_URL` / `BASEMAP_USER_AGENT` / `BASEMAP_TILE_SLEEP_S` の 4 項目のみ

- [ ] **Step 2: 全置換**

内容（そのまま）:

```dotenv
# ============================================================
# AreaMap / MigrationMap 環境変数サンプル
# 使い方: このファイルを .env にコピーして各値を設定する
#   cp .env.example .env
# .env は .gitignore で追跡除外されている。コミットしないこと。
# ============================================================

# --- 必須 ---
# PostgreSQL 接続 URL。未設定だと app.py が起動時に ValueError。
# 例: postgresql://user:pass@host:5432/dbname
DATABASE_URL=

# Flask セッション/CSRF 用シークレット。本番では必ずランダム値を設定。
SECRET_KEY=dev-secret-change-me

# --- メール（LP からの問い合わせ通知）---
MAIL_USERNAME=
MAIL_PASSWORD=
MAIL_DEFAULT_SENDER_EMAIL=mitsunaka007@gmail.com
MAIL_ADMIN_TO=mitsunaka007@gmail.com

# --- Cloudinary（画像アップロード。3 つ揃うと有効化）---
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=

# --- アクセスログの IP ハッシュ用ソルト ---
IP_HASH_SALT=change-me

# --- アップロード保存先（未設定ならプロジェクト直下の既定ディレクトリ）---
MIGRATIONMAPS_UPLOAD_DIR=migrationmaps_uploads
MIGRATIONSHOP_UPLOAD_DIR=migrationshop_uploads

# --- MigrationMap: OSM / Overpass ---
# 未設定なら overpass-api.de の公開インスタンスを使用
OVERPASS_ENDPOINT=

# --- MigrationMap: 方式A（サーバー側ベース地図生成）---
# {z}/{x}/{y} テンプレート。未設定なら方式Aは 503
BASEMAP_TILE_URL=
BASEMAP_USER_AGENT=MigrationMap/1.0 (+https://example.com; contact@example.com)
BASEMAP_TILE_SLEEP_S=0

# --- 現在コードから参照されていないが .env に存在していたキー（参考）---
# STRIPE_SECRET_KEY=
# ADMIN_EMAIL=
# CLOUDINARY_URL=
```

- [ ] **Step 3: 検証**

Run: `grep -c "=" .env.example`
Expected: 15 以上（コメントアウト行 `# STRIPE_SECRET_KEY=` 等も含む）

Run: `grep -E "^DATABASE_URL=$" .env.example`
Expected: `DATABASE_URL=`（値が空であること＝実値が入っていない）

---

## Task 3: `README.md` を作成

**Files:**
- Create: `c:\Users\mitsu\dev\areamap-main\README.md`

- [ ] **Step 1: ファイル作成**

内容（そのまま）:

```markdown
# AreaMap / MigrationMap

福井・岡山などの商店街向けエリアマップと、イラスト地図に OSM 店舗情報を重ねる
MigrationMap 機能を持つ Flask アプリケーション。

## 構成

| パス | 役割 |
|---|---|
| `app.py` | 単一エントリポイント。AreaMap・MigrationMap・問い合わせフォームの全ルート |
| `models.py` | SQLAlchemy モデル（Shop / MapProject / MapPoint / MigrationShop ほか） |
| `migrationmaps_geo.py` | アフィン変換・緯度経度⇔ピクセル変換 |
| `migrationmaps_osm.py` | Overpass API 経由の OSM 店舗取得 |
| `migrationmaps_basemap.py` | 方式A（サーバー側タイル合成）でのベース地図生成 |
| `forms.py` / `extensions.py` | WTForms 定義 / `db` インスタンス |
| `migrations/*.sql` | 手動適用の DB マイグレーション（`scripts/run_migration.py`） |
| `templates/` `static/` | Jinja2 テンプレートと静的アセット |
| `tests/` | pytest（`migrationmaps_geo` / `migrationmaps_osm` / affine 解決） |

## セットアップ

```bash
python -m venv .venv
.venv\Scripts\activate            # Windows
pip install -r requirements.txt
cp .env.example .env               # 各値を設定（最低 DATABASE_URL は必須）
```

## ローカル起動

```bash
# 開発用
flask --app app run --debug

# 本番相当
gunicorn app:app
```

`DATABASE_URL` が未設定だと起動時に `ValueError` になる。

## 環境変数

`.env.example` を参照。必須は `DATABASE_URL`。メール通知には `MAIL_*`、
画像を Cloudinary に載せる場合は `CLOUDINARY_*` 3 種、MigrationMap の方式A には
`BASEMAP_TILE_URL` が必要。

## DB マイグレーション

`migrations/` の SQL を番号順に適用する。

```bash
python scripts/run_migration.py migrations/001_mapproject_georef.sql
python scripts/run_migration.py migrations/002_migrationshop_osm.sql
python scripts/run_migration.py migrations/003_buildingguide_fk_and_floor_pct.sql
```

## テスト

```bash
python -m pytest -q
```

## デプロイ（Render）

- `Procfile` の `web: gunicorn app:app` を使用。
- Render の Environment に `.env.example` の各キーを設定。
- `runtime.txt` で Python バージョンを固定。
- `migrations/` の SQL は接続先 DB へ手動適用。

## ドキュメント

- `docs/AreaMap.md` — AreaMap 機能仕様
- `docs/MigrationMap.md` — MigrationMap 機能仕様
- `docs/prompts/` — 実装時の作業プロンプト（履歴用）
- `docs/superpowers/` — spec / plan
```

- [ ] **Step 2: 検証**

Run: `head -1 README.md`
Expected: `# AreaMap / MigrationMap`

---

## Task 4: `Procfile` と `runtime.txt` を作成

**Files:**
- Create: `c:\Users\mitsu\dev\areamap-main\Procfile`
- Create: `c:\Users\mitsu\dev\areamap-main\runtime.txt`

- [ ] **Step 1: `Procfile` 作成**

内容（改行のみ・1 行）:

```
web: gunicorn app:app
```

- [ ] **Step 2: `runtime.txt` 作成**

内容（1 行）:

```
python-3.12.8
```

- [ ] **Step 3: 検証**

Run: `cat Procfile && echo "---" && cat runtime.txt`
Expected:
```
web: gunicorn app:app
---
python-3.12.8
```

---

## Task 5: プロンプトファイルを `docs/prompts/` へ移動

**Files:**
- Create dir: `c:\Users\mitsu\dev\areamap-main\docs\prompts\`
- Move: `migrationmap_implementation_prompt.md` → `docs/prompts/migrationmap_implementation_prompt.md`
- Move: `設計プロンプト.txt` → `docs/prompts/設計プロンプト.txt`

- [ ] **Step 1: 参照が無いことを再確認**

Run: `grep -rn "migrationmap_implementation_prompt\|設計プロンプト" --include="*.py" --include="*.html" .`
Expected: 出力なし（コード・テンプレートから参照されていない）

- [ ] **Step 2: 移動**

Run（Git Bash / PowerShell いずれか。まだ Git 管理下でないので通常の mv）:
```bash
mkdir -p docs/prompts
mv migrationmap_implementation_prompt.md docs/prompts/
mv 設計プロンプト.txt docs/prompts/
```

- [ ] **Step 3: 検証**

Run: `ls docs/prompts/ && ls migrationmap_implementation_prompt.md 2>&1`
Expected: `docs/prompts/` に 2 ファイルが存在し、root の `migrationmap_implementation_prompt.md` は `No such file` になる

---

## Task 6: Playwright CLI 一時出力を削除

**Files:**
- Delete: `c:\Users\mitsu\dev\areamap-main\templates\migrationmaps\.playwright-cli\`（フォルダごと）

- [ ] **Step 1: 中身を確認**

Run: `ls -la templates/migrationmaps/.playwright-cli/`
Expected: `page-2026-07-20T06-01-26-900Z.yml` と `page-2026-07-20T06-02-03-740Z.yml` の 2 ファイル

- [ ] **Step 2: 削除**

Run: `rm -rf templates/migrationmaps/.playwright-cli`

- [ ] **Step 3: 検証**

Run: `ls templates/migrationmaps/`
Expected: `admin.html`, `lp.html`, `public.html` のみ（`.playwright-cli` は無い）

---

## Task 7: 整理後の作業ツリーを検証（コミット前）

- [ ] **Step 1: テストが従来どおり通ることを確認**

Run: `python -m pytest -q`
Expected: `37 passed`（コード未変更のため baseline と同一）

- [ ] **Step 2: 期待するファイル構成を目視**

Run: `find . -maxdepth 2 -type f -not -path './.git/*' -not -path '*/__pycache__/*' -not -path './.pytest_cache/*' | sort`
Expected（抜粋・順不同）:
- `./.gitignore` `./.env.example` `./README.md` `./Procfile` `./runtime.txt` が存在
- `./設計プロンプト.txt` `./migrationmap_implementation_prompt.md` は **存在しない**
- `./docs/prompts/migrationmap_implementation_prompt.md` `./docs/prompts/設計プロンプト.txt` が存在
- `./app.py` `./models.py` `./migrationmaps_geo.py` 等コードは全て残っている

---

## Task 8: Git リポジトリを初期化してコミット（安全ゲートあり）

**Files:**
- Create: `c:\Users\mitsu\dev\areamap-main\.git\`（`git init`）

> ⚠️ すべてのコマンドは `c:\Users\mitsu\dev\areamap-main` をカレントで実行する。
> `cd ..` / `git -C ..` / 親 `C:\Users\mitsu` に対する git 操作は **禁止**。

- [ ] **Step 1: init**

Run: `git init`
Expected: `Initialized empty Git repository in .../areamap-main/.git/`

- [ ] **Step 2: ブランチ名を main に**

Run: `git symbolic-ref HEAD refs/heads/main`
Expected: 出力なし（成功）

- [ ] **Step 3: ローカル identity を確認（無ければ設定）**

Run: `git config user.name && git config user.email`
Expected: 何か表示される。空なら:
```bash
git config user.name "Mitsugu Nakagawa"
git config user.email "mitsunaka007@gmail.com"
```

- [ ] **Step 4: 全ファイルをステージ**

Run: `git add -A`
Expected: 出力なし

- [ ] **Step 5: 🚨 安全ゲート — 秘密情報・生成物が含まれないことを確認**

Run:
```bash
git ls-files | grep -E "(^|/)\.env$" || echo "OK: no .env"
git ls-files | grep -E "__pycache__|\.pyc$|\.pytest_cache|\.playwright-cli" || echo "OK: no caches"
git ls-files | grep -iE "secret|credential|service.?account|\.pem$|\.key$|id_rsa" || echo "OK: no key-like files"
```
Expected: 3 行とも `OK: ...` が出る（`grep` がヒット 0 件）。
**いずれかにファイル名が出たら即中断し、`.gitignore` を修正して `git rm --cached` してからやり直す。**

- [ ] **Step 6: 追跡ファイル一覧をユーザーに提示**

Run: `git ls-files | wc -l && echo "---" && git ls-files`
Expected: 想定（コード + テンプレート + static + docs + migrations + scripts + tests +
新規 5 ファイル）。`.env` が無いこと、`migrationmaps_uploads/` の 5 枚が含まれることを確認。
**この一覧をユーザーに見せて明示的な承認を得てから次へ進む。**

- [ ] **Step 7: 初回コミット**

Run:
```bash
git commit -m "$(cat <<'EOF'
chore: clean import of AreaMap/MigrationMap Flask app

Fresh single-commit history for the standalone areamap repository:
- add .gitignore, README.md, Procfile, runtime.txt
- expand .env.example to cover every env var referenced by the code
- move stray implementation prompts under docs/prompts/
- drop templates/migrationmaps/.playwright-cli/ tooling output

No application code, templates, or static assets changed.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
Expected: `[main (root-commit) <sha>] chore: clean import of AreaMap/MigrationMap Flask app` と変更ファイル数

- [ ] **Step 8: 検証**

Run: `git log --oneline && git status`
Expected: コミット 1 件、`working tree clean`

---

## Task 9: リモートへ反映（旧 main 退避 → force-push）

> ⚠️ `git push` は `origin`（areamap.git）に対してのみ。`patientform-github` へは push しない。

- [ ] **Step 1: remote 追加**

Run: `git remote add origin https://github.com/mitsunaka007/areamap.git`
Expected: 出力なし

Run: `git remote -v`
Expected: `origin  https://github.com/mitsunaka007/areamap.git (fetch/push)` の 2 行のみ

- [ ] **Step 2: 現在のリモート状態を取得**

Run: `git fetch origin`
Expected: `origin/main` などのブランチが取得される（認証プロンプトが出たらユーザー対応）

- [ ] **Step 3: 旧 origin/main を退避ブランチとして push（保険）**

Run: `git push origin refs/remotes/origin/main:refs/heads/backup/old-main-20260902`
Expected: `* [new branch]      origin/main -> backup/old-main-20260902`

Run: `git ls-remote --heads origin backup/old-main-20260902`
Expected: 1 行（sha + `refs/heads/backup/old-main-20260902`）が返る＝退避成功

- [ ] **Step 4: main を force-push でクリーン置き換え**

Run: `git push --force origin main`
Expected: `+ <old>...<new> main -> main (forced update)`

- [ ] **Step 5: 最終検証**

Run: `git ls-remote --heads origin`
Expected: `refs/heads/main`（新 sha）と `refs/heads/backup/old-main-20260902` が両方存在

Run: `git log --oneline origin/main -1`（`git fetch origin` 後）
Expected: `chore: clean import of AreaMap/MigrationMap Flask app`

- [ ] **Step 6: ユーザーへ完了報告**

- GitHub `main` が新コミット 1 件に置き換わったこと
- `backup/old-main-20260902` に旧内容が退避されていること（不要になったら
  `git push origin --delete backup/old-main-20260902` で削除可）
- 別タスクとして残っている項目: `.env` の履歴流出に伴うキーローテーション、
  `app.py` の分割、画像の外部ストレージ移管

---

## Self-Review

**1. Spec coverage:**
- spec「A. 追加ファイル」→ Task 1（.gitignore）, 2（.env.example）, 3（README）, 4（Procfile/runtime.txt）✅
- spec「B. 移動」→ Task 5 ✅
- spec「C. 削除」→ Task 6（.playwright-cli）、`__pycache__` 等は Task 1 の .gitignore で除外 ✅
- spec「D. 触らない」→ 全タスクでコード/テンプレ/static を編集しない。Task 7 Step 1 で pytest 37 passed を確認 ✅
- spec「GitHub 反映手順 1–11」→ Task 8（init〜commit）, Task 9（remote〜force-push、退避ブランチ含む）✅
- spec「安全確認ゲート」→ Task 8 Step 5–6 ✅
- spec「リスクと対策」→ 退避ブランチ（Task 9 Step 3）、安全ゲート（Task 8 Step 5）、親リポ不介入（Task 8/9 冒頭の警告）✅
- spec「検証」→ Task 7（pytest・ツリー）, Task 9 Step 5（リモート）✅

**2. Placeholder scan:** TBD/TODO/「適切に処理」等なし。全ファイル内容を実体で記載。`runtime.txt` は `python-3.12.8` に確定済み。

**3. Type consistency:** 退避ブランチ名は全箇所 `backup/old-main-20260902`。remote 名は全箇所 `origin`。ブランチ名は全箇所 `main`。整合。
