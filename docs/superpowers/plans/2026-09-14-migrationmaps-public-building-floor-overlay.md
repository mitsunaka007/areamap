# MigrationMaps Public Building Floor Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the MigrationMaps public page (`static/migrationmaps/public.js` /
`templates/migrationmaps/public.html`), when the default building image is
shown for co-located shops (no custom `BuildingGuide` photo), replace the
auto-left-edge floor hotspots with fixed image-height-band click zones for
`1F`/`2F`/`3F` (others still fall back to left-edge stacking), stop
auto-showing the first floor's shop grid on open, and show the tapped
floor's shops as a card grid overlaid on top of the building image with its
own independent close button.

**Architecture:** `showBuildingGuide()`'s single `if (buildingImageUrl)`
branch is split into two dedicated render functions —
`renderCustomGuidePhoto()` (today's `BuildingGuide`-photo behavior, extracted
verbatim, unchanged) and a new `renderDefaultBuildingPhoto()` (fixed-band
hotspots + an absolutely-positioned overlay grid with its own "×"). A new
pure function `getDefaultBuildingFloorLayout()` computes the fixed/fallback
hotspot positions. No backend, no DB, no admin-page changes.

**Tech Stack:** Vanilla JS (no framework, no bundler) in
`static/migrationmaps/public.js`, Jinja2 template
`templates/migrationmaps/public.html`, Leaflet 1.9.4.

**Reference:** Design spec at
`docs/superpowers/specs/2026-09-14-migrationmaps-public-building-floor-overlay-design.md`.

---

### Task 1: Extract `renderCustomGuidePhoto()` (behavior-preserving refactor)

**Files:**
- Modify: `static/migrationmaps/public.js:479-537` (`showBuildingGuide` and
  the `buildingGuideCloseEl` listener right after it)

- [ ] **Step 1: Confirm the anchor text**

Open `static/migrationmaps/public.js` and confirm lines 479-537 read exactly:

```js
function showBuildingGuide(groupShops, groupKey) {
  const guide = groupShops[0]?.building_guide || null;
  buildingPhotoWrapEl.innerHTML = "";
  floorShopGridEl.innerHTML = "";

  // 同一緯度経度に複数店舗（テナントビル）で BuildingGuide 画像が無い場合は、
  // 既定のビル画像でフロアホットスポット表示に切り替える。
  const isMultiTenant = Array.isArray(groupShops) && groupShops.length > 1;
  const buildingImageUrl = (guide && guide.image_url)
    ? guide.image_url
    : (isMultiTenant ? DEFAULT_BUILDING_IMAGE_URL : null);

  if (buildingImageUrl) {
    const imgEl = document.createElement("img");
    imgEl.src = buildingImageUrl;
    imgEl.className = "building-photo";
    imgEl.alt = escapeHtml(guide?.building_name || "building");
    buildingPhotoWrapEl.appendChild(imgEl);

    const floors = getFloorDisplayOrder(groupShops, guide);
    floors.forEach((floor, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "floor-hotspot" + (idx === 0 ? " is-active" : "");
      btn.dataset.floor = floor.floorlevel;
      btn.style.cssText = buildHotspotStyle(floor);
      btn.textContent = floor.floorlevel;
      btn.addEventListener("click", () => {
        buildingPhotoWrapEl.querySelectorAll(".floor-hotspot").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        floorShopGridEl.innerHTML = buildFloorGridSection(groupShops, floor.floorlevel);
      });
      buildingPhotoWrapEl.appendChild(btn);
    });
    const firstFloor = floors[0]?.floorlevel || groupShops[0]?.floorlevel || "";
    floorShopGridEl.innerHTML = buildFloorGridSection(groupShops, firstFloor);
  } else {
    const shop = groupShops[0];
    floorShopGridEl.innerHTML = `
      <div class="floor-shop-list">
        <section class="floor-shop-card">
          ${buildShopSummary(shop)}
          ${buildImageGrid(shop)}
        </section>
      </div>
    `;
  }

  autoShownGroupKey = groupKey;
  userClosedGuide = false;
  buildingGuideEl.hidden = false;

  // シートに表示中のグループを覚えて目的地ボタンを同期
  guideGroupKey = groupKey;
  guideGroupShops = groupShops;
  syncDestinationButton();
}

buildingGuideCloseEl.addEventListener("click", hideBuildingGuide);
```

If the surrounding code differs, use this block as the anchor to find the
right spot rather than trusting line numbers.

- [ ] **Step 2: Replace it with the extracted, behavior-identical version**

Replace the whole block above with:

```js
function renderCustomGuidePhoto(groupShops, guide) {
  const imgEl = document.createElement("img");
  imgEl.src = guide.image_url;
  imgEl.className = "building-photo";
  imgEl.alt = escapeHtml(guide?.building_name || "building");
  buildingPhotoWrapEl.appendChild(imgEl);

  const floors = getFloorDisplayOrder(groupShops, guide);
  floors.forEach((floor, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "floor-hotspot" + (idx === 0 ? " is-active" : "");
    btn.dataset.floor = floor.floorlevel;
    btn.style.cssText = buildHotspotStyle(floor);
    btn.textContent = floor.floorlevel;
    btn.addEventListener("click", () => {
      buildingPhotoWrapEl.querySelectorAll(".floor-hotspot").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      floorShopGridEl.innerHTML = buildFloorGridSection(groupShops, floor.floorlevel);
    });
    buildingPhotoWrapEl.appendChild(btn);
  });
  const firstFloor = floors[0]?.floorlevel || groupShops[0]?.floorlevel || "";
  floorShopGridEl.innerHTML = buildFloorGridSection(groupShops, firstFloor);
}

function showBuildingGuide(groupShops, groupKey) {
  const guide = groupShops[0]?.building_guide || null;
  buildingPhotoWrapEl.innerHTML = "";
  floorShopGridEl.innerHTML = "";

  const isMultiTenant = Array.isArray(groupShops) && groupShops.length > 1;

  if (guide && guide.image_url) {
    renderCustomGuidePhoto(groupShops, guide);
  } else if (isMultiTenant) {
    // Task 3 replaces this branch with renderDefaultBuildingPhoto(groupShops).
    const imgEl = document.createElement("img");
    imgEl.src = DEFAULT_BUILDING_IMAGE_URL;
    imgEl.className = "building-photo";
    imgEl.alt = "building";
    buildingPhotoWrapEl.appendChild(imgEl);

    const floors = getFloorDisplayOrder(groupShops, null);
    floors.forEach((floor, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "floor-hotspot" + (idx === 0 ? " is-active" : "");
      btn.dataset.floor = floor.floorlevel;
      btn.style.cssText = buildHotspotStyle(floor);
      btn.textContent = floor.floorlevel;
      btn.addEventListener("click", () => {
        buildingPhotoWrapEl.querySelectorAll(".floor-hotspot").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        floorShopGridEl.innerHTML = buildFloorGridSection(groupShops, floor.floorlevel);
      });
      buildingPhotoWrapEl.appendChild(btn);
    });
    const firstFloor = floors[0]?.floorlevel || groupShops[0]?.floorlevel || "";
    floorShopGridEl.innerHTML = buildFloorGridSection(groupShops, firstFloor);
  } else {
    const shop = groupShops[0];
    floorShopGridEl.innerHTML = `
      <div class="floor-shop-list">
        <section class="floor-shop-card">
          ${buildShopSummary(shop)}
          ${buildImageGrid(shop)}
        </section>
      </div>
    `;
  }

  autoShownGroupKey = groupKey;
  userClosedGuide = false;
  buildingGuideEl.hidden = false;

  guideGroupKey = groupKey;
  guideGroupShops = groupShops;
  syncDestinationButton();
}

buildingGuideCloseEl.addEventListener("click", hideBuildingGuide);
```

This step is intentionally a pure extraction: the `isMultiTenant` branch
still does exactly what the old combined branch did (same call to
`getFloorDisplayOrder`, same eager first-floor grid render) — it's inlined
here only so Task 1 stays a no-behavior-change refactor. Task 3 deletes this
inlined copy and replaces it with the real new behavior.

- [ ] **Step 3: Syntax-check the file**

Run: `node --check static/migrationmaps/public.js`
Expected: no output, exit code 0 (this only parses the file — it does not
execute browser-only code like `document.getElementById`, so it's safe to
run outside a browser).

- [ ] **Step 4: Commit**

```bash
git add static/migrationmaps/public.js
git commit -m "refactor(migrationmaps): extract renderCustomGuidePhoto from showBuildingGuide"
```

---

### Task 2: Add `getDefaultBuildingFloorLayout()` (pure function, fixed floor bands)

**Files:**
- Modify: `static/migrationmaps/public.js` — insert after `getFloorDisplayOrder`
  (originally ending at `public.js:385`, now shifted by Task 1's edit; locate
  by the `getFloorDisplayOrder` function's closing `}` followed by
  `function buildFloorGridSection` instead of by line number)

- [ ] **Step 1: Confirm the anchor text**

Confirm the code immediately after `getFloorDisplayOrder()`'s closing brace
reads:

```js
function buildFloorGridSection(groupShops, floorlevel) {
```

- [ ] **Step 2: Insert the new function above it**

Insert this block immediately before `function buildFloorGridSection(...)`:

```js
// ---- 既定ビル画像専用: 1F/2F/3F は画像の高さバンドに固定、それ以外は左端に自動縦積み ----
const FIXED_FLOOR_BANDS = {
  "3F": { area_x_pct: 0, area_y_pct: 0,  area_width_pct: 100, area_height_pct: 30 },
  "2F": { area_x_pct: 0, area_y_pct: 35, area_width_pct: 100, area_height_pct: 30 },
  "1F": { area_x_pct: 0, area_y_pct: 70, area_width_pct: 100, area_height_pct: 30 },
};

function getDefaultBuildingFloorLayout(groupShops) {
  const keys = [];
  groupShops.forEach((s) => {
    const key = normalizeFloorLevel(s.floorlevel) || "階層未設定";
    if (!keys.includes(key)) keys.push(key);
  });

  const fixed = keys.filter((k) => FIXED_FLOOR_BANDS[k]);
  const other = keys.filter((k) => !FIXED_FLOOR_BANDS[k]);

  fixed.sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
  const fixedFloors = fixed.map((k) => ({ floorlevel: k, ...FIXED_FLOOR_BANDS[k] }));

  const gap = other.length ? 92 / other.length : 0;
  const otherFloors = other.map((k, i) => ({
    floorlevel: k,
    area_x_pct: 4,
    area_y_pct: 4 + gap * i,
    area_width_pct: 22,
    area_height_pct: Math.max(Math.min(gap - 4, 16), 8),
  }));

  return [...fixedFloors, ...otherFloors];
}
```

- [ ] **Step 3: Syntax-check, then sanity-check the logic in Node**

Run: `node --check static/migrationmaps/public.js`
Expected: no output, exit code 0.

Then run this standalone sanity check (copies just the new pure function —
not a permanent test file, just a quick manual check since this repo has no
JS test runner):

```bash
node -e "
function normalizeFloorLevel(value) { return String(value || '').trim().toUpperCase(); }
const FIXED_FLOOR_BANDS = {
  '3F': { area_x_pct: 0, area_y_pct: 0,  area_width_pct: 100, area_height_pct: 30 },
  '2F': { area_x_pct: 0, area_y_pct: 35, area_width_pct: 100, area_height_pct: 30 },
  '1F': { area_x_pct: 0, area_y_pct: 70, area_width_pct: 100, area_height_pct: 30 },
};
function getDefaultBuildingFloorLayout(groupShops) {
  const keys = [];
  groupShops.forEach((s) => {
    const key = normalizeFloorLevel(s.floorlevel) || '階層未設定';
    if (!keys.includes(key)) keys.push(key);
  });
  const fixed = keys.filter((k) => FIXED_FLOOR_BANDS[k]);
  const other = keys.filter((k) => !FIXED_FLOOR_BANDS[k]);
  fixed.sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
  const fixedFloors = fixed.map((k) => ({ floorlevel: k, ...FIXED_FLOOR_BANDS[k] }));
  const gap = other.length ? 92 / other.length : 0;
  const otherFloors = other.map((k, i) => ({
    floorlevel: k, area_x_pct: 4, area_y_pct: 4 + gap * i,
    area_width_pct: 22, area_height_pct: Math.max(Math.min(gap - 4, 16), 8),
  }));
  return [...fixedFloors, ...otherFloors];
}

console.log(JSON.stringify(getDefaultBuildingFloorLayout([{floorlevel:'1F'},{floorlevel:'2F'}]), null, 2));
console.log(JSON.stringify(getDefaultBuildingFloorLayout([{floorlevel:'B1F'},{floorlevel:'4F'}]), null, 2));
console.log(JSON.stringify(getDefaultBuildingFloorLayout([{floorlevel:'1F'},{floorlevel:'4F'}]), null, 2));
"
```

Expected:
- First call: two entries, `1F` with `area_y_pct: 70`, `2F` with
  `area_y_pct: 35`, both `area_width_pct: 100, area_height_pct: 30`.
- Second call: two entries (`B1F`, `4F`), both with `area_x_pct: 4`,
  `area_width_pct: 22`, `area_y_pct` values `4` and `50` (gap = 92/2 = 46),
  `area_height_pct` = 16 (capped).
- Third call: `1F` fixed-band entry plus one `4F` left-edge entry with
  `area_y_pct: 4`, `area_height_pct: 16` (gap = 92/1 = 92, capped at 16).

- [ ] **Step 4: Commit**

```bash
git add static/migrationmaps/public.js
git commit -m "feat(migrationmaps): add getDefaultBuildingFloorLayout for fixed 1F/2F/3F click bands"
```

---

### Task 3: Add `renderDefaultBuildingPhoto()` and wire it into `showBuildingGuide()`

**Files:**
- Modify: `static/migrationmaps/public.js` — replace the inlined
  `isMultiTenant` branch added in Task 1 with a call to a new
  `renderDefaultBuildingPhoto()` function.

- [ ] **Step 1: Confirm the anchor text**

After Tasks 1–2, `showBuildingGuide`'s middle branch should read exactly:

```js
  } else if (isMultiTenant) {
    // Task 3 replaces this branch with renderDefaultBuildingPhoto(groupShops).
    const imgEl = document.createElement("img");
    imgEl.src = DEFAULT_BUILDING_IMAGE_URL;
    imgEl.className = "building-photo";
    imgEl.alt = "building";
    buildingPhotoWrapEl.appendChild(imgEl);

    const floors = getFloorDisplayOrder(groupShops, null);
    floors.forEach((floor, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "floor-hotspot" + (idx === 0 ? " is-active" : "");
      btn.dataset.floor = floor.floorlevel;
      btn.style.cssText = buildHotspotStyle(floor);
      btn.textContent = floor.floorlevel;
      btn.addEventListener("click", () => {
        buildingPhotoWrapEl.querySelectorAll(".floor-hotspot").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        floorShopGridEl.innerHTML = buildFloorGridSection(groupShops, floor.floorlevel);
      });
      buildingPhotoWrapEl.appendChild(btn);
    });
    const firstFloor = floors[0]?.floorlevel || groupShops[0]?.floorlevel || "";
    floorShopGridEl.innerHTML = buildFloorGridSection(groupShops, firstFloor);
  } else {
```

- [ ] **Step 2: Add `renderDefaultBuildingPhoto()` above `showBuildingGuide`**

Insert this function immediately before `function showBuildingGuide(groupShops, groupKey) {`:

```js
function renderDefaultBuildingPhoto(groupShops) {
  const imgEl = document.createElement("img");
  imgEl.src = DEFAULT_BUILDING_IMAGE_URL;
  imgEl.className = "building-photo";
  imgEl.alt = "building";
  buildingPhotoWrapEl.appendChild(imgEl);

  const overlayEl = document.createElement("div");
  overlayEl.className = "building-floor-overlay";
  overlayEl.hidden = true;
  overlayEl.innerHTML = `
    <button type="button" class="building-floor-overlay-close" aria-label="閉じる">×</button>
    <div class="building-floor-overlay-grid"></div>
  `;
  buildingPhotoWrapEl.appendChild(overlayEl);

  const gridEl = overlayEl.querySelector(".building-floor-overlay-grid");
  overlayEl.querySelector(".building-floor-overlay-close").addEventListener("click", () => {
    overlayEl.hidden = true;
    buildingPhotoWrapEl.querySelectorAll(".floor-hotspot.is-active").forEach((b) => b.classList.remove("is-active"));
  });

  const floors = getDefaultBuildingFloorLayout(groupShops);
  floors.forEach((floor) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "floor-hotspot";
    btn.dataset.floor = floor.floorlevel;
    btn.style.cssText = buildHotspotStyle(floor);
    btn.textContent = floor.floorlevel;
    btn.addEventListener("click", () => {
      buildingPhotoWrapEl.querySelectorAll(".floor-hotspot").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      gridEl.innerHTML = buildFloorGridSection(groupShops, floor.floorlevel);
      overlayEl.hidden = false;
    });
    buildingPhotoWrapEl.appendChild(btn);
  });
  // 要件: どの階もタップされるまでグリッドを表示しない（overlayEl は hidden のまま）
}

```

Note: no hotspot gets `is-active` on initial render (unlike
`renderCustomGuidePhoto`'s first-floor default) — this is what makes nothing
show until tapped.

- [ ] **Step 3: Replace the inlined branch with a call to the new function**

Replace the `} else if (isMultiTenant) { ... }` block (the whole block quoted
in Step 1 above) with:

```js
  } else if (isMultiTenant) {
    renderDefaultBuildingPhoto(groupShops);
  } else {
```

- [ ] **Step 4: Syntax-check**

Run: `node --check static/migrationmaps/public.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add static/migrationmaps/public.js
git commit -m "feat(migrationmaps): overlay floor shop grid on default building image, hidden until tapped"
```

---

### Task 4: CSS for the overlay (public.html)

**Files:**
- Modify: `templates/migrationmaps/public.html` (append after the existing
  `.floor-hotspot:hover, .floor-hotspot.is-active { ... }` rule, before the
  `/* ---- Floor shop list ---- */` comment)

- [ ] **Step 1: Confirm the anchor text**

Confirm these lines exist (originally `public.html:218-226`):

```css
  .floor-hotspot:hover,
  .floor-hotspot.is-active {
    background: rgba(37, 99, 235, 0.60);
    color: #fff;
    border-color: #1d4ed8;
  }

  /* ---- Floor shop list ---- */
```

- [ ] **Step 2: Insert the new rules**

Insert this block immediately after the `.floor-hotspot.is-active { ... }`
closing brace and before the `/* ---- Floor shop list ---- */` comment:

```css
  /* ---- 既定ビル画像: 階グリッドのオーバーレイ表示 ---- */
  .building-floor-overlay {
    position: absolute;
    inset: 0;
    background: rgba(255, 255, 255, 0.97);
    border-radius: 8px;
    padding: 40px 10px 10px;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    box-sizing: border-box;
  }

  .building-floor-overlay[hidden] {
    display: none;
  }

  .building-floor-overlay-close {
    position: absolute;
    top: 8px;
    right: 8px;
    font-size: 18px;
    line-height: 1;
    border: 1px solid #e5e7eb;
    background: #fff;
    cursor: pointer;
    color: #374151;
    padding: 3px 9px;
    border-radius: 8px;
    z-index: 1;
  }

  .building-floor-overlay-close:hover {
    background: #f3f4f6;
  }

  .building-floor-overlay-grid .floor-shop-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 8px;
    box-sizing: border-box;
  }

  .building-floor-overlay-grid .floor-shop-card {
    padding: 8px 10px;
    box-sizing: border-box;
  }
```

- [ ] **Step 3: Verify the page still loads**

Run: `flask --app app run --debug` (from the repo root; requires the
`DATABASE_URL` already configured in `.env` — this is a read-heavy page load,
no writes happen just from opening it).

Open `http://127.0.0.1:5000/migrationmaps/m/<any existing project_id>` (check
`GET /api/migrationmaps/projects` if you don't know one). Confirm the page
loads with no visual change yet (the overlay only appears once Task 3's code
is exercised by clicking a co-located-shop marker) and no browser console
errors about CSS parsing.

- [ ] **Step 4: Commit**

```bash
git add templates/migrationmaps/public.html
git commit -m "style(migrationmaps): add building-floor-overlay CSS for default building image grid"
```

---

### Task 5: End-to-end manual verification

This repo has no pytest coverage for public-page JS and no browser-test
harness (no `package.json`, confirmed) — all prior MigrationMaps client-side
work in this repo was verified manually against a real dev environment
(convention documented in `docs/superpowers/specs/2026-09-13-migrationmaps-admin-building-preview-design.md`
and `docs/superpowers/specs/2026-09-12-migrationmaps-capture-shop-link-design.md`).
Follow the same convention here.

**Heads up before starting:** the `DATABASE_URL` in `.env` points to a real,
shared database — registering shops through the admin UI during this
verification writes real rows to it. Use clearly throwaway names (prefix
`【確認用】`) and get explicit confirmation before running any cleanup
`DELETE`.

- [ ] **Step 1: Start the dev server**

```bash
flask --app app run --debug
```

- [ ] **Step 2: Register test shops with no `BuildingGuide` at their location**

Open `http://127.0.0.1:5000/migrationmaps/admin`, expand "☰ 店舗を登録・編集す
る", and register (pick any existing project ID; check
`GET /api/migrationmaps/projects` if unsure — use a project whose public page
you can reach):

- Shop A: 店名=`【確認用】オーバーレイ1F店`, 住所=`テスト住所`, 階層=`1F`,
  メール=`test-overlay-a@example.com`, 緯度=`36.0641`, 経度=`136.2229`.
- Shop B: same 住所/緯度/経度, 店名=`【確認用】オーバーレイ2F店`, 階層=`2F`,
  メール=`test-overlay-b@example.com`.

Confirm via `GET /api/migrationmaps/<project_id>` that this project has no
`BuildingGuide` at that lat/lng (this repo's existing data won't have one
unless someone deliberately created it through direct DB access — there's no
UI to create `BuildingGuide` rows in this codebase today).

- [ ] **Step 3: Verify nothing shows until a zone is tapped**

Open `http://127.0.0.1:5000/migrationmaps/m/<project_id>` and click the
marker at Shop A/B's location.

Expected: the building-guide sheet opens, the default building image
(`migrationmaps_buildingimage.jpg`) is shown, **no shop card/grid is
visible**, and no floor hotspot is visually marked active.

- [ ] **Step 4: Verify the fixed 1F/2F zones**

Click in the bottom ~30% of the building image.

Expected: Shop A's card appears in an overlay on top of the image, with a
"×" in the overlay's own top-right corner.

Click the overlay's "×".

Expected: the overlay disappears; the building image and its zones remain
visible; the sheet itself stays open.

Click in the vertical middle band of the image (roughly 35%–65% from the
top).

Expected: Shop B's card appears in the overlay instead of Shop A's.

- [ ] **Step 5: Verify the fallback zone for a non-1F/2F/3F floor**

Register a third shop at the same lat/lng: 店名=`【確認用】オーバーレイ4F店`,
階層=`4F`, メール=`test-overlay-c@example.com`. Reopen the marker's guide
(close and reopen, or navigate back to the page).

Expected: a small hotspot appears on the image's left edge (not a
top/middle/bottom band) labeled `4F`; tapping it overlays Shop C's card the
same way as Steps 3–4.

- [ ] **Step 6: Verify the sheet-level close still closes everything**

With the overlay open (from Step 4 or 5), click the sheet's top-level "×"
(the one already present at the top of the building-guide panel, not the
overlay's own "×").

Expected: the entire building guide (image, zones, and overlay if it was
open) closes. Reopening the same marker afterward starts fresh with the
overlay hidden again (per Step 3).

- [ ] **Step 7: Mobile-width check (no horizontal overflow)**

In the browser dev tools, switch to a mobile device emulation at 375px width
(e.g. "iPhone SE"). Reopen the guide and tap a zone with several shops on
one floor if possible (or just confirm with the two/three test shops).

Expected: no horizontal scrollbar appears anywhere on the page; the overlay
grid's cards wrap within the building image's width instead of overflowing
it.

- [ ] **Step 8: Regression-check a `BuildingGuide`-backed project, if one exists**

If any existing project in the DB has a `MigrationShop` with a non-null
`building_guide_id` (check via a quick read query, e.g.
`SELECT DISTINCT map_project_id FROM migrationshop WHERE building_guide_id IS NOT NULL;`
against the configured `DATABASE_URL`), open that project's public page and
click the corresponding marker.

Expected: unchanged from before this plan — the real guide photo shows, and
the first floor's shop grid appears immediately below the image (not
overlaid, no separate overlay close button) — because `renderCustomGuidePhoto`
was extracted verbatim in Task 1 with no behavior change. If no such project
exists in the DB, skip this step (there is no admin UI to create one, so
none may exist).

- [ ] **Step 9: Clean up the test data**

Stop and confirm with the user before running any DELETE against the shared
DB. Once confirmed:

```sql
DELETE FROM mapshopimages WHERE migrationshop_id IN (
  SELECT id FROM migrationshop WHERE shopname LIKE '【確認用】オーバーレイ%'
);
DELETE FROM migrationshop WHERE shopname LIKE '【確認用】オーバーレイ%';
```

- [ ] **Step 10: Stop the dev server**

`Ctrl+C` in the terminal running `flask --app app run --debug`.

No commit for this task — it's verification only, no code changes.
