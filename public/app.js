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
    alerts: document.getElementById("alerts"),
    autoToggle: document.getElementById("auto-toggle"),
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
            renderFrame(payload.frame);
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
    renderFrame(await response.json());
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
    el.state.textContent = changeAge > 10000 ? `idle ${Math.round(changeAge / 1000)}s` : "live";
  }, 500);

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

  // The pane auto mode should follow: the most urgent (waiting before
  // idle-input, then oldest) flagged pane. The server already sorts the list
  // that way, so the head is the target. Returns undefined when nothing needs
  // attention — auto is then "sticky" and holds the current view.
  function autoTarget() {
    // Follow panes that need a human (waiting first, then finished). A merely
    // busy pane is shown as a chip but never auto-followed — chasing whatever
    // is working would make the view jumpy.
    return attentionList.find((item) => item.state !== "busy");
  }

  function applyAuto() {
    if (!auto) {
      return;
    }
    const target = autoTarget();
    el.autoToggle.classList.toggle("armed", Boolean(target));
    if (target && target.paneId !== pinned) {
      applyPin(target);
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
      chip.addEventListener("click", () => selectPane(item));
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
      const followingThis = pinned === "" &&
        (followSession ? followSession === session : currentSession === session);
      header.classList.toggle("selected", followingThis);
      header.addEventListener("click", () => selectFollow(session));
      el.pickerList.appendChild(header);

      for (const pane of bySession.get(session) || []) {
        const button = document.createElement("button");
        button.className = "picker-pane";
        const title = pane.paneTitle && pane.paneTitle !== pane.windowName ? ` - ${pane.paneTitle}` : "";
        button.textContent = `${pane.active ? "* " : ""}${pane.windowIndex}:${pane.windowName}.${pane.paneIndex}${title} (${pane.width}x${pane.height})`;
        button.classList.toggle("selected", pinned === pane.paneId);
        button.addEventListener("click", () => selectPane(pane));
        el.pickerList.appendChild(button);
      }
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
  el.autoToggle.addEventListener("click", () => {
    setAuto(!auto);
    el.autoToggle.classList.remove("hot");
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
      applyAttentionVisibility();
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
