"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test, before, after } = require("node:test");

const { loadConfig } = require("../src/config");
const { makeServer } = require("../src/server");

let server;
let port;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airc-server-test-"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    viewToken: "v".repeat(32),
    controlToken: "c".repeat(32),
    tokenEpoch: 2,
    attention: { enabled: false },
    tunnels: { ngrok: { enabled: false } },
  }));
  const { config } = loadConfig(["--config", configPath, "--no-tls"]);
  server = makeServer(config, () => ({ running: false, url: "" }), () => "");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(() => {
  server.closeWebSockets();
  server.closeIdleConnections();
  server.close();
});

// Write raw bytes (bypassing any client-side Host validation) and collect the
// reply until the server closes the connection.
function rawRequest(text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => resolve(data));
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
    socket.write(text);
  });
}

function statusOf(reply) {
  return Number((/^HTTP\/1\.1 (\d{3})/.exec(reply) || [])[1]);
}

// The Host header is never used to parse the URL, so a malformed one is just
// ignored: the request gets its ordinary (unauthenticated) 404.
test("a malformed Host header is ignored instead of crashing the server", async () => {
  const reply = await rawRequest("GET / HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n");
  assert.ok(statusOf(reply) >= 200, reply);
});

test("a malformed upgrade Host is rejected and the server survives", async () => {
  const reply = await rawRequest(
    "GET /api/tmux/ws HTTP/1.1\r\nHost: [\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
  );
  assert.strictEqual(statusOf(reply), 404); // no such socket any more
});

test("an unparseable absolute upgrade target gets 400", async () => {
  const reply = await rawRequest(
    "GET http://[/api/tmux/ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
  );
  assert.strictEqual(statusOf(reply), 400);
});

test("an unparseable absolute request target gets 400", async () => {
  const reply = await rawRequest("GET http://[/ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
  assert.strictEqual(statusOf(reply), 400);
});

test("the server still answers normal requests afterwards", async () => {
  const reply = await rawRequest("GET /api/tmux/frame HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
  assert.strictEqual(statusOf(reply), 404); // no token: the usual not-found
});

function closesWithin(socket, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    socket.once("close", () => { clearTimeout(timer); resolve(true); });
  });
}

// Upgrade `target` and return the status line's code plus the raw socket.
function upgrade(target, extraHeaders = "") {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("error", reject);
    socket.write(
      `GET ${target} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n` +
      "Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" +
      `${extraHeaders}\r\n`,
    );
    socket.once("data", (chunk) => resolve({ status: statusOf(String(chunk)), head: String(chunk), socket }));
  });
}

// A masked client frame (FIN set) with the given first byte.
function clientFrame(first, body) {
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(body.map((byte, index) => byte ^ mask[index % 4]));
  return Buffer.concat([Buffer.from([first, 0x80 | body.length]), mask, masked]);
}

test("no token is accepted in plaintext, on any route", async () => {
  const token = "c".repeat(32);
  for (const request of [
    `GET /api/status?k=${token} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
    `GET /api/status HTTP/1.1\r\nHost: localhost\r\nX-Airc-Auth: ${token}\r\nConnection: close\r\n\r\n`,
    `GET /api/status HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`,
    `GET /api/status HTTP/1.1\r\nHost: localhost\r\nCookie: airc_auth=${token}\r\nConnection: close\r\n\r\n`,
    `GET /probe?k=${token} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
  ]) {
    const reply = await rawRequest(request);
    if (request.startsWith("GET /probe")) {
      assert.ok(!/set-cookie/i.test(reply), "no auth cookie is ever set");
    } else {
      assert.strictEqual(statusOf(reply), 404, request.split("\r\n")[2]);
    }
  }
  const legacy = await upgrade(`/api/tmux/ws?k=${token}`);
  assert.strictEqual(legacy.status, 404, "the plaintext websocket is gone");
  legacy.socket.destroy();
});

test("the probe page and its poll are public", async () => {
  assert.strictEqual(statusOf(await rawRequest("GET /probe HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")), 200);
  const poll = await rawRequest("GET /api/probe/poll?event=3 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
  assert.strictEqual(statusOf(poll), 200);
  assert.match(poll, /"event_number":3/);
});

test("the encrypted socket negotiates no compression and refuses a compressed frame", async () => {
  const { status, head, socket } = await upgrade("/api/e2e/ws", "Sec-WebSocket-Extensions: permessage-deflate\r\n");
  assert.strictEqual(status, 101);
  assert.ok(!/permessage-deflate/i.test(head), head);
  socket.on("data", () => {});
  socket.write(clientFrame(0xc2, Buffer.from("anything"))); // FIN + RSV1 + binary
  assert.strictEqual(await closesWithin(socket, 2000), true);
});

test("forged X-Forwarded-For can't dodge the failed-handshake block, and a valid token still works", async () => {
  const shared = require("../public/airc-noise");
  const { noise } = require("../src/noise-node");
  const msg1 = (token) => Buffer.from(new noise.Handshake({ initiator: true, psk: noise.derivePsk(token), prologue: shared.PROLOGUE }).writeMessage());
  const handshake = (token, forwardedFor = "") => new Promise((resolve, reject) => {
    const body = msg1(token);
    const socket = net.connect(port, "127.0.0.1");
    let reply = "";
    socket.on("data", (chunk) => { reply += chunk.toString("latin1"); });
    socket.on("end", () => resolve(statusOf(reply)));
    socket.on("error", reject);
    socket.write(
      `POST /api/e2e/hs HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${body.length}\r\n` +
      `${forwardedFor ? `X-Forwarded-For: ${forwardedFor}\r\n` : ""}Connection: close\r\n\r\n`,
    );
    socket.write(body);
  });
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(" ")); };
  try {
    for (let index = 0; index < 10; index += 1) {
      assert.strictEqual(await handshake(`wrong-token-${index}`.padEnd(32, "x"), `203.0.113.${index}`), 404);
    }
    assert.ok(lines.some((line) => /rate-limit: blocking 127\.0\.0\.1 /.test(line)), lines.join("\n"));
    // Behind a tunnel every client shares this address: a block must not lock out a valid token.
    assert.strictEqual(await handshake("v".repeat(32)), 200);
  } finally {
    console.log = original;
  }
});

test("the local Unix socket is owner-only and counts as control without a token", async () => {
  const http = require("node:http");
  // The socket starts listening alongside the TCP port; give it a moment.
  for (let tries = 0; tries < 50 && !server.localSocketPath; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const socketPath = server.localSocketPath;
  assert.ok(socketPath && fs.existsSync(socketPath), "socket exists");
  assert.strictEqual(fs.statSync(socketPath).mode & 0o777, 0o600);
  const status = (pathname) => new Promise((resolve, reject) => {
    http.get({ socketPath, path: pathname }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.strictEqual(await status("/healthz"), 200);
  assert.strictEqual(await status("/api/pairing"), 200);
  // The same paths over TCP without a token stay closed.
  assert.strictEqual(statusOf(await rawRequest("GET /api/pairing HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")), 404);
});
