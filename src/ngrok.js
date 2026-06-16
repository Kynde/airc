"use strict";

const { spawn } = require("node:child_process");

const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60000;
const STABLE_AFTER_MS = 60000;
const URL_POLL_MS = 1000;
const URL_POLL_TRIES = 30;

function startNgrok(options, log, onUrl) {
  const state = {
    child: null,
    running: false,
    url: "",
    urlSince: 0,
    startedAt: 0,
    restarts: 0,
    lastError: "",
    stopping: false,
  };
  let backoffMs = INITIAL_BACKOFF_MS;

  async function discoverUrl() {
    for (let attempt = 0; attempt < URL_POLL_TRIES; attempt += 1) {
      if (state.stopping || !state.running) {
        return;
      }
      try {
        const response = await fetch(`${options.apiUrl}/api/tunnels`);
        const payload = await response.json();
        const tunnel = (payload.tunnels || []).find((item) => item.public_url);
        if (tunnel) {
          state.url = tunnel.public_url;
          state.urlSince = Date.now();
          log(`[ngrok] tunnel up: ${state.url}`);
          if (onUrl) {
            onUrl(state.url);
          }
          return;
        }
      } catch {
        // The local ngrok API may not be ready yet.
      }
      await new Promise((resolve) => setTimeout(resolve, URL_POLL_MS));
    }
    log("[ngrok] gave up waiting for tunnel URL");
  }

  function pipeLines(stream) {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim() === "") {
          continue;
        }
        log(`[ngrok] ${line}`);
        if (line.includes('"lvl":"erro"') || line.includes("ERR_NGROK")) {
          state.lastError = line;
        }
      }
    });
  }

  function spawnAgent() {
    if (state.stopping) {
      return;
    }
    const args = ["http", String(options.port), "--url", `https://${options.domain}`, "--log", "stdout", "--log-format", "json"];
    log(`[ngrok] starting: ${options.binary} ${args.join(" ")}`);
    const child = spawn(options.binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    state.child = child;
    state.running = true;
    state.startedAt = Date.now();
    state.url = "";
    pipeLines(child.stdout);
    pipeLines(child.stderr);
    discoverUrl();

    child.on("error", (error) => {
      state.lastError = error.message;
      log(`[ngrok] spawn failed: ${error.message}`);
    });

    child.on("exit", (code, signal) => {
      state.running = false;
      state.url = "";
      if (state.stopping) {
        return;
      }
      const uptimeMs = Date.now() - state.startedAt;
      if (uptimeMs > STABLE_AFTER_MS) {
        backoffMs = INITIAL_BACKOFF_MS;
      }
      state.restarts += 1;
      log(`[ngrok] exited (code=${code} signal=${signal}); restarting in ${backoffMs / 1000}s`);
      setTimeout(spawnAgent, backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    });
  }

  spawnAgent();

  return {
    stop() {
      state.stopping = true;
      if (state.child && state.running) {
        state.child.kill("SIGTERM");
      }
    },
    status() {
      return {
        running: state.running,
        url: state.url,
        uptimeMs: state.running ? Date.now() - state.startedAt : 0,
        restarts: state.restarts,
        lastError: state.lastError,
      };
    },
  };
}

module.exports = { startNgrok };
