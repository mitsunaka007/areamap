const map = L.map("map", {
  zoomControl: true,
  maxZoom: 22,
}).setView([35.0, 135.0], 14);

let buildingGuideMap = new Map();

// pane
map.createPane("migrationOverlayPane");
map.getPane("migrationOverlayPane").style.zIndex = 350;
map.getPane("migrationOverlayPane").style.pointerEvents = "none";

map.createPane("migrationMarkerPane");
map.getPane("migrationMarkerPane").style.zIndex = 650;

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxNativeZoom: 19, // ← 実タイルは19まで
  maxZoom: 22,       // ← 22までは拡大を許可（19を引き伸ばして表示）
}).addTo(map);

let overlay = null;
let projectData = null;
let overlayBounds = null;
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
  if (!value) return "";
  return String(value).trim().toUpperCase();
}

function latLngGroupKey(lat, lng) {
  return `${Number(lat).toFixed(7)},${Number(lng).toFixed(7)}`;
}

function sanitizeTel(tel) {
  return String(tel ?? "").replace(/[^\d+]/g, "");
}

function buildTelPart(shop) {
  const telRaw = (shop.tel || "").trim();
  if (!telRaw) return `<span class="shop-ig-none">-</span>`;

  const telHref = sanitizeTel(telRaw);
  if (!telHref) return `<span class="shop-ig-none">${escapeHtml(telRaw)}</span>`;

  return `<a href="tel:${escapeHtml(telHref)}" class="shop-ig-link">📞 ${escapeHtml(telRaw)}</a>`;
}

function buildInstagramPart(shop) {
  const igRaw = (shop.instagram_account || "").trim();
  if (!igRaw) return `<span class="shop-ig-none">-</span>`;

  const account = igRaw.replace(/^@/, "");
  const igHref = `https://www.instagram.com/${encodeURIComponent(account)}/`;
  const label = igRaw.startsWith("@") ? igRaw : `@${igRaw}`;

  return `<a href="${igHref}" target="_blank" rel="noopener noreferrer" class="shop-ig-link">📷 ${escapeHtml(label)}</a>`;
}

function buildSingleShopPopup(shop) {
  const name = escapeHtml(shop.shopname || "店名未設定");
  const address = escapeHtml(shop.address || "-");
  const floor = escapeHtml(shop.floorlevel || "-");

  return `
    <div class="shop-popup">
      <div class="shop-name">${name}</div>
      <div class="shop-meta"><span class="shop-label">階</span><span>${floor}</span></div>
      <div class="shop-meta"><span class="shop-label">住所</span><span>${address}</span></div>
      <div class="shop-meta"><span class="shop-label">TEL</span><span>${buildTelPart(shop)}</span></div>
      <div class="shop-meta"><span class="shop-label">Instagram</span><span>${buildInstagramPart(shop)}</span></div>
    </div>
  `;
}

function sortFloorLevels(floors = []) {
  return [...floors].sort((a, b) => a.localeCompare(b, "ja", { numeric: true }));
}

function buildGuideMap(guides = []) {
  const m = new Map();
  for (const guide of guides) {
    const key = latLngGroupKey(guide.lat, guide.lng);
    m.set(key, guide);
  }
  return m;
}

function collectExistingFloors(groupShops) {
  const set = new Set();
  groupShops.forEach((shop) => {
    const floor = normalizeFloorLevel(shop.floorlevel);
    if (floor) set.add(floor);
  });
  return sortFloorLevels([...set]);
}

function resolveDisplayFloors(groupShops, guide) {
  const existingSet = new Set(collectExistingFloors(groupShops));

  if (Array.isArray(guide?.floors) && guide.floors.length) {
    return [...guide.floors]
      .sort((a, b) => Number(a.sort_order || 999) - Number(b.sort_order || 999))
      .map((row) => normalizeFloorLevel(row.floorlevel))
      .filter((floor) => existingSet.has(floor));
  }

  return sortFloorLevels([...existingSet]);
}

function renderFloorShopGrid(groupShops, floorlevel) {
  const floorShops = groupShops.filter(
    (s) => normalizeFloorLevel(s.floorlevel) === floorlevel
  );

  if (!floorShops.length) {
    return `<div class="shop-grid-empty">${escapeHtml(floorlevel || "未設定")} の店舗はありません</div>`;
  }

  return floorShops.map((shop) => {
    const thumb = Array.isArray(shop.shop_images) && shop.shop_images.length
      ? shop.shop_images.slice().sort((a, b) => a.sort_order - b.sort_order)[0].image_url
      : "";

    return `
      <button type="button" class="shop-card" data-shop-id="${shop.id}">
        <div class="shop-card-thumb">
          ${
            thumb
              ? `<img src="${escapeHtml(thumb)}" alt="${escapeHtml(shop.shopname || "")}">`
              : `<div class="shop-card-noimage">No Image</div>`
          }
        </div>
        <div class="shop-card-name">${escapeHtml(shop.shopname || "店名未設定")}</div>
        <div class="shop-card-floor">${escapeHtml(shop.floorlevel || "")}</div>
      </button>
    `;
  }).join("");
}

function buildBuildingPopup(groupShops, groupKey) {
  const guide = buildingGuideMap.get(groupKey);
  const floors = resolveDisplayFloors(groupShops, guide);
  const defaultFloor = floors[0] || "";

  const floorButtonsHtml = floors.length
    ? floors.map((floor, i) => `
        <button
          type="button"
          class="floor-btn ${i === 0 ? "is-active" : ""}"
          data-group-key="${escapeHtml(groupKey)}"
          data-floor="${escapeHtml(floor)}">
          ${escapeHtml(floor)}
        </button>
      `).join("")
    : `<div class="shop-grid-empty">表示できる階がありません</div>`;

  const photoHtml = guide?.image_url
    ? `<img src="${escapeHtml(guide.image_url)}" class="building-photo" alt="${escapeHtml(guide.building_name || "ビル画像")}">`
    : `<div class="building-photo-empty">ビル画像未登録</div>`;

  const gridHtml = defaultFloor
    ? renderFloorShopGrid(groupShops, defaultFloor)
    : `<div class="shop-grid-empty">店舗の階情報がありません</div>`;

  return `
    <div class="building-popup" data-group-key="${escapeHtml(groupKey)}">
      <div class="shop-name">${escapeHtml(guide?.building_name || "ビル案内")}</div>

      <div class="building-popup-main">
        <div class="building-popup-photo">
          ${photoHtml}
        </div>
        <div class="building-popup-floors">
          ${floorButtonsHtml}
        </div>
      </div>

      <div class="floor-shop-grid" id="floor-shop-grid-${escapeHtml(groupKey)}">
        ${gridHtml}
      </div>
    </div>
  `;
}

function attachFloorSwitcherHandlers(popupRoot, groupedShops) {
  if (!popupRoot) return;

  popupRoot.querySelectorAll(".floor-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const groupKey = btn.dataset.groupKey || "";
      const floor = normalizeFloorLevel(btn.dataset.floor || "");
      const shops = groupedShops[groupKey] || [];

      const gridEl = popupRoot.querySelector(`#floor-shop-grid-${CSS.escape(groupKey)}`);
      if (!gridEl) return;

      gridEl.innerHTML = renderFloorShopGrid(shops, floor);

      popupRoot.querySelectorAll(".floor-btn").forEach((node) => {
        node.classList.remove("is-active");
      });
      btn.classList.add("is-active");
    });
  });
}

function addShopMarkers() {
  if (!Array.isArray(shopData) || shopData.length === 0) {
    console.warn("shopData is empty");
    return;
  }

  const validShops = shopData.filter((shop) =>
    Number.isFinite(Number(shop.lat)) && Number.isFinite(Number(shop.lng))
  );

  console.log("shopData raw:", shopData);
  console.log("shopData valid:", validShops);

  const groupedShops = validShops.reduce((acc, shop) => {
    const key = latLngGroupKey(shop.lat, shop.lng);
    if (!acc[key]) acc[key] = [];
    acc[key].push(shop);
    return acc;
  }, {});

  Object.entries(groupedShops).forEach(([groupKey, shopsAtSamePoint]) => {
    const lat = Number(shopsAtSamePoint[0].lat);
    const lng = Number(shopsAtSamePoint[0].lng);

    const marker = L.marker([lat, lng], {
      pane: "migrationMarkerPane"
    }).addTo(map);

    if (shopsAtSamePoint.length === 1) {
      marker.bindPopup(buildSingleShopPopup(shopsAtSamePoint[0]), { maxWidth: 320 });
      return;
    }

    marker.bindPopup(buildBuildingPopup(shopsAtSamePoint, groupKey), { maxWidth: 340 });
    marker.on("popupopen", (e) => {
      attachFloorSwitcherHandlers(e.popup.getElement(), groupedShops);
    });
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

  locationStatusEl.textContent =
    `現在地: ${lat.toFixed(6)}, ${lng.toFixed(6)} / ±${Math.round(accuracy)}m`;

  if (currentLocationMarker) {
    currentLocationMarker.setLatLng([lat, lng]);
  } else {
    currentLocationMarker = L.marker([lat, lng], {
      pane: "migrationMarkerPane"
    }).addTo(map);
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
      fillOpacity: 0.08
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

  stopLocationWatch();
  locationEnabled = true;
  btnToggleLocation.textContent = "現在地表示: ON";
  locationStatusEl.textContent = "現在地を取得中です…";

  locationWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      updateLocationInsideBounds(
        pos.coords.latitude,
        pos.coords.longitude,
        pos.coords.accuracy
      );
    },
    (err) => {
      locationStatusEl.textContent = `現在地取得失敗: ${err.message}`;
      stopLocationWatch();
    },
    {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 10000
    }
  );
}

btnToggleLocation.addEventListener("click", () => {
  if (locationEnabled) {
    stopLocationWatch();
  } else {
    startLocationWatch();
  }
});

function renderDistortedOverlay(imageUrl, corners) {
  if (typeof L.distortableImageOverlay !== "function") {
    throw new Error("Leaflet.DistortableImage が読み込まれていません");
  }

  if (overlay) {
    map.removeLayer(overlay);
    overlay = null;
  }

  overlay = L.distortableImageOverlay(imageUrl, {
    corners: corners.map((c) => L.latLng(Number(c.lat), Number(c.lng))),
    editable: false,
    selected: false,
    suppressToolbar: true,
    mode: "lock",
    opacity: 0.88,
    pane: "migrationOverlayPane"
  }).addTo(map);
}

function fitMapForViewport(bounds) {
  const isPortrait = window.innerHeight > window.innerWidth;

  const paddingTopLeft = isPortrait ? [18, 12] : [12, 12];
  const paddingBottomRight = isPortrait ? [18, 24] : [12, 12];

  map.fitBounds(bounds, {
    paddingTopLeft,
    paddingBottomRight
  });

  map.setMaxBounds(bounds.pad(isPortrait ? 0.02 : 0.03));
  map.options.maxBoundsViscosity = 1.0;

  const minZoom = map.getBoundsZoom(bounds, false, paddingBottomRight);
  map.setMinZoom(minZoom);
}

(async () => {
  try {
    const [projRes, boundsRes, shopsRes, guidesRes] = await Promise.all([
      fetch(`/api/migrationmaps/${PROJECT_ID}`),
      fetch(`/api/migrationmaps/${PROJECT_ID}/overlay_bounds`),
      fetch(`/api/migrationmaps/${PROJECT_ID}/shops`),
      fetch(`/api/migrationmaps/${PROJECT_ID}/building-guides`)
    ]);

    if (!projRes.ok) {
      titleEl.textContent = "地図が見つかりません";
      locationStatusEl.textContent = "読込失敗";
      return;
    }

    if (!boundsRes.ok) {
      titleEl.textContent = "重ね合わせ範囲の取得に失敗しました";
      locationStatusEl.textContent = "読込失敗";
      return;
    }

    projectData = await projRes.json();
    titleEl.textContent = projectData.name;

    const boundsData = await boundsRes.json();
    overlayBounds = boundsData.bounds;
    overlayCorners = boundsData.distortable_corners;
    overlayLatLngBounds = L.latLngBounds(overlayBounds);

    if (shopsRes.ok) {
      const shopsJson = await shopsRes.json();
      shopData = Array.isArray(shopsJson.shops) ? shopsJson.shops : [];
    } else {
      console.warn("shops api failed:", shopsRes.status);
      shopData = [];
    }

    if (guidesRes.ok) {
      const guidesJson = await guidesRes.json();
      buildingGuideMap = buildGuideMap(Array.isArray(guidesJson.guides) ? guidesJson.guides : []);
    } else {
      console.warn("building guides api failed:", guidesRes.status);
      buildingGuideMap = new Map();
    }

    console.log("overlayBounds:", overlayBounds);
    console.log("overlayCorners:", overlayCorners);

    renderDistortedOverlay(projectData.image_url, overlayCorners);
    fitMapForViewport(overlayLatLngBounds);
    addShopMarkers();

    locationStatusEl.textContent = "現在地表示はOFFです";

    window.addEventListener("resize", () => {
      if (overlayLatLngBounds) {
        fitMapForViewport(overlayLatLngBounds);
      }
    });
  } catch (err) {
    console.error("map init error:", err);
    titleEl.textContent = "地図の初期化に失敗しました";
    locationStatusEl.textContent = "読込失敗";
  }
})();

const appState = {
  selectedDestinationShopId: null, // 目的地
  autoGuideOpen: false,            // 案内パネル開閉
  activeBuildingFloor: null,       // 1F / 2F / 3F
  shownGuideKey: null              // 同じものを連続表示しない
};
// 同一ビルの判定をlat,lngで行い、誤差を丸める
function buildingKey(shop) {
  return `${Number(shop.lat).toFixed(7)},${Number(shop.lng).toFixed(7)}`;
}