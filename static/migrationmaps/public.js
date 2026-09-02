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
  groupShops.forEach((s) => {
    const key = normalizeFloorLevel(s.floorlevel);
    if (key && !floorMap.has(key)) {
      floorMap.set(key, { floorlevel: key, area_x_pct: 4, area_y_pct: 4, area_width_pct: 16, area_height_pct: 10 });
    }
  });
  return [...floorMap.values()].sort((a, b) => {
    const av = parseInt(String(a.floorlevel).replace(/\D/g, "") || "999", 10);
    const bv = parseInt(String(b.floorlevel).replace(/\D/g, "") || "999", 10);
    return av - bv;
  });
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

function iconNormal() { return L.divIcon({ className: "shop-marker-normal", iconSize: [28, 28], iconAnchor: [14, 28] }); }
function iconActive() { return L.divIcon({ className: "shop-marker-active", iconSize: [36, 36], iconAnchor: [18, 36] }); }
function iconDimmed() { return L.divIcon({ className: "shop-marker-dimmed", iconSize: [16, 16], iconAnchor: [8, 16] }); }

function resetMarkerIcons() { shopMarkers.forEach((marker) => marker.setIcon(iconNormal())); }

function hideBuildingGuide() {
  buildingGuideEl.hidden = true;
  userClosedGuide = true;
  resetMarkerIcons();
}

function showBuildingGuide(groupShops, groupKey) {
  const guide = groupShops[0]?.building_guide || null;
  buildingPhotoWrapEl.innerHTML = "";
  floorShopGridEl.innerHTML = "";

  if (guide && guide.image_url) {
    const imgEl = document.createElement("img");
    imgEl.src = guide.image_url;
    imgEl.className = "building-photo";
    imgEl.alt = escapeHtml(guide.building_name || "building");
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
  Object.entries(groupedShopsCache).forEach(([groupKey, shopsAtSamePoint]) => {
    const lat = Number(shopsAtSamePoint[0].lat);
    const lng = Number(shopsAtSamePoint[0].lng);
    const marker = L.marker([lat, lng], { pane: "migrationMarkerPane", icon: iconNormal() }).addTo(map);
    shopMarkers.set(groupKey, marker);
    marker.on("click", () => {
      shopMarkers.forEach((m, key) => { m.setIcon(key === groupKey ? iconActive() : iconDimmed()); });
      showBuildingGuide(shopsAtSamePoint, groupKey);
    });
  });
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
  btnToggleLocation.textContent = "現在地表示: OFF";
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
  btnToggleLocation.textContent = "現在地表示: ON";
  locationStatusEl.textContent = "現在地を取得中です...";
  locationWatchId = navigator.geolocation.watchPosition(
    (pos) => updateLocationInsideBounds(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy || 20),
    (err) => { console.error(err); locationStatusEl.textContent = "現在地を取得できませんでした"; },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );
}

btnToggleLocation?.addEventListener("click", () => {
  if (locationEnabled) stopLocationWatch(); else startLocationWatch();
});

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

  if (!projectRes.ok) throw new Error("project load failed");
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
    alert("公開地図の読み込みに失敗しました");
  }
})();
