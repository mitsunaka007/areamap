# MigrationMaps: Public-page building floor click zones + overlay grid

## Problem

On the public map page (`static/migrationmaps/public.js`), when two or more
registered shops share the exact same lat/lng, `showBuildingGuide()`
(`public.js:479-535`) displays the default building photo
(`static/img/migrationmaps_buildingimage.jpg`) with clickable floor hotspots
built by `getFloorDisplayOrder()` (`public.js:356-385`). Today this function
auto-positions hotspots by stacking them down the left edge of the image, and
`showBuildingGuide()` immediately renders the first floor's shop grid
(`public.js:513-514`) the moment the sheet opens — so whichever floor sorts
first (frequently `2F`, if no `1F` shop exists in that group) is shown before
the user taps anything.

The requested behavior instead ties click zones to fixed regions of the
building image itself (which depicts a 3-story building) — top third for 3F,
middle third for 2F, bottom third for 1F — shows nothing until a zone is
tapped, and then overlays the matching floor's shops as a card grid on top of
the image (closable independently of the whole guide sheet).

Separately, the current live deployment (`https://areamap.onrender.com/migrationmaps/m/8`)
does not show its illustration map layer at all. Investigation (see
"Out of scope" below) found this is a missing-asset problem (the uploaded
image 404s), not a layer-ordering bug — no code change addresses it.

## Goal

On the public page, for the "co-located shops sharing lat/lng, no custom
`BuildingGuide` photo" case only:

1. Show the default building image with no floor grid visible until the user
   taps a click zone.
2. Click zones for floor labels that normalize (via the existing
   `normalizeFloorLevel`) to exactly `1F`, `2F`, or `3F` are fixed to the
   image's height bands: `3F` = top 30%, `2F` = middle 30% (centered, i.e.
   35%–65%), `1F` = bottom 30% (70%–100%), each spanning the full width.
   Only zones for floors actually present in the group are rendered (no
   zone for a floor with zero shops in this group).
3. Any other floor label present in the group (`B1F`, `4F`, empty/`階層未設定`,
   etc.) keeps today's fallback: auto-stacked hotspots down the image's left
   edge, sized by however many "other" floors exist in that group.
4. Tapping any zone (fixed or fallback) renders that floor's shops as a card
   grid, overlaid on top of the building image (not below it in the sheet),
   with its own "×" close control that hides only the grid — the image and
   its click zones remain visible/tappable underneath.
5. The existing sheet-level "×" (`#buildingGuideClose`) is unchanged: it
   still closes the entire building guide (image + overlay + everything),
   and is already positioned over the top of the building photo area.

## Non-goals

- No change to `BuildingGuide`/`BuildingGuideFloor`-backed buildings (a real
  photo with admin-authored hotspot rectangles). Those keep using
  `getFloorDisplayOrder()`'s existing per-guide logic and the existing
  below-image floor grid list, unchanged.
- No change to the single-shop case (no building image at all).
- No change to Leaflet pane z-ordering (`public.js:14-36`) — it already
  implements "OSM tiles below, illustration overlay in the middle, markers on
  top," and the building-guide sheet is already a DOM overlay above the map
  via CSS `z-index`. This spec adds no pane changes.
- **project 8's missing illustration image**: confirmed via
  `GET https://areamap.onrender.com/api/migrationmaps/8` (affine coefficients
  and `image_url` present, bounds computed correctly near 36.06/136.22) and a
  direct fetch of `https://areamap.onrender.com/migrationmaps/uploads/aossa_dragonquest_zoom19_4c8d6610be87445f8fdca35b4a18f97b.jpg`
  (**404**). That filename isn't among the 5 images tracked in git under
  `migrationmaps_uploads/` — it was uploaded at runtime through the admin
  page and is not persisted (this repo's default local-disk storage,
  `MIGRATIONMAPS_UPLOAD_DIR`, doesn't survive a redeploy/restart on an
  ephemeral-disk host unless Cloudinary env vars are configured). Per user
  decision, no code change is made for this; the user will re-upload the
  project's illustration image via the admin page themselves.
- No admin-page (`admin.js`/`admin.html`) changes — this spec is public-page
  (`public.js`/`public.html`) only.

## Design

### 1. New function: `getDefaultBuildingFloorLayout(groupShops)` (public.js)

Added near `getFloorDisplayOrder()`. Used **only** on the branch where
`showBuildingGuide()` has no `building_guide.image_url` (i.e. the default
image is in use). `getFloorDisplayOrder()` itself is untouched and continues
to serve the custom-`BuildingGuide` branch exactly as today.

```js
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

  // 固定3階(表示順は画像の見た目に合わせ 3F→2F→1F ではなく、既存と揃えて昇順)
  fixed.sort((a, b) => (parseInt(a) || 0) - (parseInt(b) || 0));
  const fixedFloors = fixed.map((k) => ({ floorlevel: k, ...FIXED_FLOOR_BANDS[k] }));

  // 固定3階以外は既存の「画像左端に縦積み」フォールバックをそのまま流用
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

Reuses the existing `buildHotspotStyle()` (`public.js:341-354`) unchanged,
since both floor-object shapes are identical (`area_*_pct` fields).

### 2. `showBuildingGuide()` rewrite of the default-image branch

Current structure (`public.js:479-535`) branches on `buildingImageUrl`
truthiness. Split that branch in two based on whether `guide` (the custom
`BuildingGuide`) exists:

```js
function showBuildingGuide(groupShops, groupKey) {
  const guide = groupShops[0]?.building_guide || null;
  buildingPhotoWrapEl.innerHTML = "";
  floorShopGridEl.innerHTML = "";

  const isMultiTenant = Array.isArray(groupShops) && groupShops.length > 1;
  const buildingImageUrl = (guide && guide.image_url)
    ? guide.image_url
    : (isMultiTenant ? DEFAULT_BUILDING_IMAGE_URL : null);

  if (guide && guide.image_url) {
    // 既存の BuildingGuide 分岐。無変更。
    renderCustomGuidePhoto(groupShops, guide);       // 既存コードそのまま(関数分割のみ)
  } else if (buildingImageUrl) {
    renderDefaultBuildingPhoto(groupShops);          // 新規
  } else {
    // 既存の「画像なし・単独店舗」分岐。無変更。
    const shop = groupShops[0];
    floorShopGridEl.innerHTML = `...`;               // 既存コードそのまま
  }

  autoShownGroupKey = groupKey;
  userClosedGuide = false;
  buildingGuideEl.hidden = false;
  guideGroupKey = groupKey;
  guideGroupShops = groupShops;
  syncDestinationButton();
}
```

`renderCustomGuidePhoto()` is exactly today's `if (buildingImageUrl)` body
(image + `getFloorDisplayOrder` + eager first-floor grid into
`floorShopGridEl`), extracted verbatim into its own function — behavior
identical to today, just named so the two branches don't tangle.

`renderDefaultBuildingPhoto(groupShops)` is new:

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
  const closeOverlay = () => {
    overlayEl.hidden = true;
    buildingPhotoWrapEl.querySelectorAll(".floor-hotspot.is-active")
      .forEach((b) => b.classList.remove("is-active"));
  };
  overlayEl.querySelector(".building-floor-overlay-close")
    .addEventListener("click", closeOverlay);

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

  // 要件1: どの階もタップされるまでグリッドを表示しない(overlayEl は hidden のまま)
}
```

`buildFloorGridSection()` (`public.js:387-401`) is reused unchanged for the
overlay's content — it already renders `.floor-shop-list` /
`.floor-shop-card` markup; only the *container* around it (the overlay) is
new, and CSS gives `.building-floor-overlay-grid .floor-shop-list` a grid
layout instead of the default flex-column (see CSS section) so cards appear
as a grid rather than a vertical stack, without forking the card-building
logic itself.

### 3. CSS additions (`templates/migrationmaps/public.html`)

Added after the existing `.floor-hotspot` rules:

```css
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

.building-floor-overlay[hidden] { display: none; }

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

.building-floor-overlay-close:hover { background: #f3f4f6; }

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

`.building-photo-wrap` is already `position: relative; width: 100%;
max-width: 420px` (`public.html:186-192`) — the overlay's `position:
absolute; inset: 0` fills exactly the rendered photo's box, and everything
here uses `%`/`minmax()`/`box-sizing: border-box`, so it stays within the
wrap's width on narrow viewports (matches item 7 — no new fixed-px widths
that could exceed a phone screen).

### 4. Edge cases

- A group whose shops are all on floors outside `{1F, 2F, 3F}` (e.g. only
  `B1F` and `4F`): `getDefaultBuildingFloorLayout` puts all of them in the
  `other` bucket, reproducing today's left-edge auto-stacking exactly (same
  formula as the current `getFloorDisplayOrder` synthesis) — visually
  identical to current behavior for this case, just no eager first-floor
  grid render.
- A group with e.g. `1F` and `4F`: `1F` gets the fixed bottom-30% band, `4F`
  gets the single left-edge slot (gap = 92, since `other.length === 1`).
- Tapping a different zone while the overlay is already open: the grid
  content and `is-active` state simply update in place (overlay stays open,
  no flicker) — same pattern as today's tab-switching.
- Closing the overlay (its own "×") does not close the whole sheet; closing
  the sheet's "×" (`buildingGuideClose`, unchanged) hides everything
  including the overlay (next open starts fresh with the overlay hidden
  again, since `buildingPhotoWrapEl.innerHTML = ""` at the top of
  `showBuildingGuide` rebuilds it).
- Floor label matching for the fixed bands is exact post-`normalizeFloorLevel`
  string equality (`"1F"`, `"2F"`, `"3F"`) — a label like `"1階"` or `"F1"`
  falls into the `other` fallback bucket, not the fixed bands. This matches
  the scoped decision (only labels that normalize to exactly those three
  strings get fixed bands).

## Files touched

- `static/migrationmaps/public.js`: new `getDefaultBuildingFloorLayout()`,
  new `renderDefaultBuildingPhoto()`, `showBuildingGuide()` split into the
  three branches described above (custom-guide branch extracted verbatim
  into `renderCustomGuidePhoto()`, no behavior change there).
- `templates/migrationmaps/public.html`: new CSS rules only (no markup
  changes — the overlay element is created dynamically in JS, same
  convention as the existing floor hotspots).

## Testing

No pytest coverage exists for this client-side JS (repo convention — see
prior MigrationMaps public/admin specs). Manual verification against a real
dev environment (per the same shared-DB convention documented in
`docs/superpowers/specs/2026-09-13-migrationmaps-admin-building-preview-design.md`):

1. Register two throwaway shops (`【確認用】` prefix) sharing lat/lng, one
   `floorlevel=1F` and one `floorlevel=2F`, on a project with no
   `BuildingGuide` at that location.
2. Open that project's public page, click the shared marker. Confirm: the
   default building image appears, **no shop grid is visible yet**.
3. Tap the bottom ~30% of the image; confirm the `1F` shop's card appears as
   an overlay on top of the image, with its own "×".
4. Tap that overlay's "×"; confirm the grid disappears but the image and
   zones remain, sheet stays open.
5. Tap the middle band (~35–65% height); confirm the `2F` shop appears in
   the overlay instead.
6. Add a third throwaway shop at the same lat/lng with `floorlevel=4F`.
   Reload/reopen the guide; confirm a small hotspot appears on the image's
   left edge (fallback positioning) and tapping it overlays the `4F` shop
   the same way.
7. Tap the sheet's top-level "×" (`buildingGuideClose`); confirm the entire
   guide (image + overlay if open) closes.
8. Resize the browser to a phone width (e.g. 375px) or use device emulation;
   confirm no horizontal scrollbar appears on the page and the overlay grid
   cards stay within the building image's width.
9. Clean up the throwaway test shops (confirm with user before any DELETE
   against the shared DB, same convention as prior specs).
10. Confirm a project that still uses a real `BuildingGuide` (photo +
    admin-authored hotspots) is visually unchanged (eager first-floor grid
    still shows below the image, as before) — regression check for the
    non-goal.
