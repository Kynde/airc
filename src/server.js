#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const { ansiToHtml } = require("./ansi");
const { isAuthorized, authCookie, tokenEquals } = require("./auth");
const { loadConfig, bookmarkUrl, pairingPayload } = require("./config");
const { startNgrok } = require("./ngrok");
const tmux = require("./tmux");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const RESIZE_MIN_INTERVAL_MS = 2000;
const INPUT_LIMIT_BYTES = 16 * 1024;

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

function sendFile(response, fileName, contentType, cacheControl) {
  fs.readFile(path.join(PUBLIC_DIR, fileName), (error, body) => {
    if (error) {
      notFound(response);
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": body.length,
      "Cache-Control": cacheControl,
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
    const meta = await tmux.activePane(config.session);
    if (!meta) {
      return { ok: false, error: `tmux session not found: ${config.session}` };
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

  async function handleFrame(request, response, url) {
    const requestedPane = url.searchParams.get("pane");
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
      meta = await tmux.activePane(config.session);
    }
    if (!meta) {
      sendJson(response, 200, {
        ok: false,
        error: `tmux session not found: ${config.session}`,
        serverTime: new Date().toISOString(),
      });
      return;
    }

    if (config.resizeToViewport && !requestedPane) {
      const cols = Number(url.searchParams.get("cols"));
      const rows = Number(url.searchParams.get("rows"));
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
      sendJson(response, 200, {
        ok: false,
        error: `tmux capture failed: ${capture.error}`,
        serverTime: new Date().toISOString(),
      });
      return;
    }

    stats.lastCaptureAt = Date.now();
    stats.viewers.set(clientAddress(request), Date.now());

    const etag = `"${crypto.createHash("sha1")
      .update(`${meta.paneId}|${meta.width}x${meta.height}|${meta.cursorX},${meta.cursorY}|${pinValid}|`)
      .update(capture.text)
      .digest("hex")}"`;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { ETag: etag, "Cache-Control": "no-store" });
      response.end();
      return;
    }

    sendJson(response, 200, {
      ok: true,
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
    }, { ETag: etag });
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
    const tmuxOk = await tmux.sessionExists(config.session);
    const ngrok = config.ngrok.enabled
      ? ngrokStatus()
      : { running: false, url: "", uptimeMs: 0, restarts: 0, lastError: "disabled" };
    sendJson(response, 200, {
      ok: tmuxOk && (!config.ngrok.enabled || (ngrok.running && ngrok.url !== "")),
      session: config.session,
      tmuxOk,
      lastCaptureAgeMs: stats.lastCaptureAt === 0 ? null : now - stats.lastCaptureAt,
      lastInputAgeMs: stats.lastInputAt === 0 ? null : now - stats.lastInputAt,
      viewersLastMin: stats.viewers.size,
      ngrok,
      uptimeMs: now - startedAt,
    });
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

    const authorized = isAuthorized(request, url, config.authToken);

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
    if (tokenEquals(url.searchParams.get("k") || "", config.authToken)) {
      extraHeaders["Set-Cookie"] = authCookie(config.authToken);
    }

    if ((url.pathname === "/" || url.pathname === "/index.html") && request.method === "GET") {
      sendFile(response, "index.html", "text/html; charset=utf-8", "no-store");
      return;
    }
    if (url.pathname === "/api/config" && request.method === "GET") {
      sendJson(response, 200, {
        session: config.session,
        pollMs: config.pollMs,
        pollIdleMaxMs: config.pollIdleMaxMs,
        fontSizeDefault: config.fontSizeDefault,
        theme: config.theme,
        resizeToViewport: config.resizeToViewport,
      }, extraHeaders);
      return;
    }
    if (url.pathname === "/api/pairing" && request.method === "GET") {
      sendJson(response, 200, pairingPayload(config, currentPublicUrl() || ""), extraHeaders);
      return;
    }
    if (url.pathname === "/api/tmux/frame" && request.method === "GET") {
      handleFrame(request, response, url);
      return;
    }
    if (url.pathname === "/api/tmux/panes" && request.method === "GET") {
      tmux.listPanes(config.session).then((panes) => {
        sendJson(response, 200, panes === null ? { ok: false, panes: [] } : { ok: true, panes });
      });
      return;
    }
    if (url.pathname === "/api/tmux/input" && request.method === "POST") {
      handleInput(request, response);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
      send(response, 405, "text/plain; charset=utf-8", "method not allowed\n");
      return;
    }
    notFound(response);
  });

  return server;
}

function printHelp() {
  console.log(`Usage: node src/server.js [options]

Mirror and control a tmux session from Android.

Options:
  --session NAME   tmux session to follow (default from config.json)
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
    console.log(bookmarkUrl(config));
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
    log(`airc tmux remote listening on http://${config.host}:${config.port} (session: ${config.session})`);
    if (config.ngrok.enabled) {
      ngrok = startNgrok({ ...config.ngrok, port: config.port }, log, (url) => {
        publicUrl = url;
        log(`bookmark: ${bookmarkUrl(config)}`);
        log(`pairing: ${JSON.stringify(pairingPayload(config, publicUrl))}`);
      });
    } else {
      log(`bookmark: ${bookmarkUrl(config)}`);
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
