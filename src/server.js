#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");

const { ansiToHtml } = require("./ansi");
const { authLevel, authCookie, tokenEquals } = require("./auth");
const { loadConfig, bookmarkUrl, pairingPayload, localLanAddresses } = require("./config");
const { detectPaneState, STATE } = require("./detect");
const { startNgrok } = require("./ngrok");
const tmux = require("./tmux");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const RESIZE_MIN_INTERVAL_MS = 2000;
const INPUT_LIMIT_BYTES = 16 * 1024;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const AUTH_FAIL_LIMIT = 10; // wrong-token tries per window before a temporary block
const AUTH_FAIL_WINDOW_MS = 60 * 1000;
const AUTH_BLOCK_MS = 5 * 60 * 1000;
const WS_PER_IP_LIMIT = 8; // concurrent websockets per client address

// Mask token values before anything reaches the (persistent, possibly
// world-readable) log: the `?k=<token>` query param and the `"token":"<token>"`
// field in a pairing payload. The control token grants shell input, so it must
// never be written to disk in cleartext.
function redactSecrets(message) {
  return String(message)
    .replace(/([?&]k=)[^&\s"]+/g, "$1<redacted>")
    .replace(/("token"\s*:\s*")[^"]+(")/g, "$1<redacted>$2");
}

function log(message) {
  console.log(`${new Date().toISOString()} ${redactSecrets(message)}`);
}

// The build the server is running, resolved once at startup (the "when started"
// version). Mirrors the Android app's `git describe`: a tag when on one, else a
// short hash, gaining `-dirty` for a modified tree. Falls back to package.json
// when run outside a git tree (e.g. an extracted tarball).
const SERVER_VERSION = (() => {
  try {
    return execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim() || `v${require("../package.json").version}`;
  } catch {
    try {
      return `v${require("../package.json").version}`;
    } catch {
      return "unknown";
    }
  }
})();

function send(response, status, contentType, body, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(body);
}

function sendJson(response, status, payload, extraHeaders = {}) {
  send(response, status, "application/json; charset=utf-8", `${JSON.stringify(payload)}\n`, extraHeaders);
}

function notFound(response) {
  send(response, 404, "text/plain; charset=utf-8", "not found\n");
}

function printPairing(payload) {
  const encoded = JSON.stringify(payload);
  try {
    require("qrcode-terminal").generate(encoded, { small: true });
  } catch {
    // QR output is a convenience; the JSON remains the source of truth.
  }
  console.log(JSON.stringify(payload, null, 2));
}

function sendFile(response, fileName, contentType, cacheControl, extraHeaders = {}) {
  fs.readFile(path.join(PUBLIC_DIR, fileName), (error, body) => {
    if (error) {
      notFound(response);
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": body.length,
      "Cache-Control": cacheControl,
      ...extraHeaders,
    });
    response.end(body);
  });
}

function clientAddress(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return request.socket.remoteAddress || "unknown";
}

function readBatteryStatus() {
  const root = "/sys/class/power_supply";
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch {
    return { available: false, batteries: [], summary: "" };
  }
  const batteries = [];
  for (const name of entries) {
    const dir = path.join(root, name);
    let type = "";
    try {
      type = fs.readFileSync(path.join(dir, "type"), "utf8").trim();
    } catch {
      continue;
    }
    if (type !== "Battery") {
      continue;
    }
    let capacity = null;
    let status = "";
    try {
      capacity = Number(fs.readFileSync(path.join(dir, "capacity"), "utf8").trim());
    } catch {
      // Some power supplies may not expose capacity.
    }
    try {
      status = fs.readFileSync(path.join(dir, "status"), "utf8").trim();
    } catch {
      // Status is optional.
    }
    batteries.push({ name, capacity: Number.isFinite(capacity) ? capacity : null, status });
  }
  const primary = batteries.find((item) => item.capacity !== null) || batteries[0];
  const summary = primary
    ? `${primary.capacity !== null ? `${primary.capacity}%` : "battery"}${primary.status ? ` ${primary.status.toLowerCase()}` : ""}`
    : "";
  return { available: batteries.length > 0, batteries, summary };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > INPUT_LIMIT_BYTES) {
        reject(new Error("body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    request.on("error", reject);
  });
}

function websocketAccept(key) {
  return crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

function websocketFrame(payload) {
  const body = Buffer.from(payload);
  if (body.length < 126) {
    return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  }
  if (body.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}

function websocketCloseFrame() {
  return Buffer.from([0x88, 0x00]);
}

function readWebsocketMessages(state, chunk) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  const messages = [];
  while (state.buffer.length >= 2) {
    const second = state.buffer[1];
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (state.buffer.length < offset + 2) break;
      length = state.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (state.buffer.length < offset + 8) break;
      const bigLength = state.buffer.readBigUInt64BE(offset);
      if (bigLength > BigInt(1024 * 1024)) {
        throw new Error("websocket frame too large");
      }
      length = Number(bigLength);
      offset += 8;
    }
    const masked = Boolean(second & 0x80);
    if (!masked) {
      throw new Error("unmasked client frame");
    }
    if (state.buffer.length < offset + 4 + length) break;
    const first = state.buffer[0];
    const opcode = first & 0x0f;
    const mask = state.buffer.subarray(offset, offset + 4);
    offset += 4;
    const encoded = state.buffer.subarray(offset, offset + length);
    const decoded = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) {
      decoded[index] = encoded[index] ^ mask[index % 4];
    }
    state.buffer = state.buffer.subarray(offset + length);
    if (opcode === 0x8) {
      messages.push({ type: "close" });
    } else if (opcode === 0x1) {
      messages.push({ type: "text", text: decoded.toString("utf8") });
    }
  }
  return messages;
}

// Resolve the active pane to follow. Prefer the requested session, then fall
// back to each configured session in order (sessions[0] first) so losing one
// session switches to a surviving one rather than blanking the view. Returns
// null only when no configured session is alive.
async function resolveActivePane(config, requestedSession = "") {
  const candidates = [];
  if (requestedSession) {
    candidates.push(requestedSession);
  }
  for (const session of await tmux.expandSessions(config.sessions)) {
    if (!candidates.includes(session)) {
      candidates.push(session);
    }
  }
  for (const session of candidates) {
    const meta = await tmux.activePane(session);
    if (meta) {
      return meta;
    }
  }
  return null;
}

async function resolveInputTarget(config, payload) {
  if (payload.target === "pane") {
    if (typeof payload.paneId !== "string" || !/^%\d+$/.test(payload.paneId)) {
      return { ok: false, error: "invalid paneId" };
    }
    const meta = await tmux.paneMeta(payload.paneId);
    if (!meta) {
      return { ok: false, error: "pane not found" };
    }
    return { ok: true, target: payload.paneId };
  }
  if (payload.target === undefined || payload.target === "active") {
    const requestedSession = typeof payload.session === "string" ? payload.session : "";
    const meta = await resolveActivePane(config, requestedSession);
    if (!meta) {
      return { ok: false, error: "no tmux session available" };
    }
    return { ok: true, target: meta.paneId };
  }
  return { ok: false, error: "target must be active or pane" };
}

function makeServer(config, ngrokStatus, currentPublicUrl, tlsMaterial = null) {
  const startedAt = Date.now();
  const stats = {
    lastCaptureAt: 0,
    lastInputAt: 0,
    viewers: new Map(),
  };
  const resizeState = { lastCols: 0, lastRows: 0, lastAt: 0 };

  // --- Attention: which panes have an agent that needs interaction ----------
  // A single server-wide scan (not per-connection) captures every candidate
  // pane on an interval, classifies it with the per-agent recognizers, and
  // keeps the result so any client — or the auto mode — can ask "who needs me?"
  // Two sources feed the same map: the screen scan, and agent hooks POSTing to
  // /api/agent/event. A hook is authoritative until a screen read contradicts
  // it, so agents that support hooks get instant, exact signals while everyone
  // else still works zero-config.
  const SHELL_COMMANDS = new Set(["zsh", "bash", "sh", "fish", "-zsh", "-bash", "login", "tmux"]);
  const HOOK_TTL_MS = 15000; // a hook signal stops overriding the screen after this
  const attention = new Map(); // paneId -> { session, windowName, paneIndex, agent, state, since, source, lastHash, hookAt, pendingState, pendingCount }
  let scanning = false;

  function viewerCount() {
    return wsSockets.size;
  }

  // Map a hook `event` onto an attention state. Hooks speak in coarse terms
  // (the agent is waiting / working / done); the screen scan refines from there.
  function hookEventToState(event) {
    if (event === "waiting") return STATE.WAITING;
    if (event === "busy") return STATE.BUSY;
    if (event === "idle") return STATE.IDLE_INPUT;
    return "";
  }

  // Record an agent-reported event. Trusted over the screen for HOOK_TTL_MS so a
  // hook's "waiting" isn't immediately overwritten by a not-yet-rendered screen.
  function recordHookEvent(paneId, event) {
    const state = hookEventToState(event);
    if (!state) {
      return false;
    }
    const now = Date.now();
    const prev = attention.get(paneId);
    const entry = prev || { session: "", windowName: "", paneIndex: 0, agent: "", lastHash: "" };
    if (entry.state !== state) {
      entry.since = now;
    }
    entry.state = state;
    entry.source = "hook";
    entry.hookAt = now;
    entry.pendingState = undefined;
    entry.pendingCount = 0;
    attention.set(paneId, entry);
    return true;
  }

  // Fold one screen classification into the map, with debounce: a new
  // waiting/idle-input state must persist across config.attention.debounceScans
  // scans before it's published, so a mid-render frame can't flash a false
  // "needs you". busy and clearing are applied immediately (they're not urgent
  // and quick clearing is desirable). Returns nothing; mutates `attention`.
  function applyScreenState(pane, detected) {
    const now = Date.now();
    const paneId = pane.paneId;
    const prev = attention.get(paneId);

    // A live hook signal wins until it goes stale.
    if (prev && prev.source === "hook" && now - (prev.hookAt || 0) < HOOK_TTL_MS) {
      // Keep the hook state but refresh the pane's display metadata.
      prev.session = pane.session;
      prev.windowName = pane.windowName;
      prev.paneIndex = pane.paneIndex;
      return;
    }

    const debounce = Math.max(1, config.attention.debounceScans || 1);
    const target = detected.state;
    const needsDebounce = target === STATE.WAITING || target === STATE.IDLE_INPUT;

    const entry = prev || { since: now, state: STATE.NONE, source: "screen", pendingState: undefined, pendingCount: 0 };
    entry.session = pane.session;
    entry.windowName = pane.windowName;
    entry.paneIndex = pane.paneIndex;
    entry.agent = detected.agent || entry.agent || "";
    entry.source = "screen";

    if (target === entry.state) {
      entry.pendingState = undefined;
      entry.pendingCount = 0;
      attention.set(paneId, entry);
      return;
    }

    if (needsDebounce) {
      if (entry.pendingState === target) {
        entry.pendingCount += 1;
      } else {
        entry.pendingState = target;
        entry.pendingCount = 1;
      }
      if (entry.pendingCount >= debounce) {
        entry.state = target;
        entry.since = now;
        entry.pendingState = undefined;
        entry.pendingCount = 0;
      }
    } else {
      // BUSY / NONE apply at once.
      entry.state = target;
      entry.since = now;
      entry.pendingState = undefined;
      entry.pendingCount = 0;
    }
    attention.set(paneId, entry);
  }

  async function scanAttention() {
    if (scanning || !config.attention.enabled || viewerCount() === 0) {
      return;
    }
    scanning = true;
    try {
      const sessions = await tmux.expandSessions(config.sessions);
      const panes = await tmux.listPanesForSessions(sessions);
      const live = new Set();
      const candidates = panes.filter((pane) => !SHELL_COMMANDS.has(pane.command));
      const cap = config.attention.maxPanes || candidates.length;
      if (candidates.length > cap) {
        log(`attention: scanning ${cap} of ${candidates.length} candidate panes (maxPanes)`);
      }
      for (const pane of candidates.slice(0, cap)) {
        live.add(pane.paneId);
        const capture = await tmux.capturePanePlain(pane.paneId);
        if (!capture.ok) {
          continue;
        }
        const detected = detectPaneState({ text: capture.text, command: pane.command });
        applyScreenState(pane, detected);
      }
      // Drop panes that vanished or are no longer candidates (closed/became a shell).
      for (const paneId of [...attention.keys()]) {
        const entry = attention.get(paneId);
        const hookFresh = entry.source === "hook" && Date.now() - (entry.hookAt || 0) < HOOK_TTL_MS;
        if (!live.has(paneId) && !hookFresh) {
          attention.delete(paneId);
        }
      }
    } catch (error) {
      log(`attention scan failed: ${error.message}`);
    } finally {
      scanning = false;
    }
  }

  // Panes worth showing in the HUD, ranked: waiting (urgent) first, then
  // finished/awaiting-input, then busy (actively working). Within a rank,
  // oldest first. busy ranks last so a working agent never buries one that
  // actually needs you; auto-follow ignores it (see autoTarget on the clients).
  function attentionItems() {
    const rank = { [STATE.WAITING]: 0, [STATE.IDLE_INPUT]: 1, [STATE.BUSY]: 2 };
    return [...attention.entries()]
      .filter(([, e]) => e.state === STATE.WAITING || e.state === STATE.IDLE_INPUT || e.state === STATE.BUSY)
      .map(([paneId, e]) => ({
        paneId,
        session: e.session,
        windowName: e.windowName,
        paneIndex: e.paneIndex,
        agent: e.agent,
        state: e.state,
        since: e.since,
        source: e.source,
      }))
      .sort((a, b) => (rank[a.state] - rank[b.state]) || (a.since - b.since));
  }

  // Per-IP brute-force throttle for wrong-token requests, plus a cap on
  // concurrent websockets. Note: clientAddress() ultimately trusts
  // X-Forwarded-For from the fronting proxy (ngrok), so this raises the bar
  // against naive guessing rather than being a hard ceiling against a client
  // that forges the header.
  const authFailures = new Map(); // ip -> { count, first, blockedUntil }
  const wsCounts = new Map(); // ip -> active socket count

  function rateLimited(ip) {
    const entry = authFailures.get(ip);
    return Boolean(entry && entry.blockedUntil && Date.now() < entry.blockedUntil);
  }

  function recordFailedAuth(ip) {
    const now = Date.now();
    let entry = authFailures.get(ip);
    if (!entry || now - entry.first > AUTH_FAIL_WINDOW_MS) {
      entry = { count: 0, first: now, blockedUntil: 0 };
    }
    entry.count += 1;
    if (entry.count >= AUTH_FAIL_LIMIT) {
      entry.blockedUntil = now + AUTH_BLOCK_MS;
      log(`rate-limit: blocking ${ip} for ${AUTH_BLOCK_MS / 1000}s after ${entry.count} failed auth attempts`);
    }
    authFailures.set(ip, entry);
  }

  function clearFailedAuth(ip) {
    authFailures.delete(ip);
  }

  async function captureFrame({ requestedPane = "", requestedSession = "", cols = NaN, rows = NaN, viewerAddress = "" }) {
    let pinValid = true;
    let meta = null;

    if (requestedPane) {
      if (/^%\d+$/.test(requestedPane)) {
        meta = await tmux.paneMeta(requestedPane);
      }
      if (!meta) {
        pinValid = false;
      }
    }
    if (!meta) {
      // A vanished pin falls back to its own session's active pane first.
      meta = await resolveActivePane(config, requestedSession);
    }
    if (!meta) {
      return {
        payload: {
          ok: false,
          error: "no tmux session available",
          serverTime: new Date().toISOString(),
        },
        etag: "",
      };
    }

    if (config.resizeToViewport && !requestedPane) {
      const now = Date.now();
      if (Number.isInteger(cols) && Number.isInteger(rows) &&
          cols >= 20 && cols <= 500 && rows >= 5 && rows <= 200 &&
          (cols !== resizeState.lastCols || rows !== resizeState.lastRows) &&
          now - resizeState.lastAt > RESIZE_MIN_INTERVAL_MS) {
        resizeState.lastCols = cols;
        resizeState.lastRows = rows;
        resizeState.lastAt = now;
        tmux.resizeWindow(meta.windowId, cols, rows).then((ok) => {
          log(`resize-window ${meta.windowId} -> ${cols}x${rows}${ok ? "" : " failed"}`);
        });
      }
    }

    const capture = await tmux.capturePane(meta.paneId);
    if (!capture.ok) {
      return {
        payload: {
          ok: false,
          error: `tmux capture failed: ${capture.error}`,
          serverTime: new Date().toISOString(),
        },
        etag: "",
      };
    }

    stats.lastCaptureAt = Date.now();
    if (viewerAddress) {
      stats.viewers.set(viewerAddress, Date.now());
    }

    const etag = `"${crypto.createHash("sha1")
      .update(`${meta.session}|${meta.paneId}|${meta.width}x${meta.height}|${meta.cursorX},${meta.cursorY}|${pinValid}|`)
      .update(capture.text)
      .digest("hex")}"`;
    return {
      etag,
      payload: {
        ok: true,
        session: meta.session,
        paneId: meta.paneId,
        windowIndex: meta.windowIndex,
        windowName: meta.windowName,
        paneIndex: meta.paneIndex,
        paneTitle: meta.paneTitle,
        cols: meta.width,
        rows: meta.height,
        cursor: { x: meta.cursorX, y: meta.cursorY },
        pinned: Boolean(requestedPane) && pinValid,
        pinValid,
        html: ansiToHtml(capture.text),
        serverTime: new Date().toISOString(),
      },
    };
  }

  async function handleFrame(request, response, url) {
    const frame = await captureFrame({
      requestedPane: url.searchParams.get("pane") || "",
      requestedSession: url.searchParams.get("session") || "",
      cols: Number(url.searchParams.get("cols")),
      rows: Number(url.searchParams.get("rows")),
      viewerAddress: clientAddress(request),
    });
    const etag = frame.etag;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { ETag: etag, "Cache-Control": "no-store" });
      response.end();
      return;
    }

    sendJson(response, 200, frame.payload, etag ? { ETag: etag } : {});
  }

  async function handleInput(request, response) {
    let payload;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
      return;
    }

    const target = await resolveInputTarget(config, payload);
    if (!target.ok) {
      sendJson(response, 400, target);
      return;
    }

    let result;
    if (typeof payload.text === "string" && payload.text.length > 0) {
      result = await tmux.sendText(target.target, payload.text);
    } else if (typeof payload.key === "string") {
      result = await tmux.sendKey(target.target, payload.key);
    } else {
      sendJson(response, 400, { ok: false, error: "text or key is required" });
      return;
    }

    if (!result.ok) {
      sendJson(response, 500, result);
      return;
    }
    stats.lastInputAt = Date.now();
    sendJson(response, 200, { ok: true, target: target.target });
  }

  async function handleAgentEvent(request, response) {
    let payload;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
      return;
    }
    const paneId = typeof payload.paneId === "string" ? payload.paneId : "";
    if (!/^%\d+$/.test(paneId)) {
      sendJson(response, 400, { ok: false, error: "invalid paneId" });
      return;
    }
    if (!recordHookEvent(paneId, payload.event)) {
      sendJson(response, 400, { ok: false, error: "event must be waiting, busy, or idle" });
      return;
    }
    // Best-effort label so the HUD names the pane right away rather than waiting
    // for the next scan to fill session/window in.
    const meta = await tmux.paneMeta(paneId);
    const entry = attention.get(paneId);
    if (meta && entry) {
      entry.session = meta.session;
      entry.windowName = meta.windowName;
      entry.paneIndex = meta.paneIndex;
    }
    sendJson(response, 200, { ok: true, paneId, state: attention.get(paneId).state });
  }

  async function handleHealthz(response) {
    const now = Date.now();
    for (const [address, ts] of stats.viewers) {
      if (now - ts > 60000) {
        stats.viewers.delete(address);
      }
    }
    const liveSessions = (await Promise.all(
      (await tmux.expandSessions(config.sessions)).map(
        async (session) => (await tmux.sessionExists(session) ? session : null),
      ),
    )).filter(Boolean);
    const tmuxOk = liveSessions.length > 0;
    const ngrok = config.ngrok.enabled
      ? ngrokStatus()
      : { running: false, url: "", uptimeMs: 0, restarts: 0, lastError: "disabled" };
    sendJson(response, 200, {
      ok: tmuxOk && (!config.ngrok.enabled || (ngrok.running && ngrok.url !== "")),
      session: config.session,
      sessions: config.sessions,
      liveSessions,
      tmuxOk,
      lastCaptureAgeMs: stats.lastCaptureAt === 0 ? null : now - stats.lastCaptureAt,
      lastInputAgeMs: stats.lastInputAt === 0 ? null : now - stats.lastInputAt,
      viewersLastMin: stats.viewers.size,
      ngrok,
      uptimeMs: now - startedAt,
    });
  }

  function statusPayload() {
    const ngrok = config.ngrok.enabled
      ? ngrokStatus()
      : { running: false, url: "", uptimeMs: 0, restarts: 0, lastError: "disabled" };
    return {
      serverTime: new Date().toISOString(),
      serverVersion: SERVER_VERSION,
      publicUrl: currentPublicUrl() || ngrok.url || "",
      ngrok: {
        enabled: Boolean(config.ngrok.enabled),
        ...ngrok,
      },
      battery: readBatteryStatus(),
    };
  }

  function handleRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    log(`${clientAddress(request)} ${request.method} ${url.pathname}`);

    // Defense-in-depth headers on every response. `style-src 'unsafe-inline'`
    // is required because captured truecolor spans carry inline `style=` color
    // (no script can run from a style attribute). The diagnostic probe page is
    // the only page with an inline <script>, so it gets a narrowly relaxed CSP.
    const scriptSrc = url.pathname === "/probe" ? "'self' 'unsafe-inline'" : "'self'";
    response.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    );
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (request.headers["x-forwarded-proto"] === "https") {
      response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }

    if (url.pathname === "/fonts/FiraCode-Regular.ttf") {
      sendFile(response, "fonts/FiraCode-Regular.ttf", "font/ttf", "public, max-age=31536000, immutable");
      return;
    }
    if (url.pathname === "/app.css") {
      sendFile(response, "app.css", "text/css; charset=utf-8", "no-store");
      return;
    }
    if (url.pathname === "/app.js") {
      sendFile(response, "app.js", "text/javascript; charset=utf-8", "no-store");
      return;
    }
    if (url.pathname === "/favicon.ico") {
      sendFile(response, "favicon.ico", "image/x-icon", "public, max-age=31536000, immutable");
      return;
    }
    if (url.pathname === "/site.webmanifest") {
      sendFile(response, "site.webmanifest", "application/manifest+json; charset=utf-8", "no-store");
      return;
    }
    if (url.pathname === "/icons/favicon-16x16.png") {
      sendFile(response, "icons/favicon-16x16.png", "image/png", "public, max-age=31536000, immutable");
      return;
    }
    if (url.pathname === "/icons/favicon-32x32.png") {
      sendFile(response, "icons/favicon-32x32.png", "image/png", "public, max-age=31536000, immutable");
      return;
    }
    if (url.pathname === "/icons/apple-touch-icon.png") {
      sendFile(response, "icons/apple-touch-icon.png", "image/png", "public, max-age=31536000, immutable");
      return;
    }
    if (url.pathname === "/icons/icon-192.png") {
      sendFile(response, "icons/icon-192.png", "image/png", "public, max-age=31536000, immutable");
      return;
    }
    if (url.pathname === "/icons/icon-512.png") {
      sendFile(response, "icons/icon-512.png", "image/png", "public, max-age=31536000, immutable");
      return;
    }

    const auth = authLevel(request, url, config);
    const authorized = auth.level !== "none";
    const canControl = auth.level === "control";
    const ip = clientAddress(request);

    // A wrong token from a throttled address is dropped before any work.
    if (!authorized && auth.presented && rateLimited(ip)) {
      notFound(response);
      return;
    }
    if (!authorized && auth.presented) {
      recordFailedAuth(ip);
    } else if (authorized) {
      clearFailedAuth(ip);
    }

    // /healthz now requires a token like every other endpoint; the local CLI
    // authenticates its probe with the control token. This removes the previous
    // reliance on the (proxy-spoofable) "no X-Forwarded-For + loopback peer"
    // signal as an auth bypass.
    if (url.pathname === "/healthz") {
      if (!authorized) {
        notFound(response);
        return;
      }
      handleHealthz(response);
      return;
    }

    if (!authorized) {
      notFound(response);
      return;
    }

    const extraHeaders = {};
    if (auth.token && tokenEquals(url.searchParams.get("k") || "", auth.token)) {
      extraHeaders["Set-Cookie"] = authCookie(auth.token);
    }

    if ((url.pathname === "/" || url.pathname === "/index.html") && request.method === "GET") {
      sendFile(response, "index.html", "text/html; charset=utf-8", "no-store", extraHeaders);
      return;
    }
    if (url.pathname === "/probe" && request.method === "GET") {
      sendFile(response, "probe.html", "text/html; charset=utf-8", "no-store", extraHeaders);
      return;
    }
    if (url.pathname === "/api/config" && request.method === "GET") {
      sendJson(response, 200, {
        productName: config.productName,
        session: config.session,
        sessions: config.sessions,
        pollMs: config.pollMs,
        pollIdleMaxMs: config.pollIdleMaxMs,
        fontSizeDefault: config.fontSizeDefault,
        theme: config.theme,
        resizeToViewport: config.resizeToViewport,
        attentionEnabled: Boolean(config.attention.enabled),
        canControl,
        authLevel: auth.level,
        publicUrl: currentPublicUrl() || "",
        lanUrls: localLanAddresses(config.port),
      }, extraHeaders);
      return;
    }
    if (url.pathname === "/api/status" && request.method === "GET") {
      sendJson(response, 200, statusPayload(), extraHeaders);
      return;
    }
    if (url.pathname === "/api/pairing" && request.method === "GET") {
      if (!canControl) {
        notFound(response);
        return;
      }
      sendJson(response, 200, pairingPayload(config, currentPublicUrl() || "", tlsMaterial), extraHeaders);
      return;
    }
    if (url.pathname === "/api/tmux/frame" && request.method === "GET") {
      handleFrame(request, response, url);
      return;
    }
    if (url.pathname === "/api/tmux/panes" && request.method === "GET") {
      // Return the expanded session names (not the raw `foo*` patterns) so the
      // client can order picker headers by configured precedence.
      tmux.expandSessions(config.sessions).then((sessions) =>
        tmux.listPanesForSessions(sessions).then((panes) => {
          sendJson(response, 200, { ok: panes.length > 0, sessions, panes });
        }),
      );
      return;
    }
    if (url.pathname === "/api/tmux/input" && request.method === "POST") {
      if (!canControl) {
        notFound(response);
        return;
      }
      handleInput(request, response);
      return;
    }
    if (url.pathname === "/api/attention" && request.method === "GET") {
      // View-level: seeing which panes need attention reveals no pane contents,
      // and auto mode must work for view-only clients. The poll fallback path
      // (no websocket) reads this.
      sendJson(response, 200, { ok: true, items: attentionItems() }, extraHeaders);
      return;
    }
    if (url.pathname === "/api/agent/event" && request.method === "POST") {
      // Agent hooks (Claude Code Notification/Stop, Codex notify) POST here.
      // Control-gated: a hook can steer auto mode and the HUD, same trust level
      // as sending input. The local CLI passes the control token.
      if (!canControl) {
        notFound(response);
        return;
      }
      handleAgentEvent(request, response);
      return;
    }
    if (url.pathname === "/api/probe/poll" && request.method === "GET") {
      sendJson(response, 200, {
        server_time: new Date().toISOString(),
        client_address: clientAddress(request),
        event_number: Number(url.searchParams.get("event")) || 0,
      });
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
      send(response, 405, "text/plain; charset=utf-8", "method not allowed\n");
      return;
    }
    notFound(response);
  }
  const wsSockets = new Set();

  // One server-wide attention scan loop. It self-gates on viewerCount() so an
  // idle server (no clients connected) issues zero tmux calls; unref() lets the
  // process exit without waiting on it.
  if (config.attention.enabled) {
    setInterval(scanAttention, config.attention.scanMs).unref();
  }

  function rejectUpgrade(socket, status = 404) {
    socket.write(`HTTP/1.1 ${status} ${status === 404 ? "Not Found" : "Bad Request"}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  function handleUpgrade(request, socket) {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname !== "/api/tmux/ws") {
      rejectUpgrade(socket);
      return;
    }
    const ip = clientAddress(request);
    const auth = authLevel(request, url, config);
    if (auth.level === "none") {
      if (auth.presented && !rateLimited(ip)) {
        recordFailedAuth(ip);
      }
      rejectUpgrade(socket);
      return;
    }
    clearFailedAuth(ip);
    if ((wsCounts.get(ip) || 0) >= WS_PER_IP_LIMIT) {
      log(`ws-limit: rejecting upgrade from ${ip} (>= ${WS_PER_IP_LIMIT} open)`);
      rejectUpgrade(socket, 400);
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (!key) {
      rejectUpgrade(socket, 400);
      return;
    }
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
      "\r\n",
    ].join("\r\n"));
    wsSockets.add(socket);
    wsCounts.set(ip, (wsCounts.get(ip) || 0) + 1);

    const wsState = {
      buffer: Buffer.alloc(0),
      pane: "",
      session: "",
      cols: NaN,
      rows: NaN,
      etag: "",
      closed: false,
      sending: false,
      // Hold off on capturing until the client's first `view` message tells us
      // which pane to show. Otherwise a pinned viewer briefly sees the active
      // pane on every (re)connect before the pin arrives.
      viewReady: false,
      attentionJson: "",
    };

    function send(payload) {
      if (!wsState.closed && socket.writable) {
        socket.write(websocketFrame(JSON.stringify(payload)));
      }
    }

    // Push the current attention list when it differs from what this socket
    // last saw. Cheap: reads the already-computed map, no tmux work here.
    function sendAttention(force = false) {
      if (wsState.closed || !config.attention.enabled) {
        return;
      }
      const items = attentionItems();
      const json = JSON.stringify(items);
      if (!force && json === wsState.attentionJson) {
        return;
      }
      wsState.attentionJson = json;
      send({ type: "attention", items });
    }

    async function sendFrame(force = false) {
      if (wsState.closed || wsState.sending || !wsState.viewReady) {
        return;
      }
      wsState.sending = true;
      try {
        const frame = await captureFrame({
          requestedPane: wsState.pane,
          requestedSession: wsState.session,
          cols: wsState.cols,
          rows: wsState.rows,
          viewerAddress: clientAddress(request),
        });
        if (force || !frame.etag || frame.etag !== wsState.etag) {
          wsState.etag = frame.etag;
          send({ type: "frame", frame: frame.payload });
        } else {
          send({ type: "heartbeat", serverTime: new Date().toISOString() });
        }
        sendAttention();
      } catch (error) {
        send({ type: "error", error: error.message });
      } finally {
        wsState.sending = false;
      }
    }

    const timer = setInterval(() => sendFrame(false), config.pollMs);
    send({ type: "hello", canControl: auth.level === "control", serverVersion: SERVER_VERSION });
    // First frame is deferred until the client sends its `view` state, so we
    // never flash the active pane before a pin is known.

    socket.on("data", (chunk) => {
      let messages;
      try {
        messages = readWebsocketMessages(wsState, chunk);
      } catch {
        socket.end(websocketCloseFrame());
        return;
      }
      for (const message of messages) {
        if (message.type === "close") {
          socket.end(websocketCloseFrame());
          return;
        }
        if (message.type !== "text") {
          continue;
        }
        try {
          const payload = JSON.parse(message.text);
          if (payload.type === "view") {
            wsState.pane = typeof payload.pane === "string" && /^%\d+$/.test(payload.pane) ? payload.pane : "";
            wsState.session = typeof payload.session === "string" ? payload.session : "";
            wsState.cols = Number(payload.cols);
            wsState.rows = Number(payload.rows);
            wsState.etag = "";
            wsState.viewReady = true;
            sendFrame(true);
          }
        } catch {
          // Ignore malformed client state; the next good state wins.
        }
      }
    });

    let cleaned = false;
    function cleanup() {
      if (cleaned) {
        return;
      }
      cleaned = true;
      wsState.closed = true;
      wsSockets.delete(socket);
      clearInterval(timer);
      const remaining = (wsCounts.get(ip) || 1) - 1;
      if (remaining <= 0) {
        wsCounts.delete(ip);
      } else {
        wsCounts.set(ip, remaining);
      }
    }
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  }

  // Browsers keep the plain HTTP listener (they can't accept the self-signed
  // cert). The app gets an HTTPS listener on config.tls.port when cert material
  // is available; both share the identical request and upgrade handlers. By the
  // time `upgrade` fires, Node has already terminated TLS, so the hand-rolled
  // WS handshake operates on a plaintext socket exactly as over HTTP.
  const httpServer = http.createServer(handleRequest);
  httpServer.on("upgrade", handleUpgrade);
  const tlsServer = tlsMaterial
    ? https.createServer({ key: tlsMaterial.key, cert: tlsMaterial.cert }, handleRequest)
    : null;
  if (tlsServer) {
    tlsServer.on("upgrade", handleUpgrade);
  }

  // Lifecycle facade so main() drives both listeners through one object.
  return {
    listen(port, host, callback) {
      httpServer.listen(port, host, callback);
      if (tlsServer) {
        tlsServer.listen(config.tls.port, host, () => {
          log(`airc tmux remote TLS listening on https://${host}:${config.tls.port}`);
        });
        // A TLS bind clash (e.g. port already in use) must not take down the
        // working HTTP/browser path — log and keep serving HTTP only.
        tlsServer.on("error", (error) => {
          log(`WARNING: TLS listener error, serving HTTP only: ${error.message}`);
        });
      }
    },
    on(event, listener) {
      httpServer.on(event, listener);
    },
    closeWebSockets() {
      for (const socket of wsSockets) {
        socket.destroy();
      }
      wsSockets.clear();
    },
    close(callback) {
      if (tlsServer) {
        tlsServer.close();
      }
      httpServer.close(callback);
    },
    closeIdleConnections() {
      httpServer.closeIdleConnections();
      if (tlsServer) {
        tlsServer.closeIdleConnections();
      }
    },
  };
}

function printHelp() {
  console.log(`Usage: node src/server.js [options]

Mirror and control tmux sessions from Android.

Options:
  --session NAME   tmux session to follow; repeat for multiple (default from config.json)
  --host HOST      address to bind (use 0.0.0.0 for same-WLAN phones)
  --port PORT      port to listen on
  --config PATH    config file (default <repo>/config.json)
  --no-ngrok       do not start ngrok
  --no-tls         do not serve HTTPS / generate a self-signed cert (HTTP only)
  --print-url      print the browser URL with token and exit
  --pair           print Android pairing JSON and exit
`);
}

function main() {
  let loaded;
  try {
    loaded = loadConfig(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const { config, flags, warnings, tls } = loaded;
  for (const warning of warnings || []) {
    log(`WARNING: ${warning}`);
  }

  if (flags.help) {
    printHelp();
    return;
  }
  if (flags.printUrl) {
    console.log(bookmarkUrl(config, "view"));
    return;
  }
  if (flags.pair) {
    printPairing(pairingPayload(config, "", tls));
    return;
  }

  let ngrok = null;
  let publicUrl = "";
  const ngrokStatus = () => (ngrok ? ngrok.status() : { running: false, url: "", uptimeMs: 0, restarts: 0, lastError: "" });
  const server = makeServer(config, ngrokStatus, () => publicUrl, tls);

  server.listen(config.port, config.host, () => {
    log(`airc tmux remote listening on http://${config.host}:${config.port} (sessions: ${config.sessions.join(", ")})`);
    if (config.ngrok.enabled) {
      ngrok = startNgrok({ ...config.ngrok, port: config.port }, log, (url) => {
        publicUrl = url;
        log(`bookmark: ${bookmarkUrl(config, "view", publicUrl)}`);
        log(`pairing: ${JSON.stringify(pairingPayload(config, publicUrl, tls))}`);
      });
    } else {
      log(`bookmark: ${bookmarkUrl(config, "view")}`);
      log(`pairing: ${JSON.stringify(pairingPayload(config, "", tls))}`);
    }
  });

  server.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log(`${signal}: shutting down`);
    if (ngrok) {
      ngrok.stop();
    }
    server.closeWebSockets();
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (require.main === module) {
  main();
}

module.exports = { makeServer };
