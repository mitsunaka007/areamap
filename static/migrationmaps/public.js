const map = L.map("map", {
  zoomControl: true
}).setView([35.0, 135.0], 14);

// イラスト画像用pane
map.createPane("migrationOverlayPane");
map.getPane("migrationOverlayPane").style.zIndex = 350;
map.getPane("migrationOverlayPane").style.pointerEvents = "none";

// マーカー用レイヤ
const markerLayer = L.layerGroup().addTo(map);

// OSM背面
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 20,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

let overlay = null;
let projectData = null;
let overlayBounds = null;
let overlayLatLngBounds = null;
let overlayCorners = null;
let shopData = [];

// 現在地関連
let locationEnabled = false;
let locationWatchId = null;
let currentLocationMarker = null;
let currentLocationCircle = null;

// DOM
const titleEl = document.getElementById("title");
const btnToggleLocation = document.getElementById("btnToggleLocation");
const locationStatusEl = document.getElementById("locationStatus");

// ---------- Utils ----------
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
  if (!telRaw) {
    return `<span class="shop-ig-none">📞 -</span>`;
  }

  const telHref = sanitizeTel(telRaw);
  if (!telHref) {
    return `<span class="shop-ig-none">📞 ${escapeHtml(telRaw)}</span>`;
  }

  return `
    <a href="tel:${escapeHtml(telHref)}" class="shop-ig-link" title="電話をかける">
      📞 ${escapeHtml(telRaw)}
    </a>
  `;
}

function buildInstagramPart(shop) {
  const igRaw = (shop.instagram_account || "").trim();
  if (!igRaw) {
    return `<span class="shop-ig-none">📷 -</span>`;
  }

  const account = igRaw.replace(/^@/, "");
  const igHref = `https://www.instagram.com/${encodeURIComponent(account)}/`;
  const label = igRaw.startsWith("@") ? igRaw : `@${igRaw}`;

  return `
    <a href="${igHref}" target="_blank" rel="noopener noreferrer" class="shop-ig-link" title="Instagramを開く">
      📷 ${escapeHtml(label)}
    </a>
  `;
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
    <div class="shop-popup multi-floor-popup" data-group-key="${escapeHtml(groupKey)}">
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

      popupRoot
        .querySelectorAll(`.floor-btn[data-group-key="${CSS.escape(groupKey)}"]`)
        .forEach((node) => node.classList.remove("is-active"));

      btn.classList.add("is-active");
    });
  });
}

function addShopMarkers() {
  markerLayer.clearLayers();

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
    const { lat, lng } = shopsAtSamePoint[0];
    const marker = L.marker([lat, lng]);

    if (shopsAtSamePoint.length === 1) {
      marker.bindPopup(buildSingleShopPopup(shopsAtSamePoint[0]), { maxWidth: 360 });
    } else {
      marker.bindPopup(buildBuildingPopup(shopsAtSamePoint, groupKey), { maxWidth: 360 });
      marker.on("popupopen", (e) => {
        attachFloorSwitcherHandlers(e.popup.getElement(), groupedShops);
      });
    }

    marker.addTo(markerLayer);
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

// ---------- 初期化 ----------
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
      shopData = [];
    }

    renderDistortedOverlay(projectData.image_url, overlayCorners);

    // 画像四隅から作った範囲を表示ベースにする
    map.fitBounds(overlayLatLngBounds, { padding: [8, 8] });
    map.setMaxBounds(overlayLatLngBounds.pad(0.03));
    map.options.maxBoundsViscosity = 1.0;

    const minZoom = map.getBoundsZoom(overlayLatLngBounds);
    map.setMinZoom(minZoom);

    addShopMarkers();

    locationStatusEl.textContent = "現在地表示はOFFです";
  } catch (err) {
    console.error(err);
    titleEl.textContent = "地図の初期化に失敗しました";
    locationStatusEl.textContent = "読込失敗";
  }
})();