const map = L.map("map", {
    center: AREA.center,
    zoom: AREA.zoom,
    zoomControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: false
});

// 極薄タイル（後でstyle変更）
L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
        attribution: "",
        opacity: 0.3
    }
).addTo(map);

// マーカー
SPOTS.forEach(spot => {
    const marker = L.circleMarker(
        [spot.lat, spot.lng],
        {
            radius: 8,
            color: spot.status === "now" ? "#e53935" : "#4caf50",
            fillOpacity: 0.9
        }
    ).addTo(map);

    marker.on("click", () => {
        const card = document.getElementById("bottom-card");
        card.innerHTML = `
            <strong>${spot.name}</strong><br>
            <small>ステータス：${spot.status}</small>
        `;
    });
});
