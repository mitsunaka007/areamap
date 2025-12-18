const map = L.map("map", {
  center: AREA.center,
  zoom: AREA.zoom,
  zoomControl: false,
  dragging: false,
  scrollWheelZoom: false,
  doubleClickZoom: false,
  touchZoom: false
});

L.tileLayer(
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  {
    attribution: "",
    opacity: 0.25
  }
).addTo(map);
function latLngToPercent(lat, lng) {
  const point = map.latLngToContainerPoint([lat, lng]);
  const size  = map.getSize();

  return {
    xPercent: (point.x / size.x) * 100,
    yPercent: (point.y / size.y) * 100
  };
}
const layer = document.getElementById("spot-cards-layer");
const placedCards = []; // 重なり判定用

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

  // 重なりチェック & 自動調整
  resolveOverlap(card, placedCards);

  placedCards.push(card);

  // モーダル連携
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
  const directions = [
    "card-up",
    "card-right",
    "card-down",
    "card-left"
  ];

  for (let dir of directions) {
    card.classList.remove("card-up", "card-right", "card-down", "card-left");
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

  // 全部ダメなら最後は上（妥協）
  card.classList.add("card-up");
}
const modal = document.getElementById("spot-modal");

function openModal(spot) {
  modal.querySelector(".modal-title").textContent = spot.name;

  modal.querySelector(".modal-image img").src =
    spot.image || "/static/images/noimage.jpg";

  modal.querySelector(".modal-category").textContent =
    spot.category || "";

  modal.querySelector(".modal-address").textContent =
    spot.address || "";

  // メニュー生成
  const menuEl = modal.querySelector(".modal-menu ul");
  menuEl.innerHTML = "";

  (spot.menu || []).forEach(item => {
    const li = document.createElement("li");
    li.textContent = `${item.name} ¥${item.price}`;
    menuEl.appendChild(li);
  });

  // Google Map ルート
  const gmap = modal.querySelector(".btn-route");
  gmap.href = `https://www.google.com/maps/search/?api=1&query=${spot.lat},${spot.lng}`;

  modal.setAttribute("aria-hidden", "false");
}
modal.querySelector(".modal-close").addEventListener("click", closeModal);
modal.querySelector(".modal-overlay").addEventListener("click", closeModal);

function closeModal() {
  modal.setAttribute("aria-hidden", "true");
}
window.addEventListener("resize", () => {
  document.querySelectorAll(".spot-card").forEach(card => card.remove());
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

    document.getElementById("spot-cards-layer").appendChild(card);
    resolveOverlap(card, placedCards);
    placedCards.push(card);

    card.addEventListener("click", () => openModal(spot));
  });
});
