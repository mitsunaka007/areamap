# MigrationMaps: イラスト待ち枠(draft)の削除機能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/migrationmaps/admin` の「イラスト待ちの枠」パネルで、`draft`（イラスト未アップロード）状態のキャプチャ枠を削除できるようにする。

**Architecture:** バックエンドに `DELETE /api/migrationmaps/<int:project_id>` を追加し、`status == "draft"` の場合のみ削除を許可する。フロントエンドは `capturesListV2` の各draft行に削除ボタンを追加し、確認ダイアログ→DELETE呼び出し→一覧再描画を行う。

**Tech Stack:** Flask (`app.py`), SQLAlchemy (`models.py`), vanilla JS (`static/migrationmaps/admin.js`), Jinja/HTML (`templates/migrationmaps/admin.html` — 変更なし、既存要素を流用)。

**設計書:** `docs/superpowers/specs/2026-09-13-migrationmaps-capture-delete-draft-design.md`

**テストについて:** このリポジトリの `tests/` には Flask の test client / DB接続を伴うルートテストが存在せず（`test_migrationmaps_osm.py` 等はいずれも純粋関数のテストのみ）、`DATABASE_URL` の実DB接続が前提の `app.py` に対する自動テストハーネスも無い。本計画はこの既存方針を踏襲し、バックエンドはインポート可否の静的確認、機能全体は手動確認（Task 4）で検証する。新規テストハーネスの構築は本タスクのスコープ外。

---

### Task 1: バックエンドに削除エンドポイントを追加する

**Files:**
- Modify: `app.py:1147` 付近（`api_migrationmaps_captures` 関数の直後、`api_migrationmaps_illustration` の直前）

- [ ] **Step 1: `DELETE /api/migrationmaps/<int:project_id>` を追加する**

[app.py:1113-1149](../../../app.py#L1113-L1149) の `api_migrationmaps_captures` 関数は下記のように終わっている:

```python
    return jsonify({
        "captures": [
            {
                "project_id": p.id,
                "basemap_name": p.basemap_name,
                "name": p.name,
                "status": p.status,
                "zoom": p.capture_zoom,
                "width": p.capture_width,
                "height": p.capture_height,
                "center": {"lat": p.capture_center_lat, "lng": p.capture_center_lng},
                "captured_at": p.captured_at.isoformat() if p.captured_at else None,
                "shop_count": shop_counts.get(p.id, 0),
            }
            for p in rows
        ]
    })

@app.post("/api/migrationmaps/<int:project_id>/illustration")
```

この2つの間（`})` の次の空行の後）に、以下を挿入する:

```python
@app.delete("/api/migrationmaps/<int:project_id>")
def api_migrationmaps_delete_capture(project_id: int):
    proj = MapProject.query.get(project_id)
    if not proj:
        abort(404)
    if proj.status != "draft":
        return jsonify({"error": "イラスト待ち(draft)の枠のみ削除できます"}), 400

    try:
        db.session.delete(proj)
        db.session.commit()
    except Exception as ex:
        db.session.rollback()
        return jsonify({"error": "DB削除に失敗しました", "detail": str(ex)}), 500

    return jsonify({"deleted": True, "project_id": project_id})

```

編集後、該当箇所は次の順序になる: `api_migrationmaps_captures` → （空行）→ `api_migrationmaps_delete_capture`（新規）→ （空行）→ `api_migrationmaps_illustration`。

補足:
- `MapProject.points` は `cascade="all, delete-orphan"`（[models.py:259](../../../models.py#L259)）なので `db.session.delete(proj)` だけで紐づく `MapPoint` も削除される。追加コード不要。
- `MigrationShop.map_project_id` の FK は `ondelete="SET NULL"`（[models.py:318-322](../../../models.py#L318-L322)）なので、紐づく店舗があってもレコードは残り `map_project_id` が `NULL` になるだけ。追加コード不要。

- [ ] **Step 2: 構文・インポート確認**

Run: `python -c "import os; os.environ.setdefault('DATABASE_URL','postgresql://u:p@localhost/none'); import app; print('ok')"`
Expected: `ok`（`DATABASE_URL` はダミーで良い。DB接続は起動時に発生しないため、モジュールのインポート＝構文チェックとして機能する）

- [ ] **Step 3: コミット**

```bash
git add app.py
git commit -m "feat(migrationmaps): add DELETE endpoint for draft capture rows"
```

---

### Task 2: 削除ボタンをキャプチャ一覧の描画に追加する

**Files:**
- Modify: `static/migrationmaps/admin.js:1501-1516`（`refreshCapturesV2` 内の行テンプレート）

- [ ] **Step 1: draft行にのみ削除ボタンを追加する**

[static/migrationmaps/admin.js:1501-1516](../../../static/migrationmaps/admin.js#L1501-L1516) の現在のコード:

```javascript
      div.innerHTML = `
        <strong>${escapeHtmlLocal(cap.basemap_name)}</strong> <span class="muted">(${escapeHtmlLocal(cap.name)})</span>
        <div class="muted">${statusLabel} ・ z${cap.zoom} ・ ${cap.width}×${cap.height} ・ 店舗${cap.shop_count}件</div>
        <div class="project-actions">
          <button class="small-btn btnRedownloadV2" data-id="${cap.project_id}" data-name="${escapeHtmlLocal(cap.basemap_name)}">PNGを再ダウンロード</button>
          <button class="small-btn btnSelectForOsmV2" data-id="${cap.project_id}" data-label="${escapeHtmlLocal(targetLabel)}" data-lat="${cap.center?.lat ?? ""}" data-lng="${cap.center?.lng ?? ""}" data-zoom="${cap.zoom ?? ""}">🗺 OSMから取得</button>
          <button class="small-btn btnSelectForShopV2" data-id="${cap.project_id}" data-label="${escapeHtmlLocal(targetLabel)}">☰ 店舗を登録・編集</button>
          ${cap.status === "draft" ? `
            <label class="small-btn" style="display:inline-block;">
              イラストをアップロード
              <input type="file" accept="image/*" class="illustrationInputV2" data-id="${cap.project_id}" style="display:none;" />
            </label>
          ` : `<a class="small-btn" href="/migrationmaps/m/${cap.project_id}" target="_blank">公開ページ</a>`}
        </div>
        <div class="muted illustrationErrorV2" data-id="${cap.project_id}" style="color:#b02a37;"></div>
      `;
```

これを次のように変更する（`draft` 分岐に削除ボタンを1行追加するのみ。`ready` 分岐は変更しない）:

```javascript
      div.innerHTML = `
        <strong>${escapeHtmlLocal(cap.basemap_name)}</strong> <span class="muted">(${escapeHtmlLocal(cap.name)})</span>
        <div class="muted">${statusLabel} ・ z${cap.zoom} ・ ${cap.width}×${cap.height} ・ 店舗${cap.shop_count}件</div>
        <div class="project-actions">
          <button class="small-btn btnRedownloadV2" data-id="${cap.project_id}" data-name="${escapeHtmlLocal(cap.basemap_name)}">PNGを再ダウンロード</button>
          <button class="small-btn btnSelectForOsmV2" data-id="${cap.project_id}" data-label="${escapeHtmlLocal(targetLabel)}" data-lat="${cap.center?.lat ?? ""}" data-lng="${cap.center?.lng ?? ""}" data-zoom="${cap.zoom ?? ""}">🗺 OSMから取得</button>
          <button class="small-btn btnSelectForShopV2" data-id="${cap.project_id}" data-label="${escapeHtmlLocal(targetLabel)}">☰ 店舗を登録・編集</button>
          ${cap.status === "draft" ? `
            <label class="small-btn" style="display:inline-block;">
              イラストをアップロード
              <input type="file" accept="image/*" class="illustrationInputV2" data-id="${cap.project_id}" style="display:none;" />
            </label>
            <button class="small-btn btnDeleteCaptureV2" data-id="${cap.project_id}" data-name="${escapeHtmlLocal(cap.basemap_name)}" data-shopcount="${cap.shop_count}" style="color:#b02a37;">🗑 削除</button>
          ` : `<a class="small-btn" href="/migrationmaps/m/${cap.project_id}" target="_blank">公開ページ</a>`}
        </div>
        <div class="muted illustrationErrorV2" data-id="${cap.project_id}" style="color:#b02a37;"></div>
      `;
```

- [ ] **Step 2: ブラウザで見た目を確認する**

ローカルでアプリを起動し（`DATABASE_URL` を実際の開発用Postgresに設定 — 詳細はTask 4参照）、`/migrationmaps/admin` を開いて「イラスト待ちの枠」パネルを見る。draft行にだけ赤字の「🗑 削除」ボタンが表示され、ready（🟢紐づけ済み）行には表示されないことを目視確認する。この時点ではボタンを押しても何も起きない（Task 3で実装）。

- [ ] **Step 3: コミット**

```bash
git add static/migrationmaps/admin.js
git commit -m "feat(migrationmaps): render delete button on draft capture rows"
```

---

### Task 3: 削除ボタンのクリックハンドラを実装する

**Files:**
- Modify: `static/migrationmaps/admin.js:1540-1550`（`capturesListV2` の `click` イベントリスナー内）

- [ ] **Step 1: `btnSelectForShopV2` 処理の直後、`btnRedownloadV2` 処理の直前に削除ハンドラを追加する**

[static/migrationmaps/admin.js:1540-1552](../../../static/migrationmaps/admin.js#L1540-L1552) の現在のコード:

```javascript
  const shopBtn = ev.target.closest(".btnSelectForShopV2");
  if (shopBtn) {
    currentProjectId = shopBtn.dataset.id;
    updateShopTargetIndicator(shopBtn.dataset.label);
    setShopMenuOpen(true);
    if ($("r_map_project_id")) $("r_map_project_id").value = shopBtn.dataset.id;
    if (typeof refreshShopList === "function") await refreshShopList();
    log(`[CAPTURES] project_id=${shopBtn.dataset.id} を店舗登録の対象に選択`);
    return;
  }

  const btn = ev.target.closest(".btnRedownloadV2");
  if (!btn) return;
```

これを次のように変更する（`shopBtn` ブロックと `btnRedownloadV2` ブロックの間に新しい分岐を挿入する。既存2ブロックの中身は変更しない）:

```javascript
  const shopBtn = ev.target.closest(".btnSelectForShopV2");
  if (shopBtn) {
    currentProjectId = shopBtn.dataset.id;
    updateShopTargetIndicator(shopBtn.dataset.label);
    setShopMenuOpen(true);
    if ($("r_map_project_id")) $("r_map_project_id").value = shopBtn.dataset.id;
    if (typeof refreshShopList === "function") await refreshShopList();
    log(`[CAPTURES] project_id=${shopBtn.dataset.id} を店舗登録の対象に選択`);
    return;
  }

  const deleteBtn = ev.target.closest(".btnDeleteCaptureV2");
  if (deleteBtn) {
    const id = deleteBtn.dataset.id;
    const name = deleteBtn.dataset.name || `#${id}`;
    const shopCount = parseInt(deleteBtn.dataset.shopcount, 10) || 0;
    const msg = shopCount > 0
      ? `「${name}」を削除します。店舗${shopCount}件の紐づけが解除されます（店舗自体は削除されません）。よろしいですか？`
      : `「${name}」を削除します。よろしいですか？`;
    if (!confirm(msg)) return;
    const errEl = document.querySelector(`.illustrationErrorV2[data-id="${id}"]`);
    try {
      const res = await fetch(`/api/migrationmaps/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        if (errEl) errEl.textContent = data.error || `削除に失敗しました (${res.status})`;
        return;
      }
      if (String(currentProjectId) === String(id)) {
        currentProjectId = null;
        updateShopTargetIndicator();
      }
      log(`[CAPTURES] project_id=${id} を削除しました`);
      await refreshCapturesV2();
    } catch (err) {
      if (errEl) errEl.textContent = `通信エラー: ${err.message}`;
    }
    return;
  }

  const btn = ev.target.closest(".btnRedownloadV2");
  if (!btn) return;
```

- [ ] **Step 2: コミット**

```bash
git add static/migrationmaps/admin.js
git commit -m "feat(migrationmaps): wire up delete button to DELETE endpoint"
```

---

### Task 4: 手動での動作確認

**Files:** なし（動作確認のみ）

- [ ] **Step 1: ローカルで起動する**

```bash
DATABASE_URL="postgresql://<開発用DB接続文字列>" python app.py
```

`/migrationmaps/admin` をブラウザで開く。

- [ ] **Step 2: シナリオ1 — 店舗未紐づけのdraft枠を削除する**

1. 管理画面で新規に枠(capture)を作成し、イラストはアップロードしない（`draft` 状態のまま）。
2. 「イラスト待ちの枠」パネルでその行の「🗑 削除」を押す。
3. 確認ダイアログに「店舗」の文言が含まれない（店舗0件のメッセージ）ことを確認し、OKを押す。
4. 一覧からその行が消えることを確認する。

Expected: 削除後、一覧に該当枠が表示されない。

- [ ] **Step 3: シナリオ2 — 店舗が紐づいたdraft枠を削除する**

1. 別のdraft枠を作成し、「☰ 店舗を登録・編集」または「🗺 OSMから取得」経由で店舗を1件以上紐づける。
2. 一覧の「店舗N件」表示がN≥1になっていることを確認する。
3. 「🗑 削除」を押し、確認ダイアログに「店舗N件の紐づけが解除されます（店舗自体は削除されません）」という文言が出ることを確認する。
4. OKを押し、一覧から消えることを確認する。
5. `curl http://localhost:5000/api/migrationmaps/shops`（または管理画面の店舗一覧）で、その店舗が削除されずに残っており、`map_project_id` が `NULL`（未割当）になっていることを確認する。

Expected: 店舗レコードは残る。枠だけが消える。

- [ ] **Step 4: シナリオ3 — readyな枠には削除ボタンが出ないことを確認する**

1. イラストを紐づけ済み（🟢紐づけ済み）の枠を一覧で確認する。
2. その行に「🗑 削除」ボタンが表示されていないことを確認する。

Expected: readyな行には削除ボタンなし。

- [ ] **Step 5: シナリオ4 — 削除対象が選択中対象だった場合に選択表示がクリアされることを確認する**

1. draft枠の「🗺 OSMから取得」または「☰ 店舗を登録・編集」を押し、その枠を対象として選択する（画面上部に「対象の地図: ...」の表示が出る）。
2. 選択したままその枠の「🗑 削除」を押して削除する。
3. 「対象の地図」表示が未選択状態に戻ることを確認する。

Expected: 削除後、対象選択インジケータがクリアされる。

- [ ] **Step 6: バックエンドの直接確認（任意）**

```bash
curl -i -X DELETE http://localhost:5000/api/migrationmaps/<readyな枠のproject_id>
```

Expected: HTTP 400 と `{"error": "イラスト待ち(draft)の枠のみ削除できます"}`

```bash
curl -i -X DELETE http://localhost:5000/api/migrationmaps/999999
```

Expected: HTTP 404

---

## Self-Review Notes

- **Spec coverage:** DELETE エンドポイント(draft限定/400/404/500) → Task 1。削除ボタンの表示条件(draftのみ) → Task 2。確認ダイアログ(店舗件数分岐)・fetch・エラー表示・対象選択クリア・一覧再描画 → Task 3。設計書の手動テスト4シナリオ → Task 4 Step 2-5 でそれぞれ対応。バックエンドのエラーケース(400/404) → Task 4 Step 6。ギャップなし。
- **Placeholder scan:** 各コードブロックは実際の差し替え前後の完全なコードを記載済み。「TODO」等のプレースホルダーなし。
- **Type consistency:** `currentProjectId` と `deleteBtn.dataset.id` は文字列/数値が混在しうるため `String(...) === String(...)` で比較（既存コードの `currentProjectId = shopBtn.dataset.id`（文字列代入）という扱いに合わせた）。`updateShopTargetIndicator()` の呼び出し方は既存の `resetToNew()`（admin.js:1118-1120）と同一パターン。
