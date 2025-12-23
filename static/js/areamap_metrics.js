// static/js/areamap_metrics.js
(function (global) {
  "use strict";

  const DEFAULT_ENDPOINT = "/api/metrics/log";

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
      // localStorage不可でも最低限ユニーク
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
      // ページ情報
      page_url: location.href,
      page_path: location.pathname,
      referrer: document.referrer || "",
      title: document.title || "",

      // URLパラメータ（媒体/投稿別）
      ref: qs("ref", ""),
      post: qs("post", ""),
      variant: qs("variant", ""),

      // 匿名セッションID
      session_id: getOrCreateSessionId(),

      // ブラウザ情報
      user_agent: nav.userAgent || "",
      language: nav.language || "",
      languages: Array.isArray(nav.languages) ? nav.languages : [],
      platform: nav.platform || "",

      // タイムゾーン
      timezone: (() => {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { return ""; }
      })(),
      tz_offset_min: new Date().getTimezoneOffset(),

      // 画面/表示
      screen_width: scr.width || null,
      screen_height: scr.height || null,
      viewport_width: window.innerWidth || null,
      viewport_height: window.innerHeight || null,
      device_pixel_ratio: window.devicePixelRatio || null,
      color_depth: scr.colorDepth || null,

      // 入力環境
      max_touch_points: nav.maxTouchPoints ?? null,
      pointer_coarse: mmPointerCoarse,
      hover_none: mmHoverNone,

      // 端末性能
      device_memory_gb: nav.deviceMemory ?? null,
      hardware_concurrency: nav.hardwareConcurrency ?? null,

      // 回線（対応ブラウザのみ）
      connection_effective_type: conn?.effectiveType || null,
      connection_rtt_ms: conn?.rtt ?? null,
      connection_downlink_mbps: conn?.downlink ?? null,
      connection_save_data: conn?.saveData ?? null,

      // プライバシー系
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

  // ---- 送信（優先順位：sendBeacon > fetch keepalive > fetch）
  function postJSON(endpoint, payload) {
    const body = JSON.stringify(payload);

    // 1) sendBeacon（ページ遷移/離脱に強い）
    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([body], { type: "application/json" });
        const ok = navigator.sendBeacon(endpoint, blob);
        if (ok) return Promise.resolve(true);
      }
    } catch (e) {
      // fallback
    }

    // 2) fetch keepalive
    try {
      return fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
        credentials: "same-origin"
      }).then(() => true).catch(() => false);
    } catch (e) {
      // 3) 最後のfallback
      return fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        credentials: "same-origin"
      }).then(() => true).catch(() => false);
    }
  }

  function createTracker(opts = {}) {
    const endpoint = opts.endpoint || DEFAULT_ENDPOINT;

    function track(event_name, metric_id, extra = {}) {
      if (!event_name || !metric_id) return Promise.resolve(false);
      const payload = buildPayload(event_name, metric_id, extra);
      return postJSON(endpoint, payload);
    }

    // DOM要素に data-track が付いてたら自動でクリック計測
    // 例: <a data-track="google_map_click" ...>
    function bindAutoClicks(root = document) {
      root.addEventListener("click", (e) => {
        const el = e.target?.closest?.("[data-track]");
        if (!el) return;

        const metricId = el.getAttribute("data-track");
        const href = el.getAttribute("href") || "";
        const modalImg = el.getAttribute("data-modal-img") || "";

        track("click", metricId, {
          href,
          modal_img: modalImg
        });
      }, true);
    }

    // PV（到達）計測。ページ読み込みで呼ぶ
    function trackPageView(metricId = "areamap_page_view") {
      return track("view", metricId);
    }

    return { track, bindAutoClicks, trackPageView };
  }

  global.AreamapMetrics = { createTracker };
})(window);
