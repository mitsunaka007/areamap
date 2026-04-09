const map = L.map("map", {
  zoomControl: true,
  maxZoom: 22,
  maxBoundsViscosity: 1.0,
}).setView([35.0, 135.0], 14);

map.createPane("migrationOverlayPane");
map.getPane("migrationOverlayPane").style.zIndex = 450;
map.getPane("migrationOverlayPane").style.pointerEvents = "none";

// OSM タイルと illustrationOverlay の間にマスク層を挿入（z-index 300）
// 画像の外側を不透明で塗り、OSM が見えないようにする
map.createPane("maskPane");
map.getPane("maskPane").style.zIndex = 300;
map.getPane("maskPane").style.pointerEvents = "none";

map.createPane("migrationMarkerPane");
map.getPane("migrationMarkerPane").style.zIndex = 650;

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxNativeZoom: 19,
  maxZoom: 22,
}).addTo(map);

let overlay = null;
let maskLayer = null;
let projectData = null;
let overlayLatLngBounds = null;
let overlayCorners = null;
let shopData = [];
let groupedShopsCache = {};
const shopMarkers = new Map(); // groupKey → L.marker

let locationEnabled = false;
let locationWatchId = null;
let currentLocationMarker = null;
let currentLocationCircle = null;

// building-guide をGPS近接で自動表示した場合のグループキー
// （ユーザーが × で閉じた後は再表示しない）
let autoShownGroupKey = null;
let userClosedGuide = false;

const PROXIMITY_METERS = 50;

const titleEl = document.getElementById("title");
const btnToggleLocation = document.getElementById("btnToggleLocation");
const locationStatusEl = document.getElementById("locationStatus");
const buildingGuideEl = document.getElementById("buildingGuide");
const buildingGuideCloseEl = document.getElementById("buildingGuideClose");
const buildingPhotoWrapEl = document.getElementById("buildingPhotoWrap");
const floorShopGridEl = document.getElementById("floorShopGrid");

// ----------------------------------------------------------------
// ユーティリティ
// ----------------------------------------------------------------

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeFloorLevel(value) {
  return String(value || "").trim().toUpperCase();
}

function latLngGroupKey(lat, lng) {
  return `${Number(lat).toFixed(7)},${Number(lng).toFixed(7)}`;
}

function sanitizeTel(tel) {
  return String(tel ?? "").replace(/[^\d+]/g, "");
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ----------------------------------------------------------------
// HTML ビルダー
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
      floorMap.set(key, {
        floorlevel: key,
        area_x: 8,
        area_y: 8,
        area_width: 64,
        area_height: 32,
      });
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
  const floorShops = groupShops.filter(
    (s) => normalizeFloorLevel(s.floorlevel) === floorKey
  );
  if (!floorShops.length) {
    return `<div class="shop-grid-empty">この階の店舗はありません</div>`;
  }
  return `
    <div class="floor-shop-list">
      ${floorShops
        .map(
          (shop) => `
        <section class="floor-shop-card">
          ${buildShopSummary(shop)}
          ${buildImageGrid(shop)}
        </section>
      `
        )
        .join("")}
    </div>
  `;
}

// ----------------------------------------------------------------
// Building Guide パネル
// ----------------------------------------------------------------

function iconNormal() {
  return L.divIcon({ className: "shop-marker-normal", iconSize: [28, 28], iconAnchor: [14, 28] });
}
function iconActive() {
  return L.divIcon({ className: "shop-marker-active", iconSize: [36, 36], iconAnchor: [18, 36] });
}
function iconDimmed() {
  return L.divIcon({ className: "shop-marker-dimmed", iconSize: [16, 16], iconAnchor: [8, 16] });
}

function resetMarkerIcons() {
  shopMarkers.forEach((marker) => marker.setIcon(iconNormal()));
}

function hideBuildingGuide() {
  buildingGuideEl.hidden = true;
  userClosedGuide = true;
  resetMarkerIcons();
}

function showBuildingGuide(groupShops, groupKey) {
  const guide = groupShops[0]?.building_guide || null;

  // 写真エリアをリセット
  buildingPhotoWrapEl.innerHTML = "";
  floorShopGridEl.innerHTML = "";

  if (guide && guide.image_url) {
    // ビル写真
    const imgEl = document.createElement("img");
    imgEl.src = guide.image_url;
    imgEl.className = "building-photo";
    imgEl.alt = escapeHtml(guide.building_name || "building");
    buildingPhotoWrapEl.appendChild(imgEl);

    // 階ごとのホットスポットボタン
    const floors = getFloorDisplayOrder(groupShops, guide);
    floors.forEach((floor, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "floor-hotspot" + (idx === 0 ? " is-active" : "");
      btn.dataset.floor = floor.floorlevel;
      btn.style.cssText = buildHotspotStyle(floor);
      btn.textContent = floor.floorlevel;
      btn.addEventListener("click", () => {
        buildingPhotoWrapEl
          .querySelectorAll(".floor-hotspot")
          .forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        floorShopGridEl.innerHTML = buildFloorGridSection(
          groupShops,
          floor.floorlevel
        );
      });
      buildingPhotoWrapEl.appendChild(btn);
    });

    // 初期表示: 最初の階の店舗情報
    const firstFloor =
      floors[0]?.floorlevel || groupShops[0]?.floorlevel || "";
    floorShopGridEl.innerHTML = buildFloorGridSection(groupShops, firstFloor);
  } else {
    // BuildingGuide なし → 単店舗表示
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

  const validShops = shopData.filter(
    (shop) =>
      Number.isFinite(Number(shop.lat)) && Number.isFinite(Number(shop.lng))
  );

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
    const marker = L.marker([lat, lng], {
      pane: "migrationMarkerPane",
      icon: iconNormal(),
    }).addTo(map);

    shopMarkers.set(groupKey, marker);

    marker.on("click", () => {
      shopMarkers.forEach((m, key) => {
        m.setIcon(key === groupKey ? iconActive() : iconDimmed());
      });
      showBuildingGuide(shopsAtSamePoint, groupKey);
    });
  });
}

// ----------------------------------------------------------------
// 現在地
// ----------------------------------------------------------------

function clearCurrentLocationLayers() {
  if (currentLocationMarker) {
    map.removeLayer(currentLocationMarker);
    currentLocationMarker = null;
  }
  if (currentLocationCircle) {
    map.removeLayer(currentLocationCircle);
    currentLocationCircle = null;
  }
}

function stopLocationWatch() {
  if (locationWatchId !== null) {
    navigator.geolocation.clearWatch(locationWatchId);
    locationWatchId = null;
  }
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
    const dist = haversineMeters(lat, lng, shopLat, shopLng);
    if (dist <= PROXIMITY_METERS) {
      // すでに同じグループを表示中なら何もしない
      if (!buildingGuideEl.hidden && autoShownGroupKey === groupKey) return;
      showBuildingGuide(shops, groupKey);
      return;
    }
  }

  // 全ショップから離れていたら GPS 近接で表示したパネルを閉じる
  if (!buildingGuideEl.hidden && autoShownGroupKey !== null) {
    buildingGuideEl.hidden = true;
    autoShownGroupKey = null;
  }
}

function updateLocationInsideBounds(lat, lng, accuracy) {
  if (!overlayLatLngBounds) {
    locationStatusEl.textContent = "地図範囲が未確定です";
    return;
  }
  const inside = overlayLatLngBounds.contains([lat, lng]);
  if (!inside) {
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
    currentLocationCircle = L.circle([lat, lng], {
      radius: accuracy,
      weight: 1,
      opacity: 0.6,
      fillOpacity: 0.08,
    }).addTo(map);
  }

  checkProximityToShops(lat, lng);
}

function startLocationWatch() {
  if (!navigator.geolocation) {
    alert("このブラウザは位置情報に対応していません");
    return;
  }
  if (!overlayLatLngBounds) {
    alert("地図の読み込み完了後に現在地表示を使ってください");
    return;
  }

  locationEnabled = true;
  userClosedGuide = false;
  btnToggleLocation.textContent = "現在地表示: ON";
  locationStatusEl.textContent = "現在地を取得中です...";

  locationWatchId = navigator.geolocation.watchPosition(
    (pos) =>
      updateLocationInsideBounds(
        pos.coords.latitude,
        pos.coords.longitude,
        pos.coords.accuracy || 20
      ),
    (err) => {
      console.error(err);
      locationStatusEl.textContent = "現在地を取得できませんでした";
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );
}

btnToggleLocation?.addEventListener("click", () => {
  if (locationEnabled) stopLocationWatch();
  else startLocationWatch();
});

// ----------------------------------------------------------------
// 地図・オーバーレイ読み込み
// ----------------------------------------------------------------

/**
 * イラスト地図の縦横比に合わせて #map コンテナの高さを設定する。
 * Leaflet は invalidateSize() で新サイズを反映する。
 */
function applyMapSize(imgW, imgH) {
  const mapEl = document.getElementById("map");
  const headerEl = document.querySelector("header");
  const headerH = headerEl ? headerEl.offsetHeight : 92;
  const availW = window.innerWidth;
  const availH = window.innerHeight - headerH;

  // 画像の縦横比を保ちつつ、ビューポートに収まる最大サイズを計算
  const ratio = imgH / imgW;
  const targetH = Math.min(availH, Math.round(availW * ratio));
  mapEl.style.height = `${Math.max(targetH, 280)}px`;
  map.invalidateSize({ animate: false });
}

function fitMapForViewport(bounds) {
  // マスクポリゴンが画像外を完全に覆うため、padding は不要。
  // pad(0) で setMaxBounds もぴったり合わせる。
  map.fitBounds(bounds, { padding: [0, 0] });
  map.setMaxBounds(bounds);

  const minZoom = map.getBoundsZoom(bounds, false);
  map.setMinZoom(minZoom);
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

  projectData = {
    ...project,
    ...boundsData,
  };

  titleEl.textContent = projectData.name || "公開地図";

  overlayCorners = projectData.distortable_corners || projectData.image_corners;
  if (!Array.isArray(overlayCorners) || overlayCorners.length !== 4) {
    console.error("projectData:", projectData);
    throw new Error("overlay corners invalid");
  }

  if (overlay) {
    map.removeLayer(overlay);
    overlay = null;
  }

  const rawImageUrl = projectData.image_url || "";
  const imageUrl = rawImageUrl.startsWith("http")
    ? rawImageUrl
    : new URL(rawImageUrl, window.location.origin).href;

  const cornerLatLngs = overlayCorners.map((c) =>
    L.latLng(Number(c.lat), Number(c.lng))
  );
  const swLatLng = L.latLng(
    Math.min(...cornerLatLngs.map((ll) => ll.lat)),
    Math.min(...cornerLatLngs.map((ll) => ll.lng))
  );
  const neLatLng = L.latLng(
    Math.max(...cornerLatLngs.map((ll) => ll.lat)),
    Math.max(...cornerLatLngs.map((ll) => ll.lng))
  );

  const useDistortable = typeof L.distortableImageOverlay === "function";

  if (useDistortable) {
    try {
      // mode:"lock" / editable:false は v0.21.9 では無効なオプションのため除外
      overlay = L.distortableImageOverlay(imageUrl, {
        corners: cornerLatLngs,
        pane: "migrationOverlayPane",
        selected: false,
        suppressToolbar: true,
        opacity: 0.88,
        crossOrigin: true,
      }).addTo(map);
    } catch (e) {
      console.warn(
        "L.distortableImageOverlay の初期化に失敗しました。L.imageOverlay にフォールバックします:",
        e
      );
      overlay = L.imageOverlay(
        imageUrl,
        L.latLngBounds(swLatLng, neLatLng),
        { pane: "migrationOverlayPane", opacity: 0.88, crossOrigin: true }
      ).addTo(map);
    }
  } else {
    console.warn(
      "L.distortableImageOverlay が未定義のため L.imageOverlay にフォールバックします"
    );
    overlay = L.imageOverlay(
      imageUrl,
      L.latLngBounds(swLatLng, neLatLng),
      {
        pane: "migrationOverlayPane",
        opacity: 0.88,
        crossOrigin: true,
      }
    ).addTo(map);
  }

  overlay.on("error", () => {
    console.error(
      "[public.js] オーバーレイ画像の読み込みに失敗しました。image_url を確認してください:",
      imageUrl
    );
  });

  // ---- 画像外の OSM を完全に隠すマスクポリゴン ----
  // 外側リング: 世界全体を覆う大きな矩形
  // 内側リング(穴): イラスト地図の実際の4隅（歪み補正された正確な形状）
  // distortable_corners 順 [NW, NE, SW, SE] を
  // ポリゴン周回順 NW→NE→SE→SW に並べ替えて穴を定義する
  if (maskLayer) {
    map.removeLayer(maskLayer);
    maskLayer = null;
  }
  {
    const outerRing = [[-85, -180], [-85, 180], [85, 180], [85, -180]];
    const c = overlayCorners; // [NW, NE, SW, SE]
    const imageRing = [
      [Number(c[0].lat), Number(c[0].lng)], // NW
      [Number(c[1].lat), Number(c[1].lng)], // NE
      [Number(c[3].lat), Number(c[3].lng)], // SE
      [Number(c[2].lat), Number(c[2].lng)], // SW
    ];
    maskLayer = L.polygon([outerRing, imageRing], {
      pane: "maskPane",
      fillColor: "#f7f7f8",
      fillOpacity: 1,
      stroke: false,
    }).addTo(map);
  }

  if (Array.isArray(boundsData.bounds) && boundsData.bounds.length === 2) {
    overlayLatLngBounds = L.latLngBounds(boundsData.bounds);
  } else {
    const latlngs = overlayCorners.map((c) => [Number(c.lat), Number(c.lng)]);
    overlayLatLngBounds = L.latLngBounds(latlngs);
  }

  // イラスト地図の縦横比に合わせてコンテナサイズを調整してから fitBounds
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

(async function init() {
  const loadingEl = document.getElementById("mapLoadingOverlay");
  try {
    await loadProject();
    // 地図範囲が確定したらローディングオーバーレイを解除
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
