"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { loadConfig, advertisedUrl, pairingPayload } = require("../src/config");

// loadConfig persists generated tokens back into the file it read, so every
// case gets its own throwaway config. Tokens are pre-set to keep the rewrite
// (and its 0600 chmod) out of the way of what's being asserted.
function withConfig(fileConfig, argv = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airc-tunnels-test-"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    port: 9099,
    viewToken: "v".repeat(32),
    controlToken: "c".repeat(32),
    ...fileConfig,
  }));
  return loadConfig(["--config", configPath, "--no-tls", ...argv]).config;
}

const NGROK = { enabled: true, domain: "d.ngrok-free.dev" };
const TAILSCALE = { enabled: true, url: "https://host.example.ts.net" };

test("tunnels.prefer picks the advertised route, ngrok first by default", () => {
  const config = withConfig({ tunnels: { ngrok: NGROK, tailscale: TAILSCALE } });
  assert.deepStrictEqual(config.tunnels.prefer, ["ngrok", "tailscale", "external"]);
  // The reserved domain is advertised before the agent is up; the live URL the
  // agent reports takes over once known.
  assert.strictEqual(advertisedUrl(config), "https://d.ngrok-free.dev");
  assert.strictEqual(advertisedUrl(config, "https://live.ngrok-free.dev"), "https://live.ngrok-free.dev");
});

test("a lower-ranked tunnel takes over when the preferred one is off", () => {
  const config = withConfig({
    tunnels: { prefer: ["ngrok", "tailscale"], ngrok: { ...NGROK, enabled: false }, tailscale: TAILSCALE },
  });
  assert.strictEqual(advertisedUrl(config), "https://host.example.ts.net");
});

test("prefer reorders which tunnel wins", () => {
  const config = withConfig({
    tunnels: { prefer: ["tailscale", "ngrok"], ngrok: NGROK, tailscale: TAILSCALE },
  });
  assert.strictEqual(advertisedUrl(config, "https://live.ngrok-free.dev"), "https://host.example.ts.net");
});

test("a tunnel left out of prefer ranks last instead of disappearing", () => {
  const config = withConfig({ tunnels: { prefer: ["tailscale"], ngrok: NGROK, tailscale: { ...TAILSCALE, enabled: false } } });
  assert.deepStrictEqual(config.tunnels.prefer, ["tailscale", "ngrok", "external"]);
  assert.strictEqual(advertisedUrl(config), "https://d.ngrok-free.dev");
});

test("legacy publicUrl loads as tunnels.external and keeps outranking ngrok", () => {
  const config = withConfig({ publicUrl: "https://legacy.example.com/", ngrok: NGROK });
  assert.deepStrictEqual(config.tunnels.external, { enabled: true, url: "https://legacy.example.com" });
  assert.deepStrictEqual(config.tunnels.prefer, ["external", "ngrok", "tailscale"]);
  assert.strictEqual(advertisedUrl(config, "https://live.ngrok-free.dev"), "https://legacy.example.com");
  assert.strictEqual(config.publicUrl, undefined);
});

test("an explicit tunnels block overrides the legacy keys it duplicates", () => {
  const config = withConfig({
    ngrok: { enabled: true, domain: "legacy.ngrok-free.dev" },
    tunnels: { ngrok: NGROK },
  });
  assert.strictEqual(advertisedUrl(config), "https://d.ngrok-free.dev");
});

test("--no-ngrok drops ngrok only; --no-tunnels drops every route", () => {
  const file = { tunnels: { ngrok: NGROK, tailscale: TAILSCALE } };
  assert.strictEqual(advertisedUrl(withConfig(file, ["--no-ngrok"])), "https://host.example.ts.net");
  assert.strictEqual(advertisedUrl(withConfig(file, ["--no-tunnels"])), "");
});

test("pairing prefers the tunnel when one is configured and LAN when none is", () => {
  const file = { tunnels: { ngrok: NGROK, tailscale: TAILSCALE } };
  assert.strictEqual(pairingPayload(withConfig(file)).baseUrl, "https://d.ngrok-free.dev");
  const local = pairingPayload(withConfig(file, ["--no-tunnels"]));
  // With no tunnel the payload falls back to loopback, and the LAN address (a
  // box with no non-internal IPv4 has none) is what pairing should prefer.
  assert.strictEqual(local.publicUrl, "http://127.0.0.1:9099");
  assert.strictEqual(local.baseUrl, local.lanUrls[0] || "http://127.0.0.1:9099");
});

test("bad tunnel config is rejected at load", () => {
  assert.throws(
    () => withConfig({ tunnels: { tailscale: { enabled: true, url: "host.example.ts.net" } } }),
    /tunnels\.tailscale\.url must start with http/,
  );
  assert.throws(
    () => withConfig({ tunnels: { prefer: ["ngrok", "cloudflare"] } }),
    /unknown tunnel "cloudflare"/,
  );
});
