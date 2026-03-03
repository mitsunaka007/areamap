const map = L.map("map", {
  zoomControl: true
}).setView([35.0, 135.0], 14);

// スクショ画像を前面に出す専用pane
map.createPane("migrationOverlayPane");
map.getPane("migrationOverlayPane").style.zIndex = 450;

// OSMタイル（背面）
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 20,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

let overlay = null;
let projectData = null;
let overlayBounds = null;
let overlayLatLngBounds = null;
let shopData = [];

// 現在地関連
let locationEnabled = false;
let locationWatchId = null;
let currentLocationMarker = null;
let currentLocationCircle = null;

// ---------- DOM ----------
const titleEl = document.getElementById("title");
const btnToggleLocation = document.getElementById("btnToggleLocation");
const locationStatusEl = document.getElementById("locationStatus");

// ---------- 距離 ----------
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(a));
}

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

function buildSingleShopPopup(shop) {
  const name = escapeHtml(shop.shopname || "店名未設定");
  const address = escapeHtml(shop.address || "-");
  const tel = escapeHtml(shop.tel || "-");
  const floor = escapeHtml(shop.floorlevel || "-");
  const igRaw = (shop.instagram_account || "").trim();
  const igText = igRaw ? (igRaw.startsWith("@") ? igRaw : `@${igRaw}`) : "-";
  const igHref = igRaw
    ? `https://www.instagram.com/${encodeURIComponent(igRaw.replace(/^@/, ""))}/`
    : "";

  const igPart = igRaw
    ? `<a href="${igHref}" target="_blank" rel="noopener noreferrer" class="shop-ig-link" title="Instagramを開く">📷 ${escapeHtml(igText)}</a>`
    : `<span class="shop-ig-none">📷 -</span>`;

  return `
    <div class="shop-popup">
      <div class="shop-name">${name}</div>
      <div class="shop-meta"><span class="shop-label">階</span><span>${floor}</span></div>
      <div class="shop-meta"><span class="shop-label">住所</span><span>${address}</span></div>
      <div class="shop-meta"><span class="shop-label">TEL</span><span>${tel}</span></div>
      <div class="shop-meta"><span class="shop-label">Instagram</span><span>${igPart}</span></div>
    </div>
  `;
}

function buildBuildingPopup(groupShops, groupKey) {
  const floors = [...new Set(groupShops.map((s) => normalizeFloorLevel(s.floorlevel)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "ja", { numeric: true }));

  const floorButtons = floors.length
    ? floors
        .map((floor, i) => {
          const active = i === 0 ? "is-active" : "";
          return `<button type="button" class="floor-btn ${active}" data-group-key="${escapeHtml(groupKey)}" data-floor="${escapeHtml(floor)}">${escapeHtml(floor)}</button>`;
        })
        .join("")
    : `<button type="button" class="floor-btn is-active" data-group-key="${escapeHtml(groupKey)}" data-floor="">未設定</button>`;

  const initialFloor = floors.length ? floors[0] : "";
  const initialShop = groupShops.find((s) => normalizeFloorLevel(s.floorlevel) === initialFloor) || groupShops[0];

  return `
    <div class="shop-popup multi-floor-popup" data-group-key="${escapeHtml(groupKey)}">
      <img
        class="building-illustration"
        alt="ビルイメージ"
        src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='200' viewBox='0 0 140 200'%3E%3Crect x='24' y='8' width='92' height='184' rx='4' fill='%23e5e7eb' stroke='%236b7280' stroke-width='3'/%3E%3Cg fill='%239ca3af'%3E%3Crect x='38' y='22' width='14' height='14'/%3E%3Crect x='62' y='22' width='14' height='14'/%3E%3Crect x='86' y='22' width='14' height='14'/%3E%3Crect x='38' y='48' width='14' height='14'/%3E%3Crect x='62' y='48' width='14' height='14'/%3E%3Crect x='86' y='48' width='14' height='14'/%3E%3Crect x='38' y='74' width='14' height='14'/%3E%3Crect x='62' y='74' width='14' height='14'/%3E%3Crect x='86' y='74' width='14' height='14'/%3E%3Crect x='38' y='100' width='14' height='14'/%3E%3Crect x='62' y='100' width='14' height='14'/%3E%3Crect x='86' y='100' width='14' height='14'/%3E%3C/g%3E%3Crect x='62' y='148' width='16' height='44' fill='%236b7280'/%3E%3C/svg%3E"
      />
      <div class="floor-switch">${floorButtons}</div>
      <div class="floor-shop-detail" id="floor-shop-${escapeHtml(groupKey)}">
        ${buildSingleShopPopup(initialShop)}
      </div>
    </div>
  `;
}

function attachFloorSwitcherHandlers(groupedShops) {
  document.querySelectorAll(".floor-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const groupKey = btn.dataset.groupKey;
      const floor = normalizeFloorLevel(btn.dataset.floor || "");
      const shops = groupedShops[groupKey] || [];
      const selected = shops.find((s) => normalizeFloorLevel(s.floorlevel) === floor) || shops[0];
      const detailEl = document.getElementById(`floor-shop-${groupKey}`);
      if (!detailEl || !selected) return;

      detailEl.innerHTML = buildSingleShopPopup(selected);

      document
        .querySelectorAll(`.floor-btn[data-group-key="${CSS.escape(groupKey)}"]`)
        .forEach((node) => node.classList.remove("is-active"));
      btn.classList.add("is-active");
    });
  });
}

function addShopMarkers() {
  if (!shopData.length) {
    return;
  }

  const groupedShops = shopData.reduce((acc, shop) => {
    const key = latLngGroupKey(shop.lat, shop.lng);
    if (!acc[key]) acc[key] = [];
    acc[key].push(shop);
    return acc;
  }, {});

  Object.entries(groupedShops).forEach(([groupKey, shopsAtSamePoint]) => {
    const { lat, lng } = shopsAtSamePoint[0];
    const marker = L.marker([lat, lng]).addTo(map);

    if (shopsAtSamePoint.length === 1) {
      marker.bindPopup(buildSingleShopPopup(shopsAtSamePoint[0]), { maxWidth: 320 });
      return;
    }

    marker.bindPopup(buildBuildingPopup(shopsAtSamePoint, groupKey), { maxWidth: 340 });
    marker.on("popupopen", () => {
      attachFloorSwitcherHandlers(groupedShops);
    });
  });
}

// ---------- 位置情報 ----------
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
    locationStatusEl.textContent = "現在地は地図の表示外です";
    return;
  }

  locationStatusEl.textContent =
    `現在地: ${lat.toFixed(6)}, ${lng.toFixed(6)} / ±${Math.round(accuracy)}m`;

  if (currentLocationMarker) {
    currentLocationMarker.setLatLng([lat, lng]);
  } else {
    currentLocationMarker = L.marker([lat, lng]).addTo(map);
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
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const accuracy = pos.coords.accuracy;

      updateLocationInsideBounds(lat, lng, accuracy);
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

// ---------- 地図読込 ----------
(async () => {
  const [projRes, boundsRes, shopsRes] = await Promise.all([
    fetch(`/api/migrationmaps/${PROJECT_ID}`),
    fetch(`/api/migrationmaps/${PROJECT_ID}/overlay_bounds`),
    fetch(`/api/migrationmaps/${PROJECT_ID}/shops`)
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

  if (shopsRes.ok) {
    const shopsJson = await shopsRes.json();
    shopData = shopsJson.shops || [];
  }

  projectData = await projRes.json();
  titleEl.textContent = projectData.name;

  const boundsData = await boundsRes.json();
  overlayBounds = boundsData.bounds;
  overlayLatLngBounds = L.latLngBounds(overlayBounds);

  overlay = L.imageOverlay(projectData.image_url, overlayBounds, {
    opacity: 0.82,
    pane: "migrationOverlayPane",
    interactive: false
  }).addTo(map);

  map.fitBounds(overlayLatLngBounds);
  map.setMaxBounds(overlayLatLngBounds);
  map.options.maxBoundsViscosity = 1.0;

  const minZoom = map.getBoundsZoom(overlayLatLngBounds);
  map.setMinZoom(minZoom);

  addShopMarkers();

  locationStatusEl.textContent = "現在地表示はOFFです";
})();