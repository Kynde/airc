"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_CONFIG_PATH = path.join(__dirname, "..", "config.json");

const DEFAULTS = {
  productName: "AI Remote Control",
  host: "127.0.0.1",
  port: 8080,
  session: "swyd",
  pollMs: 700,
  pollIdleMaxMs: 2500,
  viewToken: "",
  controlToken: "",
  fontSizeDefault: 13,
  theme: "dark",
  resizeToViewport: false,
  ngrok: {
    enabled: true,
    domain: "carrousel-value-recipient.ngrok-free.dev",
    binary: "ngrok",
    apiUrl: "http://127.0.0.1:4040",
  },
};

function parseArgs(argv) {
  const args = { flags: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--host") {
      args.host = argv[index + 1];
      index += 1;
    } else if (item === "--port") {
      args.port = Number(argv[index + 1]);
      index += 1;
    } else if (item === "--session" || item === "--tmux-target") {
      (args.sessions ||= []).push(argv[index + 1]);
      index += 1;
    } else if (item === "--config") {
      args.configPath = argv[index + 1];
      index += 1;
    } else if (item === "--no-ngrok") {
      args.noNgrok = true;
    } else if (item === "--print-url") {
      args.flags.printUrl = true;
    } else if (item === "--pair") {
      args.flags.pair = true;
    } else if (item === "-h" || item === "--help") {
      args.flags.help = true;
    } else {
      throw new Error(`Unknown argument: ${item}`);
    }
  }
  return args;
}

// 24 random bytes → 32 base64url chars. Tokens shorter than this over a public
// endpoint are brute-forceable, so configured tokens below it are flagged.
const MIN_TOKEN_LENGTH = 32;

function generateToken() {
  return crypto.randomBytes(24).toString("base64url");
}

// Surface weak configured tokens at load time without ever printing the value.
// Returns warning strings; the caller decides how to emit them.
function tokenWarnings(config) {
  const warnings = [];
  for (const [name, value] of [["controlToken", config.controlToken], ["viewToken", config.viewToken]]) {
    if (typeof value === "string" && value.length > 0 && value.length < MIN_TOKEN_LENGTH) {
      warnings.push(`${name} is only ${value.length} chars; use >= ${MIN_TOKEN_LENGTH} (clear it in config.json to auto-generate a strong one)`);
    }
  }
  return warnings;
}

// Accept a string, an array, or a mix and produce a de-duplicated, non-empty
// list of session names. Order is preserved; the first entry is the primary.
function normalizeSessions(...sources) {
  const out = [];
  for (const source of sources) {
    const items = Array.isArray(source) ? source : [source];
    for (const item of items) {
      if (typeof item === "string" && item.trim() && !out.includes(item)) {
        out.push(item);
      }
    }
  }
  return out;
}

function loadConfig(argv) {
  const args = parseArgs(argv);
  const configPath = args.configPath || DEFAULT_CONFIG_PATH;
  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }

  const config = {
    ...DEFAULTS,
    ...fileConfig,
    ngrok: { ...DEFAULTS.ngrok, ...(fileConfig.ngrok || {}) },
  };
  if (args.host !== undefined) config.host = args.host;
  if (args.port !== undefined) config.port = args.port;
  if (args.noNgrok) config.ngrok = { ...config.ngrok, enabled: false };

  // sessions[] is canonical, resolved by precedence (not merged): CLI --session
  // (repeatable) wins, else a file `sessions` array, else a legacy file `session`
  // string, else the built-in default. config.session is kept as the primary
  // session so singular readers still work.
  config.sessions =
    normalizeSessions(args.sessions).length ? normalizeSessions(args.sessions)
      : normalizeSessions(fileConfig.sessions).length ? normalizeSessions(fileConfig.sessions)
        : normalizeSessions(fileConfig.session).length ? normalizeSessions(fileConfig.session)
          : normalizeSessions(DEFAULTS.session);
  config.session = config.sessions[0];

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("port must be an integer between 1 and 65535");
  }

  const persisted = { ...fileConfig };
  let changed = false;
  if (!config.controlToken) {
    config.controlToken = typeof fileConfig.authToken === "string" && fileConfig.authToken
      ? fileConfig.authToken
      : generateToken();
    persisted.controlToken = config.controlToken;
    changed = true;
  }
  if (!config.viewToken) {
    config.viewToken = generateToken();
    persisted.viewToken = config.viewToken;
    changed = true;
  }
  if (changed) {
    // 0600: the file holds the control token, which grants shell input.
    fs.writeFileSync(configPath, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
  }
  // Tighten perms even when we didn't rewrite (e.g. a pre-existing 0644 file).
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Best effort; a read-only/owned-elsewhere config is not fatal.
  }

  return { config, flags: args.flags, configPath, warnings: tokenWarnings(config) };
}

function localLanAddresses(port) {
  const addresses = [];
  let interfaces;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    return addresses;
  }
  for (const items of Object.values(interfaces)) {
    for (const item of items || []) {
      if (item.family === "IPv4" && !item.internal) {
        addresses.push(`http://${item.address}:${port}`);
      }
    }
  }
  return addresses;
}

function baseUrl(config) {
  if (config.ngrok.enabled) {
    return `https://${config.ngrok.domain}`;
  }
  return `http://127.0.0.1:${config.port}`;
}

function publicBaseUrl(config, actualBaseUrl = "") {
  return actualBaseUrl || baseUrl(config);
}

function bookmarkUrl(config, level = "view", actualBaseUrl = "") {
  const token = level === "control" ? config.controlToken : config.viewToken;
  return `${publicBaseUrl(config, actualBaseUrl)}/?k=${token}`;
}

function pairingPayload(config, actualBaseUrl = "") {
  const lanUrls = localLanAddresses(config.port);
  const preferredBaseUrl = actualBaseUrl || (config.ngrok.enabled ? baseUrl(config) : (lanUrls[0] || baseUrl(config)));
  const sessions = config.sessions || [config.session];
  return {
    type: "airc-tmux-remote",
    version: 2,
    name: `${os.hostname()} ${sessions.join(", ")}`,
    baseUrl: preferredBaseUrl,
    token: config.controlToken,
    session: config.session,
    sessions,
    lanUrls,
    publicUrl: publicBaseUrl(config, actualBaseUrl),
  };
}

module.exports = {
  loadConfig,
  bookmarkUrl,
  pairingPayload,
  localLanAddresses,
  publicBaseUrl,
  tokenWarnings,
  DEFAULT_CONFIG_PATH,
};
