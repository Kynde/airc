"use strict";

(() => {
  const LINE_HEIGHT = 1.25;
  const PAD = 8;
  const FONT_MIN = 7;
  const MOBILE_FONT_MIN = 10;
  const FONT_MAX = 24;
  const el = {
    dot: document.getElementById("dot"),
    state: document.getElementById("state"),
    note: document.getElementById("note"),
    alerts: document.getElementById("alerts"),
    autoToggle: document.getElementById("auto-toggle"),
    windowToggle: document.getElementById("window-toggle"),
    dashboard: document.getElementById("dashboard"),
    mobileMenuToggle: document.getElementById("mobile-menu-toggle"),
    paneLabel: document.getElementById("pane-label"),
    fontMinus: document.getElementById("font-minus"),
    fontPlus: document.getElementById("font-plus"),
    fontFit: document.getElementById("font-fit"),
    controlsToggle: document.getElementById("controls-toggle"),
    themeToggle: document.getElementById("theme-toggle"),
    pauseToggle: document.getElementById("pause-toggle"),
    termWrap: document.getElementById("term-wrap"),
    term: document.getElementById("term"),
    termGrid: document.getElementById("term-grid"),
    cursor: document.getElementById("cursor"),
    controlBar: document.getElementById("control-bar"),
    controlText: document.getElementById("control-text"),
    controlSend: document.getElementById("control-send"),
    controlLeft: document.getElementById("control-left"),
    controlRight: document.getElementById("control-right"),
    controlUp: document.getElementById("control-up"),
    controlDown: document.getElementById("control-down"),
    controlEnter: document.getElementById("control-enter"),
    controlCtrl: document.getElementById("control-ctrl"),
    controlCtrlMenu: document.getElementById("control-ctrl-menu"),
    picker: document.getElementById("picker"),
    pickerList: document.getElementById("picker-list"),
    pickerClose: document.getElementById("picker-close"),
  };

  const params = new URLSearchParams(location.search);
  if (params.get("k")) {
    localStorage.setItem("airc_token", params.get("k"));
    history.replaceState(null, "", location.pathname);
  }
  const token = localStorage.getItem("airc_token") || "";
  const headers = (extra = {}) => {
    const out = { ...extra };
    if (token) {
      out["X-Airc-Auth"] = token;
    }
    return out;
  };

  let cfg = { pollMs: 700, pollIdleMaxMs: 2500, fontSizeDefault: 13, theme: "dark", resizeToViewport: false, canControl: false };
  let etag = null;
  let interval = cfg.pollMs;
  let misses = 0;
  let paused = false;
  let pinned = localStorage.getItem("airc_pin") || "";
  let followSession = localStorage.getItem("airc_session") || "";
  let currentSession = "";
  // Window view: "pane" (one pane, the original mode) or "window" (the whole
  // tmux window laid out as a grid). pinnedWindow is the @id being shown;
  // inputPane is the pane keystrokes target (defaults to the active pane,
  // overridable by clicking a pane). Both reset across reconnects from state.
  let viewMode = localStorage.getItem("airc_view_mode") === "window" ? "window" : "pane";
  let pinnedWindow = localStorage.getItem("airc_pin_window") || "";
  let inputPane = "";
  let windowFrame = null;
  let auto = localStorage.getItem("airc_auto") === "1";
  let attentionList = [];
  let fontMode = localStorage.getItem("airc_font_mode") || "auto";
  let fontSize = Number(localStorage.getItem("airc_font_size")) || 13;
  let controlsVisible = localStorage.getItem("airc_controls_visible") === "1";
  let chRatio = 0.6;
  let lastCols = 0;
  let lastRows = 0;
  let lastCursor = null;
  let lastOkAt = 0;
  let lastChangeAt = 0;
  let ws = null;
  let fallbackStarted = false;
  let followLeft = true;
  let followBottom = true;
  let mobileMenuOpen = false;
  const mobileMedia = window.matchMedia("(max-width: 720px), (pointer: coarse)");
  let mobileView = mobileMedia.matches;

  function applyMobileView() {
    mobileView = mobileMedia.matches;
    document.body.classList.toggle("mobile-view", mobileView);
    if (!mobileView) {
      mobileMenuOpen = false;
      document.body.classList.remove("mobile-menu-open");
      el.mobileMenuToggle.setAttribute("aria-expanded", "false");
    }
    applyFont();
  }

  function toggleMobileMenu() {
    mobileMenuOpen = !mobileMenuOpen;
    document.body.classList.toggle("mobile-menu-open", mobileMenuOpen);
    el.mobileMenuToggle.setAttribute("aria-expanded", mobileMenuOpen ? "true" : "false");
  }

  function applyTheme(theme) {
    document.body.classList.toggle("theme-day", theme === "day");
    document.body.classList.toggle("theme-dark", theme !== "day");
    el.themeToggle.textContent = theme === "day" ? "dark" : "day";
  }

  async function measureFont() {
    try {
      await document.fonts.ready;
    } catch {
      // Keep the estimate.
    }
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:400 100px 'Airc Fira Code',monospace";
    probe.textContent = "0".repeat(50);
    document.body.appendChild(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    if (width > 0) {
      chRatio = width / 50 / 100;
    }
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function availArea() {
    return {
      w: el.termWrap.clientWidth - 2 * PAD,
      h: el.termWrap.clientHeight - 2 * PAD,
    };
  }

  function maxScrollTop() {
    return Math.max(0, el.termWrap.scrollHeight - el.termWrap.clientHeight);
  }

  function updateScrollFollow() {
    followLeft = el.termWrap.scrollLeft <= 2;
    followBottom = el.termWrap.scrollTop >= maxScrollTop() - 2;
  }

  function applyScrollFollow() {
    if (followLeft) {
      el.termWrap.scrollLeft = 0;
    }
    if (followBottom) {
      el.termWrap.scrollTop = maxScrollTop();
    }
  }

  function placeCursor() {
    if (!lastCursor || paused) {
      el.cursor.hidden = true;
      return;
    }
    const size = parseFloat(el.term.style.fontSize) || cfg.fontSizeDefault;
    const cellW = size * chRatio;
    const cellH = size * LINE_HEIGHT;
    el.cursor.style.left = `${PAD + lastCursor.x * cellW}px`;
    el.cursor.style.top = `${PAD + lastCursor.y * cellH}px`;
    el.cursor.style.width = `${cellW}px`;
    el.cursor.style.height = `${cellH}px`;
    el.cursor.hidden = false;
  }

  function currentFontSize() {
    if (fontMode === "manual" || cfg.resizeToViewport) {
      return fontMode === "manual" ? fontSize : cfg.fontSizeDefault;
    }
    if (lastCols > 0 && lastRows > 0) {
      const area = availArea();
      const min = mobileView ? MOBILE_FONT_MIN : FONT_MIN;
      const size = clamp(Math.min(area.w / (lastCols * chRatio), area.h / (lastRows * LINE_HEIGHT)), min, FONT_MAX);
      return Math.floor(size * 2) / 2;
    }
    return cfg.fontSizeDefault;
  }

  function applyFont() {
    const size = currentFontSize();
    // In window mode lastCols/lastRows are the whole window's dimensions, so the
    // same fit math sizes the grid to show every pane at once.
    const container = viewMode === "window" ? el.termGrid : el.term;
    container.style.fontSize = `${size}px`;
    el.fontFit.classList.toggle("active", fontMode === "auto" && !cfg.resizeToViewport);
    if (viewMode === "window") {
      layoutWindow();
    } else {
      placeCursor();
    }
    applyScrollFollow();
  }

  function applyControlsVisibility() {
    const visible = cfg.canControl && controlsVisible;
    el.controlsToggle.hidden = !cfg.canControl;
    el.controlsToggle.classList.toggle("active", visible);
    el.controlsToggle.textContent = visible ? "ctrl on" : "ctrl";
    el.controlBar.hidden = !visible;
    if (!visible) {
      closeCtrlMenu();
    }
    applyFont();
  }

  function applyAttentionVisibility() {
    el.autoToggle.hidden = !cfg.attentionEnabled;
    el.autoToggle.classList.toggle("active", auto);
    if (!cfg.attentionEnabled) {
      el.alerts.hidden = true;
    }
  }

  function closeCtrlMenu() {
    el.controlCtrlMenu.hidden = true;
    el.controlCtrl.classList.remove("active");
    el.controlCtrl.setAttribute("aria-expanded", "false");
  }

  function toggleCtrlMenu() {
    if (el.controlCtrlMenu.hidden) {
      el.controlCtrlMenu.hidden = false;
      el.controlCtrl.classList.add("active");
      el.controlCtrl.setAttribute("aria-expanded", "true");
    } else {
      closeCtrlMenu();
    }
  }

  function viewedTarget() {
    if (viewMode === "window") {
      // Window view follows tmux's active pane for input, but a click can pin a
      // specific pane as the target (inputPane). Either way it's a concrete pane.
      return inputPane ? { target: "pane", paneId: inputPane } : { target: "active", session: followSession };
    }
    return pinned ? { target: "pane", paneId: pinned } : { target: "active", session: followSession };
  }

  async function sendControl(payload) {
    if (!cfg.canControl) {
      return;
    }
    const response = await fetch("/api/tmux/input", {
      method: "POST",
      cache: "no-store",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ ...viewedTarget(), ...payload }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    etag = null;
  }

  async function sendControlText() {
    const text = el.controlText.value;
    if (!text) {
      return;
    }
    el.controlText.value = "";
    try {
      await sendControl({ text });
    } catch {
      el.controlText.value = text;
    }
  }

  function sendControlKey(key) {
    sendControl({ key }).catch(() => {
      // The status ticker will show stale state if control/auth is broken.
    });
  }

  function renderStatus(payload) {
    if (payload.publicUrl) {
      cfg.publicUrl = payload.publicUrl;
    }
    const parts = [];
    if (payload.ngrok?.enabled) {
      if (payload.ngrok.running && (payload.publicUrl || payload.ngrok.url)) {
        parts.push(`<span class="ok">tunnel up</span>`);
      } else {
        parts.push(`<span class="bad">tunnel down</span>`);
      }
    }
    if (payload.battery?.summary) {
      parts.push(`bat ${payload.battery.summary}`);
    }
    if (payload.serverVersion) {
      parts.push(`build ${payload.serverVersion}`);
    }
    el.dashboard.innerHTML = parts.join(" · ");
  }

  function originOf(value) {
    try {
      return new URL(value, location.href).origin;
    } catch {
      return "";
    }
  }

  function isLanHostname(hostname) {
    return /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) ||
      hostname.endsWith(".local");
  }

  function connectionLabel() {
    const here = location.origin;
    const host = location.hostname;
    const lanOrigins = (cfg.lanUrls || []).map(originOf).filter(Boolean);
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return "local";
    }
    if (lanOrigins.includes(here) || isLanHostname(host)) {
      return "wlan";
    }
    if (originOf(cfg.publicUrl) === here || host.includes("ngrok")) {
      return "ngrok";
    }
    return "net";
  }

  function connectedStateLabel(changeAge) {
    if (!mobileView) {
      return changeAge > 10000 ? `idle ${Math.round(changeAge / 1000)}s` : "live";
    }
    const route = connectionLabel();
    return changeAge > 10000 ? `${route} ${Math.round(changeAge / 1000)}s` : route;
  }

  async function updateStatus() {
    try {
      const response = await fetch("/api/status", { cache: "no-store", headers: headers() });
      if (!response.ok) {
        return;
      }
      renderStatus(await response.json());
    } catch {
      // Frame polling already communicates connectivity problems.
    }
  }

  function fitCells() {
    const size = fontMode === "manual" ? fontSize : cfg.fontSizeDefault;
    const area = availArea();
    return {
      cols: Math.max(20, Math.floor(area.w / (size * chRatio))),
      rows: Math.max(5, Math.floor(area.h / (size * LINE_HEIGHT))),
    };
  }

  function frameQuery() {
    const query = new URLSearchParams();
    // session is sent in both cases so a vanished pin falls back to its session.
    if (followSession) {
      query.set("session", followSession);
    }
    if (viewMode === "window") {
      query.set("mode", "window");
      if (pinnedWindow) {
        query.set("window", pinnedWindow);
      }
      if (cfg.resizeToViewport) {
        const cells = fitCells();
        query.set("cols", String(cells.cols));
        query.set("rows", String(cells.rows));
      }
      return query;
    }
    if (pinned) {
      query.set("pane", pinned);
    } else if (cfg.resizeToViewport) {
      const cells = fitCells();
      query.set("cols", String(cells.cols));
      query.set("rows", String(cells.rows));
    }
    return query;
  }

  function renderFrame(frame) {
    lastOkAt = Date.now();
    misses = 0;
    interval = cfg.pollMs;
    if (!frame.ok) {
      el.term.textContent = frame.error || "capture failed";
      lastCursor = null;
      placeCursor();
      return;
    }
    if (pinned && frame.pinValid === false) {
      pinned = "";
      localStorage.removeItem("airc_pin");
      // Keep following the session the dropped pane belonged to.
      followSession = frame.session || "";
      localStorage.setItem("airc_session", followSession);
      sendViewState();
    }
    el.term.innerHTML = frame.html;
    lastCursor = frame.cursor;
    lastChangeAt = Date.now();
    currentSession = frame.session || "";
    const where = `${frame.windowName}:${frame.paneIndex}`;
    el.paneLabel.textContent = frame.pinned
      ? `pin ${frame.session} ${where}`
      : `${frame.session} ${where}`;
    if (frame.cols !== lastCols || frame.rows !== lastRows) {
      lastCols = frame.cols;
      lastRows = frame.rows;
      applyFont();
    } else {
      placeCursor();
    }
    applyScrollFollow();
  }

  // Position each pane cell on the character grid from its tmux coordinates and
  // size, in px derived from the current font. Called on every frame and on any
  // resize/font change. Cheap: it only writes inline styles on existing nodes,
  // rebuilding children only when the pane set changes (see renderWindowFrame).
  function layoutWindow() {
    if (!windowFrame || viewMode !== "window") {
      return;
    }
    const size = parseFloat(el.termGrid.style.fontSize) || cfg.fontSizeDefault;
    const cellW = size * chRatio;
    const cellH = size * LINE_HEIGHT;
    el.termGrid.style.width = `${PAD * 2 + windowFrame.cols * cellW}px`;
    el.termGrid.style.height = `${PAD * 2 + windowFrame.rows * cellH}px`;
    for (const node of el.termGrid.children) {
      const left = Number(node.dataset.left);
      const top = Number(node.dataset.top);
      node.style.left = `${PAD + left * cellW}px`;
      node.style.top = `${PAD + top * cellH}px`;
      node.style.width = `${Number(node.dataset.cols) * cellW}px`;
      node.style.height = `${Number(node.dataset.rows) * cellH}px`;
      const cur = node._cursorEl;
      if (cur && !cur.hidden) {
        cur.style.left = `${Number(cur.dataset.x) * cellW}px`;
        cur.style.top = `${Number(cur.dataset.y) * cellH}px`;
        cur.style.width = `${cellW}px`;
        cur.style.height = `${cellH}px`;
      }
    }
  }

  // Decide which pane the keystrokes target. Honour an explicit click
  // (inputPane) when that pane is still present; otherwise fall back to the
  // pane tmux marks active, so a fresh window view types into the live pane.
  function resolveInputPane(frame) {
    if (inputPane && frame.panes.some((p) => p.paneId === inputPane)) {
      return inputPane;
    }
    const active = frame.panes.find((p) => p.active);
    return active ? active.paneId : (frame.panes[0] && frame.panes[0].paneId) || "";
  }

  function paneClasses(pane) {
    let cls = "gpane";
    if (pane.active) {
      cls += " active";
    }
    if (pane.paneId === inputPane) {
      cls += " target";
    }
    return cls;
  }

  function renderWindowFrame(frame) {
    lastOkAt = Date.now();
    misses = 0;
    interval = cfg.pollMs;
    if (!frame.ok) {
      el.termGrid.replaceChildren();
      el.termGrid.textContent = frame.error || "capture failed";
      windowFrame = null;
      return;
    }
    if (pinnedWindow && frame.pinValid === false) {
      // The pinned window vanished; fall back to following the active window of
      // its session, mirroring the single-pane pin-drop behaviour.
      pinnedWindow = "";
      localStorage.removeItem("airc_pin_window");
      followSession = frame.session || "";
      localStorage.setItem("airc_session", followSession);
    }
    windowFrame = frame;
    currentSession = frame.session || "";
    inputPane = resolveInputPane(frame);

    // Rebuild the cell nodes only when the pane set changes (window switch,
    // split added/removed); otherwise reuse nodes and just swap innerHTML so a
    // steady window doesn't thrash the DOM every frame.
    const ids = frame.panes.map((p) => p.paneId).join(",");
    if (el.termGrid.dataset.ids !== ids) {
      el.termGrid.dataset.ids = ids;
      el.termGrid.replaceChildren();
      for (const pane of frame.panes) {
        const cell = document.createElement("pre");
        cell.dataset.paneId = pane.paneId;
        const cursor = document.createElement("div");
        cursor.className = "gpane-cursor";
        cursor.hidden = true;
        cell._cursorEl = cursor;
        cell.appendChild(cursor);
        cell.addEventListener("click", () => selectInputPane(pane.paneId));
        el.termGrid.appendChild(cell);
      }
    }

    for (const cell of el.termGrid.children) {
      const pane = frame.panes.find((p) => p.paneId === cell.dataset.paneId);
      if (!pane) {
        continue;
      }
      cell.className = paneClasses(pane);
      cell.dataset.left = pane.left;
      cell.dataset.top = pane.top;
      cell.dataset.cols = pane.cols;
      cell.dataset.rows = pane.rows;
      // innerHTML carries server-rendered SGR spans; the cursor node is appended
      // after so it survives the content swap.
      const cursor = cell._cursorEl;
      cell.innerHTML = pane.html;
      cell.appendChild(cursor);
      const showCursor = !paused && pane.paneId === inputPane && pane.cursor;
      cursor.hidden = !showCursor;
      if (showCursor) {
        cursor.dataset.x = pane.cursor.x;
        cursor.dataset.y = pane.cursor.y;
      }
    }

    el.paneLabel.textContent = frame.pinned
      ? `win ${frame.session} ${frame.windowName}`
      : `${frame.session} ${frame.windowName} (win)`;

    if (frame.cols !== lastCols || frame.rows !== lastRows) {
      lastCols = frame.cols;
      lastRows = frame.rows;
      applyFont();
    } else {
      layoutWindow();
    }
    lastChangeAt = Date.now();
    applyAuto();
    applyScrollFollow();
  }

  function websocketUrl() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const query = new URLSearchParams();
    if (token) {
      query.set("k", token);
    }
    return `${protocol}//${location.host}/api/tmux/ws?${query}`;
  }

  function sendViewState() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (viewMode === "window") {
      const cells = cfg.resizeToViewport ? fitCells() : {};
      ws.send(JSON.stringify({
        type: "view",
        mode: "window",
        window: pinnedWindow,
        session: followSession,
        cols: cells.cols,
        rows: cells.rows,
      }));
      return;
    }
    const cells = cfg.resizeToViewport && !pinned ? fitCells() : {};
    ws.send(JSON.stringify({
      type: "view",
      pane: pinned,
      // Sent even with a pin so a vanished pin falls back to its own session.
      session: followSession,
      cols: cells.cols,
      rows: cells.rows,
    }));
  }

  function startPollingFallback() {
    if (fallbackStarted) {
      return;
    }
    fallbackStarted = true;
    loop();
    pollAttention();
    setInterval(pollAttention, 2000);
  }

  function startWebSocket() {
    if (!("WebSocket" in window) || !token) {
      startPollingFallback();
      return;
    }
    try {
      ws = new WebSocket(websocketUrl());
    } catch {
      startPollingFallback();
      return;
    }
    ws.addEventListener("open", () => {
      etag = null;
      sendViewState();
    });
    ws.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "frame") {
          if (!paused) {
            dispatchFrame(payload.frame);
          }
        } else if (payload.type === "heartbeat") {
          lastOkAt = Date.now();
        } else if (payload.type === "attention") {
          renderAttention(payload.items);
        }
      } catch {
        // Ignore malformed stream messages and keep the socket alive.
      }
    });
    ws.addEventListener("close", startPollingFallback);
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        startPollingFallback();
      }
    });
  }

  async function tick() {
    const query = frameQuery();
    const requestHeaders = headers();
    if (etag) {
      requestHeaders["If-None-Match"] = etag;
    }
    const response = await fetch(`/api/tmux/frame?${query}`, { cache: "no-store", headers: requestHeaders });
    if (response.status === 304) {
      lastOkAt = Date.now();
      misses += 1;
      if (misses >= 3) {
        interval = Math.min(interval * 1.5, cfg.pollIdleMaxMs);
      }
      return;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    etag = response.headers.get("ETag");
    dispatchFrame(await response.json());
  }

  // Route a frame to the right renderer by its shape. The server tags window
  // frames with mode:"window"; anything else is a single pane. Guarding on shape
  // (not just current viewMode) means a frame that arrives just after a mode
  // toggle can't be fed to the wrong renderer.
  function dispatchFrame(frame) {
    if (frame && frame.mode === "window") {
      renderWindowFrame(frame);
    } else {
      renderFrame(frame);
    }
  }

  // Attention reaches WebSocket clients in the frame stream. The HTTP-poll
  // fallback has no such push, so poll it directly — but only while the
  // fallback is active and the feature is on, so we add no traffic otherwise.
  async function pollAttention() {
    if (!fallbackStarted || !cfg.attentionEnabled) {
      return;
    }
    try {
      const response = await fetch("/api/attention", { cache: "no-store", headers: headers() });
      if (response.ok) {
        renderAttention((await response.json()).items);
      }
    } catch {
      // Transient; the next poll retries.
    }
  }

  function schedule() {
    setTimeout(loop, interval);
  }

  async function loop() {
    if (!paused) {
      try {
        await tick();
      } catch {
        interval = 5000;
        etag = null;
      }
    }
    schedule();
  }

  setInterval(() => {
    const now = Date.now();
    el.dot.classList.remove("live", "stale");
    el.termWrap.classList.remove("stale");
    if (paused) {
      el.state.textContent = "paused";
      return;
    }
    if (lastOkAt === 0) {
      el.state.textContent = "connecting";
      return;
    }
    const okAge = now - lastOkAt;
    if (okAge > 5000) {
      el.dot.classList.add("stale");
      el.termWrap.classList.add("stale");
      el.state.textContent = `stale ${Math.round(okAge / 1000)}s`;
      return;
    }
    el.dot.classList.add("live");
    const changeAge = now - lastChangeAt;
    el.state.textContent = connectedStateLabel(changeAge);
  }, 500);

  // Show or hide the single-pane vs. window-grid containers and label the mode
  // toggle. Switching mode resets the per-mode dimension cache so applyFont
  // refits against the new content (one pane vs. a whole window).
  function applyViewMode() {
    const isWindow = viewMode === "window";
    el.term.hidden = isWindow;
    el.termGrid.hidden = !isWindow;
    el.cursor.hidden = isWindow || el.cursor.hidden;
    el.windowToggle.classList.toggle("active", isWindow);
    el.windowToggle.textContent = isWindow ? "win on" : "win";
    lastCols = 0;
    lastRows = 0;
    applyFont();
  }

  function setViewMode(mode) {
    const next = mode === "window" ? "window" : "pane";
    if (next === viewMode) {
      return;
    }
    viewMode = next;
    localStorage.setItem("airc_view_mode", viewMode);
    etag = null;
    windowFrame = null;
    applyViewMode();
    sendViewState();
  }

  // Pin the view to a pane. Shared by the manual picker and auto mode; only the
  // manual path disables auto (see selectPane), so an auto-driven pin doesn't
  // turn auto off.
  function applyPin(pane) {
    pinned = pane.paneId;
    localStorage.setItem("airc_pin", pinned);
    followSession = pane.session || "";
    localStorage.setItem("airc_session", followSession);
    etag = null;
    sendViewState();
  }

  // Pin the window view to a specific window (@id). The session is remembered so
  // a vanished window falls back to following that session's active window.
  function applyWindowPin(windowId, session) {
    pinnedWindow = windowId;
    localStorage.setItem("airc_pin_window", windowId);
    followSession = session || "";
    localStorage.setItem("airc_session", followSession);
    etag = null;
    sendViewState();
  }

  // Click-to-target inside the window grid: redirect keystrokes to the clicked
  // pane. Re-renders the current frame so the accent ring moves immediately
  // rather than waiting for the next poll.
  function selectInputPane(paneId) {
    inputPane = paneId;
    if (windowFrame) {
      renderWindowFrame(windowFrame);
    }
  }

  function selectFollow(session) {
    setAuto(false); // an explicit session choice is a manual override
    pinned = "";
    localStorage.removeItem("airc_pin");
    followSession = session;
    localStorage.setItem("airc_session", session);
    etag = null;
    sendViewState();
    el.picker.hidden = true;
  }

  function selectPane(pane) {
    setAuto(false); // an explicit pane choice is a manual override
    applyPin(pane);
    el.picker.hidden = true;
  }

  // Picking a window from the list switches into window mode and pins that
  // window. inputPane resets so the new window types into its active pane until
  // the user clicks a specific one.
  function selectWindow(windowId, session) {
    setAuto(false); // an explicit window choice is a manual override
    inputPane = "";
    if (viewMode !== "window") {
      viewMode = "window";
      localStorage.setItem("airc_view_mode", "window");
      applyViewMode();
    }
    applyWindowPin(windowId, session);
    el.picker.hidden = true;
  }

  // Tapping an attention chip nudges the view to that pane but, unlike the
  // picker, does NOT disable auto — auto stays engaged and will still pull you
  // to anything more urgent (e.g. an agent that starts asking a question).
  function selectChip(pane) {
    applyPin(pane);
  }

  // Urgency rank for auto-follow: a pane asking a question (waiting) outranks one
  // actively working (busy), which outranks one that's finished and idle. Lower
  // is more urgent. This is the follow order; it differs from the chip-row order
  // the server sends (which trails idle ahead of busy), so auto picks its own
  // target rather than trusting the head. Ties break on server order (oldest).
  const AUTO_RANK = { waiting: 0, busy: 1, "idle-input": 2 };
  const autoRank = (item) => (item && item.state in AUTO_RANK ? AUTO_RANK[item.state] : 99);

  // The pane auto mode should follow. Auto is sticky by urgency: it only pulls
  // you to a pane strictly more urgent than the one you're already viewing. So
  // tapping a running agent to watch it (or auto landing on one) holds — even
  // as other agents work — until something more urgent appears, e.g. an agent
  // asking a question, which always wins. Without this it would hop between
  // equally-busy panes and never let you settle. Returns undefined to hold.
  // The pane auto should follow. `currentPaneId` is what's being watched now —
  // the pinned pane in pane mode, the focused pane in window mode — so the
  // sticky-by-urgency comparison holds in either view. Returns undefined to hold.
  function autoTarget(currentPaneId) {
    let best;
    for (const item of attentionList) {
      if (!best || autoRank(item) < autoRank(best)) {
        best = item;
      }
    }
    if (!best) {
      return undefined;
    }
    const current = attentionList.find((item) => item.paneId === currentPaneId);
    if (current && autoRank(current) <= autoRank(best)) {
      return undefined;
    }
    return best;
  }

  function applyAuto() {
    if (!auto) {
      return;
    }
    if (viewMode === "window") {
      applyAutoWindow();
      return;
    }
    const target = autoTarget(pinned);
    // Glow while auto is engaged with the fleet — either moving to a target or
    // holding on a pane that itself still has attention.
    const holding = attentionList.some((item) => item.paneId === pinned);
    el.autoToggle.classList.toggle("armed", Boolean(target) || holding);
    if (target && target.paneId !== pinned) {
      applyPin(target);
    }
  }

  // Window-mode auto: switch the viewed window to the most-urgent flagged pane's
  // window and focus that pane (so keystrokes land on the agent that needs you).
  // This is the two-agents-in-one-window case — auto can move focus between
  // panes of the same window without a window switch. Sticky by urgency against
  // the currently focused pane, same as pane mode.
  function applyAutoWindow() {
    const target = autoTarget(inputPane);
    const holding = attentionList.some((item) => item.paneId === inputPane);
    el.autoToggle.classList.toggle("armed", Boolean(target) || holding);
    if (!target || target.paneId === inputPane) {
      return;
    }
    inputPane = target.paneId;
    if (target.windowId && target.windowId !== (windowFrame && windowFrame.windowId)) {
      // Different window: pin it. The next frame renders the new window and
      // resolveInputPane keeps inputPane as the target since it's present there.
      applyWindowPin(target.windowId, target.session);
    } else if (windowFrame) {
      // Same window, different pane: just move the target ring/cursor now.
      renderWindowFrame(windowFrame);
    }
  }

  function setAuto(on) {
    if (auto === on) {
      return;
    }
    auto = on;
    localStorage.setItem("airc_auto", on ? "1" : "0");
    el.autoToggle.classList.toggle("active", auto);
    if (!auto) {
      el.autoToggle.classList.remove("armed");
    }
    applyAuto();
  }

  function renderAttention(items) {
    attentionList = Array.isArray(items) ? items : [];
    const waiting = attentionList.filter((item) => item.state === "waiting");
    // Build tap-to-switch chips: every flagged pane, urgent ones styled hot.
    el.alerts.replaceChildren();
    for (const item of attentionList) {
      const chip = document.createElement("button");
      chip.className = `chip ${item.state}`;
      const where = `${item.windowName}:${item.paneIndex}`;
      const mark = item.state === "waiting" ? "● " : item.state === "busy" ? "◐ " : "○ ";
      chip.textContent = `${mark}${item.agent || "agent"} ${where}`;
      chip.title = item.state === "waiting"
        ? "needs interaction — tap to switch"
        : item.state === "busy"
        ? "working — tap to switch"
        : "finished — tap to switch";
      chip.addEventListener("click", () => selectChip(item));
      el.alerts.appendChild(chip);
    }
    el.alerts.hidden = attentionList.length === 0;
    el.autoToggle.classList.toggle("hot", waiting.length > 0 && !auto);
    applyAuto();
  }

  async function openPicker() {
    const response = await fetch("/api/tmux/panes", { cache: "no-store", headers: headers() });
    const payload = await response.json();
    el.pickerList.replaceChildren();

    // Group panes by session. Only sessions with live panes are listed; a
    // configured-but-dead session has no panes, so it's left out. The server's
    // session order decides ordering, then any extra pane-sessions follow.
    const bySession = new Map();
    for (const pane of payload.panes || []) {
      if (!bySession.has(pane.session)) {
        bySession.set(pane.session, []);
      }
      bySession.get(pane.session).push(pane);
    }
    const configured = payload.sessions || [];
    const sessions = [
      ...configured.filter((session) => bySession.has(session)),
      ...[...bySession.keys()].filter((session) => !configured.includes(session)),
    ];

    for (const session of sessions) {
      const header = document.createElement("button");
      header.className = "picker-session";
      header.textContent = session;
      // The session header follows that session's active pane. Highlight the
      // explicitly-followed session, or the one currently shown if none chosen.
      const followingThis = pinned === "" && pinnedWindow === "" &&
        (followSession ? followSession === session : currentSession === session);
      header.classList.toggle("selected", followingThis);
      header.addEventListener("click", () => selectFollow(session));
      el.pickerList.appendChild(header);

      // Within a session, group panes by their window so a window-header row can
      // sit above its panes. A multi-pane window's header pins the whole window
      // (window mode); each pane row still pins that single pane (pane mode).
      const byWindow = new Map();
      for (const pane of bySession.get(session) || []) {
        if (!byWindow.has(pane.windowId)) {
          byWindow.set(pane.windowId, []);
        }
        byWindow.get(pane.windowId).push(pane);
      }

      for (const [windowId, panes] of byWindow) {
        const first = panes[0];
        const winRow = document.createElement("button");
        winRow.className = "picker-window";
        const multi = panes.length > 1;
        winRow.textContent = `${first.windowIndex}:${first.windowName}${multi ? ` — ${panes.length} panes` : ""}`;
        winRow.classList.toggle("selected", viewMode === "window" && pinnedWindow === windowId);
        winRow.addEventListener("click", () => selectWindow(windowId, session));
        el.pickerList.appendChild(winRow);

        for (const pane of panes) {
          const button = document.createElement("button");
          button.className = "picker-pane";
          const title = pane.paneTitle && pane.paneTitle !== pane.windowName ? ` - ${pane.paneTitle}` : "";
          button.textContent = `${pane.active ? "* " : ""}.${pane.paneIndex}${title} (${pane.width}x${pane.height})`;
          button.classList.toggle("selected", viewMode !== "window" && pinned === pane.paneId);
          button.addEventListener("click", () => selectPane(pane));
          el.pickerList.appendChild(button);
        }
      }
    }
    el.picker.hidden = false;
  }

  el.paneLabel.addEventListener("click", openPicker);
  el.mobileMenuToggle.addEventListener("click", toggleMobileMenu);
  el.pickerClose.addEventListener("click", () => { el.picker.hidden = true; });
  el.picker.addEventListener("click", (event) => {
    if (event.target === el.picker) {
      el.picker.hidden = true;
    }
  });
  el.fontMinus.addEventListener("click", () => {
    const current = parseFloat(el.term.style.fontSize) || cfg.fontSizeDefault;
    fontSize = clamp(current - 1, FONT_MIN, FONT_MAX);
    fontMode = "manual";
    localStorage.setItem("airc_font_mode", fontMode);
    localStorage.setItem("airc_font_size", String(fontSize));
    applyFont();
  });
  el.fontPlus.addEventListener("click", () => {
    const current = parseFloat(el.term.style.fontSize) || cfg.fontSizeDefault;
    fontSize = clamp(current + 1, FONT_MIN, FONT_MAX);
    fontMode = "manual";
    localStorage.setItem("airc_font_mode", fontMode);
    localStorage.setItem("airc_font_size", String(fontSize));
    applyFont();
  });
  el.fontFit.addEventListener("click", () => {
    fontMode = "auto";
    localStorage.setItem("airc_font_mode", fontMode);
    applyFont();
  });
  el.controlsToggle.addEventListener("click", () => {
    controlsVisible = !controlsVisible;
    localStorage.setItem("airc_controls_visible", controlsVisible ? "1" : "0");
    applyControlsVisibility();
  });
  el.autoToggle.addEventListener("click", () => {
    setAuto(!auto);
    el.autoToggle.classList.remove("hot");
  });
  el.windowToggle.addEventListener("click", () => {
    setViewMode(viewMode === "window" ? "pane" : "window");
  });
  el.themeToggle.addEventListener("click", () => {
    const next = document.body.classList.contains("theme-day") ? "dark" : "day";
    localStorage.setItem("airc_theme", next);
    applyTheme(next);
  });
  el.pauseToggle.addEventListener("click", () => {
    paused = !paused;
    el.pauseToggle.textContent = paused ? "resume" : "pause";
    el.pauseToggle.classList.toggle("active", paused);
    if (!paused) {
      etag = null;
      interval = cfg.pollMs;
      sendViewState();
    }
    placeCursor();
  });
  el.controlSend.addEventListener("click", sendControlText);
  // Typing is taking over: drop auto from the first character so it can't yank
  // the view — and the half-typed message — to a different pane mid-sentence.
  el.controlText.addEventListener("input", () => {
    if (auto && el.controlText.value) {
      setAuto(false);
    }
  });
  el.controlText.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      sendControlText();
    }
  });
  el.controlLeft.addEventListener("click", () => sendControlKey("Left"));
  el.controlRight.addEventListener("click", () => sendControlKey("Right"));
  el.controlUp.addEventListener("click", () => sendControlKey("Up"));
  el.controlDown.addEventListener("click", () => sendControlKey("Down"));
  el.controlEnter.addEventListener("click", () => sendControlKey("Enter"));
  el.controlCtrl.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleCtrlMenu();
  });
  el.controlCtrlMenu.addEventListener("click", (event) => {
    const key = event.target.closest("button")?.dataset.key;
    if (!key) {
      return;
    }
    sendControlKey(key);
    closeCtrlMenu();
  });
  document.addEventListener("click", (event) => {
    if (!el.controlCtrlMenu.hidden && !event.target.closest("#control-ctrl-wrap")) {
      closeCtrlMenu();
    }
  });
  el.termWrap.addEventListener("scroll", updateScrollFollow, { passive: true });
  window.addEventListener("resize", applyFont);
  window.addEventListener("resize", sendViewState);
  if (mobileMedia.addEventListener) {
    mobileMedia.addEventListener("change", applyMobileView);
  } else {
    mobileMedia.addListener(applyMobileView);
  }

  async function start() {
    applyMobileView();
    applyTheme(localStorage.getItem("airc_theme") || cfg.theme);
    try {
      const response = await fetch("/api/config", { cache: "no-store", headers: headers() });
      if (response.status === 404) {
        el.state.textContent = "unauthorized";
        el.term.textContent = "Not authorized. Reopen a URL that includes ?k=<token>.";
        return;
      }
      cfg = { ...cfg, ...(await response.json()) };
      applyControlsVisibility();
      applyAttentionVisibility();
    } catch {
      // Polling will keep retrying.
    }
    applyTheme(localStorage.getItem("airc_theme") || cfg.theme);
    interval = cfg.pollMs;
    await measureFont();
    applyViewMode();
    applyFont();
    updateStatus();
    setInterval(updateStatus, 15000);
    startWebSocket();
  }

  start();
})();
