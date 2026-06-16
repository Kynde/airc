"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_CONFIG_PATH = path.join(__dirname, "..", "config.json");

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8080,
  session: "swyd",
  pollMs: 700,
  pollIdleMaxMs: 2500,
  authToken: "",
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
      args.session = argv[index + 1];
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

function generateToken() {
  return crypto.randomBytes(24).toString("base64url");
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
  if (args.session !== undefined) config.session = args.session;
  if (args.noNgrok) config.ngrok = { ...config.ngrok, enabled: false };

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("port must be an integer between 1 and 65535");
  }

  if (!config.authToken) {
    config.authToken = generateToken();
    fs.writeFileSync(configPath, `${JSON.stringify({ ...fileConfig, authToken: config.authToken }, null, 2)}\n`);
  }

  return { config, flags: args.flags, configPath };
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

function bookmarkUrl(config) {
  return `${baseUrl(config)}/?k=${config.authToken}`;
}

function pairingPayload(config, actualBaseUrl = "") {
  const lanUrls = localLanAddresses(config.port);
  const preferredBaseUrl = actualBaseUrl || (config.ngrok.enabled ? baseUrl(config) : (lanUrls[0] || baseUrl(config)));
  return {
    type: "airc-tmux-remote",
    version: 1,
    name: `${os.hostname()} ${config.session}`,
    baseUrl: preferredBaseUrl,
    token: config.authToken,
    session: config.session,
    lanUrls,
  };
}

module.exports = { loadConfig, bookmarkUrl, pairingPayload, DEFAULT_CONFIG_PATH };
