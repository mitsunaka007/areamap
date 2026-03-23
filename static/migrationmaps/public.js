const map = L.map("map", {
  zoomControl: true,
  maxZoom: 22,
}).setView([35.0, 135.0], 14);

map.createPane("migrationOverlayPane");
map.getPane("migrationOverlayPane").style.zIndex = 350;
map.getPane("migrationOverlayPane").style.pointerEvents = "none";

map.createPane("migrationMarkerPane");
map.getPane("migrationMarkerPane").style.zIndex = 650;

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxNativeZoom: 19,
  maxZoom: 22,
}).addTo(map);

let overlay = null;
let projectData = null;
let overlayLatLngBounds = null;
let overlayCorners = null;
let shopData = [];

let locationEnabled = false;
let locationWatchId = null;
let currentLocationMarker = null;
let currentLocationCircle = null;

const titleEl = document.getElementById("title");
const btnToggleLocation = document.getElementById("btnToggleLocation");
const locationStatusEl = document.getElementById("locationStatus");

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
  if (!images.length) {
    return `<div class="shop-grid-empty">この階の画像はまだありません</div>`;
  }
  return `
    <div class="shop-image-grid">
      ${images.map((img) => `
        <a href="${escapeHtml(img.image_url)}" target="_blank" rel="noopener noreferrer" class="shop-image-card">
          <img src="${escapeHtml(img.image_url)}" alt="${escapeHtml(shop.shopname || 'shop image')}" loading="lazy" />
        </a>
      `).join("")}
    </div>
  `;
}

function buildShopSummary(shop) {
  return `
    <div class="shop-summary">
      <div class="shop-name">${escapeHtml(shop.shopname || '店名未設定')}</div>
      <div class="shop-meta"><span class="shop-label">階</span><span>${escapeHtml(shop.floorlevel || '-')}</span></div>
      <div class="shop-meta"><span class="shop-label">住所</span><span>${escapeHtml(shop.address || '-')}</span></div>
      <div class="shop-meta"><span class="shop-label">TEL</span><span>${buildTelPart(shop)}</span></div>
      <div class="shop-meta"><span class="shop-label">Instagram</span><span>${buildInstagramPart(shop)}</span></div>
    </div>
  `;
}

function buildSingleShopPopup(shop) {
  return `<div class="shop-popup">${buildShopSummary(shop)}${buildImageGrid(shop)}</div>`;
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
  const floorShops = groupShops.filter((s) => normalizeFloorLevel(s.floorlevel) === floorKey);
  if (!floorShops.length) {
    return `<div class="shop-grid-empty">この階の店舗はありません</div>`;
  }
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

function buildBuildingPopup(groupShops, groupKey) {
  const guide = groupShops[0].building_guide || null;
  if (!guide || !guide.image_url) {
    return buildSingleShopPopup(groupShops[0]);
  }

  const floors = getFloorDisplayOrder(groupShops, guide);
  const firstFloor = floors[0]?.floorlevel || groupShops[0]?.floorlevel || "";

  return `
    <div class="shop-popup building-popup" data-group-key="${escapeHtml(groupKey)}">
      <div class="building-photo-wrap">
        <img src="${escapeHtml(guide.image_url)}" class="building-photo" alt="${escapeHtml(guide.building_name || 'building image')}" />
        ${floors.map((floor, idx) => `
          <button
            type="button"
            class="floor-hotspot ${idx === 0 ? 'is-active' : ''}"
            data-group-key="${escapeHtml(groupKey)}"
            data-floor="${escapeHtml(floor.floorlevel)}"
            style="${buildHotspotStyle(floor)}"
          >${escapeHtml(floor.floorlevel)}</button>
        `).join("")}
      </div>
      <div class="floor-shop-grid" id="floor-grid-${escapeHtml(groupKey)}">
        ${buildFloorGridSection(groupShops, firstFloor)}
      </div>
    </div>
  `;
}

function attachFloorSwitcherHandlers(popupRoot, groupedShops) {
  if (!popupRoot) return;
  popupRoot.querySelectorAll(".floor-hotspot").forEach((btn) => {
    btn.addEventListener("click", () => {
      const groupKey = btn.dataset.groupKey || "";
      const floor = btn.dataset.floor || "";
      const groupShops = groupedShops[groupKey] || [];
      const gridEl = popupRoot.querySelector(`#floor-grid-${CSS.escape(groupKey)}`);
      if (!gridEl) return;
      gridEl.innerHTML = buildFloorGridSection(groupShops, floor);
      popupRoot.querySelectorAll(".floor-hotspot").forEach((node) => node.classList.remove("is-active"));
      btn.classList.add("is-active");
    });
  });
}

function addShopMarkers() {
  if (!Array.isArray(shopData) || shopData.length === 0) return;

  const validShops = shopData.filter((shop) =>
    Number.isFinite(Number(shop.lat)) && Number.isFinite(Number(shop.lng))
  );

  const groupedShops = validShops.reduce((acc, shop) => {
    const key = latLngGroupKey(shop.lat, shop.lng);
    if (!acc[key]) acc[key] = [];
    acc[key].push(shop);
    return acc;
  }, {});

  Object.entries(groupedShops).forEach(([groupKey, shopsAtSamePoint]) => {
    const lat = Number(shopsAtSamePoint[0].lat);
    const lng = Number(shopsAtSamePoint[0].lng);
    const marker = L.marker([lat, lng], { pane: "migrationMarkerPane" }).addTo(map);

    const hasGuide = !!shopsAtSamePoint[0].building_guide?.image_url;
    if (!hasGuide) {
      marker.bindPopup(buildSingleShopPopup(shopsAtSamePoint[0]), { maxWidth: 360 });
      return;
    }

    marker.bindPopup(buildBuildingPopup(shopsAtSamePoint, groupKey), {
      maxWidth: 380,
      className: "building-popup-shell",
    });
    marker.on("popupopen", (e) => attachFloorSwitcherHandlers(e.popup.getElement(), groupedShops));
  });
}

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
  btnToggleLocation.textContent = "現在地表示: ON";
  locationStatusEl.textContent = "現在地を取得中です...";

  locationWatchId = navigator.geolocation.watchPosition(
    (pos) => updateLocationInsideBounds(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy || 20),
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

function fitMapForViewport(bounds) {
  const isPortrait = window.innerHeight > window.innerWidth;

  const paddingTopLeft = isPortrait ? [18, 12] : [12, 12];
  const paddingBottomRight = isPortrait ? [18, 24] : [12, 12];

  map.fitBounds(bounds, {
    paddingTopLeft,
    paddingBottomRight
  });

  const restrictedBounds = bounds.pad(isPortrait ? 0.02 : 0.03);
  map.setMaxBounds(restrictedBounds);
  map.options.maxBoundsViscosity = 1.0;

  const minZoom = map.getBoundsZoom(bounds, false, paddingBottomRight);
  map.setMinZoom(minZoom);
}

async function loadProject() {
  const [projectRes, boundsRes] = await Promise.all([
    fetch(`/api/migrationmaps/${PROJECT_ID}`),
    fetch(`/api/migrationmaps/${PROJECT_ID}/overlay_bounds`)
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

  // image_url が相対パス（例: "uploads/foo.png" や "/uploads/foo.png"）の場合に
  // 同一オリジンの絶対 URL へ正規化する。
  // バックエンドが絶対 URL を返す場合はそのまま使われる。
  const rawImageUrl = projectData.image_url || "";
  const imageUrl = rawImageUrl.startsWith("http")
    ? rawImageUrl
    : new URL(rawImageUrl, window.location.origin).href;

  // distortableImageOverlay が canvas に描画する際に crossOrigin が必要。
  // 同一オリジンの場合でも明示的に設定しておくことで
  // Flask の send_from_directory が CORS ヘッダを返していない場合の
  // "Tainted canvas" エラーを防ぐ。
  // distortableImageOverlay が crossOrigin オプションに対応していない場合は
  // 通常の L.imageOverlay にフォールバックする。
  const cornerLatLngs = overlayCorners.map((c) => L.latLng(Number(c.lat), Number(c.lng)));
  const swLatLng = L.latLng(
    Math.min(...cornerLatLngs.map((ll) => ll.lat)),
    Math.min(...cornerLatLngs.map((ll) => ll.lng))
  );
  const neLatLng = L.latLng(
    Math.max(...cornerLatLngs.map((ll) => ll.lat)),
    Math.max(...cornerLatLngs.map((ll) => ll.lng))
  );

  const useDistortable =
    typeof L.distortableImageOverlay === "function";

  if (useDistortable) {
    overlay = L.distortableImageOverlay(imageUrl, {
      corners: cornerLatLngs,
      pane: "migrationOverlayPane",
      selected: false,
      suppressToolbar: true,
      editable: false,
      mode: "lock",
      opacity: 0.88,
      // crossOrigin を明示することで canvas の tainted エラーを防ぐ
      crossOrigin: true,
    }).addTo(map);
  } else {
    // leaflet-distortableimage が読み込まれていない場合の安全フォールバック
    console.warn("L.distortableImageOverlay が未定義のため L.imageOverlay にフォールバックします");
    overlay = L.imageOverlay(imageUrl, L.latLngBounds(swLatLng, neLatLng), {
      pane: "migrationOverlayPane",
      opacity: 0.88,
      crossOrigin: true,
    }).addTo(map);
  }

  // 画像の読み込みエラーを検知してコンソールに出力する
  overlay.on("error", () => {
    console.error(
      "[public.js] オーバーレイ画像の読み込みに失敗しました。image_url を確認してください:",
      imageUrl
    );
  });

  if (Array.isArray(boundsData.bounds) && boundsData.bounds.length === 2) {
    overlayLatLngBounds = L.latLngBounds(boundsData.bounds);
  } else {
    const latlngs = overlayCorners.map((c) => [Number(c.lat), Number(c.lng)]);
    overlayLatLngBounds = L.latLngBounds(latlngs);
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
  try {
    await loadProject();
    await loadShops();

    locationStatusEl.textContent = "現在地表示はOFFです";

    window.addEventListener("resize", () => {
      if (overlayLatLngBounds) {
        fitMapForViewport(overlayLatLngBounds);
      }
    });
  } catch (err) {
    console.error(err);
    alert("公開地図の読み込みに失敗しました");
  }
})();