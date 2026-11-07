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
  assert.strictEqual(statusOf(reply), 404); // no token
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

// Open an authenticated websocket that negotiates permessage-deflate, and hand
// back the raw socket once the 101 arrives.
function openWebsocket() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("error", reject);
    socket.write(
      `GET /api/tmux/ws?k=${"v".repeat(32)} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n` +
      "Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" +
      "Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n",
    );
    socket.once("data", (chunk) => {
      const head = String(chunk);
      if (!head.startsWith("HTTP/1.1 101") || !/permessage-deflate/i.test(head)) {
        reject(new Error(`no deflate websocket: ${head.split("\r\n")[0]}`));
        return;
      }
      resolve(socket);
    });
  });
}

// A masked, RSV1-compressed client text frame carrying `text`.
function compressedFrame(text) {
  const zlib = require("node:zlib");
  const raw = zlib.deflateRawSync(Buffer.from(text), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  const body = raw.subarray(0, raw.length - 4);
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(body.map((byte, index) => byte ^ mask[index % 4]));
  let header;
  if (body.length < 126) {
    header = Buffer.from([0xc1, 0x80 | body.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0xc1;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  }
  return Buffer.concat([header, mask, masked]);
}

function closesWithin(socket, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    socket.once("close", () => { clearTimeout(timer); resolve(true); });
  });
}

test("a small compressed websocket message is accepted", async () => {
  const socket = await openWebsocket();
  socket.on("data", () => {});
  socket.write(compressedFrame(JSON.stringify({ type: "noop", pad: "x".repeat(500) })));
  assert.strictEqual(await closesWithin(socket, 300), false);
  socket.destroy();
});

test("a websocket decompression bomb closes the socket instead of inflating", async () => {
  const socket = await openWebsocket();
  socket.on("data", () => {});
  socket.write(compressedFrame("A".repeat(4 * 1024 * 1024))); // ~4 KiB on the wire
  assert.strictEqual(await closesWithin(socket, 2000), true);
});

test("forged X-Forwarded-For can't dodge the failed-auth block, and a valid token still works", async () => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(" ")); };
  try {
    for (let index = 0; index < 10; index += 1) {
      await rawRequest(
        `GET /api/status HTTP/1.1\r\nHost: localhost\r\nX-Airc-Auth: wrong${index}\r\n` +
        `X-Forwarded-For: 203.0.113.${index}\r\nConnection: close\r\n\r\n`,
      );
    }
    const blocked = await rawRequest(
      `GET /api/status HTTP/1.1\r\nHost: localhost\r\nX-Airc-Auth: ${"v".repeat(32)}\r\nConnection: close\r\n\r\n`,
    );
    assert.ok(lines.some((line) => /rate-limit: blocking 127\.0\.0\.1 /.test(line)), lines.join("\n"));
    assert.strictEqual(statusOf(blocked), 200); // a block only ever drops wrong tokens
  } finally {
    console.log = original;
  }
});
