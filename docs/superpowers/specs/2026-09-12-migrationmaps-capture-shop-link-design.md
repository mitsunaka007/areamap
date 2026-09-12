# MigrationMaps: Link "イラスト待ちの枠" rows to OSM import / shop registration

## Problem

The capture-first flow (`POST /api/migrationmaps/capture/create`) already lets an
operator save a draft `MapProject` to the DB using only a center point + zoom +
output size — no manual correspondence points required. This satisfies "save to
DB without point registration" at the backend level: a draft row already has a
valid affine (`a..f`) and therefore a valid bbox, so `GET/POST /<id>/osm/search`,
`POST /<id>/osm/import`, and `POST /api/migrationmaps/shop/register` all already
work correctly against a draft project (confirmed in
`docs/superpowers/plans/2026-09-11-migrationmaps-capture-first-georef.md`,
Design Decision 5).

What's missing is UI wiring: the admin page's "イラスト待ちの枠" list
(`capturesListV2`, fed by `GET /api/migrationmaps/captures`) only offers
"PNGを再ダウンロード" and (for drafts) "イラストをアップロード" per row. There is
no way to point the "🗺 このエリアの店舗をOSMから取得" panel or the "☰ 店舗を登録・
編集する" panel at one of these projects — both panels operate on a JS-global
`currentProjectId`, which is only set by the classic manual-georeferencing save
flow (`btnSave`, which requires ≥3 correspondence points or a confirmed capture
frame) or by clicking a row in the classic "保存済みセット" list (which
excludes drafts by design). The shop-registration form's `map_project_id` field
is manual free-text entry with no autofill.

Net effect: an operator who uses the (already working) capture-first, zero-point
save flow has no path in the UI to immediately follow up with an OSM shop fetch
or manual shop registration against that same project.

## Goal

From each row in the "イラスト待ちの枠" list (both `draft` and `ready` status),
let the operator designate that project as the current target for the OSM
import panel and/or the shop registration panel, without needing to know or
type its numeric ID, and without requiring the classic manual-georeferencing
save flow.

## Non-goals

- No backend/API changes. All target endpoints already function correctly on
  draft projects.
- No change to the classic `btnSave` point-count requirement (≥3 points or a
  confirmed capture frame) — capture-first is the already-correct answer to
  "save without manual points," this work just connects it to the shop tools.
- Not fixing the pre-existing dead `resetShopForm` reference or the fact that
  clicking a row in "登録済み店舗一覧" doesn't load that shop into the edit
  form. Real, but a separate, pre-existing gap unrelated to this request.

## Design

### 1. Shared target indicator

Add one small status line in the left sidebar, positioned above both the OSM
import panel and the shop registration panel (both currently keyed off the same
`currentProjectId`):

```html
<div id="shopTargetIndicatorV2" class="muted">対象の地図: 未選択</div>
```

A helper `updateShopTargetIndicator()` renders it as:

- `対象の地図: 未選択` when `currentProjectId` is null.
- `対象の地図: {basemap_name || name} (#{id}・{イラスト待ち|紐づけ済み})` once a
  project has been selected (via either this new flow or the pre-existing
  "保存済みセット" / classic save flow, so the indicator stays accurate no
  matter which path set `currentProjectId`).

### 2. Row actions in `capturesListV2`

Extend the row template in `refreshCapturesV2()` (`admin.js`) to add two
buttons alongside the existing "PNGを再ダウンロード" (kept for both statuses)
and the existing draft-only upload input / ready-only public-page link:

- `🗺 OSMから取得` (`class="btnSelectForOsmV2"`, `data-id`, `data-lat`,
  `data-lng`, `data-zoom` sourced from the row's `center`/`zoom` fields already
  present in the `/captures` payload).
- `☰ 店舗を登録・編集` (`class="btnSelectForShopV2"`, `data-id`).

Both buttons render for every row regardless of `draft`/`ready` status.

### 3. Click handling

Extend the existing delegated click listener on `#capturesListV2`
(`admin.js:1499`) with two more branches:

- `.btnSelectForOsmV2`: set `currentProjectId = id`; call
  `updateShopTargetIndicator()`; open the OSM import panel (factor the toggle
  body/aria-expanded/icon logic at `admin.js:1291-1296` into a small
  `setOsmMenuOpen(open)` helper, mirroring the existing `setShopMenuOpen`, and
  call `setOsmMenuOpen(true)`); if `data-lat`/`data-lng`/`data-zoom` are
  present, `map.setView([lat, lng], zoom)` so the operator can see the search
  area before pressing "取得".
- `.btnSelectForShopV2`: set `currentProjectId = id`; call
  `updateShopTargetIndicator()`; call `setShopMenuOpen(true)`; set
  `$("r_map_project_id").value = id`; call `refreshShopList()`.

### 4. Keep the capture-list shop counts fresh

After a successful OSM import (`btnOsmImport` success branch) and after a
successful shop registration (the inline handler in `admin.html`), call
`refreshCapturesV2()` (guarded with `typeof refreshCapturesV2 === "function"`,
matching the existing cross-file call convention already used for
`refreshShopList`) so the "店舗n件" count on the capture-list rows reflects the
change without a manual "更新" click.

## Files touched

- `templates/migrationmaps/admin.html`: add the indicator element; no other
  markup changes (buttons are generated client-side in `admin.js`).
- `static/migrationmaps/admin.js`: `refreshCapturesV2()` row template, the
  `#capturesListV2` click listener, new `setOsmMenuOpen`/
  `updateShopTargetIndicator` helpers, and the `btnOsmImport` success branch.
- Small addition to the inline script in `admin.html` (shop-register success
  branch) to call `refreshCapturesV2()`.

## Testing

No pytest coverage exists for admin JS (repo convention — routes/UI are
verified manually, per the capture-first plan's Investigation Summary point
4). Manual verification:

1. Create a draft via "① 中心をクリックで選択" → "② 枠を確定してPNGを書き出す"
   (or use an existing draft from a prior session).
2. In "イラスト待ちの枠", click `🗺 OSMから取得` on that draft row. Confirm the
   indicator updates, the OSM panel expands, the right-side map recenters, and
   pressing "取得" returns candidates (network permitting — Overpass is
   unreachable from this sandbox per the prior plan's manual-test notes, so
   this step may need to run against a real dev environment).
3. Click `☰ 店舗を登録・編集` on the same row. Confirm the indicator updates,
   the shop panel expands, and "イラスト地図ID" is pre-filled with that
   project's ID. Submit a shop registration and confirm it succeeds and the
   capture row's "店舗n件" count increments after the panel's own list
   refreshes.
4. Repeat both actions against a `ready`-status row to confirm they work
   identically post-illustration-upload.
5. Confirm the classic flow (manual points, `btnSave`) is unaffected: saving,
   loading from "保存済みセット", and OSM/shop actions there still work as
   before, and the new indicator reflects `currentProjectId` correctly in that
   path too.
