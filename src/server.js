#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { Readable } = require("node:stream");

const { ansiToHtml } = require("./ansi");
const { loadConfig, bookmarkUrl, pairingPayload, localLanAddresses, advertisedUrl, tunnelUrl } = require("./config");
const dais = require("./dais");
const { createE2e, HANDSHAKE_LIMIT_BYTES } = require("./e2e");
const { detectPaneState, STATE } = require("./detect");
const { startNgrok } = require("./ngrok");
const tmux = require("./tmux");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const IMMUTABLE = "public, max-age=31536000, immutable";

// Public static assets served pre-auth, keyed by request path:
// [file within PUBLIC_DIR, Content-Type, Cache-Control].
const STATIC_ASSETS = {
  "/fonts/FiraCode-Regular.ttf": ["fonts/FiraCode-Regular.ttf", "font/ttf", IMMUTABLE],
  "/app.css": ["app.css", "text/css; charset=utf-8", "no-store"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8", "no-store"],
  "/airc-noise.js": ["airc-noise.js", "text/javascript; charset=utf-8", "no-store"],
  "/airc-crypto.js": ["airc-crypto.js", "text/javascript; charset=utf-8", "no-store"],
  "/favicon.ico": ["favicon.ico", "image/x-icon", IMMUTABLE],
  "/site.webmanifest": ["site.webmanifest", "application/manifest+json; charset=utf-8", "no-store"],
  "/icons/favicon-16x16.png": ["icons/favicon-16x16.png", "image/png", IMMUTABLE],
  "/icons/favicon-32x32.png": ["icons/favicon-32x32.png", "image/png", IMMUTABLE],
  "/icons/apple-touch-icon.png": ["icons/apple-touch-icon.png", "image/png", IMMUTABLE],
  "/icons/icon-192.png": ["icons/icon-192.png", "image/png", IMMUTABLE],
  "/icons/icon-512.png": ["icons/icon-512.png", "image/png", IMMUTABLE],
};

const RESIZE_MIN_INTERVAL_MS = 2000;
const INPUT_LIMIT_BYTES = 16 * 1024;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const AUTH_FAIL_LIMIT = 10; // wrong-token tries per window before a temporary block
const AUTH_FAIL_WINDOW_MS = 60 * 1000;
const AUTH_BLOCK_MS = 5 * 60 * 1000;
const AUTH_FAIL_MAX_ENTRIES = 1024; // distinct addresses tracked at once
const WS_PER_IP_LIMIT = 8; // concurrent websockets per client address
// An encrypted request carries at most an INPUT_LIMIT_BYTES body, JSON-quoted
// inside the envelope; leave room for that escaping and the framing.
const E2E_ENVELOPE_LIMIT = 8 * INPUT_LIMIT_BYTES;
const E2E_WS_HANDSHAKE_MS = 10 * 1000; // an encrypted socket must handshake within this

// Mask token values before anything reaches the (persistent, possibly
// world-readable) log: the `#k=<token>` of a bookmark link (and a legacy
// `?k=`), and the `"token":"<token>"` field in a pairing payload. The control token grants shell input, so it must
// never be written to disk in cleartext.
function redactSecrets(message) {
  return String(message)
    .replace(/([?&#]k=)[^&\s"]+/g, "$1<redacted>")
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

// Only the path and query are ever read, so parse against a fixed base rather
// than the client's Host header: a malformed Host (e.g. "[") or request target
// would otherwise throw inside the listener and take the process down before
// authentication. Returns null for anything unparseable.
function parseRequestUrl(request) {
  try {
    return new URL(request.url, "http://localhost");
  } catch {
    return null;
  }
}

// The address the TCP connection actually came from. The failed-auth throttle
// and websocket cap key on this, never on X-Forwarded-For, which any client can
// set and which not every tunnel overwrites. Behind a tunnel this makes all its
// traffic one bucket, which is safe: a block only ever drops WRONG tokens, and
// the websocket cap counts only authenticated sockets.
function peerAddress(request) {
  return request.socket.remoteAddress || "unknown";
}

// For display only (logs, the viewers list): the forwarded client address when
// a proxy supplied one. Unverified, so it must not drive any limit.
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

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
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

// Every message on the (encrypted) socket is a binary frame. No
// permessage-deflate: ciphertext doesn't compress, so it's never negotiated.
function websocketFrame(payload) {
  const body = Buffer.from(payload);
  const first = 0x82; // FIN + binary
  if (body.length < 126) {
    return Buffer.concat([Buffer.from([first, body.length]), body]);
  }
  if (body.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.alloc(10);
  header[0] = first;
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
    if (first & 0x70) {
      throw new Error("reserved bits set (no extension is negotiated)");
    }
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
    } else if (opcode === 0x2) {
      messages.push({ type: "binary", data: decoded });
    } else if (opcode === 0x1) {
      messages.push({ type: "text" }); // never valid here; fails a handshake, ignored after
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
  const resizeState = { cols: 0, rows: 0, at: 0 };
  // Window-mode resize is throttled per window id (the grid the viewer fills),
  // separate from the single-pane active-view throttle above.
  const windowResize = new Map(); // windowId -> { cols, rows, at }

  // Reshape a window to the viewer's grid, throttled: only when the request is a
  // sane size, actually differs from `last`, and at least RESIZE_MIN_INTERVAL_MS
  // has passed. `last` is mutated in place. Fire-and-forget — the next frame
  // reflects the new size; a failure is only logged.
  function maybeResizeWindow(windowId, cols, rows, last) {
    const now = Date.now();
    if (Number.isInteger(cols) && Number.isInteger(rows) &&
        cols >= 20 && cols <= 500 && rows >= 5 && rows <= 200 &&
        (cols !== last.cols || rows !== last.rows) &&
        now - last.at > RESIZE_MIN_INTERVAL_MS) {
      last.cols = cols;
      last.rows = rows;
      last.at = now;
      tmux.resizeWindow(windowId, cols, rows).then((ok) => {
        log(`resize-window ${windowId} -> ${cols}x${rows}${ok ? "" : " failed"}`);
      });
    }
  }

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
  const attention = new Map(); // paneId -> { session, windowName, paneIndex, agent, state, since, source, hookAt, pendingState, pendingCount }
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
    const entry = prev || { session: "", windowName: "", windowId: "", paneIndex: 0, agent: "" };
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
    entry.windowId = pane.windowId;
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
        windowId: e.windowId || "",
        windowName: e.windowName,
        paneIndex: e.paneIndex,
        agent: e.agent,
        state: e.state,
        since: e.since,
        source: e.source,
      }))
      .sort((a, b) => (rank[a.state] - rank[b.state]) || (a.since - b.since));
  }

  // Per-address brute-force throttle for wrong-token requests, plus a cap on
  // concurrent websockets, both keyed on peerAddress(). authFailures is bounded:
  // expired entries are swept once it grows, and past AUTH_FAIL_MAX_ENTRIES the
  // oldest go first, so a stream of distinct addresses can't grow it forever.
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
    if (!authFailures.has(ip) && authFailures.size >= AUTH_FAIL_MAX_ENTRIES) {
      pruneAuthFailures(now);
    }
    if (entry.count >= AUTH_FAIL_LIMIT) {
      entry.blockedUntil = now + AUTH_BLOCK_MS;
      log(`rate-limit: blocking ${ip} for ${AUTH_BLOCK_MS / 1000}s after ${entry.count} failed auth attempts`);
    }
    authFailures.set(ip, entry);
  }

  function clearFailedAuth(ip) {
    authFailures.delete(ip);
  }

  function pruneAuthFailures(now) {
    for (const [ip, entry] of authFailures) {
      if (now - entry.first > AUTH_FAIL_WINDOW_MS && now >= entry.blockedUntil) {
        authFailures.delete(ip);
      }
    }
    // Still full: drop the oldest (Map iterates in insertion order).
    for (const ip of authFailures.keys()) {
      if (authFailures.size < AUTH_FAIL_MAX_ENTRIES) {
        break;
      }
      authFailures.delete(ip);
    }
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
      maybeResizeWindow(meta.windowId, cols, rows, resizeState);
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
        windowId: meta.windowId,
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

  // Resolve which window the viewer should see, in precedence order: an
  // explicitly pinned window (`@id`), then the window of a pinned pane (`%id`),
  // then the active pane of the requested/configured session and whatever window
  // it currently sits in. `pinValid` is false only when a pin was asked for but
  // could not be honoured (so the client can drop a stale pin, mirroring
  // captureFrame's pinned-pane fallback).
  async function resolveWindowTarget(requestedWindow, requestedPane, requestedSession) {
    if (requestedWindow && /^@\d+$/.test(requestedWindow)) {
      const layout = await tmux.listWindowPanes(requestedWindow);
      if (layout) {
        return { windowId: requestedWindow, pinValid: true };
      }
    }
    if (requestedPane && /^%\d+$/.test(requestedPane)) {
      const meta = await tmux.paneMeta(requestedPane);
      if (meta && meta.windowId) {
        return { windowId: meta.windowId, pinValid: true };
      }
    }
    const active = await resolveActivePane(config, requestedSession);
    if (active && active.windowId) {
      return { windowId: active.windowId, pinValid: !(requestedWindow || requestedPane) };
    }
    return null;
  }

  // Capture every pane of one window and assemble a single frame the browser
  // lays out on a character grid. Mirrors captureFrame's shape (ok/etag/payload)
  // so the WS and HTTP paths treat pane- and window-frames uniformly. The viewed
  // window is pinned by a pane id (its window) or follows the active pane's
  // window; when resizeToViewport is on, the whole window is reshaped to the
  // viewport grid — fine because airc's premise is an unattended laptop.
  async function captureWindowFrame({ requestedWindow = "", requestedPane = "", requestedSession = "", cols = NaN, rows = NaN, viewerAddress = "" }) {
    const target = await resolveWindowTarget(requestedWindow, requestedPane, requestedSession);
    if (!target) {
      return {
        payload: { ok: false, error: "no tmux session available", serverTime: new Date().toISOString() },
        etag: "",
      };
    }

    if (config.resizeToViewport) {
      let last = windowResize.get(target.windowId);
      if (!last) {
        last = { cols: 0, rows: 0, at: 0 };
        windowResize.set(target.windowId, last);
      }
      maybeResizeWindow(target.windowId, cols, rows, last);
    }

    const layout = await tmux.listWindowPanes(target.windowId);
    if (!layout) {
      return {
        payload: { ok: false, error: "window not found", serverTime: new Date().toISOString() },
        etag: "",
      };
    }

    const captures = await Promise.all(layout.map((pane) => tmux.capturePane(pane.paneId)));
    stats.lastCaptureAt = Date.now();
    if (viewerAddress) {
      stats.viewers.set(viewerAddress, Date.now());
    }

    const head = layout[0];
    const hash = crypto.createHash("sha1");
    hash.update(`${head.session}|${head.windowId}|${head.windowWidth}x${head.windowHeight}|${target.pinValid}|`);
    const panes = layout.map((pane, index) => {
      const capture = captures[index];
      const text = capture.ok ? capture.text : "";
      hash.update(`${pane.paneId}|${pane.left},${pane.top}|${pane.width}x${pane.height}|${pane.cursorX},${pane.cursorY}|${pane.active}|`);
      hash.update(text);
      return {
        paneId: pane.paneId,
        left: pane.left,
        top: pane.top,
        cols: pane.width,
        rows: pane.height,
        active: pane.active,
        paneIndex: pane.paneIndex,
        paneTitle: pane.paneTitle,
        cursor: { x: pane.cursorX, y: pane.cursorY },
        html: capture.ok ? ansiToHtml(text) : "",
        error: capture.ok ? "" : capture.error,
      };
    });

    return {
      etag: `"${hash.digest("hex")}"`,
      payload: {
        ok: true,
        mode: "window",
        session: head.session,
        windowId: head.windowId,
        windowIndex: head.windowIndex,
        windowName: head.windowName,
        cols: head.windowWidth,
        rows: head.windowHeight,
        pinned: Boolean(requestedWindow || requestedPane) && target.pinValid,
        pinValid: target.pinValid,
        panes,
        serverTime: new Date().toISOString(),
      },
    };
  }

  // Emit a captured frame with conditional-GET support: a matching If-None-Match
  // yields 304, otherwise the payload with its ETag. Both frame modes share this.
  function respondFrame(request, response, frame) {
    const { etag, payload } = frame;
    if (etag && request.headers["if-none-match"] === etag) {
      response.writeHead(304, { ETag: etag, "Cache-Control": "no-store" });
      response.end();
      return;
    }
    sendJson(response, 200, payload, etag ? { ETag: etag } : {});
  }

  async function handleFrame(request, response, url) {
    const windowMode = url.searchParams.get("mode") === "window";
    const capture = windowMode ? captureWindowFrame : captureFrame;
    const frame = await capture({
      requestedWindow: url.searchParams.get("window") || "",
      requestedPane: url.searchParams.get("pane") || "",
      requestedSession: url.searchParams.get("session") || "",
      cols: Number(url.searchParams.get("cols")),
      rows: Number(url.searchParams.get("rows")),
      viewerAddress: clientAddress(request),
    });
    respondFrame(request, response, frame);
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
      entry.windowId = meta.windowId;
      entry.paneIndex = meta.paneIndex;
    }
    sendJson(response, 200, { ok: true, paneId, state: attention.get(paneId).state });
  }

  // Voice dictation: hand the pane the viewer is looking at to dais and let it
  // record, transcribe and type there. Type-only by design — the transcript
  // lands in the pane's input box and the user submits it with the Enter button
  // above, so a misheard prompt is readable before an agent acts on it.
  //
  // The pane goes through the same resolveInputTarget as every keystroke, so the
  // `^%\d+$` trust boundary holds; dais treats it as an ephemeral, single-use
  // aim and never touches its own durable target slots.
  async function handleDaisDictate(request, response) {
    let payload;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
      return;
    }
    const action = typeof payload.action === "string" ? payload.action : "";
    if (!dais.ACTIONS.has(action)) {
      sendJson(response, 400, { ok: false, error: "action must be start, stop, discard, or toggle" });
      return;
    }
    // Only a start needs a pane. A stop/discard acts on whatever is already
    // recording, and demanding a live pane there would strand a recording that
    // must be stoppable even if its pane just died. `toggle` may become a stop,
    // but dais ignores the pane in that case.
    let pane = "";
    if (action === "start" || action === "toggle") {
      const target = await resolveInputTarget(config, payload);
      if (!target.ok) {
        sendJson(response, 400, target);
        return;
      }
      pane = target.target;
    }
    const result = await dais.dictate(config, action, pane);
    log(`dais dictate ${action}${pane ? ` ${pane}` : ""} -> ${result.ok ? "ok" : result.error}`);
    // 503 when dais couldn't be reached at all, 409 when dais itself refused
    // (mic already open, VAD session running, pane gone) — the browser shows
    // `error` either way, but the split keeps the log and any future client honest.
    const status = result.ok ? 200 : (result.unavailable ? 503 : 409);
    sendJson(response, status, { ...result, action, pane });
  }

  // The tunnel's live status, or a fixed "disabled" report when ngrok is off, so
  // callers don't each spell out the empty shape.
  function ngrokReport() {
    return config.tunnels.ngrok.enabled
      ? ngrokStatus()
      : { running: false, url: "", uptimeMs: 0, restarts: 0, lastError: "disabled" };
  }

  // Every configured route in precedence order, with the advertised one named.
  // Only ngrok carries live state (running/restarts/lastError) — airc doesn't
  // run the others, so "enabled" is the whole truth it has about them.
  function tunnelsReport(liveNgrokUrl) {
    const routes = config.tunnels.prefer.map((name) => ({
      name,
      enabled: Boolean(config.tunnels[name].enabled),
      url: tunnelUrl(config, name, liveNgrokUrl),
    }));
    return { advertised: routes.find((route) => route.url)?.name || "", routes };
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
    const ngrok = ngrokReport();
    sendJson(response, 200, {
      ok: tmuxOk && (!config.tunnels.ngrok.enabled || (ngrok.running && ngrok.url !== "")),
      session: config.session,
      sessions: config.sessions,
      liveSessions,
      tmuxOk,
      lastCaptureAgeMs: stats.lastCaptureAt === 0 ? null : now - stats.lastCaptureAt,
      lastInputAgeMs: stats.lastInputAt === 0 ? null : now - stats.lastInputAt,
      viewersLastMin: stats.viewers.size,
      // The address clients should actually use: the top-ranked tunnel that can
      // name a URL. tools/airc reads this for pairing output, which must not
      // fall back to the ngrok URL while a higher-ranked tunnel is configured.
      publicUrl: currentPublicUrl() || ngrok.url || "",
      ngrok,
      tunnels: tunnelsReport(ngrok.url),
      uptimeMs: now - startedAt,
    });
  }

  function statusPayload() {
    const ngrok = ngrokReport();
    return {
      serverTime: new Date().toISOString(),
      serverVersion: SERVER_VERSION,
      publicUrl: currentPublicUrl() || ngrok.url || "",
      ngrok: {
        enabled: Boolean(config.tunnels.ngrok.enabled),
        ...ngrok,
      },
      tunnels: tunnelsReport(ngrok.url),
      battery: readBatteryStatus(),
    };
  }

  function handleRequest(request, response) {
    const url = parseRequestUrl(request);
    if (!url) {
      send(response, 400, "text/plain; charset=utf-8", "bad request\n");
      return;
    }
    // Encrypted requests are logged once their inner path is known.
    if (url.pathname !== "/api/e2e") {
      log(`${clientAddress(request)} ${request.method} ${url.pathname}`);
    }

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

    const asset = STATIC_ASSETS[url.pathname];
    if (asset) {
      sendFile(response, ...asset);
      return;
    }

    // The page shell carries no data and no token (that's in the #k= fragment,
    // which browsers never send); everything it shows comes over /api/e2e.
    if ((url.pathname === "/" || url.pathname === "/index.html") && request.method === "GET") {
      sendFile(response, "index.html", "text/html; charset=utf-8", "no-store");
      return;
    }

    if (url.pathname === "/api/e2e/hs" || url.pathname === "/api/e2e") {
      if (request.method !== "POST") {
        notFound(response);
        return;
      }
      handleE2e(request, response, url.pathname === "/api/e2e/hs");
      return;
    }

    // The car diagnostics page and its poll: public, since they show only the
    // server time and the caller's own address, and the car's browser should
    // need nothing but a URL to run them.
    if (url.pathname === "/probe" && request.method === "GET") {
      sendFile(response, "probe.html", "text/html; charset=utf-8", "no-store");
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

    // No token is accepted in plaintext anywhere. Over the network, every
    // authenticated request arrives through /api/e2e (handled above) and gets
    // its level from its session; the local Unix socket is control by
    // construction (see config.localSocket). Everything else is anonymous.
    route(request, response, url, { level: request.aircLocal ? "control" : "none" });
  }

  // Everything behind authentication, for a plaintext request (auth from its
  // token) and a decrypted one (auth from its session) alike.
  function route(request, response, url, auth) {
    const authorized = auth.level !== "none";
    const canControl = auth.level === "control";

    // /healthz is authenticated like every other endpoint: the local CLI reaches
    // it over the Unix socket. (Never "loopback with no X-Forwarded-For": a
    // tunnel agent arrives from loopback too.)
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
        // Only whether the feature is configured — never the socket path. The
        // button hides when this is false and greys out when dais isn't running
        // (that part comes from /api/dais/status).
        dais: { enabled: Boolean(config.dais.enabled) },
        canControl,
        authLevel: auth.level,
        publicUrl: currentPublicUrl() || "",
        lanUrls: localLanAddresses(config.port),
      });
      return;
    }
    if (url.pathname === "/api/status" && request.method === "GET") {
      sendJson(response, 200, statusPayload());
      return;
    }
    if (url.pathname === "/api/pairing" && request.method === "GET") {
      if (!canControl) {
        notFound(response);
        return;
      }
      sendJson(response, 200, pairingPayload(config, currentPublicUrl() || "", tlsMaterial));
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
      sendJson(response, 200, { ok: true, items: attentionItems() });
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
    if (url.pathname === "/api/dais/dictate" && request.method === "POST") {
      // Control-gated like /api/tmux/input, and for a stronger reason: this one
      // opens the laptop's microphone. Off unless explicitly configured.
      if (!canControl || !config.dais.enabled) {
        notFound(response);
        return;
      }
      handleDaisDictate(request, response);
      return;
    }
    if (url.pathname === "/api/dais/status" && request.method === "GET") {
      // Control-gated too, unlike /api/attention: only a control client can use
      // the button, and "the mic on that laptop is open right now" is not
      // something a shared read-only link should report.
      if (!canControl || !config.dais.enabled) {
        notFound(response);
        return;
      }
      sendJson(response, 200, { ok: true, ...dais.status(config) });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
      send(response, 405, "text/plain; charset=utf-8", "method not allowed\n");
      return;
    }
    notFound(response);
  }

  const e2e = createE2e({
    keys: () => [
      { level: "control", token: config.controlToken },
      { level: "view", token: config.viewToken },
    ],
    serverVersion: SERVER_VERSION,
  });

  // POST /api/e2e/hs (handshake) and POST /api/e2e (an encrypted request).
  // Neither carries a token: the handshake authenticates by the Noise psk, and
  // a request by its session's keys.
  function handleE2e(request, response, isHandshake) {
    const ip = peerAddress(request);
    readBody(request, isHandshake ? HANDSHAKE_LIMIT_BYTES : E2E_ENVELOPE_LIMIT)
      .then((body) => {
        if (isHandshake) {
          // A failed handshake is a wrong token, so it feeds the throttle. The
          // handshake is still tried while blocked: behind a tunnel every client
          // shares the agent's address, and a block must never lock out a valid
          // token (it costs one trial decryption per token, no DH).
          const result = e2e.handshake(body);
          if (!result) {
            if (!rateLimited(ip)) {
              recordFailedAuth(ip);
            }
            notFound(response);
            return;
          }
          clearFailedAuth(ip);
          sendBytes(response, result.reply);
          return;
        }
        const opened = e2e.open(body);
        if (!opened) {
          send(response, 401, "text/plain; charset=utf-8", "e2e: handshake again\n");
          return;
        }
        dispatchE2e(request, response, opened);
      })
      .catch(() => {
        if (!response.headersSent) {
          send(response, 400, "text/plain; charset=utf-8", "bad request\n");
        }
      });
  }

  function sendBytes(response, bytes) {
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": bytes.length,
      "Cache-Control": "no-store",
    });
    response.end(bytes);
  }

  // Run a decrypted request through the normal routing: a stand-in request
  // (its body as a stream) and a stand-in response that captures what the
  // handler writes, which is then sealed under the request's seq.
  function dispatchE2e(outerRequest, outerResponse, opened) {
    const inner = opened.request || {};
    const reply = (status, body, headers = {}) => {
      sendBytes(outerResponse, e2e.seal(opened, { status, headers, body }));
    };
    const method = inner.method === "POST" ? "POST" : inner.method === "GET" ? "GET" : "";
    const pathOk = typeof inner.path === "string"
      && (inner.path === "/healthz" || (inner.path.startsWith("/api/") && !inner.path.startsWith("/api/e2e")));
    const query = typeof inner.query === "string" ? inner.query : "";
    let url = null;
    if (method && pathOk) {
      try {
        url = new URL(`${inner.path}${query ? `?${query.replace(/^\?/, "")}` : ""}`, "http://localhost");
      } catch {
        url = null;
      }
    }
    if (!url || url.pathname !== inner.path) {
      reply(400, "bad request\n");
      return;
    }
    log(`${clientAddress(outerRequest)} e2e ${method} ${url.pathname}`);

    const body = typeof inner.body === "string" ? inner.body : "";
    const innerHeaders = inner.headers && typeof inner.headers === "object" ? inner.headers : {};
    const request = Readable.from(body ? [Buffer.from(body)] : []);
    request.method = method;
    request.url = `${url.pathname}${url.search}`;
    request.socket = outerRequest.socket;
    request.headers = {};
    if (typeof innerHeaders["If-None-Match"] === "string") {
      request.headers["if-none-match"] = innerHeaders["If-None-Match"];
    }
    if (outerRequest.headers["x-forwarded-for"]) {
      request.headers["x-forwarded-for"] = outerRequest.headers["x-forwarded-for"];
    }

    // Only what a client needs back crosses into the sealed response.
    const KEEP = { etag: "ETag", "content-type": "Content-Type" };
    const captured = {};
    const response = {
      headersSent: false,
      setHeader(name, value) {
        captured[String(name).toLowerCase()] = value;
      },
      writeHead(status, headers = {}) {
        this.statusCode = status;
        for (const [name, value] of Object.entries(headers)) {
          this.setHeader(name, value);
        }
        this.headersSent = true;
      },
      end(chunk) {
        const text = chunk == null ? "" : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        const headers = {};
        for (const [lower, name] of Object.entries(KEEP)) {
          if (captured[lower] !== undefined) {
            headers[name] = String(captured[lower]);
          }
        }
        reply(this.statusCode || 200, text, headers);
      },
    };
    route(request, response, url, { level: opened.session.level, token: "" });
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
    const url = parseRequestUrl(request);
    if (!url) {
      rejectUpgrade(socket, 400);
      return;
    }
    // The only socket: /api/e2e/ws carries no token and authenticates by its
    // first message, a Noise handshake, after which every message is encrypted.
    if (url.pathname !== "/api/e2e/ws") {
      rejectUpgrade(socket);
      return;
    }
    const ip = peerAddress(request);
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
      window: "",
      session: "",
      mode: "pane",
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
      cipher: null, // { send, receive } once the handshake is done
    };
    const EMPTY_AD = Buffer.alloc(0);

    function send(payload) {
      if (wsState.closed || !socket.writable) {
        return;
      }
      if (wsState.cipher) {
        socket.write(websocketFrame(wsState.cipher.send.send(EMPTY_AD, Buffer.from(JSON.stringify(payload)))));
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
        const capture = wsState.mode === "window" ? captureWindowFrame : captureFrame;
        const frame = await capture({
          requestedWindow: wsState.window,
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

    let timer = null;
    function start(level) {
      timer = setInterval(() => sendFrame(false), config.pollMs);
      send({ type: "hello", canControl: level === "control", serverVersion: SERVER_VERSION });
      // First frame is deferred until the client sends its `view` state, so we
      // never flash the active pane before a pin is known.
    }
    // A socket that never completes its handshake doesn't get to sit on a slot.
    const deadline = setTimeout(() => {
      if (!wsState.cipher) {
        socket.destroy();
      }
    }, E2E_WS_HANDSHAKE_MS);
    socket.once("close", () => clearTimeout(deadline));

    // The encrypted socket's first message is Noise msg1. Answer with msg2 and
    // start; a wrong token counts against the throttle and closes the socket.
    function handshake(message) {
      const result = message.type === "binary" ? e2e.channel(message.data) : null;
      if (!result) {
        if (!rateLimited(ip)) {
          recordFailedAuth(ip); // the same throttle as the HTTP handshake
        }
        socket.end(websocketCloseFrame());
        return false;
      }
      clearFailedAuth(ip);
      socket.write(websocketFrame(result.reply));
      wsState.cipher = { send: result.send, receive: result.receive };
      start(result.level);
      return true;
    }

    // The JSON text of a client message, or null to ignore it. Only binary
    // messages that authenticate count, and one that doesn't ends the
    // connection (the channel's counters can't recover).
    function messageText(message) {
      if (message.type !== "binary") {
        return null;
      }
      try {
        return Buffer.from(wsState.cipher.receive.receive(EMPTY_AD, message.data)).toString("utf8");
      } catch {
        socket.end(websocketCloseFrame());
        return undefined;
      }
    }

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
        if (!wsState.cipher) {
          if (!handshake(message)) {
            return;
          }
          continue;
        }
        const text = messageText(message);
        if (text === undefined) {
          return;
        }
        if (text === null) {
          continue;
        }
        try {
          const payload = JSON.parse(text);
          if (payload.type === "view") {
            wsState.pane = typeof payload.pane === "string" && /^%\d+$/.test(payload.pane) ? payload.pane : "";
            wsState.window = typeof payload.window === "string" && /^@\d+$/.test(payload.window) ? payload.window : "";
            wsState.session = typeof payload.session === "string" ? payload.session : "";
            wsState.mode = payload.mode === "window" ? "window" : "pane";
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
  const localServer = http.createServer((request, response) => {
    request.aircLocal = true;
    handleRequest(request, response);
  });

  function listenLocal() {
    const socketPath = config.localSocket;
    if (!socketPath) {
      return;
    }
    // A leftover socket from a crashed run would make listen() fail. Only ever
    // remove a socket, never a regular file someone put there.
    try {
      if (fs.lstatSync(socketPath).isSocket()) {
        fs.unlinkSync(socketPath);
      }
    } catch {
      // nothing there
    }
    localServer.on("error", (error) => {
      log(`WARNING: local socket ${socketPath} unavailable: ${error.message}`);
    });
    localServer.listen(socketPath, () => {
      // Connecting needs write permission on the socket; owner only.
      fs.chmodSync(socketPath, 0o600);
    });
  }

  // Lifecycle facade so main() drives both listeners through one object.
  return {
    listen(port, host, callback) {
      httpServer.listen(port, host, callback);
      listenLocal();
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
    address() {
      return httpServer.address();
    },
    get localSocketPath() {
      return localServer.listening ? config.localSocket : "";
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
      if (localServer.listening) {
        localServer.close(); // also unlinks the socket file
      }
      httpServer.close(callback);
    },
    closeIdleConnections() {
      httpServer.closeIdleConnections();
      localServer.closeIdleConnections();
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
  --session NAME   follow a tmux session (repeat, globs ok); navigation, not access control
                   (default: every live session)
  --host HOST      address to bind (use 0.0.0.0 for same-WLAN phones)
  --port PORT      port to listen on
  --config PATH    config file (default <repo>/config.json)
  --no-ngrok       do not start ngrok (other tunnels stay advertised)
  --no-tunnels     advertise no tunnel at all; LAN/loopback only
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
  // The advertised address is resolved per call from config.tunnels rather than
  // latched at startup: the only part that isn't known up front is the live
  // ngrok URL, which lands here when the agent reports it.
  let ngrokLiveUrl = "";
  const currentPublicUrl = () => advertisedUrl(config, ngrokLiveUrl);
  const ngrokStatus = () => (ngrok ? ngrok.status() : { running: false, url: "", uptimeMs: 0, restarts: 0, lastError: "" });
  const server = makeServer(config, ngrokStatus, currentPublicUrl, tls);
  const announce = () => {
    const publicUrl = currentPublicUrl();
    log(`bookmark: ${bookmarkUrl(config, "view", publicUrl)}`);
    log(`pairing: ${JSON.stringify(pairingPayload(config, publicUrl, tls))}`);
  };

  server.listen(config.port, config.host, () => {
    log(`airc tmux remote listening on http://${config.host}:${config.port} (sessions: ${config.sessions.join(", ")})`);
    if (config.dais.enabled) {
      // Say so at startup, including whether the daemon is actually up: the mic
      // button greying out in the car is otherwise the first place you'd learn it.
      const present = dais.status(config).available ? "" : " — daemon not running yet";
      log(`dais dictation enabled (socket: ${dais.socketPath(config)}${present})`);
    }
    announce();
    if (config.tunnels.ngrok.enabled) {
      // Re-announce once the agent reports: with a reserved domain the URL is
      // the one already logged above, but a non-reserved one is only knowable
      // here — and either way it's the line that says the tunnel came up.
      ngrok = startNgrok({ ...config.tunnels.ngrok, port: config.port }, log, (url) => {
        ngrokLiveUrl = url;
        announce();
      });
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
