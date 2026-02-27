const map = L.map("map").setView([35.0, 135.0], 14);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 20,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

let overlay = null;

function haversineMeters(lat1,lng1,lat2,lng2){
  const R = 6371000;
  const toRad = (d)=> d*Math.PI/180;
  const dLat = toRad(lat2-lat1);
  const dLng = toRad(lng2-lng1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

(async () => {
  const res = await fetch(`/api/migrationmaps/${PROJECT_ID}`);
  if (!res.ok) {
    document.getElementById("title").textContent = "地図が見つかりません";
    return;
  }
  const proj = await res.json();
  document.getElementById("title").textContent = proj.name;

  const boundsRes = await fetch(`/api/migrationmaps/${PROJECT_ID}/overlay_bounds`);
  const b = await boundsRes.json();

  overlay = L.imageOverlay(proj.image_url, b.bounds, { opacity: 0.8 }).addTo(map);
  map.fitBounds(b.bounds);

  // 点を表示
  const center = proj.points.find(p => p.label === "center");
  for (const p of proj.points) {
    const m = L.marker([p.lat, p.lng]).addTo(map);
    if (p.label === "center") {
      m.bindPopup("center").openPopup();
    } else {
      const d = center ? haversineMeters(center.lat, center.lng, p.lat, p.lng) : null;
      m.bindPopup(`${p.label}${d!=null ? ` / centerから ${d.toFixed(1)}m` : ""}`);
    }
  }
})();