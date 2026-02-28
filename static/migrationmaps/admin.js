let uploaded = null; // {image_url, image_filename, image_width, image_height}
let mode = null;     // "center" or "point"
let nextPointIndex = 1;

// 点データ（ペア作成）
const points = []; // {label, kind, img_x,img_y, lat,lng, img_ok, ll_ok}

const $ = (id) => document.getElementById(id);
const logEl = $("log");
const statusEl = $("status");
const tbody = $("pointsTbody");

function log(msg) {
  logEl.textContent += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function redrawTable() {
  tbody.innerHTML = "";
  for (const p of points) {
    const tr = document.createElement("tr");
    const ok = p.img_ok && p.ll_ok;
    tr.innerHTML = `
      <td>${p.label}</td>
      <td>${p.img_ok ? `${p.img_x.toFixed(1)}, ${p.img_y.toFixed(1)}` : "-"}</td>
      <td>${p.ll_ok ? `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}` : "-"}</td>
      <td><span class="pill ${ok ? "ok":"ng"}">${ok ? "OK" : "未完"}</span></td>
    `;
    tbody.appendChild(tr);
  }
}

function ensurePoint(label, kind) {
  let p = points.find(x => x.label === label);
  if (!p) {
    p = {label, kind, img_ok:false, ll_ok:false, img_x:0, img_y:0, lat:0, lng:0};
    points.push(p);
  }
  return p;
}

// --- 画像キャンバス ---
const canvas = $("imgCanvas");
const ctx = canvas.getContext("2d");
let img = new Image();
let canvasScale = 1; // 表示スケール

function setCanvasToImage(image) {
  // 表示は最大幅でフィット（実座標は image_width/height 基準）
  const maxW = Math.min(900, window.innerWidth * 0.45);
  canvasScale = Math.min(1, maxW / image.naturalWidth);

  canvas.width = Math.round(image.naturalWidth * canvasScale);
  canvas.height = Math.round(image.naturalHeight * canvasScale);

  ctx.clearRect(0,0,canvas.width, canvas.height);
  ctx.drawImage(image, 0,0, canvas.width, canvas.height);
  drawMarkersOnCanvas();
}

function drawMarkersOnCanvas() {
  // 画像再描画
  if (!img || !img.complete) return;
  ctx.clearRect(0,0,canvas.width, canvas.height);
  ctx.drawImage(img, 0,0, canvas.width, canvas.height);

  for (const p of points) {
    if (!p.img_ok) continue;
    const x = p.img_x * canvasScale;
    const y = p.img_y * canvasScale;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI*2);
    ctx.fillStyle = (p.kind === "center") ? "red" : "yellow";
    ctx.fill();
    ctx.strokeStyle = "black";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = "black";
    ctx.font = "12px sans-serif";
    ctx.fillText(p.label, x + 8, y - 8);
  }
}

canvas.addEventListener("click", (ev) => {
  if (!uploaded) return alert("先に画像をアップロードしてください");
  if (!mode) return alert("「中心を選択」または「地点を追加」を押してください");

  const rect = canvas.getBoundingClientRect();
  const cx = ev.clientX - rect.left;
  const cy = ev.clientY - rect.top;

  // 実ピクセル座標に戻す
  const img_x = cx / canvasScale;
  const img_y = cy / canvasScale;

  if (mode === "center") {
    const p = ensurePoint("center", "center");
    p.img_x = img_x; p.img_y = img_y; p.img_ok = true;
    log(`[IMG] center = (${p.img_x.toFixed(1)}, ${p.img_y.toFixed(1)})`);
  } else {
    const label = `p${nextPointIndex}`;
    const p = ensurePoint(label, "point");
    p.img_x = img_x; p.img_y = img_y; p.img_ok = true;
    log(`[IMG] ${label} = (${p.img_x.toFixed(1)}, ${p.img_y.toFixed(1)})`);
    nextPointIndex++;
  }

  mode = null;
  drawMarkersOnCanvas();
  redrawTable();
});

// --- Leaflet OSM ---
const map = L.map("map").setView([36.061, 136.223], 15); // 福井あたり初期値（適宜）
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 20,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

const markers = new Map(); // label -> Leaflet marker
let overlay = null;

function setMarker(label, latlng, kind) {
  if (markers.has(label)) {
    markers.get(label).setLatLng(latlng);
  } else {
    const m = L.marker(latlng, { draggable:false }).addTo(map);
    m.bindPopup(`${label}`);
    markers.set(label, m);
  }
}

let pendingAssign = null; // {label, kind}

function pickOSMTarget(label, kind) {
  pendingAssign = {label, kind};
  log(`[OSM] 次のクリックで ${label} の緯度経度を割当`);
}

map.on("click", (e) => {
  if (!pendingAssign) {
    log(`[OSM] click = ${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)} (未割当)`);
    return;
  }
  const {label, kind} = pendingAssign;
  const p = ensurePoint(label, kind);
  p.lat = e.latlng.lat;
  p.lng = e.latlng.lng;
  p.ll_ok = true;

  setMarker(label, e.latlng, kind);
  log(`[OSM] ${label} = ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`);
  pendingAssign = null;
  redrawTable();
});

// --- UI ---
$("btnSetCenter").addEventListener("click", () => {
  mode = "center";
  ensurePoint("center", "center");
  pickOSMTarget("center", "center");
  log("中心：画像をクリック→OSMをクリックでペア作成");
  redrawTable();
});

$("btnAddPoint").addEventListener("click", () => {
  mode = "point";
  const label = `p${nextPointIndex}`;
  ensurePoint(label, "point");
  pickOSMTarget(label, "point");
  log("地点：画像をクリック→OSMをクリックでペア作成");
  redrawTable();
});

// --- アップロード ---
$("fileInput").addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;

  const name = $("mapName").value.trim();
  if (!name) {
    alert("地図名を先に入力してください");
    ev.target.value = "";
    return;
  }

  const fd = new FormData();
  fd.append("file", file);
  fd.append("name", name);

  const res = await fetch("/api/maps/upload", { method:"POST", body: fd });
  const data = await res.json();
  if (!res.ok) return alert(data.error || "upload failed");

  uploaded = data;
  img = new Image();
  img.onload = () => setCanvasToImage(img);
  img.src = data.image_url;

  log(`[UPLOAD] ${data.image_filename} (${data.image_width}x${data.image_height})`);
  statusEl.textContent = "未保存";
  statusEl.className = "pill ng";
});

// --- 距離計測（表示用：中心→各点） ---
function haversineMeters(lat1,lng1,lat2,lng2){
  const R = 6371000;
  const toRad = (d)=> d*Math.PI/180;
  const dLat = toRad(lat2-lat1);
  const dLng = toRad(lng2-lng1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

// --- アフィン推定はサーバ側で行い、overlay_bounds を使って重ね合わせ ---
$("btnPreviewOverlay").addEventListener("click", async () => {
  if (!uploaded) return alert("先に画像をアップロードしてください");
  const ready = points.filter(p => p.img_ok && p.ll_ok);
  if (ready.length < 3) return alert("中心+2点以上（合計3点以上）のペアが必要です");

  // まだ保存していないなら、まず一旦保存（プレビューもDB基準に統一）
  const projectId = await saveToDB(false);
  if (!projectId) return;

  const res = await fetch(`/api/maps/${projectId}/overlay_bounds`);
  const data = await res.json();

  if (overlay) map.removeLayer(overlay);

  // 画像をOSMに重ねる
  overlay = L.imageOverlay(uploaded.image_url, data.bounds, { opacity: 0.65 }).addTo(map);
  map.fitBounds(data.bounds);

  log(`[OVERLAY] bounds = ${JSON.stringify(data.bounds)}`);

  // 中心から距離表示（OSM距離）
  const center = ready.find(p => p.label === "center");
  if (center) {
    for (const p of ready) {
      if (p.label === "center") continue;
      const d = haversineMeters(center.lat, center.lng, p.lat, p.lng);
      log(`[DIST] OSM center -> ${p.label} = ${d.toFixed(1)} m`);
    }
  }
});

async function saveToDB(showAlert=true) {
  const name = $("mapName").value.trim();
  if (!name) { if(showAlert) alert("地図名が必要です"); return null; }
  if (!uploaded) { if(showAlert) alert("画像アップロードが必要です"); return null; }

  const ready = points.filter(p => p.img_ok && p.ll_ok);
  if (ready.length < 3) { if(showAlert) alert("点が足りません（3点以上）"); return null; }

  const payload = {
    name,
    image_filename: uploaded.image_filename,
    image_width: uploaded.image_width,
    image_height: uploaded.image_height,
    points: ready.map(p => ({
      label: p.label,
      kind: p.kind,
      img_x: p.img_x,
      img_y: p.img_y,
      lat: p.lat,
      lng: p.lng
    }))
  };

  const res = await fetch("/api/maps/save", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) {
    if (showAlert) alert(data.error || "save failed");
    return null;
  }

  statusEl.textContent = "保存済み";
  statusEl.className = "pill ok";

  const url = `/m/${data.project_id}`;
  $("publicLink").innerHTML = `公開URL: <a href="${url}" target="_blank" rel="noopener">${url}</a>`;
  log(`[SAVE] project_id=${data.project_id}`);

  return data.project_id;
}

$("btnSave").addEventListener("click", async () => {
  await saveToDB(true);
});

redrawTable();
log("準備OK：地図名→画像アップロード→中心/地点のペアを3つ以上→プレビュー→保存");