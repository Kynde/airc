"use strict";

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_CONFIG_PATH = path.join(__dirname, "..", "config.json");
const DEFAULT_TLS_KEY_PATH = path.join(__dirname, "..", ".airc-tls-key.pem");
const DEFAULT_TLS_CERT_PATH = path.join(__dirname, "..", ".airc-tls-cert.pem");

const DEFAULTS = {
  productName: "AI Remote Control",
  host: "127.0.0.1",
  port: 8080,
  // Follow every live tmux session by default: the zero-config path shouldn't
  // care what you named the session you already have open. Narrowing the scope
  // (a name, a list, or a `foo*` glob) is opt-in, via config or --session.
  sessions: ["*"],
  pollMs: 700,
  pollIdleMaxMs: 2500,
  viewToken: "",
  controlToken: "",
  fontSizeDefault: 13,
  theme: "dark",
  resizeToViewport: false,
  // Attention scanning: watch other panes for an agent that needs interaction.
  // scanMs is decoupled from pollMs because a scan captures every candidate
  // pane, not just the viewed one. debounceScans guards against mid-render
  // flicker; maxPanes caps work per cycle (excess is logged, never silent).
  attention: {
    enabled: true,
    scanMs: 1500,
    debounceScans: 2,
    maxPanes: 24,
  },
  // The tunnels that can front this server. Enabling several is normal: they
  // all keep reaching the server, and `prefer` only decides which one gets
  // baked into bookmarks and pairing payloads (first entry that can name a URL
  // wins). Only ngrok is supervised by airc — it spawns and restarts the agent;
  // the others are routes someone else keeps up, so airc just needs the URL.
  // The legacy top-level `ngrok` block and `publicUrl` string still load: see
  // normalizeTunnels().
  tunnels: {
    prefer: ["ngrok", "tailscale", "external"],
    ngrok: {
      // Off by default: the zero-setup path is LAN/browser access, which needs
      // no account. Set enabled:true (and a real domain) only after configuring
      // ngrok for away-from-home access. See INSTALLATION.md.
      enabled: false,
      domain: "your-domain.ngrok-free.dev",
      binary: "ngrok",
      apiUrl: "http://127.0.0.1:4040",
    },
    // Tailscale Funnel, brought up out-of-band with `tailscale funnel --bg PORT`
    // (which prints the https://<host>.ts.net URL to paste here).
    tailscale: { enabled: false, url: "" },
    // Any other tunnel or reverse proxy you run yourself — Cloudflare Tunnel,
    // Caddy, `ssh -R`. Also where a legacy top-level `publicUrl` lands.
    external: { enabled: false, url: "" },
  },
  // Voice dictation through dais (the local voice daemon): a mic button in the
  // control bar records and types the transcript into the pane you're viewing.
  // OFF by default, and not merely for tidiness — with this on, the control
  // token can open the laptop's MICROPHONE, which is a new capability class
  // rather than more typing. Turn it on only where that is understood.
  // Empty socket → $XDG_RUNTIME_DIR/dais/control.sock.
  dais: {
    enabled: false,
    socket: "",
  },
  // A self-signed cert is generated on first run so the Android app can talk
  // HTTPS/WSS over the LAN (pinned via the QR payload). Browsers keep using the
  // plain HTTP port — they can't accept a self-signed cert. Self-disables if
  // openssl is unavailable. Empty paths fall back to .airc-tls-{key,cert}.pem.
  tls: {
    enabled: true,
    port: 8443,
    keyPath: "",
    certPath: "",
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
    } else if (item === "--no-tunnels") {
      args.noTunnels = true;
    } else if (item === "--no-tls") {
      args.noTls = true;
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

// Base64 of the cert's DER SHA-256 — the value the app pins. Computed from the
// cert (never persisted) so it can't desync from what the server presents.
function certFingerprint(certPem) {
  const der = new crypto.X509Certificate(certPem).raw;
  return crypto.createHash("sha256").update(der).digest("base64");
}

// Generate (once) and load the self-signed TLS key/cert. Mirrors the token
// persistence below: generate on first run, reuse thereafter, lock to 0600.
// Returns { key, cert, fingerprint } or null if disabled / openssl is missing.
// Pushes any failure onto `warnings` rather than throwing — HTTP must keep
// working on a box without openssl.
function ensureTlsMaterials(config, warnings) {
  if (!config.tls || !config.tls.enabled) {
    return null;
  }
  const keyPath = config.tls.keyPath || DEFAULT_TLS_KEY_PATH;
  const certPath = config.tls.certPath || DEFAULT_TLS_CERT_PATH;
  try {
    const haveKey = fs.existsSync(keyPath) && fs.statSync(keyPath).size > 0;
    const haveCert = fs.existsSync(certPath) && fs.statSync(certPath).size > 0;
    if (!haveKey || !haveCert) {
      // SAN is a fixed placeholder: the app verifies by pinned fingerprint, not
      // hostname, so the IP here is irrelevant and a fixed value survives DHCP
      // changes without forcing a regen + re-pair. -nodes leaves the key
      // unencrypted (the file is 0600); 10-year life since it's pinned, not CA-trusted.
      execFileSync("openssl", [
        "req", "-x509", "-newkey", "ec",
        "-pkeyopt", "ec_paramgen_curve:P-256",
        "-keyout", keyPath, "-out", certPath,
        "-days", "3650", "-nodes",
        "-subj", "/CN=airc-tmux-remote",
        "-addext", "subjectAltName=IP:0.0.0.0",
      ], { stdio: "pipe" });
      fs.chmodSync(keyPath, 0o600);
      fs.chmodSync(certPath, 0o600);
    }
    const key = fs.readFileSync(keyPath, "utf8");
    const cert = fs.readFileSync(certPath, "utf8");
    return { key, cert, fingerprint: certFingerprint(cert) };
  } catch (error) {
    warnings.push(`TLS disabled: could not generate/load self-signed cert (${error.message}); serving HTTP only`);
    return null;
  }
}

const TUNNEL_NAMES = ["ngrok", "tailscale", "external"];

// Trailing slashes would produce "https://host//?k=..." in every bookmark and
// pairing payload, so normalize once at load — and reject a bare hostname here
// rather than at the first tap on a dead bookmark.
function normalizeTunnelUrl(value, label) {
  const url = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  if (url && !/^https?:\/\//.test(url)) {
    throw new Error(`${label} must start with http:// or https://`);
  }
  return url;
}

// Build config.tunnels from the file, accepting both the current `tunnels`
// block and the legacy shape it replaced (a top-level `ngrok` object plus a
// `publicUrl` string). A legacy file also keeps its old precedence — publicUrl
// used to outrank ngrok — so upgrading airc never silently re-points an
// existing pairing at a different tunnel. Configs that opt into `tunnels` get
// the new default order, ngrok first.
function normalizeTunnels(fileConfig) {
  const file = fileConfig.tunnels || {};
  const legacyPublicUrl = normalizeTunnelUrl(fileConfig.publicUrl, "publicUrl");
  const tunnels = {
    // A legacy top-level `ngrok` merges under an explicit tunnels.ngrok, so a
    // half-migrated file resolves to the block that was written last.
    ngrok: { ...DEFAULTS.tunnels.ngrok, ...(fileConfig.ngrok || {}), ...(file.ngrok || {}) },
    tailscale: { ...DEFAULTS.tunnels.tailscale, ...(file.tailscale || {}) },
    external: { ...DEFAULTS.tunnels.external, ...(file.external || {}) },
  };
  if (legacyPublicUrl && !tunnels.external.url) {
    tunnels.external = { enabled: true, url: legacyPublicUrl };
  }
  for (const name of TUNNEL_NAMES) {
    tunnels[name].enabled = Boolean(tunnels[name].enabled);
    if (name !== "ngrok") {
      tunnels[name].url = normalizeTunnelUrl(tunnels[name].url, `tunnels.${name}.url`);
    }
  }

  const prefer = Array.isArray(file.prefer)
    ? file.prefer
    : (legacyPublicUrl ? ["external", ...DEFAULTS.tunnels.prefer] : DEFAULTS.tunnels.prefer);
  tunnels.prefer = [];
  for (const name of prefer) {
    if (!TUNNEL_NAMES.includes(name)) {
      throw new Error(`tunnels.prefer: unknown tunnel "${name}" (known: ${TUNNEL_NAMES.join(", ")})`);
    }
    if (!tunnels.prefer.includes(name)) {
      tunnels.prefer.push(name);
    }
  }
  // A partial `prefer` ranks the rest last rather than hiding them: an enabled
  // tunnel left off the list is still a route, just the least preferred one.
  for (const name of TUNNEL_NAMES) {
    if (!tunnels.prefer.includes(name)) {
      tunnels.prefer.push(name);
    }
  }
  return tunnels;
}

// The URL a tunnel would advertise, or "" when it is off or can't name one.
// ngrok's reserved domain is known before the agent is up, so it can be
// advertised from the first request; `liveNgrokUrl` (what the agent actually
// reports) replaces it once known — the two differ only without a reserved
// domain.
function tunnelUrl(config, name, liveNgrokUrl = "") {
  const tunnel = config.tunnels[name];
  if (!tunnel || !tunnel.enabled) {
    return "";
  }
  if (name === "ngrok") {
    return liveNgrokUrl || (tunnel.domain ? `https://${tunnel.domain}` : "");
  }
  return tunnel.url;
}

// The advertised route: the first tunnel in `prefer` that can name a URL. The
// others stay perfectly reachable — they're just not what bookmarks, the
// pairing QR and /api/config point at.
function advertisedUrl(config, liveNgrokUrl = "") {
  for (const name of config.tunnels.prefer) {
    const url = tunnelUrl(config, name, liveNgrokUrl);
    if (url) {
      return url;
    }
  }
  return "";
}

function anyTunnelEnabled(config) {
  return TUNNEL_NAMES.some((name) => config.tunnels[name].enabled);
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
    tunnels: normalizeTunnels(fileConfig),
    attention: { ...DEFAULTS.attention, ...(fileConfig.attention || {}) },
    dais: { ...DEFAULTS.dais, ...(fileConfig.dais || {}) },
    tls: { ...DEFAULTS.tls, ...(fileConfig.tls || {}) },
  };
  // publicUrl is a file-level alias for tunnels.external.url (see
  // normalizeTunnels); drop the raw key so nothing reads it as a second,
  // stale source of the advertised address.
  delete config.publicUrl;
  if (args.host !== undefined) config.host = args.host;
  if (args.port !== undefined) config.port = args.port;
  if (args.noNgrok) config.tunnels.ngrok = { ...config.tunnels.ngrok, enabled: false };
  if (args.noTunnels) {
    for (const name of TUNNEL_NAMES) {
      config.tunnels[name] = { ...config.tunnels[name], enabled: false };
    }
  }
  if (args.noTls) config.tls = { ...config.tls, enabled: false };

  // sessions[] is canonical, resolved by precedence (not merged): CLI --session
  // (repeatable) wins, else a file `sessions` array, else a legacy file `session`
  // string, else the built-in default. config.session is kept as the primary
  // session so singular readers still work.
  config.sessions =
    normalizeSessions(args.sessions).length ? normalizeSessions(args.sessions)
      : normalizeSessions(fileConfig.sessions).length ? normalizeSessions(fileConfig.sessions)
        : normalizeSessions(fileConfig.session).length ? normalizeSessions(fileConfig.session)
          : normalizeSessions(DEFAULTS.sessions);
  config.session = config.sessions[0];

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("port must be an integer between 1 and 65535");
  }

  // An absolute path or nothing: a relative socket path would resolve against
  // whatever directory the server happened to be started from, which fails only
  // later, at the first mic tap.
  config.dais = {
    enabled: Boolean(config.dais.enabled),
    socket: typeof config.dais.socket === "string" ? config.dais.socket.trim() : "",
  };
  if (config.dais.socket && !path.isAbsolute(config.dais.socket)) {
    throw new Error("dais.socket must be an absolute path (or empty for $XDG_RUNTIME_DIR/dais/control.sock)");
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

  const warnings = tokenWarnings(config);
  const tls = ensureTlsMaterials(config, warnings);

  return { config, flags: args.flags, configPath, warnings, tls };
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

function baseUrl(config, liveNgrokUrl = "") {
  return advertisedUrl(config, liveNgrokUrl) || `http://127.0.0.1:${config.port}`;
}

function publicBaseUrl(config, actualBaseUrl = "") {
  return actualBaseUrl || baseUrl(config);
}

function bookmarkUrl(config, level = "view", actualBaseUrl = "") {
  const token = level === "control" ? config.controlToken : config.viewToken;
  return `${publicBaseUrl(config, actualBaseUrl)}/?k=${token}`;
}

function pairingPayload(config, actualBaseUrl = "", tls = null) {
  // lanUrls stay http:// — they're shared with the browser viewer, which can't
  // use the self-signed cert. The app rewrites them to https://IP:tlsPort itself
  // when certFingerprint is present (it pins by fingerprint, so the IP is fine).
  const lanUrls = localLanAddresses(config.port);
  // With any tunnel configured, the app should pair on the public route and
  // fall back to LAN; with none (`--no-tunnels`, i.e. `tools/airc local`) a LAN
  // address beats the 127.0.0.1 the base URL would otherwise be.
  const preferredBaseUrl = actualBaseUrl
    || (anyTunnelEnabled(config) ? baseUrl(config) : (lanUrls[0] || baseUrl(config)));
  const sessions = config.sessions || [config.session];
  // Globs aren't session names, so they'd read as noise in the app's device
  // label ("thinkpad *"). Name the device after the sessions it is pinned to,
  // or after the host alone when the scope is "whatever is running".
  const named = sessions.filter((session) => !/[*?]/.test(session));
  return {
    type: "airc-tmux-remote",
    version: 2,
    name: [os.hostname(), named.join(", ")].filter(Boolean).join(" "),
    baseUrl: preferredBaseUrl,
    token: config.controlToken,
    session: config.session,
    sessions,
    lanUrls,
    publicUrl: publicBaseUrl(config, actualBaseUrl),
    certFingerprint: tls ? tls.fingerprint : "",
    tlsPort: tls ? config.tls.port : 0,
  };
}

module.exports = {
  loadConfig,
  bookmarkUrl,
  pairingPayload,
  localLanAddresses,
  publicBaseUrl,
  advertisedUrl,
  tunnelUrl,
  tokenWarnings,
  TUNNEL_NAMES,
  DEFAULT_CONFIG_PATH,
};
