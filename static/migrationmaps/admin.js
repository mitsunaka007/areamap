// ================================================================
// MigrationMaps Admin JS — デュアルレイヤー対応
// ================================================================

// ---- ユーティリティ ----
const $ = (id) => document.getElementById(id);
const logEl = $("log");
const statusEl = $("status");
const editingProjectEl = $("editingProject");
const currentLocationBadge = $("currentLocationBadge");
const registeredShopListEl = $("registeredShopList");
const projectListEl = $("projectList");
const shopMenuToggle = $("shopMenuToggle");
const shopMenuBody = $("shopMenuBody");
const shopMenuToggleIcon = $("shopMenuToggleIcon");

function log(msg) {
  if (!logEl) return;
  logEl.textContent += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function setDirty(dirty = true) {
  if (!statusEl) return;
  statusEl.textContent = dirty ? "未保存" : "保存済み";
  statusEl.className = `pill ${dirty ? "ng" : "ok"}`;
}

// ================================================================
// レイヤー状態管理
// ================================================================

const LAYERS = {
  1: {
    uploaded: null,
    points: [],
    img: new Image(),
    canvasScale: 1,
    nextPointIndex: 1,
    dragState: null,
    mode: null,
  },
  2: {
    uploaded: null,
    points: [],
    img: new Image(),
    canvasScale: 1,
    nextPointIndex: 1,
    dragState: null,
    mode: null,
  },
};

let activeLayer = 1;
const AL = () => LAYERS[activeLayer];

// キャンバス要素（DOM 読み込み後に設定）
const canvas1 = $("imgCanvas1");
const canvas2 = $("imgCanvas2");
const ctx1 = canvas1?.getContext("2d");
const ctx2 = canvas2?.getContext("2d");

function getCanvas(layerNum) { return layerNum === 1 ? canvas1 : canvas2; }
function getCtx(layerNum) { return layerNum === 1 ? ctx1 : ctx2; }
function getTbody(layerNum) { return layerNum === 1 ? $("pointsTbody1") : $("pointsTbody2"); }

// OSM マップ上のマーカー（レイヤー別）
const markersL1 = new Map();
const markersL2 = new Map();
function getMarkers(layerNum) { return layerNum === 1 ? markersL1 : markersL2; }

// アフィン係数（ロード済みプロジェクトから）
let currentAffineL1 = null;
let currentAffineL2 = null;
let currentProjectId = null;

// ジオリファレンス capture メタデータ（レイヤー別）。null = 未確定（= manual）
const captureMeta = { 1: null, 2: null };

function captureFromCurrentMap() {
  const cont = map.getContainer();
  return {
    center_lat: map.getCenter().lat,
    center_lng: map.getCenter().lng,
    zoom: map.getZoom(),
    width: cont.clientWidth,
    height: cont.clientHeight,
    dpr: window.devicePixelRatio || 1,
  };
}

function setCaptureStatus(layerNum) {
  const el = $(`captureStatus${layerNum}`);
  if (!el) return;
  const m = captureMeta[layerNum];
  el.textContent = m
    ? `確定: 中心 ${m.center_lat.toFixed(5)}, ${m.center_lng.toFixed(5)} / z${m.zoom} / ${m.width}×${m.height}px @dpr${m.dpr}`
    : "未確定（確定するとレイヤー1は対応点なしで保存できます）";
}

function showGuideFrame() {
  const mapEl = $("map");
  let frame = $("captureGuideFrame");
  if (!frame) {
    frame = document.createElement("div");
    frame.id = "captureGuideFrame";
    mapEl.parentElement.appendChild(frame);
  }
  frame.style.left = mapEl.offsetLeft + "px";
  frame.style.top = mapEl.offsetTop + "px";
  frame.style.width = mapEl.clientWidth + "px";
  frame.style.height = mapEl.clientHeight + "px";
}

const EARTH_CIRCUMFERENCE_M = 40075016.68557849;
function resAtZoom(z) { return EARTH_CIRCUMFERENCE_M / (256 * Math.pow(2, z)); }

// 画像座標 -> 緯度経度（アフィン係数はロード済みプロジェクトのもの）
function imgToLatLng(affine, x, y) {
  const { a, b, c, d, e, f } = affine;
  const R = 6378137;
  const X = a * x + b * y + c;
  const Y = d * x + e * y + f;
  const lng = (X / R) * 180 / Math.PI;
  const lat = (2 * Math.atan(Math.exp(Y / R)) - Math.PI / 2) * 180 / Math.PI;
  return [lat, lng];
}

let verifyMode = false;
let verifyMarker = null;     // OSM 上の「変換結果」
let verifyExpected = null;   // OSM 上の「本来あるべき位置」

$("btnCaptureFrame")?.addEventListener("click", () => {
  captureMeta[activeLayer] = captureFromCurrentMap();
  setCaptureStatus(activeLayer);
  showGuideFrame();
  log(`[CAPTURE] L${activeLayer} キャプチャ枠を確定。この枠のとおりにスクショ→イラスト化→アップロードしてください`);
  setDirty(true);
});

$("btnExportBasemap")?.addEventListener("click", async () => {
  const w = parseInt($("basemapW").value, 10);
  const h = parseInt($("basemapH").value, 10);
  const c = map.getCenter();
  const z = map.getZoom();
  const url = `/api/migrationmaps/basemap?lat=${c.lat}&lng=${c.lng}&zoom=${z}&width=${w}&height=${h}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || `ベース地図の取得に失敗しました (${res.status})`);
      return;
    }
    // capture メタデータはサーバーが生成に使った値（= リクエスト値）で確定
    captureMeta[activeLayer] = {
      center_lat: c.lat, center_lng: c.lng, zoom: z,
      width: w, height: h, dpr: 1,
    };
    setCaptureStatus(activeLayer);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `basemap_z${z}_${w}x${h}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
    log(`[CAPTURE] L${activeLayer} ベース地図PNGを書き出し。上からイラストを描いて同サイズでアップロードしてください`);
    setDirty(true);
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
  }
});

// 現在地
let currentLocation = null;
let geolocationWatchId = null;
let currentLocationMarker = null;

// ================================================================
// タブ切り替え
// ================================================================

document.querySelectorAll(".layer-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const layerNum = parseInt(btn.dataset.layer, 10);
    switchActiveLayer(layerNum);
  });
});

function switchActiveLayer(layerNum) {
  activeLayer = layerNum;
  document.querySelectorAll(".layer-tab").forEach((b) => {
    b.classList.toggle("is-active", parseInt(b.dataset.layer, 10) === layerNum);
  });
  $("layerPanel1").classList.toggle("is-active", layerNum === 1);
  $("layerPanel2").classList.toggle("is-active", layerNum === 2);
  redrawTable(layerNum);
  setCaptureStatus(layerNum);
  log(`[TAB] レイヤー${layerNum}を編集中`);
}

// ================================================================
// 点の管理
// ================================================================

function ensurePoint(label, kind, layerNum) {
  const pts = LAYERS[layerNum].points;
  let p = pts.find((x) => x.label === label);
  if (!p) {
    p = { label, kind, layer: layerNum, img_ok: false, ll_ok: false, img_x: 0, img_y: 0, lat: "", lng: "" };
    pts.push(p);
  }
  return p;
}

function sortPoints(layerNum) {
  LAYERS[layerNum].points.sort((a, b) => {
    if (a.label === "center") return -1;
    if (b.label === "center") return 1;
    return Number(a.label.slice(1)) - Number(b.label.slice(1));
  });
}

function redrawTable(layerNum) {
  sortPoints(layerNum);
  const tbody = getTbody(layerNum);
  if (!tbody) return;
  tbody.innerHTML = "";

  for (const p of LAYERS[layerNum].points) {
    const ok = p.img_ok && p.ll_ok;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p.label}</td>
      <td>
        ${p.img_ok ? `${Number(p.img_x).toFixed(1)}, ${Number(p.img_y).toFixed(1)}` : "-"}
        <div style="margin-top:4px;">
          <button type="button" class="small-btn btnSelectOnImage" data-label="${p.label}" data-layer="${layerNum}">
            クリックで再設定
          </button>
        </div>
      </td>
      <td>
        <div>${p.ll_ok ? `${Number(p.lat).toFixed(6)}, ${Number(p.lng).toFixed(6)}` : "-"}</div>
        <div class="coord-inputs">
          <input type="number" step="0.000001" class="latInput" data-label="${p.label}" data-layer="${layerNum}" value="${p.ll_ok ? p.lat : ""}" placeholder="lat" />
          <input type="number" step="0.000001" class="lngInput" data-label="${p.label}" data-layer="${layerNum}" value="${p.ll_ok ? p.lng : ""}" placeholder="lng" />
        </div>
        <div style="margin-top:4px; display:flex; gap:6px; flex-wrap:wrap;">
          <button type="button" class="small-btn btnApplyLatLng" data-label="${p.label}" data-layer="${layerNum}" ${p.img_ok ? "" : "disabled"}>手入力を反映</button>
          <button type="button" class="small-btn btnAssignOSM" data-label="${p.label}" data-kind="${p.kind}" data-layer="${layerNum}" ${p.img_ok ? "" : "disabled"}>
            ${p.ll_ok ? "OSMで再設定" : "OSMで設定"}
          </button>
        </div>
      </td>
      <td><span class="pill ${ok ? "ok" : "ng"}">${ok ? "OK" : "未完"}</span></td>
    `;
    tbody.appendChild(tr);
  }
}

// tbody イベント委譲（両レイヤー）
[1, 2].forEach((layerNum) => {
  getTbody(layerNum)?.addEventListener("click", (ev) => {
    const assignBtn = ev.target.closest(".btnAssignOSM");
    if (assignBtn) {
      const label = assignBtn.dataset.label;
      const kind = assignBtn.dataset.kind;
      const ln = parseInt(assignBtn.dataset.layer, 10);
      const p = ensurePoint(label, kind, ln);
      if (!p.img_ok) { alert("先に画像座標を設定してください"); return; }
      activeLayer = ln;
      pickOSMTarget(label, kind, ln);
      log(`[EDIT] L${ln} ${label} の緯度経度をOSMクリックで設定します`);
      return;
    }

    const applyBtn = ev.target.closest(".btnApplyLatLng");
    if (applyBtn) {
      const label = applyBtn.dataset.label;
      const ln = parseInt(applyBtn.dataset.layer, 10);
      const p = ensurePoint(label, label === "center" ? "center" : "point", ln);
      const tbody = getTbody(ln);
      const latVal = tbody?.querySelector(`.latInput[data-label="${label}"][data-layer="${ln}"]`)?.value;
      const lngVal = tbody?.querySelector(`.lngInput[data-label="${label}"][data-layer="${ln}"]`)?.value;
      if (!latVal || !lngVal) { alert("緯度経度を入力してください"); return; }
      p.lat = Number(latVal);
      p.lng = Number(lngVal);
      p.ll_ok = Number.isFinite(p.lat) && Number.isFinite(p.lng);
      if (!p.ll_ok) { alert("緯度経度が不正です"); return; }
      setMarker(label, [p.lat, p.lng], p.kind, ln);
      setDirty(true);
      redrawTable(ln);
      log(`[MANUAL] L${ln} ${label} = ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`);
      return;
    }

    const imageBtn = ev.target.closest(".btnSelectOnImage");
    if (imageBtn) {
      const label = imageBtn.dataset.label;
      const ln = parseInt(imageBtn.dataset.layer, 10);
      activeLayer = ln;
      switchActiveLayer(ln);
      LAYERS[ln].mode = label === "center" ? "center" : { type: "edit-point", label };
      log(`[IMG] L${ln} 次の画像クリックで ${label} の画像座標を更新します`);
    }
  });
});

// ================================================================
// キャンバス描画
// ================================================================

const DRAG_HIT_RADIUS = 14;

function getCanvasPos(ev, canvas) {
  const rect = canvas.getBoundingClientRect();
  const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
  const clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
  return { cx: clientX - rect.left, cy: clientY - rect.top };
}

function getPointAtCanvasPos(cx, cy, ls) {
  const ordered = [...ls.points].sort((a, b) => {
    if (a.label === "center") return -1;
    if (b.label === "center") return 1;
    return 0;
  });
  for (const p of ordered) {
    if (!p.img_ok) continue;
    const px = p.img_x * ls.canvasScale;
    const py = p.img_y * ls.canvasScale;
    if (Math.sqrt((cx - px) ** 2 + (cy - py) ** 2) <= DRAG_HIT_RADIUS) return p;
  }
  return null;
}

function setCanvasToImage(image, layerNum) {
  const canvas = getCanvas(layerNum);
  if (!canvas) return;
  const maxW = Math.min(900, window.innerWidth * 0.30);
  const scale = Math.min(1, maxW / image.naturalWidth);
  LAYERS[layerNum].canvasScale = scale;
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  drawMarkersOnCanvas(layerNum);
}

function drawMarkersOnCanvas(layerNum) {
  const ls = LAYERS[layerNum];
  const canvas = getCanvas(layerNum);
  const ctx = getCtx(layerNum);
  if (!ls.img || !ls.img.complete || !ctx || !canvas) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(ls.img, 0, 0, canvas.width, canvas.height);

  for (const p of ls.points) {
    if (!p.img_ok) continue;
    const x = p.img_x * ls.canvasScale;
    const y = p.img_y * ls.canvasScale;
    const isDragging = ls.dragState && ls.dragState.point.label === p.label;

    ctx.beginPath();
    ctx.arc(x, y, isDragging ? 9 : 6, 0, Math.PI * 2);
    ctx.fillStyle = p.kind === "center" ? "red" : (layerNum === 1 ? "yellow" : "#f97316");
    ctx.fill();
    ctx.strokeStyle = isDragging ? "white" : "black";
    ctx.lineWidth = isDragging ? 3 : 2;
    ctx.stroke();
    ctx.fillStyle = "black";
    ctx.font = "12px sans-serif";
    ctx.fillText(p.label, x + 8, y - 8);
  }

  // 現在地（アクティブレイヤーのみ）
  if (layerNum === activeLayer && currentLocation) {
    const affine = layerNum === 1 ? currentAffineL1 : currentAffineL2;
    if (affine && ls.uploaded) {
      const { a, b, c, d, e, f } = affine;
      const R = 6378137;
      const lng = currentLocation.lng;
      const lat = currentLocation.lat;
      const X = R * (lng * Math.PI / 180);
      const latClamped = Math.max(Math.min(lat, 85.05112878), -85.05112878);
      const Y = R * Math.log(Math.tan(Math.PI / 4 + (latClamped * Math.PI / 180) / 2));
      const det = a * e - b * d;
      if (Math.abs(det) > 1e-6) {
        const img_x = (e * (X - c) - b * (Y - f)) / det;
        const img_y = (a * (Y - f) - d * (X - c)) / det;
        if (img_x >= 0 && img_x <= ls.uploaded.image_width && img_y >= 0 && img_y <= ls.uploaded.image_height) {
          const sx = img_x * ls.canvasScale;
          const sy = img_y * ls.canvasScale;
          ctx.beginPath();
          ctx.arc(sx, sy, 8, 0, Math.PI * 2);
          ctx.fillStyle = "deepskyblue";
          ctx.fill();
          ctx.strokeStyle = "white";
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.fillStyle = "#003049";
          ctx.font = "12px sans-serif";
          ctx.fillText("現在地", sx + 10, sy + 4);
        }
      }
    }
  }
}

// ================================================================
// キャンバスイベント（両レイヤー共通ファクトリ）
// ================================================================

function setupCanvasEvents(canvas, layerNum) {
  if (!canvas) return;

  canvas.addEventListener("mousedown", (ev) => {
    const ls = LAYERS[layerNum];
    if (!ls.uploaded || ls.mode) return;
    const { cx, cy } = getCanvasPos(ev, canvas);
    const p = getPointAtCanvasPos(cx, cy, ls);
    if (!p) return;
    ls.dragState = { point: p };
    canvas.style.cursor = "grabbing";
    ev.preventDefault();
  });

  canvas.addEventListener("mousemove", (ev) => {
    const ls = LAYERS[layerNum];
    if (!ls.uploaded) return;
    const { cx, cy } = getCanvasPos(ev, canvas);
    if (ls.dragState) {
      ls.dragState.point.img_x = Math.max(0, Math.min(ls.uploaded.image_width, cx / ls.canvasScale));
      ls.dragState.point.img_y = Math.max(0, Math.min(ls.uploaded.image_height, cy / ls.canvasScale));
      drawMarkersOnCanvas(layerNum);
      ev.preventDefault();
      return;
    }
    const p = getPointAtCanvasPos(cx, cy, ls);
    canvas.style.cursor = p ? "grab" : (ls.mode ? "crosshair" : "default");
  });

  canvas.addEventListener("mouseup", () => {
    const ls = LAYERS[layerNum];
    if (!ls.dragState) return;
    const p = ls.dragState.point;
    ls.dragState = null;
    canvas.style.cursor = "default";
    setDirty(true);
    redrawTable(layerNum);
    log(`[DRAG] L${layerNum} ${p.label} → (${p.img_x.toFixed(1)}, ${p.img_y.toFixed(1)})`);
  });

  canvas.addEventListener("click", (ev) => {
    const ls = LAYERS[layerNum];
    if (!ls.uploaded) {
      alert("先に画像をアップロードまたは保存済み地図を読み込んでください");
      return;
    }
    if (!ls.mode) return;

    const { cx, cy } = getCanvasPos(ev, canvas);
    const img_x = cx / ls.canvasScale;
    const img_y = cy / ls.canvasScale;

    if (ls.mode === "center") {
      const p = ensurePoint("center", "center", layerNum);
      p.img_x = img_x; p.img_y = img_y; p.img_ok = true;
      pickOSMTarget("center", "center", layerNum);
      log(`[IMG] L${layerNum} center = (${p.img_x.toFixed(1)}, ${p.img_y.toFixed(1)})`);
    } else if (ls.mode === "point") {
      const label = `p${ls.nextPointIndex}`;
      const p = ensurePoint(label, "point", layerNum);
      p.img_x = img_x; p.img_y = img_y; p.img_ok = true;
      pickOSMTarget(label, "point", layerNum);
      ls.nextPointIndex++;
      log(`[IMG] L${layerNum} ${label} = (${p.img_x.toFixed(1)}, ${p.img_y.toFixed(1)})`);
    } else if (typeof ls.mode === "object" && ls.mode.type === "edit-point") {
      const p = ensurePoint(ls.mode.label, ls.mode.label === "center" ? "center" : "point", layerNum);
      p.img_x = img_x; p.img_y = img_y; p.img_ok = true;
      log(`[IMG] L${layerNum} ${p.label} 画像座標更新 = (${p.img_x.toFixed(1)}, ${p.img_y.toFixed(1)})`);
    }

    ls.mode = null;
    setDirty(true);
    drawMarkersOnCanvas(layerNum);
    redrawTable(layerNum);
  });
}

setupCanvasEvents(canvas1, 1);
setupCanvasEvents(canvas2, 2);

// ================================================================
// Leaflet マップ
// ================================================================

const map = L.map("map", { zoomSnap: 1, zoomDelta: 1 }).setView([36.061, 136.223], 15);
map.createPane("migrationOverlayPane");
map.getPane("migrationOverlayPane").style.zIndex = 450;

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 20,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

let overlayL1 = null;
let overlayL2 = null;
let pendingAssign = null; // { label, kind, layerNum }

function setMarker(label, latlng, kind, layerNum) {
  const mMap = getMarkers(layerNum);
  if (mMap.has(label)) {
    mMap.get(label).setLatLng(latlng);
  } else {
    let m;
    if (layerNum === 2) {
      m = L.circleMarker(latlng, { radius: 8, color: "#f97316", fillColor: "#f97316", fillOpacity: 0.8 }).addTo(map);
    } else {
      m = L.marker(latlng).addTo(map);
    }
    m.bindPopup(`[L${layerNum}] ${label}`);
    mMap.set(label, m);
  }
}

function pickOSMTarget(label, kind, layerNum) {
  pendingAssign = { label, kind, layerNum };
  log(`[OSM] 次のクリックで L${layerNum} ${label} の緯度経度を割当`);
}

map.on("click", (e) => {
  if (!pendingAssign) return;
  const { label, kind, layerNum } = pendingAssign;
  const p = ensurePoint(label, kind, layerNum);
  p.lat = e.latlng.lat;
  p.lng = e.latlng.lng;
  p.ll_ok = true;
  setMarker(label, e.latlng, kind, layerNum);
  pendingAssign = null;
  setDirty(true);
  redrawTable(layerNum);
  log(`[OSM] L${layerNum} ${label} = ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`);
});

// ================================================================
// レイヤー操作ボタン
// ================================================================

// Layer 1 ボタン
$("btnSetCenter1")?.addEventListener("click", () => {
  switchActiveLayer(1);
  LAYERS[1].mode = "center";
  ensurePoint("center", "center", 1);
  log("[L1] 中心：画像をクリックしてください");
  redrawTable(1);
});

$("btnAddPoint1")?.addEventListener("click", () => {
  switchActiveLayer(1);
  LAYERS[1].mode = "point";
  const label = `p${LAYERS[1].nextPointIndex}`;
  ensurePoint(label, "point", 1);
  log(`[L1] 地点 ${label}：画像をクリックしてください`);
  redrawTable(1);
});

// Layer 2 ボタン
$("btnSetCenter2")?.addEventListener("click", () => {
  switchActiveLayer(2);
  LAYERS[2].mode = "center";
  ensurePoint("center", "center", 2);
  log("[L2] 中心：画像をクリックしてください");
  redrawTable(2);
});

$("btnAddPoint2")?.addEventListener("click", () => {
  switchActiveLayer(2);
  LAYERS[2].mode = "point";
  const label = `p${LAYERS[2].nextPointIndex}`;
  ensurePoint(label, "point", 2);
  log(`[L2] 地点 ${label}：画像をクリックしてください`);
  redrawTable(2);
});

// ================================================================
// 画像アップロード（ファイル選択）
// ================================================================

async function uploadImageFile(file, layerNum) {
  const name = $("mapName")?.value.trim();
  if (!name) {
    alert("地図名を先に入力してください");
    return;
  }
  const fd = new FormData();
  fd.append("file", file);
  fd.append("name", name);
  const res = await fetch("/api/migrationmaps/upload", { method: "POST", body: fd });
  const data = await res.json();
  if (!res.ok) { alert(data.error || "upload failed"); return; }
  applyUploadedImage(data, layerNum);
}

function applyUploadedImage(data, layerNum) {
  const ls = LAYERS[layerNum];
  ls.uploaded = data;
  ls.points.length = 0;
  ls.nextPointIndex = 1;
  if (layerNum === 1) {
    currentProjectId = null;
    markersL1.forEach((m) => map.removeLayer(m));
    markersL1.clear();
    editingProjectEl.textContent = "新規作成";
  } else {
    markersL2.forEach((m) => map.removeLayer(m));
    markersL2.clear();
  }
  ls.img = new Image();
  ls.img.onload = () => setCanvasToImage(ls.img, layerNum);
  ls.img.src = data.image_url;
  setDirty(true);
  redrawTable(layerNum);
  log(`[L${layerNum}] 画像設定: ${data.image_url} (${data.image_width}×${data.image_height})`);
}

$("fileInput1")?.addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  await uploadImageFile(file, 1);
});

$("fileInput2")?.addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  await uploadImageFile(file, 2);
});

// ================================================================
// Cloudinary 選択モーダル（レイヤー別）
// ================================================================

async function openCloudinaryModal(layerNum) {
  const modal = $(layerNum === 1 ? "cloudinaryModal1" : "cloudinaryModal2");
  const grid = $(layerNum === 1 ? "cloudinaryGrid1" : "cloudinaryGrid2");
  if (!modal || !grid) return;
  modal.hidden = false;
  grid.innerHTML = '<div class="modal-loading">読み込み中…</div>';
  try {
    const res = await fetch("/api/migrationmaps/cloudinary-images");
    const data = await res.json();
    if (!res.ok) { grid.innerHTML = `<div class="modal-loading">エラー: ${data.error || res.status}</div>`; return; }
    if (!data.images?.length) { grid.innerHTML = '<div class="modal-loading">画像が見つかりませんでした</div>'; return; }
    grid.innerHTML = "";
    for (const image of data.images) {
      const div = document.createElement("div");
      div.className = "cloudinary-thumb";
      div.innerHTML = `
        <img src="${image.secure_url}" alt="${image.public_id}" loading="lazy" />
        <div class="cloudinary-thumb-label">${image.public_id}</div>
      `;
      div.addEventListener("click", () => {
        applyUploadedImage({
          image_url: image.secure_url,
          image_width: image.width,
          image_height: image.height,
          is_cloudinary: true,
        }, layerNum);
        modal.hidden = true;
        log(`[CLOUDINARY] L${layerNum} 画像を選択: ${image.public_id}`);
      });
      grid.appendChild(div);
    }
  } catch (err) {
    grid.innerHTML = `<div class="modal-loading">通信エラー: ${err.message}</div>`;
  }
}

$("btnPickCloudinary1")?.addEventListener("click", () => openCloudinaryModal(1));
$("btnPickCloudinary2")?.addEventListener("click", () => openCloudinaryModal(2));
$("btnCloseCloudinaryModal1")?.addEventListener("click", () => { $("cloudinaryModal1").hidden = true; });
$("btnCloseCloudinaryModal2")?.addEventListener("click", () => { $("cloudinaryModal2").hidden = true; });
$("cloudinaryModal1")?.addEventListener("click", (ev) => { if (ev.target === $("cloudinaryModal1")) $("cloudinaryModal1").hidden = true; });
$("cloudinaryModal2")?.addEventListener("click", (ev) => { if (ev.target === $("cloudinaryModal2")) $("cloudinaryModal2").hidden = true; });

// ================================================================
// プロジェクト保存
// ================================================================

$("btnSave")?.addEventListener("click", async () => {
  const ls1 = LAYERS[1];
  if (!ls1.uploaded) { alert("レイヤー1の画像をアップロードしてください"); return; }
  const name = $("mapName")?.value.trim();
  if (!name) { alert("地図名を入力してください"); return; }

  const ready1 = ls1.points.filter((p) => p.img_ok && p.ll_ok);
  if (!captureMeta[1] && ready1.length < 3) {
    alert("レイヤー1に中心+他2点以上（合計3点以上）を設定するか、①でキャプチャ枠を確定してください");
    return;
  }

  const ls2 = LAYERS[2];
  const ready2 = ls2.points.filter((p) => p.img_ok && p.ll_ok);
  const hasLayer2 = ls2.uploaded && (ready2.length >= 3 || !!captureMeta[2]);

  // image_filename 解決（Cloudinary or ローカル）
  function resolveFilename(uploaded) {
    if (!uploaded) return null;
    if (uploaded.is_cloudinary || uploaded.image_url?.startsWith("http")) return uploaded.image_url;
    return uploaded.image_url.split("/").pop();
  }

  const allPoints = [
    ...ready1.map((p) => ({ ...p, layer: 1 })),
    ...ready2.map((p) => ({ ...p, layer: 2 })),
  ];

  function georefFieldsFor(layerNum, readyCount) {
    const m = captureMeta[layerNum];
    if (!m) return { mode: "manual", cap: {} };
    let mode = "manual";
    if (readyCount === 0) mode = "auto";
    else if (readyCount === 1) mode = "shift";
    else if (readyCount === 2) mode = "similar";
    return {
      mode,
      cap: {
        center_lat: m.center_lat, center_lng: m.center_lng, zoom: m.zoom,
        width: m.width, height: m.height, dpr: m.dpr,
      },
    };
  }
  const g1 = georefFieldsFor(1, ready1.length);
  const g2 = georefFieldsFor(2, ready2.length);

  const body = {
    project_id: currentProjectId,
    name,
    image_filename: resolveFilename(ls1.uploaded),
    image_width: ls1.uploaded.image_width,
    image_height: ls1.uploaded.image_height,
    image_filename2: hasLayer2 ? resolveFilename(ls2.uploaded) : null,
    image_width2: hasLayer2 ? ls2.uploaded.image_width : null,
    image_height2: hasLayer2 ? ls2.uploaded.image_height : null,
    switch_time_1to2: $("switchTime1to2")?.value || null,
    switch_time_2to1: $("switchTime2to1")?.value || null,
    georef_mode: g1.mode,
    georef_mode2: g2.mode,
    capture_center_lat: g1.cap.center_lat ?? null,
    capture_center_lng: g1.cap.center_lng ?? null,
    capture_zoom: g1.cap.zoom ?? null,
    capture_width: g1.cap.width ?? null,
    capture_height: g1.cap.height ?? null,
    capture_dpr: g1.cap.dpr ?? null,
    capture_center_lat2: g2.cap.center_lat ?? null,
    capture_center_lng2: g2.cap.center_lng ?? null,
    capture_zoom2: g2.cap.zoom ?? null,
    capture_width2: g2.cap.width ?? null,
    capture_height2: g2.cap.height ?? null,
    capture_dpr2: g2.cap.dpr ?? null,
    points: allPoints.map((p) => ({
      label: p.label, kind: p.kind, layer: p.layer,
      img_x: p.img_x, img_y: p.img_y, lat: p.lat, lng: p.lng,
    })),
  };

  try {
    const res = await fetch("/api/migrationmaps/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || "保存に失敗しました"); return; }
    currentProjectId = data.project_id;
    editingProjectEl.textContent = `編集中: #${data.project_id}`;
    setDirty(false);
    refreshProjects();
    log(`[SAVE] ${data.updated ? "更新" : "新規保存"} project_id=${data.project_id}${hasLayer2 ? " (レイヤー2あり)" : ""}`);
    const linkEl = $("publicLink");
    if (linkEl) linkEl.innerHTML = `<a href="/migrationmaps/m/${data.project_id}" target="_blank">公開ページ</a>`;
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
  }
});

// ================================================================
// プロジェクト読み込み
// ================================================================

async function refreshProjects() {
  if (!projectListEl) return;
  projectListEl.innerHTML = '<div class="muted">読み込み中…</div>';
  try {
    const res = await fetch("/api/migrationmaps/projects");
    const data = await res.json();
    if (!res.ok) {
      projectListEl.innerHTML = `<div class="muted" style="color:#b02a37;">取得エラー: ${data.error || res.status}</div>`;
      return;
    }
    const projects = data.projects ?? [];
    projectListEl.innerHTML = "";
    if (projects.length === 0) {
      projectListEl.innerHTML = '<div class="muted">保存済みのセットはありません</div>';
      return;
    }
    for (const p of projects) {
      const div = document.createElement("div");
      div.className = "project-item";
      div.innerHTML = `
        <strong>${p.name}</strong>
        <div class="muted">ID: ${p.id}</div>
        <div class="project-actions">
          <button class="small-btn btnLoadProject" data-id="${p.id}">編集</button>
          <a class="small-btn" href="${p.public_url}" target="_blank">公開ページ</a>
        </div>
      `;
      projectListEl.appendChild(div);
    }
  } catch (err) {
    projectListEl.innerHTML = `<div class="muted" style="color:#b02a37;">取得失敗: ${err.message}</div>`;
  }
}

async function loadProject(projectId) {
  const res = await fetch(`/api/migrationmaps/${projectId}`);
  if (!res.ok) return;
  const proj = await res.json();

  currentProjectId = proj.id;
  currentAffineL1 = proj.affine;
  currentAffineL2 = proj.affine2 || null;

  captureMeta[1] = proj.capture && proj.capture.center_lat != null ? {
    center_lat: proj.capture.center_lat, center_lng: proj.capture.center_lng,
    zoom: proj.capture.zoom, width: proj.capture.width,
    height: proj.capture.height, dpr: proj.capture.dpr || 1,
  } : null;
  captureMeta[2] = proj.capture2 && proj.capture2.center_lat != null ? {
    center_lat: proj.capture2.center_lat, center_lng: proj.capture2.center_lng,
    zoom: proj.capture2.zoom, width: proj.capture2.width,
    height: proj.capture2.height, dpr: proj.capture2.dpr || 1,
  } : null;

  $("mapName").value = proj.name;

  // Switch time
  if ($("switchTime1to2")) $("switchTime1to2").value = proj.switch_time_1to2 || "";
  if ($("switchTime2to1")) $("switchTime2to1").value = proj.switch_time_2to1 || "";

  // Layer 1
  const ls1 = LAYERS[1];
  ls1.uploaded = { image_url: proj.image_url, image_width: proj.image_width, image_height: proj.image_height };
  ls1.points.length = 0;
  ls1.nextPointIndex = 1;
  markersL1.forEach((m) => map.removeLayer(m));
  markersL1.clear();

  for (const p of (proj.points || []).filter((p) => (p.layer || 1) === 1)) {
    ls1.points.push({ ...p, layer: 1, img_ok: true, ll_ok: true });
    setMarker(p.label, [p.lat, p.lng], p.kind, 1);
    const idx = parseInt((p.label.slice(1) || "0"), 10);
    if (p.label !== "center" && idx >= ls1.nextPointIndex) ls1.nextPointIndex = idx + 1;
  }

  ls1.img = new Image();
  ls1.img.onload = () => setCanvasToImage(ls1.img, 1);
  ls1.img.src = proj.image_url;

  // Layer 2
  const ls2 = LAYERS[2];
  ls2.uploaded = null;
  ls2.points.length = 0;
  ls2.nextPointIndex = 1;
  markersL2.forEach((m) => map.removeLayer(m));
  markersL2.clear();
  const ctx2 = getCtx(2);
  const c2 = getCanvas(2);
  if (ctx2 && c2) ctx2.clearRect(0, 0, c2.width, c2.height);

  if (proj.image_url2) {
    ls2.uploaded = { image_url: proj.image_url2, image_width: proj.image_width2, image_height: proj.image_height2 };
    for (const p of (proj.points || []).filter((p) => p.layer === 2)) {
      ls2.points.push({ ...p, layer: 2, img_ok: true, ll_ok: true });
      setMarker(p.label, [p.lat, p.lng], p.kind, 2);
      const idx = parseInt((p.label.slice(1) || "0"), 10);
      if (p.label !== "center" && idx >= ls2.nextPointIndex) ls2.nextPointIndex = idx + 1;
    }
    ls2.img = new Image();
    ls2.img.onload = () => setCanvasToImage(ls2.img, 2);
    ls2.img.src = proj.image_url2;
  }

  editingProjectEl.textContent = `編集中: #${proj.id}`;
  redrawTable(1);
  redrawTable(2);
  setCaptureStatus(1);
  setCaptureStatus(2);
  setDirty(false);
  log(`[LOAD] project_id=${proj.id}${proj.image_url2 ? " (レイヤー2あり)" : ""}`);
}

projectListEl?.addEventListener("click", (ev) => {
  const btn = ev.target.closest(".btnLoadProject");
  if (btn) loadProject(btn.dataset.id);
});

$("btnRefreshProjects")?.addEventListener("click", refreshProjects);

// ================================================================
// 新規作成
// ================================================================

function resetToNew() {
  currentProjectId = null;
  currentAffineL1 = null;
  currentAffineL2 = null;

  [1, 2].forEach((ln) => {
    const ls = LAYERS[ln];
    ls.uploaded = null;
    ls.points.length = 0;
    ls.nextPointIndex = 1;
    ls.mode = null;
    ls.dragState = null;
    const ctx = getCtx(ln);
    const cvs = getCanvas(ln);
    if (ctx && cvs) ctx.clearRect(0, 0, cvs.width, cvs.height);
    if (cvs) { cvs.width = 0; cvs.height = 0; }
  });

  markersL1.forEach((m) => map.removeLayer(m)); markersL1.clear();
  markersL2.forEach((m) => map.removeLayer(m)); markersL2.clear();
  if (overlayL1) { map.removeLayer(overlayL1); overlayL1 = null; }
  if (overlayL2) { map.removeLayer(overlayL2); overlayL2 = null; }
  if (currentLocationMarker) { map.removeLayer(currentLocationMarker); currentLocationMarker = null; }
  if (geolocationWatchId !== null) {
    navigator.geolocation.clearWatch(geolocationWatchId);
    geolocationWatchId = null;
  }
  currentLocation = null;

  if ($("mapName")) $("mapName").value = "";
  if ($("fileInput1")) $("fileInput1").value = "";
  if ($("fileInput2")) $("fileInput2").value = "";
  if ($("publicLink")) $("publicLink").innerHTML = "";
  if ($("switchTime1to2")) $("switchTime1to2").value = "";
  if ($("switchTime2to1")) $("switchTime2to1").value = "";

  editingProjectEl.textContent = "新規作成";
  currentLocationBadge.textContent = "現在地: 未取得";
  setDirty(false);
  redrawTable(1);
  redrawTable(2);
  log("[NEW] 新規作成モードに切り替えました");
}

$("btnNewProject")?.addEventListener("click", () => {
  const hasData = LAYERS[1].uploaded || LAYERS[2].uploaded || LAYERS[1].points.length > 0;
  if (hasData && !confirm("現在の作業内容を破棄して新規作成しますか？")) return;
  resetToNew();
});

// ================================================================
// 重ね合わせプレビュー（OSMマップ上に両レイヤーを表示）
// ================================================================

$("btnPreviewOverlay")?.addEventListener("click", async () => {
  if (!currentProjectId) { alert("先にDBへ保存してください"); return; }
  try {
    const res = await fetch(`/api/migrationmaps/${currentProjectId}/overlay_bounds`);
    const data = await res.json();

    if (overlayL1) { map.removeLayer(overlayL1); overlayL1 = null; }
    if (overlayL2) { map.removeLayer(overlayL2); overlayL2 = null; }

    const ls1 = LAYERS[1];
    if (ls1.uploaded) {
      const corners = data.distortable_corners || data.image_corners;
      const lats = corners.map((c) => c.lat);
      const lngs = corners.map((c) => c.lng);
      const bounds = L.latLngBounds([Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]);
      overlayL1 = L.imageOverlay(ls1.uploaded.image_url, bounds, { pane: "migrationOverlayPane", opacity: 0.8 }).addTo(map);
    }

    if (data.layer2 && LAYERS[2].uploaded) {
      const c2 = data.layer2;
      const corners2 = c2.distortable_corners || c2.image_corners;
      const lats2 = corners2.map((c) => c.lat);
      const lngs2 = corners2.map((c) => c.lng);
      const bounds2 = L.latLngBounds([Math.min(...lats2), Math.min(...lngs2)], [Math.max(...lats2), Math.max(...lngs2)]);
      map.createPane("migrationOverlayPane2");
      map.getPane("migrationOverlayPane2").style.zIndex = 451;
      overlayL2 = L.imageOverlay(LAYERS[2].uploaded.image_url, bounds2, { pane: "migrationOverlayPane2", opacity: 0.6 }).addTo(map);
    }

    log("[PREVIEW] 重ね合わせプレビューを表示しました");
  } catch (err) {
    alert(`プレビュー失敗: ${err.message}`);
  }
});

// ================================================================
// 現在地取得
// ================================================================

$("btnCurrentLocation")?.addEventListener("click", () => {
  if (!navigator.geolocation) { alert("このブラウザはGeolocationに対応していません"); return; }
  if (geolocationWatchId !== null) {
    navigator.geolocation.clearWatch(geolocationWatchId);
    geolocationWatchId = null;
    currentLocationBadge.textContent = "現在地: 停止";
    if (currentLocationMarker) { map.removeLayer(currentLocationMarker); currentLocationMarker = null; }
    currentLocation = null;
    drawMarkersOnCanvas(1);
    drawMarkersOnCanvas(2);
    return;
  }

  currentLocationBadge.textContent = "現在地: 取得中…";
  geolocationWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const acc = pos.coords.accuracy;
      currentLocationBadge.textContent = `現在地: ±${Math.round(acc)}m`;
      if (currentLocationMarker) {
        currentLocationMarker.setLatLng([lat, lng]);
      } else {
        currentLocationMarker = L.circleMarker([lat, lng], { radius: 8, color: "deepskyblue", fillColor: "deepskyblue", fillOpacity: 0.7 }).addTo(map).bindPopup("現在地");
      }
      currentLocation = { lat, lng, accuracy: acc };
      drawMarkersOnCanvas(activeLayer);
    },
    (err) => { currentLocationBadge.textContent = `現在地: エラー(${err.code})`; },
    { enableHighAccuracy: true, maximumAge: 5000 }
  );
});

// ================================================================
// 店舗管理
// ================================================================

function setShopMenuOpen(open) {
  if (!shopMenuBody || !shopMenuToggle) return;
  shopMenuBody.hidden = !open;
  shopMenuToggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (shopMenuToggleIcon) shopMenuToggleIcon.textContent = open ? "－" : "＋";
}

shopMenuToggle?.addEventListener("click", () => {
  const expanded = shopMenuToggle.getAttribute("aria-expanded") === "true";
  setShopMenuOpen(!expanded);
});

async function refreshShopList() {
  if (!registeredShopListEl) return;
  const query = currentProjectId ? `?project_id=${encodeURIComponent(currentProjectId)}` : "";
  const res = await fetch(`/api/migrationmaps/shops${query}`);
  const data = await res.json();
  registeredShopListEl.innerHTML = "";
  if (!data.shops?.length) {
    registeredShopListEl.innerHTML = `<div class="muted">登録済み店舗はありません</div>`;
    return;
  }
  for (const shop of data.shops) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "registered-shop-item";
    btn.dataset.shopId = shop.id;
    btn.innerHTML = `<div class="registered-shop-name">${shop.shopname}</div>`;
    registeredShopListEl.appendChild(btn);
  }
}

$("btnRefreshShopList")?.addEventListener("click", refreshShopList);

// ================================================================
// OSM 取り込み
// ================================================================
let osmCandidates = [];

$("osmImportToggle")?.addEventListener("click", () => {
  const expanded = $("osmImportToggle").getAttribute("aria-expanded") === "true";
  $("osmImportToggle").setAttribute("aria-expanded", expanded ? "false" : "true");
  $("osmImportBody").hidden = expanded;
  if ($("osmImportToggleIcon")) $("osmImportToggleIcon").textContent = expanded ? "＋" : "－";
});

function renderOsmCandidates() {
  const listEl = $("osmCandidateList");
  listEl.innerHTML = "";
  if (!osmCandidates.length) {
    listEl.innerHTML = `<div class="muted">候補がありません</div>`;
    updateOsmSelCount();
    return;
  }
  osmCandidates.forEach((c, idx) => {
    const row = document.createElement("label");
    row.className = "osm-cand" + (c.already_imported ? " imported" : "");
    row.innerHTML = `
      <input type="checkbox" class="osm-cb" data-idx="${idx}" ${c.already_imported ? "disabled" : ""} />
      <div class="cand-main">
        <div class="cand-name">${escapeHtmlLocal(c.shopname || "(名称なし)")}</div>
        <div class="cand-meta">${escapeHtmlLocal(c.floorlevel || "-")} / ${escapeHtmlLocal(c.address || "-")}</div>
        <div class="cand-meta">${Number(c.lat).toFixed(5)}, ${Number(c.lng).toFixed(5)}${c.already_imported ? " ・取り込み済み" : ""}</div>
      </div>`;
    listEl.appendChild(row);
  });
  listEl.querySelectorAll(".osm-cb").forEach((cb) =>
    cb.addEventListener("change", updateOsmSelCount));
  updateOsmSelCount();
}

function escapeHtmlLocal(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]
  ));
}

function selectedOsmIdxs() {
  return [...$("osmCandidateList").querySelectorAll(".osm-cb:checked")]
    .map((cb) => parseInt(cb.dataset.idx, 10));
}

function updateOsmSelCount() {
  if ($("osmSelCount")) $("osmSelCount").textContent = String(selectedOsmIdxs().length);
}

$("btnOsmSelectAll")?.addEventListener("click", () => {
  $("osmCandidateList").querySelectorAll(".osm-cb:not(:disabled)").forEach((cb) => { cb.checked = true; });
  updateOsmSelCount();
});
$("btnOsmSelectNone")?.addEventListener("click", () => {
  $("osmCandidateList").querySelectorAll(".osm-cb").forEach((cb) => { cb.checked = false; });
  updateOsmSelCount();
});

$("btnOsmSearch")?.addEventListener("click", async () => {
  if (!currentProjectId) { alert("先にプロジェクトを保存/読み込みしてください"); return; }
  $("osmSearchStatus").textContent = "Overpass 検索中…";
  try {
    const res = await fetch(`/api/migrationmaps/${currentProjectId}/osm/search`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) { $("osmSearchStatus").textContent = data.error || `失敗 (${res.status})`; return; }
    osmCandidates = data.candidates || [];
    $("osmSearchStatus").textContent =
      `${osmCandidates.length} 件${data.cached ? "（キャッシュ）" : ""}`;
    renderOsmCandidates();
  } catch (err) {
    $("osmSearchStatus").textContent = `通信エラー: ${err.message}`;
  }
});

$("btnOsmImport")?.addEventListener("click", async () => {
  const idxs = selectedOsmIdxs();
  if (!idxs.length) { alert("取り込む候補を選択してください"); return; }
  const items = idxs.map((i) => ({
    osm_type: osmCandidates[i].osm_type, osm_id: osmCandidates[i].osm_id,
  }));
  try {
    const res = await fetch(`/api/migrationmaps/${currentProjectId}/osm/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || `失敗 (${res.status})`); return; }
    $("osmSearchStatus").textContent =
      `取り込み: 新規 ${data.created} / 更新 ${data.updated} / スキップ ${data.skipped}`;
    // 取り込み済みフラグを更新して再描画
    idxs.forEach((i) => { osmCandidates[i].already_imported = true; });
    renderOsmCandidates();
    if (typeof refreshShopList === "function") await refreshShopList();
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
  }
});

// ================================================================
// 検証モード（アフィン誤差の目視チェック）
// ================================================================

$("btnVerifyMode")?.addEventListener("click", () => {
  verifyMode = !verifyMode;
  $("btnVerifyMode").classList.toggle("is-active", verifyMode);
  $("verifyStatus").textContent = verifyMode
    ? "イラスト地図をクリックしてください"
    : "";
  if (!verifyMode) {
    [verifyMarker, verifyExpected].forEach((m) => { if (m) map.removeLayer(m); });
    verifyMarker = verifyExpected = null;
  }
});

// イラストキャンバス側クリック（検証モードのみ）
[1, 2].forEach((layerNum) => {
  getCanvas(layerNum)?.addEventListener("click", (ev) => {
    if (!verifyMode) return;
    const affine = layerNum === 1 ? currentAffineL1 : currentAffineL2;
    if (!affine) { $("verifyStatus").textContent = "先に保存済みプロジェクトを読み込んでください"; return; }
    const ls = LAYERS[layerNum];
    const { cx, cy } = getCanvasPos(ev, getCanvas(layerNum));
    const imgX = cx / ls.canvasScale;
    const imgY = cy / ls.canvasScale;
    const [lat, lng] = imgToLatLng(affine, imgX, imgY);
    if (verifyMarker) map.removeLayer(verifyMarker);
    verifyMarker = L.circleMarker([lat, lng], {
      radius: 7, color: "#16a34a", fillColor: "#16a34a", fillOpacity: 0.8,
    }).addTo(map).bindPopup("変換結果").openPopup();
    map.panTo([lat, lng]);
    $("verifyStatus").textContent = "OSM 側で「本来あるべき位置」をクリックしてください";
  }, true);  // capture フェーズで、既存の点編集 click より先に拾う
});

// OSM 側クリック（検証モードのみ、対応点割当より優先）
map.on("click", (e) => {
  if (!verifyMode || !verifyMarker) return;
  if (verifyExpected) map.removeLayer(verifyExpected);
  verifyExpected = L.circleMarker(e.latlng, {
    radius: 7, color: "#dc2626", fillColor: "#dc2626", fillOpacity: 0.8,
  }).addTo(map).bindPopup("本来あるべき位置").openPopup();
  const a = verifyMarker.getLatLng();
  const dist = map.distance(a, e.latlng);  // メートル
  const tol = resAtZoom(map.getZoom()) * 3;
  const ok = dist <= tol;
  $("verifyStatus").textContent =
    `誤差 ${dist.toFixed(2)} m（許容 ${tol.toFixed(2)} m）${ok ? " ✓ OK" : " ⚠ 対応点モードでの補正を推奨"}`;
  $("verifyStatus").style.color = ok ? "#16a34a" : "#b02a37";
});

// ================================================================
// 初期化
// ================================================================

redrawTable(1);
redrawTable(2);
refreshProjects();
refreshShopList();

const params = new URLSearchParams(location.search);
const initialProjectId = params.get("project_id");
if (initialProjectId) loadProject(initialProjectId);
