"use strict";

// Client for dais (https://github.com/Kynde/dais), the local voice daemon — the
// laptop half of airc's mic button: "record now, and type it into the pane I'm
// looking at". dais transcribes on the laptop and pastes into the tmux pane airc
// names, so nothing here handles audio.
//
// Two channels, deliberately:
//  - CONTROL goes over dais's ndjson Unix socket (one JSON line out, one back).
//  - STATUS is read from the files dais already maintains for statusline use, so
//    the poll behind the button costs no socket round trip and needs no new op
//    on the dais side.
//
// Everything fails soft: dais is optional and off by default, so a laptop
// without it must serve every other airc route exactly as before.

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const REQUEST_TIMEOUT_MS = 2000;
const ACTIONS = new Set(["start", "stop", "discard", "toggle"]);

// $DAIS_SOCKET (which dais's own CLI honors) is deliberately NOT consulted: the
// server's socket comes from airc's config, so a private test daemon exported in
// the operator's shell can't silently re-aim the mic of a running airc.
function socketPath(config) {
  const configured = (config.dais && config.dais.socket) || "";
  if (configured) {
    return configured;
  }
  const runtime = process.env.XDG_RUNTIME_DIR ||
    path.join("/run/user", String(process.getuid ? process.getuid() : 0));
  return path.join(runtime, "dais", "control.sock");
}

// dais writes state.json and its marker files into the same runtime directory as
// the socket, so one config value locates both.
function runtimeDir(config) {
  return path.dirname(socketPath(config));
}

function socketExists(config) {
  try {
    return fs.statSync(socketPath(config)).isSocket();
  } catch {
    return false;
  }
}

// A snapshot for the button: is dais there, is the mic hot, and where is speech
// currently aimed. Sync reads of two tiny files in a tmpfs, like readBatteryStatus.
// `micOpen` comes from the marker file, which exists for exactly this kind of
// existence check and is written by the same code as state.json.
function status(config) {
  const dir = runtimeDir(config);
  const snapshot = {
    available: socketExists(config),
    micOpen: fs.existsSync(path.join(dir, "mic-recording")),
    mode: "",
    target: "",
    dictateTarget: "",
    muted: false,
    dryRun: false,
  };
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    snapshot.mode = typeof state.mode === "string" ? state.mode : "";
    snapshot.target = typeof state.target === "string" ? state.target : "";
    // dais reports the ephemeral dictate override separately from the resolved
    // target: null means speech is going to its own slot, not to our pane.
    snapshot.dictateTarget = typeof state.dictate_target === "string" ? state.dictate_target : "";
    snapshot.muted = Boolean(state.muted);
    snapshot.dryRun = Boolean(state.dry_run);
  } catch {
    // Never started, or caught mid-write (dais rewrites the file per transition).
    // `available` + `micOpen` still answer the only question the button must get
    // right, and the next poll picks the rest up.
  }
  return snapshot;
}

// One request, one reply, then close. Resolves — never rejects: a missing daemon
// is an expected state, not an exception. `unavailable` marks "couldn't talk to
// dais" as opposed to "dais said no", which the caller maps to different HTTP
// statuses.
function request(config, payload) {
  const socket = socketPath(config);
  return new Promise((resolve) => {
    const connection = net.createConnection({ path: socket });
    let timer = null;
    let settled = false;
    let buffer = "";
    const done = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      resolve(result);
    };
    timer = setTimeout(() => done({
      ok: false,
      error: `dais did not answer within ${REQUEST_TIMEOUT_MS}ms`,
      unavailable: true,
    }), REQUEST_TIMEOUT_MS);
    connection.setEncoding("utf8");
    connection.on("connect", () => connection.write(`${JSON.stringify(payload)}\n`));
    connection.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      try {
        done(JSON.parse(buffer.slice(0, newline)));
      } catch {
        done({ ok: false, error: "dais sent an unparseable reply" });
      }
    });
    connection.on("error", (error) => done({
      ok: false,
      error: `dais unreachable (${error.code || error.message})`,
      unavailable: true,
    }));
    connection.on("close", () => done({
      ok: false,
      error: "dais closed the connection without replying",
      unavailable: true,
    }));
  });
}

// Latch a recording aimed at one pane. `start`/`toggle` carry the pane; `stop`
// (transcribe) and `discard` (throw it away) act on whatever is recording, and
// dais resolves `toggle` against its own mode so a stale browser can't invert it.
function dictate(config, action, pane = "") {
  if (!ACTIONS.has(action)) {
    return Promise.resolve({ ok: false, error: `unknown dictate action: ${action}` });
  }
  const payload = { op: "dictate", action };
  if (pane) {
    payload.pane = pane;
  }
  return request(config, payload);
}

module.exports = {
  ACTIONS,
  dictate,
  socketPath,
  status,
};
