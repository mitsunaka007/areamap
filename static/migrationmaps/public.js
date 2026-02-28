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

  // 精度円は任意。見やすさのため薄めに出す
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
  const res = await fetch(`/api/migrationmaps/${PROJECT_ID}`);
  if (!res.ok) {
    titleEl.textContent = "地図が見つかりません";
    locationStatusEl.textContent = "読込失敗";
    return;
  }

  projectData = await res.json();
  titleEl.textContent = projectData.name;

  const boundsRes = await fetch(`/api/migrationmaps/${PROJECT_ID}/overlay_bounds`);
  if (!boundsRes.ok) {
    titleEl.textContent = "重ね合わせ範囲の取得に失敗しました";
    locationStatusEl.textContent = "読込失敗";
    return;
  }

  const boundsData = await boundsRes.json();
  overlayBounds = boundsData.bounds;
  overlayLatLngBounds = L.latLngBounds(overlayBounds);

  // 画像を前面に重ねる
  overlay = L.imageOverlay(projectData.image_url, overlayBounds, {
    opacity: 0.82,
    pane: "migrationOverlayPane",
    interactive: false
  }).addTo(map);

  // 表示範囲をスクショ画像の範囲に固定
  map.fitBounds(overlayLatLngBounds);
  map.setMaxBounds(overlayLatLngBounds);
  map.options.maxBoundsViscosity = 1.0;

  // これ以上引きすぎないように最小ズームを固定
  const minZoom = map.getBoundsZoom(overlayLatLngBounds);
  map.setMinZoom(minZoom);

  // 点を表示
  const center = projectData.points.find((p) => p.label === "center");

  for (const p of projectData.points) {
    const m = L.marker([p.lat, p.lng]).addTo(map);

    if (p.label === "center") {
      m.bindPopup("center");
    } else {
      const d = center
        ? haversineMeters(center.lat, center.lng, p.lat, p.lng)
        : null;
      m.bindPopup(
        `${p.label}${d != null ? ` / centerから ${d.toFixed(1)}m` : ""}`
      );
    }
  }

  // 初期状態
  locationStatusEl.textContent = "現在地表示はOFFです";
})();