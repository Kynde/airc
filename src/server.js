#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const { ansiToHtml } = require("./ansi");
const { authLevel, authCookie, tokenEquals } = require("./auth");
const { loadConfig, bookmarkUrl, pairingPayload, localLanAddresses } = require("./config");
const { startNgrok } = require("./ngrok");
const tmux = require("./tmux");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const RESIZE_MIN_INTERVAL_MS = 2000;
const INPUT_LIMIT_BYTES = 16 * 1024;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

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

function isLocalDirect(request) {
  if (request.headers["x-forwarded-for"]) {
    return false;
  }
  const address = request.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
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
  for (const session of config.sessions) {
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

function makeServer(config, ngrokStatus, currentPublicUrl) {
  const startedAt = Date.now();
  const stats = {
    lastCaptureAt: 0,
    lastInputAt: 0,
    viewers: new Map(),
  };
  const resizeState = { lastCols: 0, lastRows: 0, lastAt: 0 };

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

  async function handleHealthz(response) {
    const now = Date.now();
    for (const [address, ts] of stats.viewers) {
      if (now - ts > 60000) {
        stats.viewers.delete(address);
      }
    }
    const liveSessions = (await Promise.all(
      config.sessions.map(async (session) => (await tmux.sessionExists(session) ? session : null)),
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
      publicUrl: currentPublicUrl() || ngrok.url || "",
      ngrok: {
        enabled: Boolean(config.ngrok.enabled),
        ...ngrok,
      },
      battery: readBatteryStatus(),
    };
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    log(`${clientAddress(request)} ${request.method} ${url.pathname}`);

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

    const auth = authLevel(request, url, config);
    const authorized = auth.level !== "none";
    const canControl = auth.level === "control";

    if (url.pathname === "/healthz") {
      if (!isLocalDirect(request) && !authorized) {
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
      sendJson(response, 200, pairingPayload(config, currentPublicUrl() || ""), extraHeaders);
      return;
    }
    if (url.pathname === "/api/tmux/frame" && request.method === "GET") {
      handleFrame(request, response, url);
      return;
    }
    if (url.pathname === "/api/tmux/panes" && request.method === "GET") {
      tmux.listPanesForSessions(config.sessions).then((panes) => {
        sendJson(response, 200, { ok: panes.length > 0, sessions: config.sessions, panes });
      });
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
  });
  const wsSockets = new Set();

  function rejectUpgrade(socket, status = 404) {
    socket.write(`HTTP/1.1 ${status} ${status === 404 ? "Not Found" : "Bad Request"}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  server.on("upgrade", (request, socket) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname !== "/api/tmux/ws") {
      rejectUpgrade(socket);
      return;
    }
    const auth = authLevel(request, url, config);
    if (auth.level === "none") {
      rejectUpgrade(socket);
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
    };

    function send(payload) {
      if (!wsState.closed && socket.writable) {
        socket.write(websocketFrame(JSON.stringify(payload)));
      }
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
      } catch (error) {
        send({ type: "error", error: error.message });
      } finally {
        wsState.sending = false;
      }
    }

    const timer = setInterval(() => sendFrame(false), config.pollMs);
    send({ type: "hello", canControl: auth.level === "control" });
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

    socket.on("close", () => {
      wsState.closed = true;
      wsSockets.delete(socket);
      clearInterval(timer);
    });
    socket.on("error", () => {
      wsState.closed = true;
      wsSockets.delete(socket);
      clearInterval(timer);
    });
  });

  server.closeWebSockets = () => {
    for (const socket of wsSockets) {
      socket.destroy();
    }
    wsSockets.clear();
  };

  return server;
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
  const { config, flags } = loaded;

  if (flags.help) {
    printHelp();
    return;
  }
  if (flags.printUrl) {
    console.log(bookmarkUrl(config, "view"));
    return;
  }
  if (flags.pair) {
    printPairing(pairingPayload(config));
    return;
  }

  let ngrok = null;
  let publicUrl = "";
  const ngrokStatus = () => (ngrok ? ngrok.status() : { running: false, url: "", uptimeMs: 0, restarts: 0, lastError: "" });
  const server = makeServer(config, ngrokStatus, () => publicUrl);

  server.listen(config.port, config.host, () => {
    log(`airc tmux remote listening on http://${config.host}:${config.port} (sessions: ${config.sessions.join(", ")})`);
    if (config.ngrok.enabled) {
      ngrok = startNgrok({ ...config.ngrok, port: config.port }, log, (url) => {
        publicUrl = url;
        log(`bookmark: ${bookmarkUrl(config, "view", publicUrl)}`);
        log(`pairing: ${JSON.stringify(pairingPayload(config, publicUrl))}`);
      });
    } else {
      log(`bookmark: ${bookmarkUrl(config, "view")}`);
      log(`pairing: ${JSON.stringify(pairingPayload(config))}`);
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
