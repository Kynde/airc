"use strict";

(() => {
  const LINE_HEIGHT = 1.25;
  const PAD = 8;
  const FONT_MIN = 7;
  const FONT_MAX = 24;
  const el = {
    dot: document.getElementById("dot"),
    state: document.getElementById("state"),
    note: document.getElementById("note"),
    dashboard: document.getElementById("dashboard"),
    paneLabel: document.getElementById("pane-label"),
    fontMinus: document.getElementById("font-minus"),
    fontPlus: document.getElementById("font-plus"),
    fontFit: document.getElementById("font-fit"),
    controlsToggle: document.getElementById("controls-toggle"),
    themeToggle: document.getElementById("theme-toggle"),
    pauseToggle: document.getElementById("pause-toggle"),
    termWrap: document.getElementById("term-wrap"),
    term: document.getElementById("term"),
    cursor: document.getElementById("cursor"),
    controlBar: document.getElementById("control-bar"),
    controlText: document.getElementById("control-text"),
    controlSend: document.getElementById("control-send"),
    controlUp: document.getElementById("control-up"),
    controlDown: document.getElementById("control-down"),
    controlEnter: document.getElementById("control-enter"),
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

  function applyTheme(theme) {
    document.body.className = theme === "day" ? "theme-day" : "theme-dark";
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

  function applyFont() {
    let size;
    if (fontMode === "manual" || cfg.resizeToViewport) {
      size = fontMode === "manual" ? fontSize : cfg.fontSizeDefault;
    } else if (lastCols > 0 && lastRows > 0) {
      const area = availArea();
      size = clamp(Math.min(area.w / (lastCols * chRatio), area.h / (lastRows * LINE_HEIGHT)), FONT_MIN, FONT_MAX);
      size = Math.floor(size * 2) / 2;
    } else {
      size = cfg.fontSizeDefault;
    }
    el.term.style.fontSize = `${size}px`;
    el.fontFit.classList.toggle("active", fontMode === "auto" && !cfg.resizeToViewport);
    placeCursor();
    applyScrollFollow();
  }

  function applyControlsVisibility() {
    const visible = cfg.canControl && controlsVisible;
    el.controlsToggle.hidden = !cfg.canControl;
    el.controlsToggle.classList.toggle("active", visible);
    el.controlsToggle.textContent = visible ? "ctrl on" : "ctrl";
    el.controlBar.hidden = !visible;
    applyFont();
  }

  function viewedTarget() {
    return pinned ? { target: "pane", paneId: pinned } : { target: "active" };
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
    el.dashboard.innerHTML = parts.join(" · ");
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
      sendViewState();
    }
    el.term.innerHTML = frame.html;
    lastCursor = frame.cursor;
    lastChangeAt = Date.now();
    el.paneLabel.textContent = `${frame.pinned ? "pin " : ""}${frame.windowName}:${frame.paneIndex}`;
    if (frame.cols !== lastCols || frame.rows !== lastRows) {
      lastCols = frame.cols;
      lastRows = frame.rows;
      applyFont();
    } else {
      placeCursor();
    }
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
    const cells = cfg.resizeToViewport && !pinned ? fitCells() : {};
    ws.send(JSON.stringify({
      type: "view",
      pane: pinned,
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
            renderFrame(payload.frame);
          }
        } else if (payload.type === "heartbeat") {
          lastOkAt = Date.now();
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
    renderFrame(await response.json());
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
    el.state.textContent = changeAge > 10000 ? `idle ${Math.round(changeAge / 1000)}s` : "live";
  }, 500);

  async function openPicker() {
    const response = await fetch("/api/tmux/panes", { cache: "no-store", headers: headers() });
    const payload = await response.json();
    el.pickerList.replaceChildren();
    const follow = document.createElement("button");
    follow.textContent = "Follow active pane";
    follow.classList.toggle("selected", pinned === "");
    follow.addEventListener("click", () => {
      pinned = "";
      localStorage.removeItem("airc_pin");
      etag = null;
      sendViewState();
      el.picker.hidden = true;
    });
    el.pickerList.appendChild(follow);
    for (const pane of payload.panes || []) {
      const button = document.createElement("button");
      const title = pane.paneTitle && pane.paneTitle !== pane.windowName ? ` - ${pane.paneTitle}` : "";
      button.textContent = `${pane.active ? "* " : ""}${pane.windowIndex}:${pane.windowName}.${pane.paneIndex}${title} (${pane.width}x${pane.height})`;
      button.classList.toggle("selected", pinned === pane.paneId);
      button.addEventListener("click", () => {
        pinned = pane.paneId;
        localStorage.setItem("airc_pin", pinned);
        etag = null;
        sendViewState();
        el.picker.hidden = true;
      });
      el.pickerList.appendChild(button);
    }
    el.picker.hidden = false;
  }

  el.paneLabel.addEventListener("click", openPicker);
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
  el.controlText.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      sendControlText();
    }
  });
  el.controlUp.addEventListener("click", () => sendControlKey("Up"));
  el.controlDown.addEventListener("click", () => sendControlKey("Down"));
  el.controlEnter.addEventListener("click", () => sendControlKey("Enter"));
  el.termWrap.addEventListener("scroll", updateScrollFollow, { passive: true });
  window.addEventListener("resize", applyFont);
  window.addEventListener("resize", sendViewState);

  async function start() {
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
    } catch {
      // Polling will keep retrying.
    }
    applyTheme(localStorage.getItem("airc_theme") || cfg.theme);
    interval = cfg.pollMs;
    await measureFont();
    applyFont();
    updateStatus();
    setInterval(updateStatus, 15000);
    startWebSocket();
  }

  start();
})();
