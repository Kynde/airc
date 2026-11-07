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
