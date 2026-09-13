# MigrationMaps: Admin building preview for co-located shops

## Problem

The public map page (`static/migrationmaps/public.js`) already groups shops
sharing the same lat/lng into a "building," shows a building photo, renders
clickable floor hotspots, and lists the shops on the clicked floor in a grid
(`showBuildingGuide`, `getFloorDisplayOrder`, `buildFloorGridSection` —
`public.js:387-535`). The admin page has no equivalent: `registeredShopList`
(`templates/migrationmaps/admin.html:187`, fed by `refreshShopList()` in
`admin.js:1261`) renders every registered shop as a flat list of name-only
buttons, with no indication that several of them share a location, and no way
to see per-floor tenant makeup while managing shops.

Separately, and discovered while investigating this: clicking a row in that
flat list does nothing today. No click handler was ever attached
(`admin.js:1271-1278` builds the buttons but never wires a listener), and
`resetShopForm`/`btnResetShopForm` are referenced (`admin.html:257`,
`admin.html:479`) but never defined anywhere. This was previously flagged and
deliberately deferred as "a separate, pre-existing gap unrelated to this
request" in
`docs/superpowers/specs/2026-09-12-migrationmaps-capture-shop-link-design.md`.
It is no longer unrelated: the new building grid needs "click a shop card to
edit it" to work, so this gap is fixed as part of this feature and applied to
both the flat list and the new grid for consistency.

## Goal

On the admin page, when two or more registered shops share the exact same
lat/lng, show a building preview (using the existing default building image at
`static/img/migrationmaps_buildingimage.jpg`) with clickable floor tabs
(1F/2F/3F/…, derived only from floors actually present in that group). Clicking
a tab shows a grid of the shops on that floor (thumbnail image, name, address).
Clicking a shop card loads that shop into the edit form. Shops that don't share
their coordinates with anyone keep rendering as today's flat list item — also
now clickable to load into the edit form.

## Non-goals

- No use of the existing `BuildingGuide`/`BuildingGuideFloor` models (custom
  building photos, hand-positioned hotspot rectangles). This feature always
  uses the single default building image and simple tabs, not positioned
  hotspots over a photo.
- No proximity-based grouping. Grouping is exact-match on lat/lng (same
  precision/strategy as `public.js`'s `latLngGroupKey`), not "nearby."
- No changes to the OSM candidate list (`osmCandidateList`) or its rendering.
- No changes to the `project_id` filter behavior of `refreshShopList()` — the
  building grouping is computed over whatever set of shops that function
  already fetches (all shops, or a single project's shops, depending on
  `currentProjectId`).
- No image upload/edit changes beyond what "load into form" requires (existing
  images are shown as read-only previews; file inputs are left empty, which
  the existing register/update endpoint already treats as "leave unchanged" —
  see `app.py:1710-1740`).

## Design

### 1. Backend: extend the shop list endpoint

`GET /api/migrationmaps/shops` (`app.py:1753`, `api_migrationshop_list`) adds
`lat`, `lng` (floats, `None` if unset — mirrors the detail endpoint's
conversion at `app.py:1792-1793`) and `thumbnail_url` to each shop in the
response. `thumbnail_url` is the `image_url` of that shop's `MapShopImages`
row with the lowest `sort_order` (typically `sort_order == 1`), or `null` if
the shop has no images. This requires eager-loading `shopimages` (already a
relationship on `MigrationShop`, ordered by `sort_order` per `models.py`) or a
per-shop lookup — given admin shop lists are small, a straightforward
`shop.shopimages[0].image_url if shop.shopimages else None` is sufficient (no
new query pattern needed; the relationship is already loaded via the ORM when
accessed).

```json
{
  "shops": [
    {
      "id": 1, "shopname": "…", "address": "…", "floorlevel": "2F",
      "map_project_id": 1, "is_active": true, "updated_at": "…",
      "lat": 36.0601234, "lng": 136.2201234,
      "thumbnail_url": "/migrationshop_uploads/shop_1_1_abc123.jpg"
    }
  ]
}
```

The existing detail endpoint (`GET /api/migrationmaps/shops/<id>`,
`app.py:1777`) is unchanged — it already returns everything `loadShopIntoForm`
needs (full field set + `images` array).

### 2. Frontend: grouping helpers (admin.js)

Add two small helpers to `admin.js`, matching `public.js` exactly so admin and
public grouping semantics never drift apart:

```js
function normalizeFloorLevel(value) { return String(value || "").trim().toUpperCase(); }
function latLngGroupKey(lat, lng) { return `${Number(lat).toFixed(7)},${Number(lng).toFixed(7)}`; }
```

### 3. Frontend: `refreshShopList()` rewrite

Replace the current flat-loop body of `refreshShopList()` (`admin.js:1261-1279`)
with:

1. Fetch shops as today (`project_id` query param unchanged).
2. Partition into groups via `latLngGroupKey`, skipping shops where `lat`/`lng`
   is `null`/not finite — those always render as standalone flat items (can't
   determine building membership).
3. For each group:
   - **Size 1** (including all shops with missing lat/lng, each treated as its
     own singleton): render today's single button
     (`.registered-shop-item`), unchanged markup, but now with a click
     listener calling `loadShopIntoForm(shop.id)`.
   - **Size ≥ 2**: render one `.building-card`:
     - `.building-thumb`: `<img src="/static/img/migrationmaps_buildingimage.jpg">`.
     - Header text: shared address (first shop's `address`) + `"{n}件の店舗"`.
     - `.building-floor-tabs`: one `.floor-tab` button per distinct
       `normalizeFloorLevel(shop.floorlevel)` present in the group, sorted
       ascending by the numeric portion of the label (same sort as
       `public.js:370-374`; a floor label with no digits sorts last). Shops
       with an empty/null `floorlevel` are bucketed into one tab labeled
       `階層未設定`, placed after all numbered floors.
     - The first tab starts `is-active`; its floor's grid renders immediately
       below via `buildAdminFloorGrid(groupShops, floorKey)`.
     - Clicking a tab toggles `is-active` and re-renders the grid for that
       floor only (no re-fetch).
   - `buildAdminFloorGrid(groupShops, floorKey)` filters the group to shops
     matching that floor key and renders `.building-shop-card` per shop:
     `.building-shop-thumb` (`<img>` from `thumbnail_url`, or an empty
     placeholder box via CSS if `null`), `.building-shop-name` (`shopname`),
     `.building-shop-address` (`address`). Each card is a `<button
     type="button">` with a click listener calling
     `loadShopIntoForm(shop.id)`.

Grouping/rendering runs client-side over the single `GET /shops` response — no
additional network calls for the building view itself.

### 4. Frontend: shared edit-load / reset (fixes the pre-existing gap)

New functions in `admin.js`:

- `async function loadShopIntoForm(shopId)`:
  - `GET /api/migrationmaps/shops/<id>`.
  - Populate `r_shop_id` (hidden), `r_shopname`, `r_address`, `r_floorlevel`,
    `r_tel`, `r_email`, `r_instagram`, `r_lat`, `r_lng`, `r_is_active`
    (checkbox), `r_description`, `r_website_url`, `r_map_project_id` from the
    response.
  - For each of the shop's `images` (by `sort_order`), set
    `r_preview{sort_order}` to a read-only `<img src="{image_url}">`; leave
    `r_img{sort_order}` file inputs untouched/empty. Slots with no existing
    image are cleared.
  - Set `shopFormTitle` text to `店舗を編集する`.
  - Mark the clicked list item / card `is-active` and clear that class from
    any previously active item (track the active element in a module-level
    variable).
  - Ensure the shop panel is open (`setShopMenuOpen(true)`) and scroll the
    form into view (`shopRegisterForm.scrollIntoView({block: "nearest"})`).
- `function resetShopForm(isNewMode)`:
  - `shopRegisterForm.reset()`, clear `r_shop_id`, clear all five
    `r_preview{n}` divs, clear the active-item highlight.
  - Set `shopFormTitle` text to `店舗を新規登録する`.
  - `isNewMode` is accepted for parity with the existing call site
    (`admin.html:479`, `resetShopForm(true)`) but the reset behavior is the
    same regardless of the argument — there is no other mode today.
- Wire `document.getElementById("btnResetShopForm").addEventListener("click",
  () => resetShopForm(false))` (this button previously had no listener at
  all).

Because `resetShopForm` becomes defined, the existing
`typeof resetShopForm === "function"` guard in `admin.html`'s inline script
(line 479) starts actually firing after a successful new-shop registration,
which is the correct existing intent (clear the form after a successful
create, but not after an update — already expressed by the `!data.updated`
condition around it).

### 5. CSS

Add to the `<style>` block in `admin.html` (co-located with the existing
`.registered-shop-*` rules at lines 96-101, matching that inline-style
convention rather than editing the separate `admin.css`):

```css
.building-card { border:1px solid #e5e7eb; border-radius:8px; background:#fff; padding:8px; }
.building-card-header { display:flex; gap:8px; align-items:flex-start; }
.building-thumb { width:40px; height:auto; border-radius:4px; flex-shrink:0; }
.building-card-title { font-size:12px; color:#333; }
.building-floor-tabs { display:flex; gap:4px; flex-wrap:wrap; margin-top:8px; }
.floor-tab { border:1px solid #e5e7eb; border-radius:6px; background:#f9fafb; padding:3px 8px; font-size:12px; cursor:pointer; }
.floor-tab.is-active { border-color:#2563eb; background:#eff6ff; color:#2563eb; font-weight:700; }
.building-shop-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(120px,1fr)); gap:6px; margin-top:8px; }
.building-shop-card { border:1px solid #e5e7eb; border-radius:6px; background:#fff; padding:6px; text-align:left; cursor:pointer; }
.building-shop-card:hover { background:#f3f4f6; }
.building-shop-card.is-active { border-color:#2563eb; background:#eff6ff; }
.building-shop-thumb { width:100%; aspect-ratio:1; object-fit:cover; border-radius:4px; background:#f0f0f0; }
.building-shop-name { font-weight:700; font-size:12px; margin-top:4px; }
.building-shop-address { font-size:11px; color:#666; margin-top:2px; }
```

Sized for the ~300px-wide sidebar panel, distinct from `public.html`'s
full-width modal styles for the same concept.

## Edge cases

- A group's shops with an empty/null `floorlevel` still appear, under a
  `階層未設定` tab, rather than being silently dropped from the building view.
- A shop with `lat`/`lng` present but `null` on only one axis is treated as
  "no valid coordinates" (excluded from grouping, rendered as a flat item) —
  same guard as `public.js:545`.
- A shop with no images renders a plain gray placeholder square in its grid
  card (CSS `background:#f0f0f0` on `.building-shop-thumb`, no `<img>` tag).
- Editing a shop that's mid-building-group and changing its lat/lng to no
  longer match the group: no special handling needed — `refreshShopList()` is
  called again after a successful save/update, which naturally re-groups from
  scratch.

## Files touched

- `app.py`: `api_migrationshop_list` (`GET /api/migrationmaps/shops`) — add
  `lat`, `lng`, `thumbnail_url` to the response.
- `static/migrationmaps/admin.js`: `normalizeFloorLevel`, `latLngGroupKey`,
  rewritten `refreshShopList()`, new `buildAdminFloorGrid()`,
  `loadShopIntoForm()`, `resetShopForm()`, and the `btnResetShopForm` listener.
- `templates/migrationmaps/admin.html`: new CSS rules only (no markup
  changes — `registeredShopList` already exists as the mount point).

## Testing

No pytest coverage exists for admin routes/JS (repo convention — see prior
migrationmaps specs' Testing sections). Manual verification against a real
dev environment:

1. Register two shops with identical lat/lng but different `floorlevel`
   values (e.g. `1F`, `2F`), plus a third shop at a different, unique lat/lng.
2. Reload the admin page's shop panel. Confirm: the two co-located shops
   render as one `.building-card` with two floor tabs in numeric order and
   the third shop still renders as a plain flat item.
3. Click each floor tab; confirm the grid below updates to show only that
   floor's shop(s), each with thumbnail (or placeholder), name, and address.
4. Click a shop card in the grid; confirm the edit form populates with that
   shop's data, existing images show as read-only previews, the form title
   reads "店舗を編集する", and the card is visually marked active.
5. Click the flat (non-grouped) shop item; confirm the same load behavior
   works there too, and the previous active highlight clears.
6. Register a shop with no `floorlevel` at a coordinate shared with another
   shop; confirm it appears under a `階層未設定` tab.
7. Click "新規入力に戻す"; confirm the form clears, title reverts to "店舗を
   新規登録する", previews clear, and the active highlight clears.
8. Submit a *new* shop registration (not an update); confirm the form resets
   afterward (this now works because `resetShopForm` is defined) and the new
   shop appears in the list/building view after the automatic refresh.
