// static/js/areamap_metrics.js
(function (global) {
  "use strict";

  const DEFAULT_ENDPOINT = "/api/metrics/log";

  // 送信の重複防止（同一キーは一定時間スキップ）
  const DEDUPE_WINDOW_MS = 1200; // 1.2秒（必要なら調整）
  const sentCache = new Map();   // key -> timestamp

  function qs(name, def = "") {
    try {
      const p = new URLSearchParams(location.search);
      return p.get(name) || def;
    } catch (e) {
      return def;
    }
  }

  function getOrCreateSessionId(storageKey = "areamap_session_id") {
    try {
      let id = localStorage.getItem(storageKey);
      if (!id) {
        id = (crypto?.randomUUID?.() || ("sid_" + Math.random().toString(36).slice(2) + Date.now()));
        localStorage.setItem(storageKey, id);
      }
      return id;
    } catch (e) {
      return "sid_" + Math.random().toString(36).slice(2) + Date.now();
    }
  }

  function getClientMeta() {
    const nav = navigator || {};
    const scr = window.screen || {};
    const conn = nav.connection || nav.mozConnection || nav.webkitConnection;

    const mmPointerCoarse = window.matchMedia ? window.matchMedia("(pointer: coarse)").matches : null;
    const mmHoverNone = window.matchMedia ? window.matchMedia("(hover: none)").matches : null;
    const mmReducedMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : null;
    const mmColorScheme = window.matchMedia
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark"
        : (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : null))
      : null;

    return {
      page_url: location.href,
      page_path: location.pathname,
      referrer: document.referrer || "",
      title: document.title || "",

      ref: qs("ref", ""),
      post: qs("post", ""),
      variant: qs("variant", ""),

      session_id: getOrCreateSessionId(),

      user_agent: nav.userAgent || "",
      language: nav.language || "",
      languages: Array.isArray(nav.languages) ? nav.languages : [],
      platform: nav.platform || "",

      timezone: (() => {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { return ""; }
      })(),
      tz_offset_min: new Date().getTimezoneOffset(),

      screen_width: scr.width || null,
      screen_height: scr.height || null,
      viewport_width: window.innerWidth || null,
      viewport_height: window.innerHeight || null,
      device_pixel_ratio: window.devicePixelRatio || null,
      color_depth: scr.colorDepth || null,

      max_touch_points: nav.maxTouchPoints ?? null,
      pointer_coarse: mmPointerCoarse,
      hover_none: mmHoverNone,

      device_memory_gb: nav.deviceMemory ?? null,
      hardware_concurrency: nav.hardwareConcurrency ?? null,

      connection_effective_type: conn?.effectiveType || null,
      connection_rtt_ms: conn?.rtt ?? null,
      connection_downlink_mbps: conn?.downlink ?? null,
      connection_save_data: conn?.saveData ?? null,

      cookies_enabled: nav.cookieEnabled ?? null,
      do_not_track: nav.doNotTrack ?? null,
      prefers_reduced_motion: mmReducedMotion,
      prefers_color_scheme: mmColorScheme
    };
  }

  function buildPayload(event_name, metric_id, extra) {
    return {
      event_name,
      metric_id,
      extra: Object.assign({}, getClientMeta(), extra || {})
    };
  }

  // ✅ 送信経路を fetch keepalive のみに固定
  function postJSON(endpoint, payload) {
    return fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
      credentials: "same-origin"
    }).then(() => true).catch(() => false);
  }

  // ✅ 同一イベントの短時間二重送信を防ぐ
  function shouldSend(key) {
    const now = Date.now();
    const last = sentCache.get(key);
    if (last && (now - last) < DEDUPE_WINDOW_MS) {
      return false;
    }
    sentCache.set(key, now);

    // キャッシュ肥大を防ぐ簡易掃除
    if (sentCache.size > 2000) {
      sentCache.clear();
    }
    return true;
  }

  function createTracker(opts = {}) {
    const endpoint = opts.endpoint || DEFAULT_ENDPOINT;

    function track(event_name, metric_id, extra = {}) {
      if (!event_name || !metric_id) return Promise.resolve(false);

      // session_id + event + metric + href/modal_img で重複判定
      const sid = (extra && extra.session_id) || getOrCreateSessionId();
      const a = extra?.href || extra?.modal_img || "";
      const key = [sid, event_name, metric_id, a, location.pathname].join("|");

      if (!shouldSend(key)) return Promise.resolve(true);

      const payload = buildPayload(event_name, metric_id, extra);
      return postJSON(endpoint, payload);
    }

    // data-track のクリックを自動計測（※これだけ使う運用が一番安全）
    function bindAutoClicks(root = document) {
      root.addEventListener("click", (e) => {
        const el = e.target?.closest?.("[data-track]");
        if (!el) return;

        const metricId = el.getAttribute("data-track");
        const href = el.getAttribute("href") || "";
        const modalImg = el.getAttribute("data-modal-img") || "";

        // ここで extra に href 等を入れる（重複判定にも使う）
        track("click", metricId, { href, modal_img: modalImg });
      }, true);
    }

    function trackPageView(metricId = "areamap_page_view") {
      // PVは二重送信されやすいので、dedupeキーに引っかかるようにする
      return track("view", metricId, {});
    }

    return { track, bindAutoClicks, trackPageView };
  }

  global.AreamapMetrics = { createTracker };
})(window);
