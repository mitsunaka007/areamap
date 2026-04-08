let uploaded = null;
let mode = null;
let nextPointIndex = 1;
let currentProjectId = null;
let currentAffine = null;
let currentLocation = null;
let geolocationWatchId = null;

// ---- キー操作で選択中の地点 ----
let selectedPointLabel = null;

const points = [];

const $ = (id) => document.getElementById(id);
const logEl = $("log");
const statusEl = $("status");
const tbody = $("pointsTbody");
const projectListEl = $("projectList");
const editingProjectEl = $("editingProject");
const currentLocationBadge = $("currentLocationBadge");

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

// ---- 選択中ポイントのハイライト更新 ----
function updateRowHighlight() {
  document.querySelectorAll("#pointsTbody tr").forEach(tr => {
    tr.classList.toggle("row-selected", tr.dataset.label === selectedPointLabel);
  });
}

function selectPoint(label) {
  selectedPointLabel = label;
  updateRowHighlight();
  if (label) {
    log(`[SELECT] ${label} を選択中（矢印キーで移動、Shiftで10倍）`);
  }
}

function redrawTable() {
  sortPoints();
  tbody.innerHTML = "";

  for (const p of points) {
    const ok = p.img_ok && p.ll_ok;
    const isSelected = p.label === selectedPointLabel;
    const tr = document.createElement("tr");
    tr.dataset.label = p.label;
    if (isSelected) tr.classList.add("row-selected");

    tr.innerHTML = `
      <td>
        <button type="button" class="small-btn btnSelectPoint ${isSelected ? "btn-selected" : ""}" data-label="${p.label}">
          ${p.label}
        </button>
      </td>
      <td>
        ${p.img_ok ? `${Number(p.img_x).toFixed(1)}, ${Number(p.img_y).toFixed(1)}` : "-"}
        <div style="margin-top:4px;">
          <button type="button" class="small-btn btnSelectOnImage" data-label="${p.label}">
            画像で再設定
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

  // 3点以上揃ったら仮プレビューを自動更新
  tryAutoPreview();
}

tbody.addEventListener("click", (ev) => {
  // ラベルボタンクリックで選択
  const selectBtn = ev.target.closest(".btnSelectPoint");
  if (selectBtn) {
    const label = selectBtn.dataset.label;
    if (selectedPointLabel === label) {
      selectPoint(null); // 再クリックで選択解除
    } else {
      selectPoint(label);
    }
    return;
  }

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

    if (latVal === "" || lngVal === "") {
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

// ---- 矢印キーで選択中ポイントを微調整 ----
const KEY_STEP_BASE = 0.000005; // 約0.5m

document.addEventListener("keydown", (ev) => {
  if (!selectedPointLabel) return;
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(ev.key)) return;

  // テキスト入力中は無効
  const tag = document.activeElement?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea") return;

  ev.preventDefault();

  const p = points.find(x => x.label === selectedPointLabel);
  if (!p || !p.ll_ok) {
    log(`[KEY] ${selectedPointLabel} の緯度経度がまだ設定されていません`);
    return;
  }

  const step = ev.shiftKey ? KEY_STEP_BASE * 10 : KEY_STEP_BASE;

  if (ev.key === "ArrowUp")    p.lat += step;
  if (ev.key === "ArrowDown")  p.lat -= step;
  if (ev.key === "ArrowRight") p.lng += step;
  if (ev.key === "ArrowLeft")  p.lng -= step;

  setMarker(p.label, [p.lat, p.lng], p.kind);
  setDirty(true);
  redrawTable();

  const stepM = ev.shiftKey ? "±5m" : "±0.5m";
  log(`[KEY] ${p.label} → ${p.lat.toFixed(7)}, ${p.lng.toFixed(7)} (${stepM})`);
});

// ---- 仮プレビュー自動更新 ----
let autoPreviewEnabled = false;

function tryAutoPreview() {
  if (!autoPreviewEnabled) return;
  if (!currentProjectId) return;
  const ready = points.filter(p => p.img_ok && p.ll_ok);
  if (ready.length < 3) return;
  // 保存せずにオーバーレイだけ更新（仮計算）
  refreshOverlayFromPoints();
}

function refreshOverlayFromPoints() {
  const ready = points.filter(p => p.img_ok && p.ll_ok);
  if (ready.length < 3) return;

  // クライアント側でアフィン係数を仮計算（保存は行わない）
  // ※ サーバー側と同じ計算をJS側で再現する
  try {
    const affine = fitAffineJS(ready);
    currentAffine = affine;
    updateCurrentLocationOnCanvas();
    if (uploaded) {
      updateOverlayFromAffine(affine);
    }
  } catch (e) {
    // 計算失敗時は無視
  }
}

// --- JS側アフィン計算（Python側の _fit_affine と同等） ---
function fitAffineJS(pts) {
  // WebMercator変換
  const R = 6378137.0;
  function toMercator(lat, lng) {
    const x = R * lng * Math.PI / 180;
    const clipped = Math.max(Math.min(lat, 85.05112878), -85.05112878);
    const y = R * Math.log(Math.tan(Math.PI / 4 + clipped * Math.PI / 360));
    return [x, y];
  }

  const n = pts.length;
  // 最小二乗法で A * coef = b を解く（単純な実装）
  // A: 2n x 6, b: 2n x 1
  // X = a*x + b*y + c
  // Y = d*x + e*y + f

  const rows = [];
  const bVec = [];
  for (const p of pts) {
    const [X, Y] = toMercator(p.lat, p.lng);
    rows.push([p.img_x, p.img_y, 1, 0, 0, 0]);
    bVec.push(X);
    rows.push([0, 0, 0, p.img_x, p.img_y, 1]);
    bVec.push(Y);
  }

  // 正規方程式 (A^T A) coef = A^T b
  const AT = transpose(rows);
  const ATA = matMul(AT, rows);
  const ATb = matVecMul(AT, bVec);
  const coef = solveLinear6(ATA, ATb);

  return { a: coef[0], b: coef[1], c: coef[2], d: coef[3], e: coef[4], f: coef[5] };
}

function transpose(M) {
  const rows = M.length, cols = M[0].length;
  const T = Array.from({ length: cols }, () => Array(rows).fill(0));
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++)
      T[j][i] = M[i][j];
  return T;
}

function matMul(A, B) {
  const r = A.length, k = B.length, c = B[0].length;
  const C = Array.from({ length: r }, () => Array(c).fill(0));
  for (let i = 0; i < r; i++)
    for (let j = 0; j < c; j++)
      for (let l = 0; l < k; l++)
        C[i][j] += A[i][l] * B[l][j];
  return C;
}

function matVecMul(A, v) {
  return A.map(row => row.reduce((s, a, j) => s + a * v[j], 0));
}

function solveLinear6(A, b) {
  // ガウス消去法（6x6）
  const n = 6;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++)
      if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const d = M[col][col];
    if (Math.abs(d) < 1e-14) throw new Error("singular");
    for (let j = col; j <= n; j++) M[col][j] /= d;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = M[row][col];
      for (let j = col; j <= n; j++) M[row][j] -= f * M[col][j];
    }
  }
  return M.map(row => row[n]);
}

function updateOverlayFromAffine(affine) {
  if (!uploaded || !overlay) return;

  // 元画像の四隅を逆変換して地図上の緯度経度を得る
  const R = 6378137.0;
  function mercatorToLatLng(X, Y) {
    const lng = (X / R) * 180 / Math.PI;
    const lat = (2 * Math.atan(Math.exp(Y / R)) - Math.PI / 2) * 180 / Math.PI;
    return [lat, lng];
  }

  const { a, b, c, d, e, f } = affine;
  const corners = [
    [0, 0],
    [uploaded.image_width, 0],
    [uploaded.image_width, uploaded.image_height],
    [0, uploaded.image_height],
  ].map(([x, y]) => {
    const X = a * x + b * y + c;
    const Y = d * x + e * y + f;
    return mercatorToLatLng(X, Y);
  });

  const lats = corners.map(c => c[0]);
  const lngs = corners.map(c => c[1]);
  const sw = [Math.min(...lats), Math.min(...lngs)];
  const ne = [Math.max(...lats), Math.max(...lngs)];
  const newBounds = [sw, ne];

  overlay.setBounds(newBounds);
  map.fitBounds(newBounds);
}

const canvas = $("imgCanvas");
const ctx = canvas.getContext("2d");
let img = new Image();
let canvasScale = 1;

function setCanvasToImage(image) {
  const maxW = Math.min(900, window.innerWidth * 0.30);
  canvasScale = Math.min(1, maxW / image.naturalWidth);

  canvas.width = Math.round(image.naturalWidth * canvasScale);
  canvas.height = Math.round(image.naturalHeight * canvasScale);

  drawMarkersOnCanvas();
}

function drawMarkersOnCanvas() {
  if (!img || !img.complete) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  for (const p of points) {
    if (!p.img_ok) continue;

    const x = p.img_x * canvasScale;
    const y = p.img_y * canvasScale;
    const isSelected = p.label === selectedPointLabel;

    ctx.beginPath();
    ctx.arc(x, y, isSelected ? 9 : 6, 0, Math.PI * 2);
    ctx.fillStyle = p.kind === "center" ? "red" : "yellow";
    ctx.fill();

    ctx.strokeStyle = isSelected ? "#00cfff" : "black";
    ctx.lineWidth = isSelected ? 3 : 2;
    ctx.stroke();

    ctx.fillStyle = "black";
    ctx.font = `${isSelected ? "bold " : ""}12px sans-serif`;
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

canvas.addEventListener("click", (ev) => {
  if (!uploaded) {
    alert("先に画像をアップロードまたは保存済み地図を読み込んでください");
    return;
  }
  if (!mode) {
    alert("「中心を選択」または「地点を追加」を押してください");
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const cx = ev.clientX - rect.left;
  const cy = ev.clientY - rect.top;

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

const map = L.map("map").setView([36.061, 136.223], 15);

// スクショ画像を前面にする専用pane
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

// ---- マーカーをドラッグ可能にして位置を更新 ----
function setMarker(label, latlng, kind) {
  if (markers.has(label)) {
    markers.get(label).setLatLng(latlng);
  } else {
    const m = L.marker(latlng, { draggable: true }).addTo(map);
    m.bindPopup(`${label}`);

    // ドラッグ中: リアルタイムで点データを更新
    m.on("drag", (e) => {
      const ll = e.target.getLatLng();
      const p = points.find(x => x.label === label);
      if (p) {
        p.lat = ll.lat;
        p.lng = ll.lng;
        p.ll_ok = true;
      }
      drawMarkersOnCanvas();
      // ドラッグ中は仮プレビューをリアルタイム更新
      const ready = points.filter(pt => pt.img_ok && pt.ll_ok);
      if (ready.length >= 3 && uploaded && overlay) {
        try {
          const affine = fitAffineJS(ready);
          currentAffine = affine;
          updateOverlayFromAffine(affine);
          updateCurrentLocationOnCanvas();
        } catch (e) { /* 無視 */ }
      }
    });

    // ドラッグ終了: テーブル更新・ダーティフラグ
    m.on("dragend", (e) => {
      const ll = e.target.getLatLng();
      const p = points.find(x => x.label === label);
      if (p) {
        p.lat = ll.lat;
        p.lng = ll.lng;
        p.ll_ok = true;
        log(`[DRAG] ${label} → ${p.lat.toFixed(7)}, ${p.lng.toFixed(7)}`);
      }
      setDirty(true);
      redrawTable();
    });

    markers.set(label, m);
  }
}

function pickOSMTarget(label, kind) {
  pendingAssign = { label, kind };
  log(`[OSM] 次のクリックで ${label} の緯度経度を割当（またはマーカーをドラッグして調整）`);
}

map.on("click", (e) => {
  if (!pendingAssign) {
    log(`[OSM] click = ${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)} (未割当)`);
    return;
  }

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

$("btnSetCenter").addEventListener("click", () => {
  mode = "center";
  ensurePoint("center", "center");
  log("中心：画像をクリックしてください。その後OSMクリックまたはドラッグで緯度経度を設定できます");
  redrawTable();
});

$("btnAddPoint").addEventListener("click", () => {
  mode = "point";
  const label = `p${nextPointIndex}`;
  ensurePoint(label, "point");
  log(`地点 ${label}：画像をクリックしてください。その後OSMクリックまたはドラッグで緯度経度を設定できます`);
  redrawTable();
});

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

  const res = await fetch("/api/migrationmaps/upload", {
    method: "POST",
    body: fd
  });
  const data = await res.json();

  if (!res.ok) {
    alert(data.error || "upload failed");
    return;
  }

  currentProjectId = null;
  uploaded = data;
  currentAffine = null;

  img = new Image();
  img.onload = () => setCanvasToImage(img);
  img.src = data.image_url;

  points.length = 0;
  markers.forEach((m) => map.removeLayer(m));
  markers.clear();

  if (overlay) {
    map.removeLayer(overlay);
    overlay = null;
  }

  selectedPointLabel = null;
  nextPointIndex = 1;
  autoPreviewEnabled = false;
  editingProjectEl.textContent = "新規作成";
  $("publicLink").innerHTML = "";
  setDirty(true);
  redrawTable();
  updateCurrentLocationOnCanvas();

  log(`[UPLOAD] ${data.image_filename} (${data.image_width}x${data.image_height})`);
});

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(a));
}

function mercatorX(lng) {
  return 6378137 * lng * Math.PI / 180;
}

function mercatorY(lat) {
  const clipped = Math.max(Math.min(lat, 85.05112878), -85.05112878);
  return 6378137 * Math.log(Math.tan(Math.PI / 4 + clipped * Math.PI / 360));
}

function mercatorToImageXY(affine, lat, lng) {
  if (!affine) return null;

  const X = mercatorX(lng);
  const Y = mercatorY(lat);

  const det = affine.a * affine.e - affine.b * affine.d;
  if (Math.abs(det) < 1e-12) return null;

  const x = (affine.e * (X - affine.c) - affine.b * (Y - affine.f)) / det;
  const y = (-affine.d * (X - affine.c) + affine.a * (Y - affine.f)) / det;

  return { x, y };
}

function updateCurrentLocationOnCanvas() {
  if (!currentLocation || !currentAffine || !uploaded) {
    if (currentLocation) {
      currentLocation.img_ok = false;
    }
    drawMarkersOnCanvas();
    return;
  }

  const xy = mercatorToImageXY(currentAffine, currentLocation.lat, currentLocation.lng);
  if (!xy) {
    currentLocation.img_ok = false;
    drawMarkersOnCanvas();
    return;
  }

  const isInside =
    xy.x >= 0 &&
    xy.y >= 0 &&
    xy.x <= uploaded.image_width &&
    xy.y <= uploaded.image_height;

  if (!isInside) {
    currentLocation.img_ok = false;
    drawMarkersOnCanvas();
    return;
  }

  currentLocation.img_x = xy.x;
  currentLocation.img_y = xy.y;
  currentLocation.img_ok = true;

  drawMarkersOnCanvas();
}

$("btnCurrentLocation").addEventListener("click", () => {
  if (!navigator.geolocation) {
    alert("このブラウザは位置情報に対応していません");
    return;
  }

  if (geolocationWatchId !== null) {
    navigator.geolocation.clearWatch(geolocationWatchId);
    geolocationWatchId = null;
  }

  geolocationWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const accuracy = pos.coords.accuracy;

      currentLocation = { lat, lng, accuracy, img_ok: false };

      currentLocationBadge.textContent =
        `現在地: ${lat.toFixed(6)}, ${lng.toFixed(6)} / ±${Math.round(accuracy)}m`;

      if (currentLocationMarker) {
        currentLocationMarker.setLatLng([lat, lng]);
      } else {
        currentLocationMarker = L.marker([lat, lng]).addTo(map).bindPopup("現在地");
      }

      updateCurrentLocationOnCanvas();
    },
    (err) => {
      alert(`現在地の取得に失敗しました: ${err.message}`);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 10000
    }
  );
});

// =============================================================
// loadProject: imageOnly=true のとき点・マーカーを保持して画像だけ差し替え
// =============================================================
async function loadProject(projectId, imageOnly = false) {
  const res = await fetch(`/api/migrationmaps/${projectId}`);
  if (!res.ok) {
    alert("保存済みデータの読込に失敗しました");
    return;
  }

  const proj = await res.json();

  // ---- 画像のみ差し替えモード ----
  if (imageOnly) {
    currentProjectId = proj.id;
    $("mapName").value = proj.name;

    uploaded = {
      image_url: proj.image_url,
      image_filename: proj.image_url.split("/").pop(),
      image_width: proj.image_width,
      image_height: proj.image_height
    };

    img = new Image();
    img.onload = () => {
      setCanvasToImage(img);
      updateCurrentLocationOnCanvas();
    };
    img.src = proj.image_url;

    editingProjectEl.textContent = `編集中: #${proj.id}（点データ引継ぎ）`;
    setDirty(true);

    $("publicLink").innerHTML =
      `公開URL: <a href="/migrationmaps/m/${proj.id}" target="_blank" rel="noopener">/migrationmaps/m/${proj.id}</a>`;

    log(`[LOAD] project_id=${proj.id} の画像のみ差し替え（中心・地点は引き継ぎ）`);
    return;
  }

  // ---- 通常モード（全リセット） ----
  currentProjectId = proj.id;
  currentAffine = proj.affine;
  $("mapName").value = proj.name;

  uploaded = {
    image_url: proj.image_url,
    image_filename: proj.image_url.split("/").pop(),
    image_width: proj.image_width,
    image_height: proj.image_height
  };

  points.length = 0;
  markers.forEach((m) => map.removeLayer(m));
  markers.clear();

  if (overlay) {
    map.removeLayer(overlay);
    overlay = null;
  }

  selectedPointLabel = null;

  for (const p of proj.points) {
    points.push({
      ...p,
      img_ok: true,
      ll_ok: true
    });
    setMarker(p.label, [p.lat, p.lng], p.kind);
  }

  nextPointIndex = Math.max(
    1,
    ...points
      .filter(p => p.label.startsWith("p"))
      .map(p => Number(p.label.slice(1)) + 1),
    1
  );

  img = new Image();
  img.onload = () => {
    setCanvasToImage(img);
    updateCurrentLocationOnCanvas();
  };
  img.src = proj.image_url;

  editingProjectEl.textContent = `編集中: #${proj.id}`;
  redrawTable();
  setDirty(false);
  autoPreviewEnabled = true;

  $("publicLink").innerHTML =
    `公開URL: <a href="/migrationmaps/m/${proj.id}" target="_blank" rel="noopener">/migrationmaps/m/${proj.id}</a>`;

  if (proj.points.length) {
    map.fitBounds(L.latLngBounds(proj.points.map(p => [p.lat, p.lng])));
  }

  log(`[LOAD] project_id=${proj.id} を読み込みました`);
}

async function refreshProjects() {
  try {
    const res = await fetch("/api/migrationmaps/projects");
    if (!res.ok) {
      projectListEl.innerHTML = '<div class="muted">一覧の取得に失敗しました</div>';
      return;
    }
    const data = await res.json();

    projectListEl.innerHTML = "";

    if (!data.projects?.length) {
      projectListEl.innerHTML = '<div class="muted">保存済みデータはありません</div>';
      return;
    }

    for (const p of data.projects) {
      const div = document.createElement("div");
      div.className = "project-item";
      div.innerHTML = `
        <strong>${p.name}</strong>
        <div class="muted">ID: ${p.id}</div>
        <div class="muted">${p.created_at ? p.created_at.replace("T", " ").slice(0, 19) : ""}</div>
        <div class="project-actions">
          <button class="small-btn btnLoadProject" data-id="${p.id}">管理画面で編集</button>
          <a class="small-btn" href="${p.public_url}" target="_blank" rel="noopener">公開ページ</a>
        </div>
      `;
      projectListEl.appendChild(div);
    }
  } catch (err) {
    projectListEl.innerHTML = '<div class="muted">一覧の取得に失敗しました</div>';
  }
}

// ---- 「管理画面で編集」クリック: 点データがあれば引継ぎを確認 ----
projectListEl.addEventListener("click", (ev) => {
  const btn = ev.target.closest(".btnLoadProject");
  if (!btn) return;

  const hasPoints = points.some(p => p.img_ok || p.ll_ok);

  if (hasPoints) {
    const keep = confirm(
      "現在の中心・地点データを引き継ぎますか？\n\n" +
      "✅ OK　　　= 点データを保持して画像だけ差し替え\n" +
      "❌ キャンセル = すべてリセットして読み込み"
    );
    loadProject(btn.dataset.id, keep);
  } else {
    loadProject(btn.dataset.id, false);
  }
});

$("btnRefreshProjects").addEventListener("click", refreshProjects);

async function showOverlay(projectId) {
  const [res1, res2] = await Promise.all([
    fetch(`/api/migrationmaps/${projectId}/overlay_bounds`),
    fetch(`/api/migrationmaps/${projectId}`)
  ]);

  const data = await res1.json();
  const proj = await res2.json();

  currentAffine = proj.affine;

  if (overlay) {
    map.removeLayer(overlay);
  }

  overlay = L.imageOverlay(uploaded.image_url, data.bounds, {
    opacity: 0.78,
    pane: "migrationOverlayPane",
    interactive: false
  }).addTo(map);

  map.fitBounds(data.bounds);
  autoPreviewEnabled = true;

  updateCurrentLocationOnCanvas();

  const center = points.find(p => p.label === "center" && p.ll_ok);
  if (center) {
    for (const p of points) {
      if (p.label === "center" || !p.ll_ok) continue;
      const d = haversineMeters(center.lat, center.lng, p.lat, p.lng);
      log(`[DIST] OSM center -> ${p.label} = ${d.toFixed(1)} m`);
    }
  }
}

async function saveToDB(showAlert = true) {
  const name = $("mapName").value.trim();
  if (!name) {
    if (showAlert) alert("地図名が必要です");
    return null;
  }
  if (!uploaded) {
    if (showAlert) alert("画像アップロードまたは保存済みデータの読込が必要です");
    return null;
  }

  const ready = points.filter(p => p.img_ok && p.ll_ok);
  if (ready.length < 3) {
    if (showAlert) alert("点が足りません（3点以上）");
    return null;
  }

  const payload = {
    project_id: currentProjectId,
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

  const res = await fetch("/api/migrationmaps/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  let data = null;

  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (!res.ok) {
    const msg = data?.error
      ? `${data.error}${data.detail ? `\n\n詳細: ${data.detail}` : ""}`
      : `save failed (HTTP ${res.status})\n\n${text.slice(0, 400)}`;

    if (showAlert) alert(msg);
    return null;
  }

  currentProjectId = data.project_id;
  editingProjectEl.textContent = `編集中: #${data.project_id}`;
  setDirty(false);

  $("publicLink").innerHTML =
    `公開URL: <a href="/migrationmaps/m/${data.project_id}" target="_blank" rel="noopener">/migrationmaps/m/${data.project_id}</a>`;

  log(`[SAVE] project_id=${data.project_id} ${data.updated ? "(updated)" : "(created)"}`);

  await refreshProjects();

  const projRes = await fetch(`/api/migrationmaps/${data.project_id}`);
  if (projRes.ok) {
    const proj = await projRes.json();
    currentAffine = proj.affine;
    autoPreviewEnabled = true;
    updateCurrentLocationOnCanvas();
  }

  return data.project_id;
}

$("btnPreviewOverlay").addEventListener("click", async () => {
  const projectId = await saveToDB(false);
  if (!projectId) return;
  await showOverlay(projectId);
});

$("btnSave").addEventListener("click", async () => {
  await saveToDB(true);
});

// ---- 初期化 ----
redrawTable();
refreshProjects();
refreshShopList();
log("準備OK：地図名→画像アップロード→中心/地点を設定（OSMクリック or ドラッグで調整）→保存");
log("💡 テーブルのラベルボタンをクリックして地点を選択 → 矢印キーで微調整（Shift=10倍速）");

const params = new URLSearchParams(location.search);
const initialProjectId = params.get("project_id");
if (initialProjectId) {
  loadProject(initialProjectId);
}

// =============================================================
// 店舗登録フォーム（既存コードをそのまま保持）
// =============================================================
let currentEditingShopId = null;

const shopMenuToggle = document.getElementById("shopMenuToggle");
const shopMenuBody = document.getElementById("shopMenuBody");
const shopMenuToggleIcon = document.getElementById("shopMenuToggleIcon");
const registeredShopListEl = document.getElementById("registeredShopList");
const shopFormTitleEl = document.getElementById("shopFormTitle");
const shopRegisterFormEl = document.getElementById("shopRegisterForm");
const shopRegisterResultEl = document.getElementById("shopRegisterResult");

function setShopMenuOpen(open) {
  shopMenuBody.hidden = !open;
  shopMenuToggle.setAttribute("aria-expanded", open ? "true" : "false");
  shopMenuToggleIcon.textContent = open ? "－" : "＋";
}

shopMenuToggle?.addEventListener("click", () => {
  const expanded = shopMenuToggle.getAttribute("aria-expanded") === "true";
  setShopMenuOpen(!expanded);
});

function clearShopImagePreviews() {
  for (let i = 1; i <= 5; i++) {
    const preview = document.getElementById(`r_preview${i}`);
    if (preview) preview.innerHTML = "";
    const input = document.getElementById(`r_img${i}`);
    if (input) input.value = "";
  }
}

function fillShopPreviewImages(images = []) {
  for (let i = 1; i <= 5; i++) {
    const preview = document.getElementById(`r_preview${i}`);
    if (preview) preview.innerHTML = "";
  }

  for (const img of images) {
    const preview = document.getElementById(`r_preview${img.sort_order}`);
    if (!preview) continue;
    preview.innerHTML = `<img src="${img.image_url}" alt="shop image ${img.sort_order}" />`;
  }
}

function resetShopForm(toCreate = true) {
  currentEditingShopId = null;
  shopRegisterFormEl.reset();
  document.getElementById("r_shop_id").value = "";
  document.getElementById("r_is_active").checked = true;
  clearShopImagePreviews();
  shopFormTitleEl.textContent = toCreate ? "店舗を新規登録する" : "店舗を編集する";
  shopRegisterResultEl.style.display = "none";
  shopRegisterResultEl.className = "";
  document.querySelectorAll(".registered-shop-item").forEach((el) => {
    el.classList.remove("is-active");
  });
}

function fillShopForm(shop) {
  currentEditingShopId = shop.id;
  document.getElementById("r_shop_id").value = shop.id ?? "";
  document.getElementById("r_shopname").value = shop.shopname ?? "";
  document.getElementById("r_address").value = shop.address ?? "";
  document.getElementById("r_floorlevel").value = shop.floorlevel ?? "";
  document.getElementById("r_tel").value = shop.tel ?? "";
  document.getElementById("r_email").value = shop.email ?? "";
  document.getElementById("r_instagram").value = shop.instagram_account ?? "";
  document.getElementById("r_lat").value = shop.lat ?? "";
  document.getElementById("r_lng").value = shop.lng ?? "";
  document.getElementById("r_is_active").checked = !!shop.is_active;
  document.getElementById("r_description").value = shop.description ?? "";
  document.getElementById("r_website_url").value = shop.website_url ?? "";
  document.getElementById("r_map_project_id").value = shop.map_project_id ?? "";

  clearShopImagePreviews();
  fillShopPreviewImages(shop.images || []);
  shopFormTitleEl.textContent = `店舗を編集する #${shop.id}`;
  setShopMenuOpen(true);
}

async function fetchShopDetail(shopId) {
  const res = await fetch(`/api/migrationmaps/shops/${shopId}`);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "店舗詳細の取得に失敗しました");
  }
  return data.shop;
}

async function refreshShopList() {
  try {
    const query = currentProjectId ? `?project_id=${encodeURIComponent(currentProjectId)}` : "";
    const res = await fetch(`/api/migrationmaps/shops${query}`);

    if (!res.ok) {
      registeredShopListEl.innerHTML = `<div class="muted">店舗一覧の取得に失敗しました</div>`;
      return;
    }

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
      btn.innerHTML = `
        <div class="registered-shop-name">${shop.shopname}</div>
        <div class="registered-shop-meta">
          ID: ${shop.id} / 地図ID: ${shop.map_project_id ?? "-"} / ${shop.floorlevel || "-"} / ${shop.is_active ? "営業中" : "非表示"}
        </div>
      `;
      registeredShopListEl.appendChild(btn);
    }
  } catch (err) {
    registeredShopListEl.innerHTML = `<div class="muted">店舗一覧の取得に失敗しました</div>`;
  }
}

registeredShopListEl?.addEventListener("click", async (ev) => {
  const btn = ev.target.closest(".registered-shop-item");
  if (!btn) return;

  try {
    document.querySelectorAll(".registered-shop-item").forEach((el) => {
      el.classList.remove("is-active");
    });
    btn.classList.add("is-active");

    const shop = await fetchShopDetail(btn.dataset.shopId);
    fillShopForm(shop);
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("btnRefreshShopList")?.addEventListener("click", refreshShopList);
document.getElementById("btnResetShopForm")?.addEventListener("click", () => resetShopForm(true));
