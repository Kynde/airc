"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { loadConfig, bookmarkUrl } = require("../src/config");

function configFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airc-config-test-"));
  const configPath = path.join(dir, "config.json");
  if (contents) {
    fs.writeFileSync(configPath, JSON.stringify(contents));
  }
  return configPath;
}

const load = (configPath) => loadConfig(["--config", configPath, "--no-tls", "--no-tunnels"]);
const OLD_CONTROL = "c".repeat(32);
const OLD_VIEW = "v".repeat(32);

test("a config from before end-to-end encryption gets fresh tokens once", () => {
  const configPath = configFile({ controlToken: OLD_CONTROL, viewToken: OLD_VIEW, authToken: "legacy-token-legacy-token", port: 8123 });
  const first = load(configPath);
  assert.notStrictEqual(first.config.controlToken, OLD_CONTROL);
  assert.notStrictEqual(first.config.viewToken, OLD_VIEW);
  assert.ok(first.warnings.some((line) => /tokens regenerated/.test(line)), first.warnings.join("\n"));
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.strictEqual(saved.tokenEpoch, 2);
  assert.strictEqual(saved.authToken, undefined);
  assert.strictEqual(saved.port, 8123, "other settings survive");
  assert.strictEqual(saved.controlToken, first.config.controlToken);

  const second = load(configPath);
  assert.strictEqual(second.config.controlToken, first.config.controlToken, "only once");
  assert.ok(!second.warnings.some((line) => /tokens regenerated/.test(line)));
});

test("a fresh config gets tokens without a re-pair warning", () => {
  const { config, warnings } = load(configFile(null));
  assert.ok(config.controlToken.length >= 32 && config.viewToken.length >= 32);
  assert.ok(!warnings.some((line) => /tokens regenerated/.test(line)));
});

test("a token shorter than 128 bits is refused", () => {
  const configPath = configFile({ tokenEpoch: 2, controlToken: "short", viewToken: OLD_VIEW });
  assert.throws(() => load(configPath), /controlToken must be at least 22 characters/);
});

test("bookmark links carry the token in the fragment, never the query", () => {
  const { config } = load(configFile({ tokenEpoch: 2, controlToken: OLD_CONTROL, viewToken: OLD_VIEW }));
  const url = bookmarkUrl(config, "view");
  assert.ok(url.endsWith(`/#k=${OLD_VIEW}`), url);
  assert.ok(!url.includes("?"), url);
});
