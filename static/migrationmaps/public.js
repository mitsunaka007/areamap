// ================================================================
// MigrationMaps Public JS — デュアルレイヤー + 時間切替対応
// ================================================================

// ---- Leaflet 地図初期化 ----
const map = L.map("map", {
  zoomControl: true,
  maxZoom: 22,
  maxBoundsViscosity: 1.0,
}).setView([35.0, 135.0], 14);

// ペイン構成（z-index順）
// 200: OSMタイル（デフォルト）
// 300: maskPane — イラスト地図の外側を隠すマスク
// 450: layer1OverlayPane — レイヤー1
// 451: layer2OverlayPane — レイヤー2
// 650: migrationMarkerPane — 店舗マーカー

map.createPane("maskPane");
map.getPane("maskPane").style.zIndex = 300;
map.getPane("maskPane").style.pointerEvents = "none";

map.createPane("layer1OverlayPane");
map.getPane("layer1OverlayPane").style.zIndex = 450;
map.getPane("layer1OverlayPane").style.pointerEvents = "none";

map.createPane("layer2OverlayPane");
map.getPane("layer2OverlayPane").style.zIndex = 451;
map.getPane("layer2OverlayPane").style.pointerEvents = "none";

map.createPane("migrationMarkerPane");
map.getPane("migrationMarkerPane").style.zIndex = 650;

map.createPane("routePane");
map.getPane("routePane").style.zIndex = 600;   // 451(overlay) < 600 < 650(marker)
map.getPane("routePane").style.pointerEvents = "none";

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxNativeZoom: 19,
  maxZoom: 22,
}).addTo(map);

// ----------------------------------------------------------------
// 状態変数
// ----------------------------------------------------------------

const OVERLAY_OPACITY = 0.88;
const TRANSITION_DURATION_MS = 10000; // 10秒フェード（admin.html の説明文と一致させる）

// 同一緯度経度のテナントビル（1F・2F・3F などに複数店舗が入居）で、
// 明示的な BuildingGuide 画像が無いときにマーカークリックで表示する既定のビル画像。
const DEFAULT_BUILDING_IMAGE_URL = "/static/img/migrationmaps_buildingimage.jpg";

let overlay1 = null;          // Layer 1 L.imageOverlay
let overlay2 = null;          // Layer 2 L.imageOverlay
let maskLayer = null;

let projectData = null;
let overlayLatLngBounds = null; // Layer 1 の表示範囲（現在地判定用）
let overlayCorners = null;

let shopData = [];
let groupedShopsCache = {};
const shopMarkers = new Map();

let locationEnabled = false;
let locationWatchId = null;
let currentLocationMarker = null;
let currentLocationCircle = null;

let autoShownGroupKey = null;
let userClosedGuide = false;
const PROXIMITY_METERS = 50;

// ---- ナビ拡張 ----
const OSRM_BASE             = "https://router.project-osrm.org/route/v1/foot/"; // https 必須
const ARRIVE_NOTICE_METERS  = 30;    // 方向通知を出す距離
const ARRIVED_METERS        = 10;    // 到着とみなす距離
const MARKER_EXPAND_METERS  = 20;    // 店名を展開する距離
const HEADING_MIN_MOVE_M    = 5;     // 座標差分から進行方向を出す最小移動量
const HEADING_STALE_MS      = 20000; // これ以上古い進行方向は使わない
const NOTICE_REPEAT_MS      = 10000; // 同じ通知を再表示する間隔
const ROUTE_MIN_INTERVAL_MS = 15000; // OSRM 再問い合わせの最短間隔
const ROUTE_MIN_MOVE_M      = 25;    // これだけ動いたら経路を引き直す

// groupKey -> { mode: "normal" | "active" | "dimmed", expanded: boolean }
const markerStates = new Map();

let destination   = null;   // { key, lat, lng, name }
let routeLayer    = null;
let routeSeq      = 0;
let lastRouteAt   = 0;
let lastRouteFrom = null;   // { lat, lng }
let lastPos       = null;   // { lat, lng }
let headingDeg    = null;   // 0=北, 時計回り
let headingAt     = 0;
let headingBase   = null;   // 座標差分の基準点
let lastNoticeMsg = "";
let lastNoticeAt  = 0;
let toastTimer    = null;
let locationFabEl = null;

// ボトムシートに今表示しているグループ
let guideGroupKey   = null;
let guideGroupShops = null;

// レイヤー切替
let currentActiveLayer = 1;     // 現在表示中のレイヤー (1 or 2)
let isTransitioning = false;
let switchTimes = null;         // { t1to2: "HH:MM" | null, t2to1: "HH:MM" | null }
let autoSwitchTimer = null;

// ----------------------------------------------------------------
// DOM 参照
// ----------------------------------------------------------------

const titleEl = document.getElementById("title");
const btnToggleLocation = document.getElementById("btnToggleLocation");
const locationStatusEl = document.getElementById("locationStatus");
const buildingGuideEl = document.getElementById("buildingGuide");
const buildingGuideCloseEl = document.getElementById("buildingGuideClose");
const buildingPhotoWrapEl = document.getElementById("buildingPhotoWrap");
const floorShopGridEl = document.getElementById("floorShopGrid");
const btnToggleLayer = document.getElementById("btnToggleLayer");
const layerIndicatorEl = document.getElementById("layerIndicator");

const btnSetDestination = document.getElementById("btnSetDestination");
const navBannerEl       = document.getElementById("navBanner");
const navBannerTextEl   = document.getElementById("navBannerText");
const navBannerClearEl  = document.getElementById("navBannerClear");
const navToastEl        = document.getElementById("navToast");

// ----------------------------------------------------------------
// ユーティリティ
// ----------------------------------------------------------------

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function normalizeFloorLevel(value) { return String(value || "").trim().toUpperCase(); }
function latLngGroupKey(lat, lng) { return `${Number(lat).toFixed(7)},${Number(lng).toFixed(7)}`; }
function sanitizeTel(tel) { return String(tel ?? "").replace(/[^\d+]/g, ""); }

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** (lat1,lng1) から (lat2,lng2) を見た方位角[deg]（0=北, 時計回り） */
function bearingDeg(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const p1 = toRad(lat1), p2 = toRad(lat2), dl = toRad(lng2 - lng1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** -180 < deg <= 180 に正規化 */
function normalizeDeg(deg) { return ((deg + 180) % 360 + 360) % 360 - 180; }

/** 進行方向 heading に対する方位 target の相対方角を日本語で返す */
function relativeSideLabel(heading, target) {
  const rel = normalizeDeg(target - heading);
  const abs = Math.abs(rel);
  if (abs <= 25)  return "正面";
  if (abs >= 155) return "後ろ";
  if (abs <= 70)  return rel > 0 ? "右斜め前" : "左斜め前";
  if (abs <= 110) return rel > 0 ? "右側"     : "左側";
  return rel > 0 ? "右斜め後ろ" : "左斜め後ろ";
}

function timeToMinutes(timeStr) {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

// ----------------------------------------------------------------
// レイヤー切替ロジック
// ----------------------------------------------------------------

/**
 * 現在時刻に基づき、どのレイヤーを表示すべきかを計算する。
 * switch_time_1to2 と switch_time_2to1 の両方が設定されている場合、
 * 日をまたぐケース（例: 23:00→06:00）も正しく処理する。
 */
function computeTargetLayer() {
  if (!overlay2 || !switchTimes?.t1to2) return 1;

  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const t1 = timeToMinutes(switchTimes.t1to2);
  const t2 = timeToMinutes(switchTimes.t2to1);

  if (t1 === null) return 1;
  if (t2 === null) return cur >= t1 ? 2 : 1;

  if (t1 < t2) {
    // 同日内: [t1, t2) の間はレイヤー2
    return (cur >= t1 && cur < t2) ? 2 : 1;
  } else {
    // 日またぎ: [t1, 翌t2) の間はレイヤー2
    return (cur >= t1 || cur < t2) ? 2 : 1;
  }
}

/**
 * 10秒かけてレイヤーを切り替える（requestAnimationFrame フェード）。
 * animate=false なら即時切り替え。
 */
function transitionToLayer(targetLayer, animate = true) {
  if (isTransitioning) return;
  if (targetLayer === currentActiveLayer) return;
  if (targetLayer === 2 && !overlay2) return;

  const fromOverlay = targetLayer === 2 ? overlay1 : overlay2;
  const toOverlay   = targetLayer === 2 ? overlay2 : overlay1;
  if (!toOverlay) return;

  if (!animate) {
    if (fromOverlay) fromOverlay.setOpacity(0);
    toOverlay.setOpacity(OVERLAY_OPACITY);
    currentActiveLayer = targetLayer;
    updateLayerToggleButton();
    return;
  }

  isTransitioning = true;
  if (layerIndicatorEl) {
    layerIndicatorEl.hidden = false;
    layerIndicatorEl.textContent = `レイヤー${targetLayer}へ切り替え中…`;
  }

  // フェード開始時点のopacity
  const fromStart = fromOverlay ? fromOverlay.options.opacity ?? OVERLAY_OPACITY : OVERLAY_OPACITY;
  const toStart   = toOverlay.options.opacity ?? 0;
  toOverlay.setOpacity(toStart);

  const startTime = performance.now();

  function tick(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / TRANSITION_DURATION_MS, 1);

    if (fromOverlay) fromOverlay.setOpacity(fromStart * (1 - progress));
    toOverlay.setOpacity(toStart + (OVERLAY_OPACITY - toStart) * progress);

    if (progress < 1) {
      requestAnimationFrame(tick);
    } else {
      if (fromOverlay) fromOverlay.setOpacity(0);
      toOverlay.setOpacity(OVERLAY_OPACITY);
      currentActiveLayer = targetLayer;
      isTransitioning = false;
      if (layerIndicatorEl) layerIndicatorEl.hidden = true;
      updateLayerToggleButton();
    }
  }

  requestAnimationFrame(tick);
}

function updateLayerToggleButton() {
  if (!btnToggleLayer) return;
  btnToggleLayer.textContent = currentActiveLayer === 1
    ? "レイヤー2へ切替"
    : "レイヤー1へ切替";
}

/** 毎分呼ばれる時間チェック — 目標レイヤーが現在と異なれば自動切替 */
function checkTimedLayerSwitch() {
  if (!switchTimes?.t1to2 || !overlay2) return;
  const target = computeTargetLayer();
  if (target !== currentActiveLayer && !isTransitioning) {
    transitionToLayer(target, true);
  }
}

// 手動切替ボタン
btnToggleLayer?.addEventListener("click", () => {
  if (isTransitioning) return;
  const target = currentActiveLayer === 1 ? 2 : 1;
  transitionToLayer(target, true);
});

// ----------------------------------------------------------------
// HTML ビルダー（ショップ情報）
// ----------------------------------------------------------------

function buildTelPart(shop) {
  const telRaw = (shop.tel || "").trim();
  if (!telRaw) return `<span class="shop-muted">-</span>`;
  const telHref = sanitizeTel(telRaw);
  if (!telHref) return `<span>${escapeHtml(telRaw)}</span>`;
  return `<a href="tel:${escapeHtml(telHref)}" class="shop-link">${escapeHtml(telRaw)}</a>`;
}

function buildInstagramPart(shop) {
  const igRaw = (shop.instagram_account || "").trim();
  if (!igRaw) return `<span class="shop-muted">-</span>`;
  const account = igRaw.replace(/^@/, "");
  const igHref = `https://www.instagram.com/${encodeURIComponent(account)}/`;
  const label = igRaw.startsWith("@") ? igRaw : `@${igRaw}`;
  return `<a href="${igHref}" target="_blank" rel="noopener noreferrer" class="shop-link">${escapeHtml(label)}</a>`;
}

function buildImageGrid(shop) {
  const images = Array.isArray(shop.images) ? shop.images : [];
  if (!images.length) return "";
  return `
    <div class="shop-image-grid">
      ${images.map((img) => `
        <a href="${escapeHtml(img.image_url)}" target="_blank" rel="noopener noreferrer" class="shop-image-card">
          <img src="${escapeHtml(img.image_url)}" alt="${escapeHtml(shop.shopname || "shop image")}" loading="lazy" />
        </a>
      `).join("")}
    </div>
  `;
}

function buildShopSummary(shop) {
  return `
    <div class="shop-summary">
      <div class="shop-name">${escapeHtml(shop.shopname || "店名未設定")}</div>
      <div class="shop-meta"><span class="shop-label">階</span><span>${escapeHtml(shop.floorlevel || "-")}</span></div>
      <div class="shop-meta"><span class="shop-label">住所</span><span>${escapeHtml(shop.address || "-")}</span></div>
      <div class="shop-meta"><span class="shop-label">TEL</span><span>${buildTelPart(shop)}</span></div>
      <div class="shop-meta"><span class="shop-label">Instagram</span><span>${buildInstagramPart(shop)}</span></div>
    </div>
  `;
}

function buildHotspotStyle(floor) {
  const hasPct = floor.area_x_pct != null && floor.area_y_pct != null
    && floor.area_width_pct != null && floor.area_height_pct != null;
  if (hasPct) {
    const w = Math.max(Number(floor.area_width_pct), 4);
    const h = Math.max(Number(floor.area_height_pct), 3);
    return `left:${Number(floor.area_x_pct)}%;top:${Number(floor.area_y_pct)}%;width:${w}%;height:${h}%;`;
  }
  const x = Number(floor.area_x || 0);
  const y = Number(floor.area_y || 0);
  const w = Math.max(Number(floor.area_width || 72), 48);
  const h = Math.max(Number(floor.area_height || 36), 28);
  return `left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;
}

function getFloorDisplayOrder(groupShops, guide) {
  const floorMap = new Map();
  (guide?.floors || []).forEach((f) => {
    const key = normalizeFloorLevel(f.floorlevel);
    if (key) floorMap.set(key, f);
  });
  const syntheticKeys = new Set();
  groupShops.forEach((s) => {
    const key = normalizeFloorLevel(s.floorlevel);
    if (key && !floorMap.has(key)) {
      floorMap.set(key, { floorlevel: key });
      syntheticKeys.add(key);
    }
  });
  const ordered = [...floorMap.values()].sort((a, b) => {
    const av = parseInt(String(a.floorlevel).replace(/\D/g, "") || "999", 10);
    const bv = parseInt(String(b.floorlevel).replace(/\D/g, "") || "999", 10);
    return av - bv;
  });
  // ホットスポット座標が未登録のフロアは、ビル画像の左端に縦へ等間隔で仮配置する
  const synthetic = ordered.filter((f) => syntheticKeys.has(normalizeFloorLevel(f.floorlevel)));
  synthetic.forEach((f, i) => {
    const gap = 92 / synthetic.length;
    f.area_x_pct = 4;
    f.area_y_pct = 4 + gap * i;
    f.area_width_pct = 22;
    f.area_height_pct = Math.max(Math.min(gap - 4, 16), 8);
  });
  return ordered;
}

// ---- 既定ビル画像専用: 1F/2F/3F は画像の高さバンドに固定、それ以外は左端に自動縦積み ----
const FIXED_FLOOR_BANDS = {
  "3F": { area_x_pct: 0, area_y_pct: 0,  area_width_pct: 100, area_height_pct: 30 },
  "2F": { area_x_pct: 0, area_y_pct: 35, area_width_pct: 100, area_height_pct: 30 },
  "1F": { area_x_pct: 0, area_y_pct: 70, area_width_pct: 100, area_height_pct: 30 },
};

function getDefaultBuildingFloorLayout(groupShops) {
  const keys = [];
  groupShops.forEach((s) => {
    const key = normalizeFloorLevel(s.floorlevel);
    if (key && !keys.includes(key)) keys.push(key);
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

function buildFloorGridSection(groupShops, floorlevel) {
  const floorKey = normalizeFloorLevel(floorlevel);
  const floorShops = groupShops.filter((s) => normalizeFloorLevel(s.floorlevel) === floorKey);
  if (!floorShops.length) return `<div class="shop-grid-empty">この階の店舗はありません</div>`;
  return `
    <div class="floor-shop-list">
      ${floorShops.map((shop) => `
        <section class="floor-shop-card">
          ${buildShopSummary(shop)}
          ${buildImageGrid(shop)}
        </section>
      `).join("")}
    </div>
  `;
}

// ----------------------------------------------------------------
// Building Guide パネル
// ----------------------------------------------------------------

const MARKER_ICON_SPEC = {
  normal: { className: "shop-marker-normal", size: 28 },
  active: { className: "shop-marker-active", size: 36 },
  dimmed: { className: "shop-marker-dimmed", size: 16 },
};

function getMarkerState(groupKey) {
  let st = markerStates.get(groupKey);
  if (!st) { st = { mode: "normal", expanded: false }; markerStates.set(groupKey, st); }
  return st;
}

/** 状態（mode + expanded）からアイコンを組み立てる */
function buildMarkerIcon(groupKey) {
  const st = getMarkerState(groupKey);
  const spec = MARKER_ICON_SPEC[st.mode] || MARKER_ICON_SPEC.normal;
  const opts = {
    className: spec.className + (st.expanded ? " is-expanded" : ""),
    iconSize: [spec.size, spec.size],
    iconAnchor: [spec.size / 2, spec.size],
  };
  if (st.expanded) {
    const shops = groupedShopsCache[groupKey] || [];
    const name  = shops[0]?.shopname || "";
    const extra = shops.length > 1 ? `<i class="shop-marker-count">+${shops.length - 1}</i>` : "";
    opts.html = `<span class="shop-marker-label">${escapeHtml(name)}${extra}</span>`;
  }
  return L.divIcon(opts);
}

/** 状態が変わったときだけ setIcon する（毎回呼ぶとチラつく） */
function applyMarkerIcon(groupKey) {
  const marker = shopMarkers.get(groupKey);
  if (marker) marker.setIcon(buildMarkerIcon(groupKey));
}

function setMarkerMode(groupKey, mode) {
  const st = getMarkerState(groupKey);
  if (st.mode === mode) return;
  st.mode = mode;
  applyMarkerIcon(groupKey);
}

/** 展開状態は保持したまま、選択状態だけ通常に戻す */
function resetMarkerIcons() {
  shopMarkers.forEach((_, groupKey) => setMarkerMode(groupKey, "normal"));
}

/** 現在地から一定距離以内のマーカーだけ店名を展開する（要件4） */
function updateMarkerExpansion(lat, lng) {
  shopMarkers.forEach((_, groupKey) => {
    const shops = groupedShopsCache[groupKey];
    if (!shops || !shops.length) return;
    const st = getMarkerState(groupKey);
    const d = haversineMeters(lat, lng, Number(shops[0].lat), Number(shops[0].lng));
    const should = d <= MARKER_EXPAND_METERS;
    if (should !== st.expanded) { st.expanded = should; applyMarkerIcon(groupKey); }
  });
}

function collapseAllMarkers() {
  markerStates.forEach((st, groupKey) => {
    if (st.expanded) { st.expanded = false; applyMarkerIcon(groupKey); }
  });
}

function hideBuildingGuide() {
  buildingGuideEl.hidden = true;
  userClosedGuide = true;
  resetMarkerIcons();
}

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

function showBuildingGuide(groupShops, groupKey) {
  const guide = groupShops[0]?.building_guide || null;
  buildingPhotoWrapEl.innerHTML = "";
  floorShopGridEl.innerHTML = "";

  const isMultiTenant = Array.isArray(groupShops) && groupShops.length > 1;

  if (guide && guide.image_url) {
    renderCustomGuidePhoto(groupShops, guide);
  } else if (isMultiTenant) {
    renderDefaultBuildingPhoto(groupShops);
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

// ----------------------------------------------------------------
// ショップマーカー
// ----------------------------------------------------------------

function addShopMarkers() {
  if (!Array.isArray(shopData) || shopData.length === 0) return;
  const validShops = shopData.filter((s) => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng)));
  groupedShopsCache = validShops.reduce((acc, shop) => {
    const key = latLngGroupKey(shop.lat, shop.lng);
    if (!acc[key]) acc[key] = [];
    acc[key].push(shop);
    return acc;
  }, {});

  shopMarkers.clear();
  markerStates.clear();

  Object.entries(groupedShopsCache).forEach(([groupKey, shopsAtSamePoint]) => {
    const lat = Number(shopsAtSamePoint[0].lat);
    const lng = Number(shopsAtSamePoint[0].lng);
    const marker = L.marker([lat, lng], {
      pane: "migrationMarkerPane",
      icon: buildMarkerIcon(groupKey),
    }).addTo(map);
    shopMarkers.set(groupKey, marker);

    marker.on("click", () => {
      shopMarkers.forEach((m, key) => setMarkerMode(key, key === groupKey ? "active" : "dimmed"));
      showBuildingGuide(shopsAtSamePoint, groupKey);
    });
  });
}

// ----------------------------------------------------------------
// 目的地・ルーティング
// ----------------------------------------------------------------

/** OSRM に経路を問い合わせる。失敗時は例外を投げる */
async function fetchRoute(fromLat, fromLng, toLat, toLng) {
  const url = `${OSRM_BASE}${fromLng},${fromLat};${toLng},${toLat}`
            + "?overview=full&geometries=geojson&alternatives=false&steps=false";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
    const json = await res.json();
    if (json.code !== "Ok" || !json.routes?.length) throw new Error(`OSRM code ${json.code}`);
    return json.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
  } finally {
    clearTimeout(timer);
  }
}

function clearRouteLayer() {
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
}

/** 経路線を描く。fallback=true なら直線（点線） */
function drawRoute(latlngs, fallback) {
  clearRouteLayer();
  routeLayer = L.polyline(latlngs, {
    pane: "routePane",
    color: fallback ? "#8a8f96" : "#1e88e5",
    weight: fallback ? 4 : 6,
    opacity: 0.85,
    lineCap: "round",
    lineJoin: "round",
    dashArray: fallback ? "6,8" : null,
    interactive: false,
  }).addTo(map);
  // 地図は fitMapForViewport で maxBounds / minZoom を固定済みなので fitBounds は呼ばない
}

/** 現在地→目的地の経路を（必要なら）取り直す */
async function refreshRoute(force) {
  if (!destination || !lastPos || !locationEnabled) return;

  const now = Date.now();
  if (!force) {
    if (now - lastRouteAt < ROUTE_MIN_INTERVAL_MS) return;
    if (lastRouteFrom &&
        haversineMeters(lastPos.lat, lastPos.lng, lastRouteFrom.lat, lastRouteFrom.lng) < ROUTE_MIN_MOVE_M) return;
  }

  lastRouteAt = now;
  const from = { lat: lastPos.lat, lng: lastPos.lng };
  lastRouteFrom = from;
  const seq = ++routeSeq;

  try {
    const latlngs = await fetchRoute(from.lat, from.lng, destination.lat, destination.lng);
    if (seq !== routeSeq) return;                  // 古いレスポンスは捨てる
    drawRoute(latlngs, false);
  } catch (err) {
    if (seq !== routeSeq) return;
    console.warn("[public.js] routing failed:", err);
    drawRoute([[from.lat, from.lng], [destination.lat, destination.lng]], true);
    showNavToast("経路が取得できないため直線で表示しています");
  }
}

function setDestination(groupKey, lat, lng, name) {
  destination   = { key: groupKey, lat, lng, name: name || "目的地" };
  lastRouteFrom = null;
  lastRouteAt   = 0;
  lastNoticeMsg = "";
  updateNavBanner();
  syncDestinationButton();

  if (!locationEnabled) { showNavToast("現在地表示をONにすると経路を表示します"); return; }
  if (!lastPos)         { showNavToast("現在地を取得しています…"); return; }
  refreshRoute(true);
}

function clearDestination() {
  destination   = null;
  lastNoticeMsg = "";
  clearRouteLayer();
  updateNavBanner();
  syncDestinationButton();
}

/** ボトムシートの目的地ボタンを現在の状態に合わせる */
function syncDestinationButton() {
  if (!btnSetDestination) return;
  if (!guideGroupKey) { btnSetDestination.hidden = true; return; }
  const isCurrent = !!destination && destination.key === guideGroupKey;
  btnSetDestination.hidden = false;
  btnSetDestination.textContent = isCurrent ? "目的地を解除" : "ここを目的地に設定";
  btnSetDestination.classList.toggle("is-active", isCurrent);
}

btnSetDestination?.addEventListener("click", () => {
  if (!guideGroupKey || !guideGroupShops?.length) return;
  if (destination && destination.key === guideGroupKey) { clearDestination(); return; }
  const head = guideGroupShops[0];
  setDestination(
    guideGroupKey,
    Number(head.lat),
    Number(head.lng),
    head.building_guide?.building_name || head.shopname || "目的地"
  );
});

navBannerClearEl?.addEventListener("click", clearDestination);

// ---- 進行方向と接近通知（要件3） ----

/** 位置更新のたびに進行方向を更新する */
function updateHeading(lat, lng, coords) {
  const h = coords?.heading;
  const moving = coords?.speed == null || coords.speed > 0.3;
  // 1) GPS が heading を返していて、実際に動いていればそれを使う
  if (typeof h === "number" && !Number.isNaN(h) && moving) {
    headingDeg = h;
    headingAt = Date.now();
    headingBase = { lat, lng };
    return;
  }
  // 2) 返さない端末（iOS Safari など）は直近の座標差分から求める
  if (!headingBase) { headingBase = { lat, lng }; return; }
  if (haversineMeters(headingBase.lat, headingBase.lng, lat, lng) >= HEADING_MIN_MOVE_M) {
    headingDeg = bearingDeg(headingBase.lat, headingBase.lng, lat, lng);
    headingAt = Date.now();
    headingBase = { lat, lng };
  }
}

function headingIsFresh() {
  return headingDeg !== null && (Date.now() - headingAt) <= HEADING_STALE_MS;
}

/** 目的地までの距離を見て、バナー更新・方向通知・到着判定を行う */
function updateNavigation(lat, lng) {
  if (!destination) return;

  const dist = haversineMeters(lat, lng, destination.lat, destination.lng);
  updateNavBanner(dist);

  if (dist <= ARRIVED_METERS) {
    showNavToast(`${destination.name} に到着しました`);
    navigator.vibrate?.([60, 40, 60]);
    clearDestination();
    return;
  }
  if (dist > ARRIVE_NOTICE_METERS) { lastNoticeMsg = ""; return; }  // 離れたら通知状態リセット

  const msg = headingIsFresh()
    ? `${destination.name} は${relativeSideLabel(headingDeg, bearingDeg(lat, lng, destination.lat, destination.lng))}です（約${Math.round(dist)}m）`
    : `${destination.name} まで約${Math.round(dist)}m`;

  const now = Date.now();
  if (msg !== lastNoticeMsg || now - lastNoticeAt > NOTICE_REPEAT_MS) {
    if (msg !== lastNoticeMsg) navigator.vibrate?.(60);
    lastNoticeMsg = msg;
    lastNoticeAt = now;
    showNavToast(msg, 6000);
  }
}

// ---- トースト / バナー ----

function showNavToast(text, ms) {
  if (!navToastEl) return;
  navToastEl.textContent = text;
  navToastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { navToastEl.hidden = true; }, ms || 4000);
}

function hideNavToast() {
  if (navToastEl) navToastEl.hidden = true;
  clearTimeout(toastTimer);
}

function updateNavBanner(dist) {
  if (!navBannerEl || !navBannerTextEl) return;
  if (!destination) { navBannerEl.hidden = true; return; }
  navBannerEl.hidden = false;
  if (!locationEnabled)   navBannerTextEl.textContent = `目的地: ${destination.name}（現在地OFF）`;
  else if (dist == null)  navBannerTextEl.textContent = `目的地: ${destination.name}`;
  else                    navBannerTextEl.textContent = `目的地: ${destination.name} / 約${Math.round(dist)}m`;
}

// ----------------------------------------------------------------
// 現在地
// ----------------------------------------------------------------

function clearCurrentLocationLayers() {
  if (currentLocationMarker) { map.removeLayer(currentLocationMarker); currentLocationMarker = null; }
  if (currentLocationCircle) { map.removeLayer(currentLocationCircle); currentLocationCircle = null; }
}

function stopLocationWatch() {
  if (locationWatchId !== null) { navigator.geolocation.clearWatch(locationWatchId); locationWatchId = null; }
  locationEnabled = false;
  clearCurrentLocationLayers();

  // ルート・展開マーカー・通知もまとめてクリア（目的地自体は保持）
  clearRouteLayer();
  collapseAllMarkers();
  hideNavToast();
  lastPos = null;
  headingDeg = null;
  headingBase = null;
  updateNavBanner();

  updateLocationButtons();
  locationStatusEl.textContent = "現在地表示はOFFです";
}

function checkProximityToShops(lat, lng) {
  if (userClosedGuide) return;
  if (!Object.keys(groupedShopsCache).length) return;
  for (const [groupKey, shops] of Object.entries(groupedShopsCache)) {
    const shopLat = Number(shops[0].lat);
    const shopLng = Number(shops[0].lng);
    if (haversineMeters(lat, lng, shopLat, shopLng) <= PROXIMITY_METERS) {
      if (!buildingGuideEl.hidden && autoShownGroupKey === groupKey) return;
      showBuildingGuide(shops, groupKey);
      return;
    }
  }
  if (!buildingGuideEl.hidden && autoShownGroupKey !== null) {
    buildingGuideEl.hidden = true;
    autoShownGroupKey = null;
  }
}

function updateLocationInsideBounds(lat, lng, accuracy) {
  if (!overlayLatLngBounds) { locationStatusEl.textContent = "地図範囲が未確定です"; return; }
  if (!overlayLatLngBounds.contains([lat, lng])) {
    clearCurrentLocationLayers();
    locationStatusEl.textContent = "現在地は画像範囲外です";
    return;
  }
  locationStatusEl.textContent = `現在地: ${lat.toFixed(6)}, ${lng.toFixed(6)} / ±${Math.round(accuracy)}m`;
  if (currentLocationMarker) {
    currentLocationMarker.setLatLng([lat, lng]);
  } else {
    currentLocationMarker = L.marker([lat, lng], { pane: "migrationMarkerPane" }).addTo(map);
    currentLocationMarker.bindPopup("現在地");
  }
  if (currentLocationCircle) {
    currentLocationCircle.setLatLng([lat, lng]);
    currentLocationCircle.setRadius(accuracy);
  } else {
    currentLocationCircle = L.circle([lat, lng], { radius: accuracy, weight: 1, opacity: 0.6, fillOpacity: 0.08 }).addTo(map);
  }
  checkProximityToShops(lat, lng);
}

function startLocationWatch() {
  if (!navigator.geolocation) { alert("このブラウザは位置情報に対応していません"); return; }
  if (!overlayLatLngBounds) { alert("地図の読み込み完了後に現在地表示を使ってください"); return; }
  locationEnabled = true;
  userClosedGuide = false;
  updateLocationButtons();
  locationStatusEl.textContent = "現在地を取得中です...";
  updateNavBanner();

  locationWatchId = navigator.geolocation.watchPosition(
    onGeoPosition,
    (err) => { console.error(err); locationStatusEl.textContent = "現在地を取得できませんでした"; },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
  );
}

/** 位置更新の入口。既存処理 → ナビ拡張の順で通す */
function onGeoPosition(pos) {
  const lat = pos.coords.latitude;
  const lng = pos.coords.longitude;

  updateLocationInsideBounds(lat, lng, pos.coords.accuracy || 20);  // 既存処理（無改修）

  lastPos = { lat, lng };
  updateHeading(lat, lng, pos.coords);
  updateMarkerExpansion(lat, lng);   // 要件4
  updateNavigation(lat, lng);        // 要件3
  refreshRoute(false);               // 要件2（間引きあり）
}

function setLocationEnabled(on) {
  if (on) startLocationWatch(); else stopLocationWatch();
}

/** ヘッダのボタンと地図上の FAB の表示を揃える */
function updateLocationButtons() {
  if (btnToggleLocation) {
    btnToggleLocation.textContent = locationEnabled ? "現在地表示: ON" : "現在地表示: OFF";
  }
  if (locationFabEl) {
    locationFabEl.textContent = locationEnabled ? "現在地 ON" : "現在地 OFF";
    locationFabEl.classList.toggle("is-on", locationEnabled);
  }
}

btnToggleLocation?.addEventListener("click", () => setLocationEnabled(!locationEnabled));

// 地図右下の現在地トグル（要件1）
const LocationToggleControl = L.Control.extend({
  options: { position: "bottomright" },
  onAdd() {
    const btn = L.DomUtil.create("button", "location-fab");
    btn.type = "button";
    btn.setAttribute("aria-label", "現在地表示の切り替え");
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.on(btn, "click", (e) => {
      L.DomEvent.preventDefault(e);
      setLocationEnabled(!locationEnabled);
    });
    locationFabEl = btn;
    updateLocationButtons();
    return btn;
  },
});
map.addControl(new LocationToggleControl());

// ----------------------------------------------------------------
// 地図サイズ調整
// ----------------------------------------------------------------

function applyMapSize(imgW, imgH) {
  const mapEl = document.getElementById("map");
  const headerEl = document.querySelector("header");
  const headerH = headerEl ? headerEl.offsetHeight : 92;
  const availW = window.innerWidth;
  const availH = window.innerHeight - headerH;
  const aspect = imgW / imgH;
  const SQUARE_THRESHOLD = 0.15;
  let mapH;
  if (Math.abs(aspect - 1) <= SQUARE_THRESHOLD) {
    mapH = Math.min(availH, availW);
  } else {
    mapH = availH;
  }
  mapEl.style.height = `${Math.max(mapH, 280)}px`;
  map.invalidateSize({ animate: false });
}

function fitMapForViewport(bounds) {
  const mapEl = document.getElementById("map");
  const containerW = mapEl.offsetWidth || window.innerWidth;
  const headerEl = document.querySelector("header");
  const containerH = mapEl.offsetHeight || (window.innerHeight - (headerEl ? headerEl.offsetHeight : 92));

  const nw = map.project(bounds.getNorthWest(), 0);
  const se = map.project(bounds.getSouthEast(), 0);
  const boundsW0 = Math.abs(se.x - nw.x);
  const boundsH0 = Math.abs(se.y - nw.y);

  if (boundsW0 === 0 || boundsH0 === 0) {
    map.fitBounds(bounds, { padding: [0, 0] });
    map.setMaxBounds(bounds);
    return;
  }

  const zoomW = Math.log2(containerW / boundsW0);
  const zoomH = Math.log2(containerH / boundsH0);
  const geoAspect = boundsW0 / boundsH0;
  const viewAspect = containerW / containerH;
  let targetZoom = geoAspect > viewAspect ? zoomH : Math.min(zoomW, zoomH);
  targetZoom = Math.max(targetZoom, 1);

  map.setView(bounds.getCenter(), targetZoom, { animate: false });
  map.setMaxBounds(bounds);
  map.setMinZoom(targetZoom);
}

// ----------------------------------------------------------------
// プロジェクト・オーバーレイ読み込み
// ----------------------------------------------------------------

/**
 * latlngsCorners (4頂点) から L.latLngBounds を計算する。
 */
function cornersToLeafletBounds(corners) {
  const lats = corners.map((c) => Number(c.lat));
  const lngs = corners.map((c) => Number(c.lng));
  return L.latLngBounds([Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]);
}

/**
 * distortable_corners / image_corners [NW, NE, SW, SE] から
 * ポリゴン穴 (NW→NE→SE→SW) を作る。
 */
function cornersToHoleRing(corners) {
  const c = corners; // [NW, NE, SW, SE]
  return [
    [Number(c[0].lat), Number(c[0].lng)], // NW
    [Number(c[1].lat), Number(c[1].lng)], // NE
    [Number(c[3].lat), Number(c[3].lng)], // SE
    [Number(c[2].lat), Number(c[2].lng)], // SW
  ];
}

async function loadProject() {
  const [projectRes, boundsRes] = await Promise.all([
    fetch(`/api/migrationmaps/${PROJECT_ID}`),
    fetch(`/api/migrationmaps/${PROJECT_ID}/overlay_bounds`),
  ]);

  if (!projectRes.ok) {
    const data = await projectRes.json().catch(() => ({}));
    throw new Error(data.error || "project load failed");
  }
  if (!boundsRes.ok) throw new Error("overlay bounds load failed");

  const project = await projectRes.json();
  const boundsData = await boundsRes.json();

  projectData = { ...project, ...boundsData };
  titleEl.textContent = projectData.name || "公開地図";

  // ---- Layer 1 オーバーレイ ----
  overlayCorners = projectData.distortable_corners || projectData.image_corners;
  if (!Array.isArray(overlayCorners) || overlayCorners.length !== 4) {
    throw new Error("overlay corners invalid");
  }

  if (overlay1) { map.removeLayer(overlay1); overlay1 = null; }

  const rawImageUrl1 = projectData.image_url || "";
  const imageUrl1 = rawImageUrl1.startsWith("http")
    ? rawImageUrl1 : new URL(rawImageUrl1, window.location.origin).href;

  const bounds1 = cornersToLeafletBounds(overlayCorners);
  overlay1 = L.imageOverlay(imageUrl1, bounds1, {
    pane: "layer1OverlayPane",
    opacity: OVERLAY_OPACITY,
    crossOrigin: true,
  }).addTo(map);

  overlay1.on("error", () => {
    console.error("[public.js] Layer1 オーバーレイ画像の読み込みに失敗:", imageUrl1);
  });

  // ---- Layer 2 オーバーレイ（オプション）----
  if (overlay2) { map.removeLayer(overlay2); overlay2 = null; }

  const layer2Data = boundsData.layer2;
  if (layer2Data && project.image_url2) {
    const rawImageUrl2 = project.image_url2 || "";
    const imageUrl2 = rawImageUrl2.startsWith("http")
      ? rawImageUrl2 : new URL(rawImageUrl2, window.location.origin).href;

    const corners2 = layer2Data.distortable_corners || layer2Data.image_corners;
    if (Array.isArray(corners2) && corners2.length === 4) {
      const bounds2 = cornersToLeafletBounds(corners2);
      overlay2 = L.imageOverlay(imageUrl2, bounds2, {
        pane: "layer2OverlayPane",
        opacity: 0,        // 初期は非表示（フェードイン前）
        crossOrigin: true,
      }).addTo(map);

      overlay2.on("error", () => {
        console.error("[public.js] Layer2 オーバーレイ画像の読み込みに失敗:", imageUrl2);
      });
    }
  }

  // ---- 切り替え時間を保存 ----
  switchTimes = {
    t1to2: project.switch_time_1to2 || null,
    t2to1: project.switch_time_2to1 || null,
  };

  // ---- 起動時の初期レイヤーを設定（常にレイヤー1を表示してから時間切替）----
  if (overlay2) {
    currentActiveLayer = 1;
    overlay1.setOpacity(OVERLAY_OPACITY);
    overlay2.setOpacity(0);

    // 切替ボタンを表示
    if (btnToggleLayer) {
      btnToggleLayer.hidden = false;
      updateLayerToggleButton();
    }

    // 2秒後に時間ベースの切替チェック（アニメあり）
    setTimeout(checkTimedLayerSwitch, 2000);

    // 毎分の自動切替チェック
    autoSwitchTimer = setInterval(checkTimedLayerSwitch, 60000);
  }

  // ---- マスクポリゴン（Layer 1 の外側を隠す）----
  if (maskLayer) { map.removeLayer(maskLayer); maskLayer = null; }
  {
    const outerRing = [[-85, -180], [-85, 180], [85, 180], [85, -180]];
    const imageRing = cornersToHoleRing(overlayCorners);
    maskLayer = L.polygon([outerRing, imageRing], {
      pane: "maskPane",
      fillColor: "#f7f7f8",
      fillOpacity: 1,
      stroke: false,
    }).addTo(map);
  }

  // ---- 表示範囲確定 ----
  if (Array.isArray(boundsData.bounds) && boundsData.bounds.length === 2) {
    overlayLatLngBounds = L.latLngBounds(boundsData.bounds);
  } else {
    overlayLatLngBounds = L.latLngBounds(overlayCorners.map((c) => [Number(c.lat), Number(c.lng)]));
  }

  if (projectData.image_width && projectData.image_height) {
    applyMapSize(projectData.image_width, projectData.image_height);
  }
  fitMapForViewport(overlayLatLngBounds);
}

async function loadShops() {
  const res = await fetch(`/api/migrationmaps/${PROJECT_ID}/shops`);
  if (!res.ok) throw new Error("shops load failed");
  const data = await res.json();
  shopData = Array.isArray(data.shops) ? data.shops : [];
  addShopMarkers();
}

// ----------------------------------------------------------------
// 初期化
// ----------------------------------------------------------------

(async function init() {
  const loadingEl = document.getElementById("mapLoadingOverlay");
  try {
    await loadProject();
    if (loadingEl) loadingEl.classList.add("hidden");
    await loadShops();
    locationStatusEl.textContent = "現在地表示はOFFです";

    window.addEventListener("resize", () => {
      if (overlayLatLngBounds && projectData?.image_width && projectData?.image_height) {
        applyMapSize(projectData.image_width, projectData.image_height);
        fitMapForViewport(overlayLatLngBounds);
      }
    });
  } catch (err) {
    console.error(err);
    if (loadingEl) loadingEl.classList.add("hidden");
    alert(err.message || "公開地図の読み込みに失敗しました");
  }
})();
