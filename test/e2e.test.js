"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, before, after } = require("node:test");

const shared = require("../public/airc-noise");
const { noise } = require("../src/noise-node");
const { ReplayWindow, REPLAY_WINDOW } = require("../src/e2e");
const { loadConfig } = require("../src/config");
const { makeServer } = require("../src/server");

const VIEW = "v".repeat(32);
const CONTROL = "c".repeat(32);
let server;
let baseUrl;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airc-e2e-test-"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    viewToken: VIEW,
    controlToken: CONTROL,
    attention: { enabled: false },
    tunnels: { ngrok: { enabled: false } },
  }));
  const { config } = loadConfig(["--config", configPath, "--no-tls"]);
  server = makeServer(config, () => ({ running: false, url: "" }), () => "");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeWebSockets();
  server.closeIdleConnections();
  server.close();
});

// A fetch that records every request and response body, standing in for a
// tunnel that logs everything it forwards.
function recordingFetch() {
  const wire = [];
  const fetchImpl = async (url, options = {}) => {
    const sent = options.body ? Buffer.from(options.body) : Buffer.alloc(0);
    const response = await fetch(url, options);
    const received = Buffer.from(await response.arrayBuffer());
    wire.push({ url, headers: JSON.stringify(options.headers || {}), sent, received, status: response.status });
    return new Response(received, { status: response.status, headers: response.headers });
  };
  return { wire, fetchImpl };
}

function client(token, fetchImpl) {
  return new shared.Client({ noise, token, client: "test", baseUrl, fetch: fetchImpl });
}

test("a view token gets a view session and can read view endpoints", async () => {
  const viewer = client(VIEW);
  const reply = await viewer.request("GET", "/api/config");
  assert.strictEqual(viewer.level, "view");
  assert.strictEqual(reply.status, 200);
  const config = JSON.parse(reply.body);
  assert.strictEqual(config.authLevel, "view");
  assert.strictEqual(config.canControl, false);
});

test("control endpoints follow the session's level, not anything in the request", async () => {
  const viewer = client(VIEW);
  assert.strictEqual((await viewer.request("GET", "/api/pairing")).status, 404);
  // A token smuggled inside the encrypted request is ignored.
  assert.strictEqual((await viewer.request("GET", "/api/pairing", { query: `k=${CONTROL}` })).status, 404);
  const controller = client(CONTROL);
  const pairing = await controller.request("GET", "/api/pairing");
  assert.strictEqual(controller.level, "control");
  assert.strictEqual(pairing.status, 200);
});

test("a wrong token is refused at the handshake", async () => {
  await assert.rejects(client("x".repeat(32)).request("GET", "/api/config"), /handshake refused \(404\)/);
});

test("no token and no plaintext content cross the wire", async () => {
  const { wire, fetchImpl } = recordingFetch();
  const controller = client(CONTROL, fetchImpl);
  const reply = await controller.request("GET", "/api/config");
  assert.ok(reply.body.includes("authLevel"));
  await controller.request("GET", "/api/status");
  assert.ok(wire.length >= 3);
  for (const entry of wire) {
    const everything = Buffer.concat([Buffer.from(entry.url), Buffer.from(entry.headers), entry.sent, entry.received]).toString("latin1");
    for (const secret of [CONTROL, "authLevel", "/api/config", "/api/status", "canControl"]) {
      assert.ok(!everything.includes(secret), `${secret} leaked in ${entry.url}`);
    }
  }
});

test("a replayed or tampered envelope is refused", async () => {
  const { wire, fetchImpl } = recordingFetch();
  const controller = client(CONTROL, fetchImpl);
  await controller.request("GET", "/api/status");
  const envelope = wire.find((entry) => entry.url.endsWith("/api/e2e")).sent;
  const post = (body) => fetch(`${baseUrl}/api/e2e`, { method: "POST", body });

  assert.strictEqual((await post(envelope)).status, 401, "replay");
  const tampered = Buffer.from(envelope);
  tampered[tampered.length - 1] ^= 0x01;
  assert.strictEqual((await post(tampered)).status, 401, "tampered tag");
  const otherSeq = Buffer.from(envelope);
  otherSeq[shared.HEADER_BYTES - 1] ^= 0x01;
  assert.strictEqual((await post(otherSeq)).status, 401, "seq rewritten");
  assert.strictEqual((await post(Buffer.from("garbage"))).status, 401, "garbage");
});

test("a response can't be moved onto another request", async () => {
  const { wire, fetchImpl } = recordingFetch();
  const controller = client(CONTROL, fetchImpl);
  await controller.request("GET", "/api/status");
  await controller.request("GET", "/api/config");
  const [first, second] = wire.filter((entry) => entry.url.endsWith("/api/e2e"));
  const header = shared.decodeEnvelope(second.sent).header;
  // The second request's keys and seq can't open the first request's response.
  assert.throws(() => controller.session.receive.receiveWithNonce(1, shared.concat(header, shared.RES), first.received));
});

test("an unknown session triggers one fresh handshake", async () => {
  const controller = client(CONTROL);
  await controller.request("GET", "/api/status");
  controller.session.id = new Uint8Array(shared.SESSION_BYTES); // as after a server restart
  const reply = await controller.request("GET", "/api/status");
  assert.strictEqual(reply.status, 200);
});

test("only API paths can be reached through the envelope", async () => {
  const controller = client(CONTROL);
  for (const target of ["/", "/index.html", "/api/e2e", "/api/e2e/hs", "/app.js", "/api/../index.html"]) {
    assert.strictEqual((await controller.request("GET", target)).status, 400, target);
  }
});

test("the replay window accepts reordering but never a repeat", () => {
  const window = new ReplayWindow();
  const accept = (seq) => {
    if (!window.check(seq)) {
      return false;
    }
    window.commit(seq);
    return true;
  };
  assert.ok(accept(5));
  assert.ok(accept(3), "late but new");
  assert.ok(!accept(3), "repeat");
  assert.ok(!accept(5), "repeat of newest");
  assert.ok(accept(5 + REPLAY_WINDOW));
  assert.ok(!accept(5), "fell out of the window");
  assert.ok(accept(6 + 1), "still inside the window");
});

// Open an encrypted socket and collect what arrives until `until(types)` holds
// (by default: the hello) or the socket closes.
function openChannel(token, onOpen, until = (types) => types.includes("hello")) {
  return new Promise((resolve, reject) => {
    const channel = new shared.Channel({ noise, token, client: "test", url: `${baseUrl.replace("http", "ws")}/api/e2e/ws` });
    const received = [];
    const timer = setTimeout(() => reject(new Error(`timeout; got ${JSON.stringify(received.map((m) => m.type))}`)), 4000);
    channel.onopen = () => onOpen(channel, received);
    channel.onmessage = (message) => {
      received.push(message);
      if (until(received.map((m) => m.type))) {
        clearTimeout(timer);
        resolve({ channel, received });
      }
    };
    channel.onclose = () => {
      clearTimeout(timer);
      resolve({ channel, received, closed: true });
    };
    channel.connect();
  });
}

test("the encrypted websocket handshakes and carries the hello at the session's level", async () => {
  const viewer = await openChannel(VIEW, () => {});
  assert.strictEqual(viewer.channel.level, "view");
  assert.deepStrictEqual(viewer.received.map((m) => [m.type, m.canControl]), [["hello", false]]);
  viewer.channel.close();
  const controller = await openChannel(CONTROL, () => {});
  assert.strictEqual(controller.received[0].canControl, true);
  controller.channel.close();
});

test("the encrypted websocket refuses a wrong token", async () => {
  const outcome = await openChannel("x".repeat(32), () => {});
  assert.strictEqual(outcome.closed, true);
  assert.strictEqual(outcome.channel.level, "");
});

test("a raw websocket can't skip the handshake or send plaintext", async () => {
  // Plain text first: no handshake, so the server closes without a word.
  const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/api/e2e/ws`);
  const outcome = await new Promise((resolve) => {
    const got = [];
    ws.onopen = () => ws.send(JSON.stringify({ type: "view" }));
    ws.onmessage = (event) => got.push(event.data);
    ws.onclose = () => resolve(got);
  });
  assert.deepStrictEqual(outcome, []);
});

test("the encrypted websocket takes view state and answers with a frame or error", async () => {
  // No tmux in the test environment is fine: the server still answers, sealed.
  const outcome = await openChannel(VIEW, (channel) => {
    channel.send({ type: "view", mode: "pane", cols: 80, rows: 24 });
  }, (types) => types.includes("frame") || types.includes("error"));
  const types = outcome.received.map((m) => m.type);
  assert.ok(types.includes("frame") || types.includes("error"), JSON.stringify(types));
  outcome.channel.close();
});
