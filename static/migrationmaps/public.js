const map = L.map("map", {
  zoomControl: true,
  maxZoom: 22,
}).setView([35.0, 135.0], 14);

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

function buildBuildingPopup(groupShops, groupKey) {
  const floors = [...new Set(
    groupShops.map((s) => normalizeFloorLevel(s.floorlevel)).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b, "ja", { numeric: true }));

  const floorButtons = floors.length
    ? floors.map((floor, i) => {
        const active = i === 0 ? "is-active" : "";
        return `<button type="button" class="floor-btn ${active}" data-group-key="${escapeHtml(groupKey)}" data-floor="${escapeHtml(floor)}">${escapeHtml(floor)}</button>`;
      }).join("")
    : `<button type="button" class="floor-btn is-active" data-group-key="${escapeHtml(groupKey)}" data-floor="">未設定</button>`;

  const initialFloor = floors.length ? floors[0] : "";
  const initialShop =
    groupShops.find((s) => normalizeFloorLevel(s.floorlevel) === initialFloor) || groupShops[0];

  return `
    <div class="shop-popup multi-floor-popup">
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

function attachFloorSwitcherHandlers(popupRoot, groupedShops) {
  if (!popupRoot) return;

  popupRoot.querySelectorAll(".floor-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const groupKey = btn.dataset.groupKey || "";
      const floor = normalizeFloorLevel(btn.dataset.floor || "");
      const shops = groupedShops[groupKey] || [];
      const selected =
        shops.find((s) => normalizeFloorLevel(s.floorlevel) === floor) || shops[0];

      const detailEl = popupRoot.querySelector(`#floor-shop-${CSS.escape(groupKey)}`);
      if (!detailEl || !selected) return;

      detailEl.innerHTML = buildSingleShopPopup(selected);

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