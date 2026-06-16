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
    paneLabel: document.getElementById("pane-label"),
    fontMinus: document.getElementById("font-minus"),
    fontPlus: document.getElementById("font-plus"),
    fontFit: document.getElementById("font-fit"),
    themeToggle: document.getElementById("theme-toggle"),
    pauseToggle: document.getElementById("pause-toggle"),
    termWrap: document.getElementById("term-wrap"),
    term: document.getElementById("term"),
    cursor: document.getElementById("cursor"),
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
  const headers = () => (token ? { "X-Airc-Auth": token } : {});

  let cfg = { pollMs: 700, pollIdleMaxMs: 2500, fontSizeDefault: 13, theme: "dark", resizeToViewport: false };
  let etag = null;
  let interval = cfg.pollMs;
  let misses = 0;
  let paused = false;
  let pinned = localStorage.getItem("airc_pin") || "";
  let fontMode = localStorage.getItem("airc_font_mode") || "auto";
  let fontSize = Number(localStorage.getItem("airc_font_size")) || 13;
  let chRatio = 0.6;
  let lastCols = 0;
  let lastRows = 0;
  let lastCursor = null;
  let lastOkAt = 0;
  let lastChangeAt = 0;

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
  }

  function fitCells() {
    const size = fontMode === "manual" ? fontSize : cfg.fontSizeDefault;
    const area = availArea();
    return {
      cols: Math.max(20, Math.floor(area.w / (size * chRatio))),
      rows: Math.max(5, Math.floor(area.h / (size * LINE_HEIGHT))),
    };
  }

  async function tick() {
    const query = new URLSearchParams();
    if (pinned) {
      query.set("pane", pinned);
    } else if (cfg.resizeToViewport) {
      const cells = fitCells();
      query.set("cols", String(cells.cols));
      query.set("rows", String(cells.rows));
    }
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
    const frame = await response.json();
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
    }
    placeCursor();
  });
  window.addEventListener("resize", applyFont);

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
    } catch {
      // Polling will keep retrying.
    }
    applyTheme(localStorage.getItem("airc_theme") || cfg.theme);
    interval = cfg.pollMs;
    await measureFont();
    applyFont();
    loop();
  }

  start();
})();
