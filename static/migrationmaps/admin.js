let uploaded = null;
let mode = null;
let nextPointIndex = 1;
let currentProjectId = null;
let currentAffine = null;
let currentLocation = null;
let geolocationWatchId = null;

const points = [];

const $ = (id) => document.getElementById(id);
const logEl = $("log");
const statusEl = $("status");
const tbody = $("pointsTbody");
const projectListEl = $("projectList");
const editingProjectEl = $("editingProject");
const currentLocationBadge = $("currentLocationBadge");
const registeredShopListEl = document.getElementById("registeredShopList");
const shopFormTitleEl = document.getElementById("shopFormTitle");
const shopRegisterFormEl = document.getElementById("shopRegisterForm");
const shopRegisterResultEl = document.getElementById("shopRegisterResult");

// 修正：関数内で使う変数を関数の外（上部）で確実に定義しておく
let currentEditingShopId = null;
const shopMenuToggle = document.getElementById("shopMenuToggle");
const shopMenuBody = document.getElementById("shopMenuBody");
const shopMenuToggleIcon = document.getElementById("shopMenuToggleIcon");

function log(msg) {
  logEl.textContent += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function setDirty(dirty = true) {
  statusEl.textContent = dirty ? "未保存" : "保存済み";
  statusEl.className = `pill ${dirty ? "ng" : "ok"}`;
}

function ensurePoint(label, kind) {
  let p = points.find(x => x.label === label);
  if (!p) {
    p = {
      label,
      kind,
      img_ok: false,
      ll_ok: false,
      img_x: 0,
      img_y: 0,
      lat: "",
      lng: ""
    };
    points.push(p);
  }
  return p;
}

function sortPoints() {
  points.sort((a, b) => {
    if (a.label === "center") return -1;
    if (b.label === "center") return 1;
    return Number(a.label.slice(1)) - Number(b.label.slice(1));
  });
}

function redrawTable() {
  sortPoints();
  if (!tbody) return;
  tbody.innerHTML = "";

  for (const p of points) {
    const ok = p.img_ok && p.ll_ok;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p.label}</td>
      <td>
        ${p.img_ok ? `${Number(p.img_x).toFixed(1)}, ${Number(p.img_y).toFixed(1)}` : "-"}
        <div style="margin-top:4px; font-size:11px; color:#888;">
          画像上のマーカーをドラッグで移動できます
        </div>
        <div style="margin-top:4px;">
          <button type="button" class="small-btn btnSelectOnImage" data-label="${p.label}">
            クリックで再設定
          </button>
        </div>
      </td>
      <td>
        <div>${p.ll_ok ? `${Number(p.lat).toFixed(6)}, ${Number(p.lng).toFixed(6)}` : "-"}</div>
        <div class="coord-inputs">
          <input
            type="number"
            step="0.000001"
            class="latInput"
            data-label="${p.label}"
            value="${p.ll_ok ? p.lat : ""}"
            placeholder="lat"
          />
          <input
            type="number"
            step="0.000001"
            class="lngInput"
            data-label="${p.label}"
            value="${p.ll_ok ? p.lng : ""}"
            placeholder="lng"
          />
        </div>
        <div style="margin-top:4px; display:flex; gap:6px; flex-wrap:wrap;">
          <button
            type="button"
            class="small-btn btnApplyLatLng"
            data-label="${p.label}"
            ${p.img_ok ? "" : "disabled"}
          >
            手入力を反映
          </button>
          <button
            type="button"
            class="small-btn btnAssignOSM"
            data-label="${p.label}"
            data-kind="${p.kind}"
            ${p.img_ok ? "" : "disabled"}
          >
            ${p.ll_ok ? "OSMで再設定" : "OSMで設定"}
          </button>
        </div>
      </td>
      <td>
        <span class="pill ${ok ? "ok" : "ng"}">${ok ? "OK" : "未完"}</span>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

tbody?.addEventListener("click", (ev) => {
  const assignBtn = ev.target.closest(".btnAssignOSM");
  if (assignBtn) {
    const p = ensurePoint(assignBtn.dataset.label, assignBtn.dataset.kind);
    if (!p.img_ok) {
      alert("先に画像座標を設定してください");
      return;
    }
    pickOSMTarget(p.label, p.kind);
    log(`[EDIT] ${p.label} の緯度経度をOSMクリックで設定します`);
    return;
  }

  const applyBtn = ev.target.closest(".btnApplyLatLng");
  if (applyBtn) {
    const label = applyBtn.dataset.label;
    const p = ensurePoint(label, label === "center" ? "center" : "point");

    const latVal = tbody.querySelector(`.latInput[data-label="${label}"]`)?.value;
    const lngVal = tbody.querySelector(`.lngInput[data-label="${label}"]`)?.value;

    if (!latVal || !lngVal) {
      alert("緯度経度を入力してください");
      return;
    }

    p.lat = Number(latVal);
    p.lng = Number(lngVal);
    p.ll_ok = Number.isFinite(p.lat) && Number.isFinite(p.lng);

    if (!p.ll_ok) {
      alert("緯度経度が不正です");
      return;
    }

    setMarker(label, [p.lat, p.lng], p.kind);
    setDirty(true);
    redrawTable();
    log(`[MANUAL] ${label} = ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`);
    return;
  }

  const imageBtn = ev.target.closest(".btnSelectOnImage");
  if (imageBtn) {
    const label = imageBtn.dataset.label;
    mode = label === "center" ? "center" : { type: "edit-point", label };
    log(`[IMG] 次の画像クリックで ${label} の画像座標を更新します`);
  }
});

const canvas = $("imgCanvas");
const ctx = canvas?.getContext("2d");
let img = new Image();
let canvasScale = 1;

let dragState = null;
const DRAG_HIT_RADIUS = 14;

function getPointAtCanvasPos(cx, cy) {
  const ordered = [...points].sort((a, b) => {
    if (a.label === "center") return -1;
    if (b.label === "center") return 1;
    return 0;
  });
  for (const p of ordered) {
    if (!p.img_ok) continue;
    const px = p.img_x * canvasScale;
    const py = p.img_y * canvasScale;
    if (Math.sqrt((cx - px) ** 2 + (cy - py) ** 2) <= DRAG_HIT_RADIUS) return p;
  }
  return null;
}

function getCanvasPos(ev) {
  const rect = canvas.getBoundingClientRect();
  const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
  const clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
  return { cx: clientX - rect.left, cy: clientY - rect.top };
}

function setCanvasToImage(image) {
  if (!canvas) return;
  const maxW = Math.min(900, window.innerWidth * 0.30);
  canvasScale = Math.min(1, maxW / image.naturalWidth);

  canvas.width = Math.round(image.naturalWidth * canvasScale);
  canvas.height = Math.round(image.naturalHeight * canvasScale);

  drawMarkersOnCanvas();
}

function drawMarkersOnCanvas() {
  if (!img || !img.complete || !ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  for (const p of points) {
    if (!p.img_ok) continue;

    const x = p.img_x * canvasScale;
    const y = p.img_y * canvasScale;

    const isDragging = dragState && dragState.point.label === p.label;

    ctx.beginPath();
    ctx.arc(x, y, isDragging ? 9 : 6, 0, Math.PI * 2);
    ctx.fillStyle = p.kind === "center" ? "red" : "yellow";
    ctx.fill();

    ctx.strokeStyle = isDragging ? "white" : "black";
    ctx.lineWidth = isDragging ? 3 : 2;
    ctx.stroke();

    ctx.fillStyle = "black";
    ctx.font = "12px sans-serif";
    ctx.fillText(p.label, x + 8, y - 8);
  }

  if (currentLocation?.img_ok) {
    const x = currentLocation.img_x * canvasScale;
    const y = currentLocation.img_y * canvasScale;

    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fillStyle = "deepskyblue";
    ctx.fill();

    ctx.strokeStyle = "white";
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = "#003049";
    ctx.font = "12px sans-serif";
    ctx.fillText("現在地", x + 10, y + 4);
  }
}

canvas?.addEventListener("mousedown", (ev) => {
  if (!uploaded || mode) return;
  const { cx, cy } = getCanvasPos(ev);
  const p = getPointAtCanvasPos(cx, cy);
  if (!p) return;
  dragState = { point: p };
  canvas.style.cursor = "grabbing";
  ev.preventDefault();
});

canvas?.addEventListener("mousemove", (ev) => {
  if (!uploaded) return;
  const { cx, cy } = getCanvasPos(ev);
  if (dragState) {
    dragState.point.img_x = Math.max(0, Math.min(uploaded.image_width,  cx / canvasScale));
    dragState.point.img_y = Math.max(0, Math.min(uploaded.image_height, cy / canvasScale));
    drawMarkersOnCanvas();
    ev.preventDefault();
    return;
  }
  const p = getPointAtCanvasPos(cx, cy);
  canvas.style.cursor = p ? "grab" : (mode ? "crosshair" : "default");
});

canvas?.addEventListener("mouseup", () => {
  if (!dragState) return;
  const p = dragState.point;
  dragState = null;
  canvas.style.cursor = "default";
  setDirty(true);
  redrawTable();
  log(`[DRAG] ${p.label} → (${p.img_x.toFixed(1)}, ${p.img_y.toFixed(1)})`);
});

canvas?.addEventListener("click", (ev) => {
  if (!uploaded) {
    alert("先に画像をアップロードまたは保存済み地図を読み込んでください");
    return;
  }
  if (!mode) return;

  const { cx, cy } = getCanvasPos(ev);
  const img_x = cx / canvasScale;
  const img_y = cy / canvasScale;

  if (mode === "center") {
    const p = ensurePoint("center", "center");
    p.img_x = img_x;
    p.img_y = img_y;
    p.img_ok = true;
    pickOSMTarget("center", "center");
    log(`[IMG] center = (${p.img_x.toFixed(1)}, ${p.img_y.toFixed(1)})`);
  } else if (mode === "point") {
    const label = `p${nextPointIndex}`;
    const p = ensurePoint(label, "point");
    p.img_x = img_x;
    p.img_y = img_y;
    p.img_ok = true;
    pickOSMTarget(label, "point");
    nextPointIndex++;
    log(`[IMG] ${label} = (${p.img_x.toFixed(1)}, ${p.img_y.toFixed(1)})`);
  } else if (typeof mode === "object" && mode.type === "edit-point") {
    const p = ensurePoint(mode.label, mode.label === "center" ? "center" : "point");
    p.img_x = img_x;
    p.img_y = img_y;
    p.img_ok = true;
    log(`[IMG] ${p.label} の画像座標を更新 = (${p.img_x.toFixed(1)}, ${p.img_y.toFixed(1)})`);
  }

  mode = null;
  setDirty(true);
  drawMarkersOnCanvas();
  redrawTable();
});

// Leafletマップの初期化
const map = L.map("map").setView([36.061, 136.223], 15);
map.createPane("migrationOverlayPane");
map.getPane("migrationOverlayPane").style.zIndex = 450;

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 20,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

const markers = new Map();
let overlay = null;
let currentLocationMarker = null;
let pendingAssign = null;

function setMarker(label, latlng, kind) {
  if (markers.has(label)) {
    markers.get(label).setLatLng(latlng);
  } else {
    const m = L.marker(latlng, { draggable: false }).addTo(map);
    m.bindPopup(`${label}`);
    markers.set(label, m);
  }
}

function pickOSMTarget(label, kind) {
  pendingAssign = { label, kind };
  log(`[OSM] 次のクリックで ${label} の緯度経度を割当`);
}

map.on("click", (e) => {
  if (!pendingAssign) return;

  const { label, kind } = pendingAssign;
  const p = ensurePoint(label, kind);
  p.lat = e.latlng.lat;
  p.lng = e.latlng.lng;
  p.ll_ok = true;

  setMarker(label, e.latlng, kind);
  pendingAssign = null;
  setDirty(true);
  redrawTable();
  log(`[OSM] ${label} = ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`);
});

$("btnSetCenter")?.addEventListener("click", () => {
  mode = "center";
  ensurePoint("center", "center");
  log("中心：画像をクリックしてください");
  redrawTable();
});

$("btnAddPoint")?.addEventListener("click", () => {
  mode = "point";
  const label = `p${nextPointIndex}`;
  ensurePoint(label, "point");
  log(`地点 ${label}：画像をクリックしてください`);
  redrawTable();
});

$("fileInput")?.addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;

  const name = $("mapName")?.value.trim();
  if (!name) {
    alert("地図名を先に入力してください");
    ev.target.value = "";
    return;
  }

  const fd = new FormData();
  fd.append("file", file);
  fd.append("name", name);

  const res = await fetch("/api/migrationmaps/upload", { method: "POST", body: fd });
  const data = await res.json();

  if (!res.ok) {
    alert(data.error || "upload failed");
    return;
  }

  currentProjectId = null;
  uploaded = data;
  img = new Image();
  img.onload = () => setCanvasToImage(img);
  img.src = data.image_url;

  points.length = 0;
  markers.forEach(m => map.removeLayer(m));
  markers.clear();
  editingProjectEl.textContent = "新規作成";
  setDirty(true);
  redrawTable();
});

// --- 店舗管理関連の関数 ---

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

async function refreshProjects() {
  if (!projectListEl) return;
  projectListEl.innerHTML = '<div class="muted">読み込み中…</div>';
  try {
    const res = await fetch("/api/migrationmaps/projects");
    const data = await res.json();
    const projects = data.projects ?? [];

    projectListEl.innerHTML = "";
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
    projectListEl.innerHTML = `<div class="muted">取得失敗</div>`;
  }
}

async function loadProject(projectId) {
  const res = await fetch(`/api/migrationmaps/${projectId}`);
  if (!res.ok) return;
  const proj = await res.json();

  currentProjectId = proj.id;
  currentAffine = proj.affine;
  $("mapName").value = proj.name;
  uploaded = { image_url: proj.image_url, image_width: proj.image_width, image_height: proj.image_height };

  points.length = 0;
  markers.forEach(m => map.removeLayer(m));
  markers.clear();

  for (const p of proj.points) {
    points.push({ ...p, img_ok: true, ll_ok: true });
    setMarker(p.label, [p.lat, p.lng], p.kind);
  }

  img = new Image();
  img.onload = () => setCanvasToImage(img);
  img.src = proj.image_url;

  editingProjectEl.textContent = `編集中: #${proj.id}`;
  redrawTable();
  setDirty(false);
}

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

// イベントリスナーの一括登録
projectListEl?.addEventListener("click", (ev) => {
  const btn = ev.target.closest(".btnLoadProject");
  if (btn) loadProject(btn.dataset.id);
});

$("btnRefreshProjects")?.addEventListener("click", refreshProjects);
$("btnRefreshShopList")?.addEventListener("click", refreshShopList);

registeredShopListEl?.addEventListener("click", async (ev) => {
  const btn = ev.target.closest(".registered-shop-item");
  if (!btn) return;
  // 店舗詳細取得・フォーム反映処理（省略可）
});

$("btnSave")?.addEventListener("click", async () => {
  if (!uploaded) {
    alert("先に画像をアップロードしてください");
    return;
  }

  const name = $("mapName")?.value.trim();
  if (!name) {
    alert("地図名を入力してください");
    return;
  }

  const readyPoints = points.filter(p => p.img_ok && p.ll_ok);
  if (readyPoints.length < 3) {
    alert("中心 + 他2点以上（合計3点以上）を設定してから保存してください");
    return;
  }

  const imageFilename = uploaded.image_url.split("/").pop();
  const body = {
    project_id: currentProjectId,
    name,
    image_filename: imageFilename,
    image_width: uploaded.image_width,
    image_height: uploaded.image_height,
    points: readyPoints.map(p => ({
      label: p.label,
      kind: p.kind,
      img_x: p.img_x,
      img_y: p.img_y,
      lat: p.lat,
      lng: p.lng,
    })),
  };

  try {
    const res = await fetch("/api/migrationmaps/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (!res.ok) {
      alert(data.error || "保存に失敗しました");
      return;
    }

    currentProjectId = data.project_id;
    editingProjectEl.textContent = `編集中: #${data.project_id}`;
    setDirty(false);
    refreshProjects();
    log(`[SAVE] ${data.updated ? "更新" : "新規保存"} project_id=${data.project_id}`);

    const linkEl = $("publicLink");
    if (linkEl) {
      linkEl.innerHTML = `<a href="/migrationmaps/m/${data.project_id}" target="_blank">公開ページ</a>`;
    }
  } catch (err) {
    alert(`通信エラー: ${err.message}`);
  }
});

$("btnCurrentLocation")?.addEventListener("click", () => {
  if (!navigator.geolocation) {
    alert("このブラウザはGeolocationに対応していません");
    return;
  }

  if (geolocationWatchId !== null) {
    navigator.geolocation.clearWatch(geolocationWatchId);
    geolocationWatchId = null;
    currentLocationBadge.textContent = "現在地: 停止";
    if (currentLocationMarker) {
      map.removeLayer(currentLocationMarker);
      currentLocationMarker = null;
    }
    currentLocation = null;
    drawMarkersOnCanvas();
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
        currentLocationMarker = L.circleMarker([lat, lng], {
          radius: 8,
          color: "deepskyblue",
          fillColor: "deepskyblue",
          fillOpacity: 0.7,
        }).addTo(map).bindPopup("現在地");
      }

      currentLocation = { lat, lng, accuracy: acc, img_ok: false };

      if (currentAffine && uploaded) {
        const { a, b, c, d, e, f } = currentAffine;
        const R = 6378137;
        const X = R * (lng * Math.PI / 180);
        const latClamped = Math.max(Math.min(lat, 85.05112878), -85.05112878);
        const Y = R * Math.log(Math.tan(Math.PI / 4 + (latClamped * Math.PI / 180) / 2));
        const det = a * e - b * d;
        if (Math.abs(det) > 1e-6) {
          const img_x = (e * (X - c) - b * (Y - f)) / det;
          const img_y = (a * (Y - f) - d * (X - c)) / det;
          if (img_x >= 0 && img_x <= uploaded.image_width && img_y >= 0 && img_y <= uploaded.image_height) {
            currentLocation.img_x = img_x;
            currentLocation.img_y = img_y;
            currentLocation.img_ok = true;
          }
        }
      }

      drawMarkersOnCanvas();
    },
    (err) => {
      currentLocationBadge.textContent = `現在地: エラー(${err.code})`;
    },
    { enableHighAccuracy: true, maximumAge: 5000 }
  );
});

// 初期実行
redrawTable();
refreshProjects();
refreshShopList();

const params = new URLSearchParams(location.search);
const initialProjectId = params.get("project_id");
if (initialProjectId) loadProject(initialProjectId);