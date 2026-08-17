"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const dais = require("../src/dais");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "airc-dais-test-"));
}

// A stand-in for the dais daemon: accepts one ndjson request per connection and
// answers with `reply`, recording what it was asked. Unix socket paths are short
// on purpose (the sun_path limit is ~108 bytes).
function fakeDaemon(socketPath, reply) {
  const seen = [];
  const server = net.createServer((connection) => {
    connection.setEncoding("utf8");
    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      seen.push(JSON.parse(buffer.slice(0, newline)));
      connection.write(`${JSON.stringify(reply)}\n`);
    });
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => resolve({
      seen,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

test("socketPath falls back to the runtime dir, config wins", () => {
  assert.strictEqual(dais.socketPath({ dais: { socket: "/run/custom/dais.sock" } }), "/run/custom/dais.sock");
  assert.match(dais.socketPath({ dais: { socket: "" } }), /\/dais\/control\.sock$/);
});

test("status reads the marker and state.json next to the socket", () => {
  const dir = tempDir();
  const config = { dais: { enabled: true, socket: path.join(dir, "control.sock") } };

  // Nothing there yet: unavailable, and no exception.
  assert.deepStrictEqual(dais.status(config), {
    available: false, micOpen: false, mode: "", target: "", dictateTarget: "",
    muted: false, dryRun: false,
  });

  fs.writeFileSync(path.join(dir, "mic-recording"), "");
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
    mode: "manual-recording",
    target: "%19",
    dictate_target: "%19",
    muted: false,
    dry_run: true,
  }));
  const hot = dais.status(config);
  assert.strictEqual(hot.micOpen, true);
  assert.strictEqual(hot.mode, "manual-recording");
  assert.strictEqual(hot.dictateTarget, "%19");
  assert.strictEqual(hot.dryRun, true);
  // Still "unavailable": the socket is what says the daemon is live, and a stale
  // state.json outliving a crashed daemon must not read as available.
  assert.strictEqual(hot.available, false);

  // A half-written state.json (dais rewrites it per transition) must not throw
  // and must not lose the marker's answer.
  fs.writeFileSync(path.join(dir, "state.json"), '{"mode":"manual-rec');
  const torn = dais.status(config);
  assert.strictEqual(torn.micOpen, true);
  assert.strictEqual(torn.mode, "");
});

test("dictate sends one ndjson line and returns the reply", async () => {
  const dir = tempDir();
  const socketPath = path.join(dir, "control.sock");
  const daemon = await fakeDaemon(socketPath, { ok: true, mode: "manual-recording", pane: "%19" });
  const config = { dais: { enabled: true, socket: socketPath } };

  assert.strictEqual(dais.status(config).available, true, "a listening socket is available");

  const started = await dais.dictate(config, "start", "%19");
  assert.deepStrictEqual(started, { ok: true, mode: "manual-recording", pane: "%19" });
  assert.deepStrictEqual(daemon.seen[0], { op: "dictate", action: "start", pane: "%19" });

  // A stop carries no pane: it acts on whatever is recording.
  await dais.dictate(config, "stop");
  assert.deepStrictEqual(daemon.seen[1], { op: "dictate", action: "stop" });

  await daemon.close();
});

test("dictate fails soft when dais is not there, and refuses unknown actions", async () => {
  const config = { dais: { enabled: true, socket: path.join(tempDir(), "nope.sock") } };
  const missing = await dais.dictate(config, "toggle", "%19");
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.unavailable, true, "unreachable is flagged apart from a refusal");

  const bogus = await dais.dictate(config, "record", "%19");
  assert.strictEqual(bogus.ok, false);
  assert.ok(!bogus.unavailable, "a bad action never reaches the socket");
});
