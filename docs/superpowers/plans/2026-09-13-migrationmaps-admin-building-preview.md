# MigrationMaps Admin Building Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the MigrationMaps admin page, group registered shops that share the exact same lat/lng into a "building" preview card (default building photo + dynamic floor tabs + per-floor shop grid), and make both the new grid cards and the existing flat shop list clickable to load a shop into the edit form.

**Architecture:** One backend response gets three new fields (`lat`, `lng`, `thumbnail_url`). All grouping, tab-switching, and grid rendering happens client-side in `admin.js` against that single response — no new endpoints, no new DB queries beyond the existing `shopimages` relationship. A shared `loadShopIntoForm()`/`resetShopForm()` pair (currently missing entirely) is added so both the flat list and the new grid cards can populate the existing edit form.

**Tech Stack:** Flask + SQLAlchemy (`app.py`, `models.py`), vanilla JS (no framework, no bundler) in `static/migrationmaps/admin.js`, Jinja2 template `templates/migrationmaps/admin.html`.

**Reference:** Design spec at `docs/superpowers/specs/2026-09-13-migrationmaps-admin-building-preview-design.md`.

---

### Task 1: Backend — return lat/lng/thumbnail_url from the shop list endpoint

**Files:**
- Modify: `app.py:1753-1775` (`api_migrationshop_list`, the `GET /api/migrationmaps/shops` route)

- [ ] **Step 1: Read the current route to confirm line numbers haven't drifted**

Open `app.py` and locate `def api_migrationshop_list():`. Confirm it matches:

```python
@app.get("/api/migrationmaps/shops")
def api_migrationshop_list():
    project_id = request.args.get("project_id", type=int)

    q = MigrationShop.query.order_by(MigrationShop.updated_at.desc(), MigrationShop.id.desc())
    if project_id:
        q = q.filter(MigrationShop.map_project_id == project_id)

    shops = q.all()
    return jsonify({
        "shops": [
            {
                "id": s.id,
                "shopname": s.shopname,
                "address": s.address,
                "floorlevel": s.floorlevel,
                "map_project_id": s.map_project_id,
                "is_active": bool(s.is_active),
                "updated_at": s.updated_at.isoformat() if s.updated_at else None,
            }
            for s in shops
        ]
    })
```

If the surrounding code differs, use this as the anchor to find the right spot rather than trusting the line numbers.

- [ ] **Step 2: Add the three new fields**

Replace the dict comprehension body with:

```python
@app.get("/api/migrationmaps/shops")
def api_migrationshop_list():
    project_id = request.args.get("project_id", type=int)

    q = MigrationShop.query.order_by(MigrationShop.updated_at.desc(), MigrationShop.id.desc())
    if project_id:
        q = q.filter(MigrationShop.map_project_id == project_id)

    shops = q.all()
    return jsonify({
        "shops": [
            {
                "id": s.id,
                "shopname": s.shopname,
                "address": s.address,
                "floorlevel": s.floorlevel,
                "map_project_id": s.map_project_id,
                "is_active": bool(s.is_active),
                "updated_at": s.updated_at.isoformat() if s.updated_at else None,
                "lat": float(s.lat) if s.lat is not None else None,
                "lng": float(s.lng) if s.lng is not None else None,
                "thumbnail_url": s.shopimages[0].image_url if s.shopimages else None,
            }
            for s in shops
        ]
    })
```

`s.shopimages` is already ordered by `sort_order` at the relationship level
(`models.py:337-343`, `order_by="MapShopImages.sort_order"`), so
`shopimages[0]` is always the lowest-`sort_order` image — no new query, no
N+1 beyond the lazy-load SQLAlchemy already does when the relationship is
accessed.

- [ ] **Step 3: Verify with a read-only request against the existing dev DB**

This is a GET request — no data is written, safe to run against the
configured `DATABASE_URL` in `.env`.

Run: `flask --app app run --debug` (in one terminal, from the repo root)

Run in a second terminal:
```bash
curl -s "http://127.0.0.1:5000/api/migrationmaps/shops" | python -m json.tool | head -30
```

Expected: valid JSON, `"shops"` is a list, and each shop object now has
`"lat"`, `"lng"`, and `"thumbnail_url"` keys alongside the existing ones. If
the DB currently has zero `MigrationShop` rows, expected output is
`{"shops": []}` — in that case, skip ahead to Task 5 to register test shops
before re-checking this shape.

Stop the dev server (`Ctrl+C`) once confirmed.

- [ ] **Step 4: Commit**

```bash
git add app.py
git commit -m "feat(migrationmaps): return lat/lng/thumbnail_url from shop list API"
```

---

### Task 2: Admin CSS — building preview styles

**Files:**
- Modify: `templates/migrationmaps/admin.html:101` (append after the existing `.registered-shop-*` rules, before the `/* ---- Cloudinary picker modal ---- */` comment)

- [ ] **Step 1: Confirm the anchor text**

Open `templates/migrationmaps/admin.html` and confirm lines 96-103 read:

```html
    .registered-shop-list { display: flex; flex-direction: column; gap: 6px; max-height: 220px; overflow: auto; border: 1px solid #eee; border-radius: 8px; padding: 8px; background: #fcfcfc; }
    .registered-shop-item { border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; padding: 8px 10px; text-align: left; cursor: pointer; }
    .registered-shop-item:hover { background: #f3f4f6; }
    .registered-shop-item.is-active { border-color: #2563eb; background: #eff6ff; }
    .registered-shop-name { font-weight: 700; font-size: 13px; }
    .registered-shop-meta { margin-top: 4px; font-size: 11px; color: #666; }

    /* ---- Cloudinary picker modal ---- */
```

- [ ] **Step 2: Insert the new rules**

Insert this block immediately after `.registered-shop-meta { ... }` and
before the blank line / Cloudinary comment:

```css
    .building-card { border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; padding: 8px; }
    .building-card + .building-card,
    .building-card + .registered-shop-item,
    .registered-shop-item + .building-card { margin-top: 6px; }
    .building-card-header { display: flex; gap: 8px; align-items: flex-start; }
    .building-thumb { width: 40px; height: auto; border-radius: 4px; flex-shrink: 0; }
    .building-card-title { font-size: 12px; color: #333; line-height: 1.4; }
    .building-floor-tabs { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 8px; }
    .floor-tab { border: 1px solid #e5e7eb; border-radius: 6px; background: #f9fafb; padding: 3px 8px; font-size: 12px; cursor: pointer; }
    .floor-tab.is-active { border-color: #2563eb; background: #eff6ff; color: #2563eb; font-weight: 700; }
    .building-shop-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 6px; margin-top: 8px; }
    .building-shop-card { border: 1px solid #e5e7eb; border-radius: 6px; background: #fff; padding: 6px; text-align: left; cursor: pointer; }
    .building-shop-card:hover { background: #f3f4f6; }
    .building-shop-card.is-active { border-color: #2563eb; background: #eff6ff; }
    .building-shop-thumb { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 4px; background: #f0f0f0; }
    .building-shop-name { font-weight: 700; font-size: 12px; margin-top: 4px; }
    .building-shop-address { font-size: 11px; color: #666; margin-top: 2px; }
```

- [ ] **Step 3: Verify the page still loads**

Run: `flask --app app run --debug`, open `http://127.0.0.1:5000/migrationmaps/admin` in a browser.

Expected: page loads with no visual change yet (no `.building-card` elements
are rendered until Task 4), and no browser console errors related to CSS
parsing.

- [ ] **Step 4: Commit**

```bash
git add templates/migrationmaps/admin.html
git commit -m "style(migrationmaps): add admin building-preview CSS"
```

---

### Task 3: Admin JS — shared edit-load and reset (fixes the pre-existing dead-code gap)

**Files:**
- Modify: `static/migrationmaps/admin.js:1259-1261` (insert new code between the end of the `shopMenuToggle` click listener and the `refreshShopList` function)

- [ ] **Step 1: Confirm the anchor text**

Confirm `static/migrationmaps/admin.js` around line 1256-1261 reads:

```js
shopMenuToggle?.addEventListener("click", () => {
  const expanded = shopMenuToggle.getAttribute("aria-expanded") === "true";
  setShopMenuOpen(!expanded);
});

async function refreshShopList() {
```

- [ ] **Step 2: Insert `activeShopEl` state, `setActiveShopEl`, `loadShopIntoForm`, and `resetShopForm`**

Insert this block between the `});` that closes the `shopMenuToggle` listener
and `async function refreshShopList() {`:

```js
let activeShopEl = null;

function setActiveShopEl(el) {
  if (activeShopEl) activeShopEl.classList.remove("is-active");
  activeShopEl = el || null;
  if (activeShopEl) activeShopEl.classList.add("is-active");
}

async function loadShopIntoForm(shopId, sourceEl) {
  const res = await fetch(`/api/migrationmaps/shops/${shopId}`);
  const data = await res.json();
  if (!res.ok || !data.shop) {
    alert(`店舗情報の取得に失敗しました: ${data.error || res.status}`);
    return;
  }
  const shop = data.shop;

  $("r_shop_id").value = shop.id;
  $("r_shopname").value = shop.shopname || "";
  $("r_address").value = shop.address || "";
  $("r_floorlevel").value = shop.floorlevel || "";
  $("r_tel").value = shop.tel || "";
  $("r_email").value = shop.email || "";
  $("r_instagram").value = shop.instagram_account || "";
  $("r_lat").value = shop.lat ?? "";
  $("r_lng").value = shop.lng ?? "";
  $("r_is_active").checked = !!shop.is_active;
  $("r_description").value = shop.description || "";
  $("r_website_url").value = shop.website_url || "";
  $("r_map_project_id").value = shop.map_project_id || "";

  for (let i = 1; i <= 5; i++) {
    const preview = $(`r_preview${i}`);
    if (preview) preview.innerHTML = "";
  }
  (shop.images || []).forEach((img) => {
    const preview = $(`r_preview${img.sort_order}`);
    if (!preview) return;
    const el = document.createElement("img");
    el.src = img.image_url;
    preview.appendChild(el);
  });

  if ($("shopFormTitle")) $("shopFormTitle").textContent = "店舗を編集する";
  setShopMenuOpen(true);
  setActiveShopEl(sourceEl || null);
  $("shopRegisterForm")?.scrollIntoView({ block: "nearest" });
}

function resetShopForm(isNewMode) {
  $("shopRegisterForm")?.reset();
  if ($("r_shop_id")) $("r_shop_id").value = "";
  for (let i = 1; i <= 5; i++) {
    const preview = $(`r_preview${i}`);
    if (preview) preview.innerHTML = "";
  }
  if ($("shopFormTitle")) $("shopFormTitle").textContent = "店舗を新規登録する";
  setActiveShopEl(null);
}

$("btnResetShopForm")?.addEventListener("click", () => resetShopForm(false));

async function refreshShopList() {
```

(The last line, `async function refreshShopList() {`, is the pre-existing
line — it's included above only so the block has an unambiguous end point.
Don't duplicate it.)

`resetShopForm` accepts `isNewMode` for parity with the existing call site
in `templates/migrationmaps/admin.html:479`
(`resetShopForm(true)`), but behaves identically regardless of the argument
— there is no second mode today.

- [ ] **Step 3: Verify `resetShopForm` is reachable and the button works**

Run: `flask --app app run --debug`, open
`http://127.0.0.1:5000/migrationmaps/admin`, open the browser console.

1. Expand "☰ 店舗を登録・編集する".
2. Type something into "店名" (shopname).
3. Click "新規入力に戻す" (`btnResetShopForm`).

Expected: the shopname field clears, no console errors. (Full
`loadShopIntoForm` verification happens in Task 5, once Task 4 wires up
click handlers that call it.)

- [ ] **Step 4: Commit**

```bash
git add static/migrationmaps/admin.js
git commit -m "feat(migrationmaps): add loadShopIntoForm/resetShopForm to admin shop panel"
```

---

### Task 4: Admin JS — group shops by lat/lng and render the building preview

**Files:**
- Modify: `static/migrationmaps/admin.js` — replace the `refreshShopList` function body (originally `admin.js:1261-1279` before Task 3's insertion shifted line numbers; locate it by the `async function refreshShopList() {` signature instead of by line number) and add four new functions above it.

- [ ] **Step 1: Confirm the anchor text**

After Task 3, `refreshShopList` should read exactly:

```js
async function refreshShopList() {
  if (!registeredShopListEl) return;
  const query = currentProjectId ? `?project_id=${encodeURIComponent(currentProjectId)}` : "";
  const res = await fetch(`/api/migrationmaps/shops${query}`);
  const data = await res.json();
  registeredShopListEl.innerHTML = "";
  if (!data.shops?.length) {
    registeredShopListEl.innerHTML = `<div class="muted">登録済み店舗はありません</div>`;
    return;
  }
  for (const shop of data.shops) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "registered-shop-item";
    btn.dataset.shopId = shop.id;
    btn.innerHTML = `<div class="registered-shop-name">${shop.shopname}</div>`;
    registeredShopListEl.appendChild(btn);
  }
}

$("btnRefreshShopList")?.addEventListener("click", refreshShopList);
```

- [ ] **Step 2: Replace it with the grouping-aware version**

Replace the whole `async function refreshShopList() { ... }` block (keep
the `$("btnRefreshShopList")?.addEventListener(...)` line right after it,
unchanged) with:

Note: `escapeHtmlLocal` used below is **not** new — it already exists later
in this same file (`function escapeHtmlLocal(s) { ... }`, originally around
`admin.js:1344`, in the OSM-import section). Function declarations are
hoisted, so calling it from `refreshShopList`/`renderBuildingCard`, which
are defined earlier in the file, works correctly. Do not redefine it.

```js
function normalizeFloorLevel(value) { return String(value || "").trim().toUpperCase(); }
function latLngGroupKey(lat, lng) { return `${Number(lat).toFixed(7)},${Number(lng).toFixed(7)}`; }

function floorSortValue(floorlevel) {
  const digits = String(floorlevel || "").replace(/\D/g, "");
  return digits ? parseInt(digits, 10) : 999;
}

function buildAdminFloorGrid(groupShops, floorKey) {
  const floorShops = groupShops.filter((s) => (normalizeFloorLevel(s.floorlevel) || "階層未設定") === floorKey);
  if (!floorShops.length) return `<div class="muted">この階の店舗はありません</div>`;
  return `
    <div class="building-shop-grid">
      ${floorShops.map((shop) => `
        <button type="button" class="building-shop-card" data-shop-id="${shop.id}">
          ${shop.thumbnail_url
            ? `<img class="building-shop-thumb" src="${escapeHtmlLocal(shop.thumbnail_url)}" alt="${escapeHtmlLocal(shop.shopname)}" />`
            : `<div class="building-shop-thumb"></div>`}
          <div class="building-shop-name">${escapeHtmlLocal(shop.shopname)}</div>
          <div class="building-shop-address">${escapeHtmlLocal(shop.address || "")}</div>
        </button>
      `).join("")}
    </div>
  `;
}

function wireShopCardClicks(container, groupShops) {
  container.querySelectorAll(".building-shop-card").forEach((cardBtn) => {
    const shop = groupShops.find((s) => String(s.id) === cardBtn.dataset.shopId);
    if (!shop) return;
    cardBtn.addEventListener("click", () => loadShopIntoForm(shop.id, cardBtn));
  });
}

function renderBuildingCard(groupShops) {
  const card = document.createElement("div");
  card.className = "building-card";

  const floorKeys = [];
  groupShops.forEach((s) => {
    const key = normalizeFloorLevel(s.floorlevel) || "階層未設定";
    if (!floorKeys.includes(key)) floorKeys.push(key);
  });
  floorKeys.sort((a, b) => {
    if (a === "階層未設定") return 1;
    if (b === "階層未設定") return -1;
    return floorSortValue(a) - floorSortValue(b);
  });

  card.innerHTML = `
    <div class="building-card-header">
      <img class="building-thumb" src="/static/img/migrationmaps_buildingimage.jpg" alt="ビル" />
      <div class="building-card-title">${escapeHtmlLocal(groupShops[0].address || "")}<br>${groupShops.length}件の店舗</div>
    </div>
    <div class="building-floor-tabs">
      ${floorKeys.map((f, idx) => `<button type="button" class="floor-tab${idx === 0 ? " is-active" : ""}" data-floor="${escapeHtmlLocal(f)}">${escapeHtmlLocal(f)}</button>`).join("")}
    </div>
    <div class="building-shop-grid-wrap"></div>
  `;

  const gridWrap = card.querySelector(".building-shop-grid-wrap");
  const renderGrid = (floorKey) => {
    gridWrap.innerHTML = buildAdminFloorGrid(groupShops, floorKey);
    wireShopCardClicks(gridWrap, groupShops);
  };
  renderGrid(floorKeys[0]);

  card.querySelectorAll(".floor-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      card.querySelectorAll(".floor-tab").forEach((t) => t.classList.remove("is-active"));
      tab.classList.add("is-active");
      renderGrid(tab.dataset.floor);
    });
  });

  return card;
}

async function refreshShopList() {
  if (!registeredShopListEl) return;
  const query = currentProjectId ? `?project_id=${encodeURIComponent(currentProjectId)}` : "";
  const res = await fetch(`/api/migrationmaps/shops${query}`);
  const data = await res.json();
  registeredShopListEl.innerHTML = "";
  if (!data.shops?.length) {
    registeredShopListEl.innerHTML = `<div class="muted">登録済み店舗はありません</div>`;
    return;
  }

  const groups = new Map();
  for (const shop of data.shops) {
    const lat = Number(shop.lat);
    const lng = Number(shop.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const key = latLngGroupKey(lat, lng);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(shop);
  }

  const renderedGroupKeys = new Set();
  for (const shop of data.shops) {
    const lat = Number(shop.lat);
    const lng = Number(shop.lng);
    const key = (Number.isFinite(lat) && Number.isFinite(lng)) ? latLngGroupKey(lat, lng) : null;
    const groupShops = key ? groups.get(key) : null;

    if (groupShops && groupShops.length >= 2) {
      if (renderedGroupKeys.has(key)) continue;
      renderedGroupKeys.add(key);
      registeredShopListEl.appendChild(renderBuildingCard(groupShops));
      continue;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "registered-shop-item";
    btn.dataset.shopId = shop.id;
    btn.innerHTML = `<div class="registered-shop-name">${escapeHtmlLocal(shop.shopname)}</div>`;
    btn.addEventListener("click", () => loadShopIntoForm(shop.id, btn));
    registeredShopListEl.appendChild(btn);
  }
}

$("btnRefreshShopList")?.addEventListener("click", refreshShopList);
```

This preserves the original `updated_at desc` ordering from the API response
— each building card renders at the position of its first-encountered
member shop, instead of sorting all buildings after all flat items.

- [ ] **Step 3: Verify no syntax errors**

Run: `flask --app app run --debug`, open
`http://127.0.0.1:5000/migrationmaps/admin`, open the browser console, expand
"☰ 店舗を登録・編集する".

Expected: no console errors on load; whatever shops currently exist in the
DB still render (as flat items, since none are expected to share lat/lng
yet). Full building-card behavior is verified in Task 5 after test data
exists.

- [ ] **Step 4: Commit**

```bash
git add static/migrationmaps/admin.js
git commit -m "feat(migrationmaps): group co-located shops into a building preview card"
```

---

### Task 5: End-to-end manual verification

This repo has no pytest coverage for admin routes/JS and no browser-test
harness (confirmed: no `package.json`, no Flask test client usage anywhere
in `tests/`) — all prior MigrationMaps admin-UI work in this repo was
verified manually against a real dev environment, per
`docs/superpowers/specs/2026-09-12-migrationmaps-capture-shop-link-design.md`'s
Testing section. Follow the same convention here.

**Heads up before starting:** the `DATABASE_URL` in `.env` points to a real,
shared database (not a disposable local one) — registering shops through the
admin UI during this verification writes real rows to it. Use clearly
throwaway names (e.g. prefix `【確認用】`) so they're easy to identify, and
get explicit confirmation before running any cleanup `DELETE`, since that's
a mutation against shared state.

- [ ] **Step 1: Start the dev server**

```bash
flask --app app run --debug
```

- [ ] **Step 2: Register two co-located test shops with different floors**

Open `http://127.0.0.1:5000/migrationmaps/admin`, expand "☰ 店舗を登録・編集す
る", and submit the form twice with:

- Shop A: 店名=`【確認用】ビルA-1F店`, 住所=`福井県福井市大手1丁目1-1`,
  階層=`1F`, メール=`test-a@example.com`, 緯度=`36.0641`, 経度=`136.2229`,
  イラスト地図ID = any existing valid project ID in the DB (check
  `GET /api/migrationmaps/projects` if unsure).
- Shop B: same 住所/緯度/経度 as Shop A, 店名=`【確認用】ビルA-2F店`,
  階層=`2F`, メール=`test-b@example.com`, same イラスト地図ID.

Also register a third shop at a **different** lat/lng
(e.g. 緯度=`36.0700`, 経度=`136.2300`) named `【確認用】単独店` to confirm
non-grouped shops are unaffected.

- [ ] **Step 3: Verify the building card renders**

Click "一覧更新" (`btnRefreshShopList`) if the list doesn't refresh
automatically.

Expected:
- Shop A and Shop B render as **one** `.building-card`: default building
  thumbnail, address text, "2件の店舗", two floor tabs reading `1F` and `2F`
  in that order (first tab active).
- `【確認用】単独店` renders as a plain flat `.registered-shop-item`, unchanged
  from before.

- [ ] **Step 4: Verify floor tab switching**

Click the `2F` tab.

Expected: the grid below updates to show only Shop B (thumbnail placeholder
— no image uploaded — shop name, address). Click `1F` again; Shop A
reappears, Shop B disappears from the grid.

- [ ] **Step 5: Verify click-to-edit from the grid**

With `1F` active, click Shop A's card in the grid.

Expected: the edit form below populates with Shop A's values (shopname,
address, floorlevel=`1F`, email, lat/lng, map_project_id), the form title
changes to "店舗を編集する", and Shop A's card gets a visible active
highlight (blue border/background per `.building-shop-card.is-active`).

- [ ] **Step 6: Verify click-to-edit from the flat list**

Click `【確認用】単独店` in the flat list.

Expected: same behavior — form populates with that shop's data, title reads
"店舗を編集する", and the highlight moves from Shop A's card to this item
(only one highlighted element at a time).

- [ ] **Step 7: Verify reset**

Click "新規入力に戻す".

Expected: form clears, title reverts to "店舗を新規登録する", and the
active highlight clears from `【確認用】単独店`.

- [ ] **Step 8: Verify a floor with no registered shops among co-located ones does not appear**

Confirm no tab other than `1F`/`2F` appears on the Shop A/B building card
(no empty `3F` tab, etc.) — tabs are driven only by floors actually present,
per the design's non-goal of not hard-coding three floors.

- [ ] **Step 9: Verify an empty-`floorlevel` shop buckets into "階層未設定"**

Register a fourth shop at the same lat/lng as Shop A/B
(`【確認用】ビルA-階層未設定店`, 階層 left blank, メール=`test-c@example.com`).
Refresh the list.

Expected: the building card now shows three tabs: `1F`, `2F`, `階層未設定`
(in that order — the unset-floor tab last), and clicking `階層未設定` shows
only this fourth shop.

- [ ] **Step 10: Clean up the test data**

Stop and confirm with the user before running any DELETE against the shared
DB. Once confirmed, from a `psql` session (or via a short Python REPL using
the app's `db` session) remove the four test rows created in Steps 2 and 9,
e.g.:

```sql
DELETE FROM mapshopimages WHERE migrationshop_id IN (
  SELECT id FROM migrationshop WHERE shopname LIKE '【確認用】%'
);
DELETE FROM migrationshop WHERE shopname LIKE '【確認用】%';
```

- [ ] **Step 11: Stop the dev server**

`Ctrl+C` in the terminal running `flask --app app run --debug`.

No commit for this task — it's verification only, no code changes.
