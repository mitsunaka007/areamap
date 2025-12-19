// =========================
// Leaflet 初期化（固定）
// =========================
const map = L.map("map", {
  center: AREA.center,
  zoom: AREA.zoom,
  zoomControl: false,
  dragging: false,
  scrollWheelZoom: false,
  doubleClickZoom: false,
  touchZoom: false
});

// =========================
// 2色ミニマップ（背景）
// =========================
L.tileLayer(
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  {
    attribution: "",
    opacity: 0.25
  }
).addTo(map);

// =========================
// デフォルト：目的地1点（AREA）
// =========================
const destinationMarker = L.circleMarker(
  AREA.center,
  {
    radius: 8,
    color: "#111",
    fillColor: "#111",
    fillOpacity: 1
  }
).addTo(map);

// Google Map 誘導（デフォルト）
const googleMapLink = document.getElementById("google-map-link");
if (googleMapLink) {
  googleMapLink.href =
    `https://www.google.com/maps/search/?api=1&query=${AREA.center[0]},${AREA.center[1]}`;
}

// =======================================================
// 以下は「拡張機能」：SPOTS がある場合のみ有効
// =======================================================

if (typeof SPOTS !== "undefined" && SPOTS.length > 0) {

  function latLngToPercent(lat, lng) {
    const point = map.latLngToContainerPoint([lat, lng]);
    const size  = map.getSize();

    return {
      xPercent: (point.x / size.x) * 100,
      yPercent: (point.y / size.y) * 100
    };
  }

  const layer = document.getElementById("spot-cards-layer");
  const placedCards = [];

  SPOTS.forEach(spot => {
    const pos = latLngToPercent(spot.lat, spot.lng);

    const card = document.createElement("div");
    card.className = "spot-card card-up";
    card.dataset.spotId = spot.id;

    card.style.left = `${pos.xPercent}%`;
    card.style.top  = `${pos.yPercent}%`;

    card.innerHTML = `
      <p class="spot-name">${spot.name}</p>
      <p class="spot-meta">${spot.category || ""}</p>
    `;

    layer.appendChild(card);
    resolveOverlap(card, placedCards);
    placedCards.push(card);

    card.addEventListener("click", () => openModal(spot));
  });

  function isOverlapping(a, b) {
    const r1 = a.getBoundingClientRect();
    const r2 = b.getBoundingClientRect();

    return !(
      r1.right < r2.left ||
      r1.left > r2.right ||
      r1.bottom < r2.top ||
      r1.top > r2.bottom
    );
  }

  function resolveOverlap(card, others) {
    const directions = ["card-up", "card-right", "card-down", "card-left"];

    for (let dir of directions) {
      card.classList.remove(...directions);
      card.classList.add(dir);

      let overlapped = false;
      for (let other of others) {
        if (isOverlapping(card, other)) {
          overlapped = true;
          break;
        }
      }
      if (!overlapped) return;
    }
    card.classList.add("card-up");
  }

  // =========================
  // モーダル制御（拡張）
  // =========================
  const modal = document.getElementById("spot-modal");

  function openModal(spot) {
    modal.querySelector(".modal-title").textContent = spot.name;
    modal.querySelector(".modal-image img").src =
      spot.image || "/static/images/noimage.jpg";
    modal.querySelector(".modal-category").textContent =
      spot.category || "";
    modal.querySelector(".modal-address").textContent =
      spot.address || "";

    const menuEl = modal.querySelector(".modal-menu ul");
    menuEl.innerHTML = "";
    (spot.menu || []).forEach(item => {
      const li = document.createElement("li");
      li.textContent = `${item.name} ¥${item.price}`;
      menuEl.appendChild(li);
    });

    const gmap = modal.querySelector(".btn-route");
    gmap.href =
      `https://www.google.com/maps/search/?api=1&query=${spot.lat},${spot.lng}`;

    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeModal() {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
  }

  modal.querySelector(".modal-close").addEventListener("click", closeModal);
  modal.querySelector(".modal-overlay").addEventListener("click", closeModal);

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && modal.classList.contains("is-open")) {
      closeModal();
    }
  });

  window.addEventListener("resize", () => {
    document.querySelectorAll(".spot-card").forEach(c => c.remove());
    placedCards.length = 0;

    SPOTS.forEach(spot => {
      const pos = latLngToPercent(spot.lat, spot.lng);
      const card = document.createElement("div");
      card.className = "spot-card card-up";
      card.style.left = `${pos.xPercent}%`;
      card.style.top  = `${pos.yPercent}%`;

      card.innerHTML = `
        <p class="spot-name">${spot.name}</p>
        <p class="spot-meta">${spot.category || ""}</p>
      `;

      layer.appendChild(card);
      resolveOverlap(card, placedCards);
      placedCards.push(card);

      card.addEventListener("click", () => openModal(spot));
    });
  });
}

// =========================
// 画像オーバーレイ（常に保持）
// =========================
const overlayBounds = AREA.bounds || [
  [36.0635, 136.2210],
  [36.0600, 136.2260]
];

const overlayImage = L.imageOverlay(
  "/static/images/areamap_overlay.png",
  overlayBounds,
  {
    opacity: 0.6,
    interactive: false
  }
).addTo(map);

let overlayVisible = true;

function toggleOverlay() {
  if (overlayVisible) {
    map.removeLayer(overlayImage);
  } else {
    overlayImage.addTo(map);
  }
  overlayVisible = !overlayVisible;
}
