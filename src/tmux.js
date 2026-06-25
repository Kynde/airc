"use strict";

const { execFile } = require("node:child_process");

function run(args, timeout = 1500) {
  return new Promise((resolve) => {
    execFile("tmux", args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, stdout: "", error: stderr.trim() || error.message });
        return;
      }
      resolve({ ok: true, stdout, error: "" });
    });
  });
}

const META_FORMAT = [
  "#{pane_id}",
  "#{window_id}",
  "#{window_index}",
  "#{window_name}",
  "#{pane_index}",
  "#{pane_title}",
  "#{pane_width}",
  "#{pane_height}",
  "#{cursor_x}",
  "#{cursor_y}",
  "#{session_name}",
].join("\t");

function parseMeta(line) {
  const parts = line.split("\t");
  if (parts.length < 11 || !parts[0].startsWith("%")) {
    return null;
  }
  return {
    paneId: parts[0],
    windowId: parts[1],
    windowIndex: Number(parts[2]),
    windowName: parts[3],
    paneIndex: Number(parts[4]),
    paneTitle: parts[5],
    width: Number(parts[6]),
    height: Number(parts[7]),
    cursorX: Number(parts[8]),
    cursorY: Number(parts[9]),
    session: parts[10],
  };
}

async function paneMeta(target) {
  const result = await run(["display-message", "-p", "-t", target, "-F", META_FORMAT]);
  if (!result.ok) {
    return null;
  }
  return parseMeta(result.stdout.split("\n")[0]);
}

async function activePane(session) {
  return paneMeta(`=${session}:`);
}

async function capturePane(paneId) {
  const result = await run(["capture-pane", "-p", "-e", "-t", paneId]);
  if (!result.ok) {
    return { ok: false, text: "", error: result.error };
  }
  return { ok: true, text: result.stdout.replace(/\s+$/u, ""), error: "" };
}

// Plain (no `-e`) capture for attention detection: the recognizers match on
// text, never colour, so the SGR codes `-e` adds would only get in the way.
async function capturePanePlain(paneId) {
  const result = await run(["capture-pane", "-p", "-t", paneId]);
  if (!result.ok) {
    return { ok: false, text: "", error: result.error };
  }
  return { ok: true, text: result.stdout.replace(/\s+$/u, ""), error: "" };
}

async function listPanes(session) {
  const format = [
    "#{pane_id}",
    "#{window_index}",
    "#{window_name}",
    "#{pane_index}",
    "#{pane_title}",
    "#{pane_width}",
    "#{pane_height}",
    "#{window_active}#{pane_active}",
    "#{pane_current_command}",
  ].join("\t");
  const result = await run(["list-panes", "-s", "-t", `=${session}`, "-F", format]);
  if (!result.ok) {
    return null;
  }
  return result.stdout.split("\n").filter(Boolean).map((line) => {
    const parts = line.split("\t");
    return {
      session,
      paneId: parts[0],
      windowIndex: Number(parts[1]),
      windowName: parts[2],
      paneIndex: Number(parts[3]),
      paneTitle: parts[4],
      width: Number(parts[5]),
      height: Number(parts[6]),
      active: parts[7] === "11",
      command: parts[8] || "",
    };
  });
}

// Glob support for configured session entries: `*` matches any run of
// characters and `?` a single one, like filename globbing. An entry with
// neither is treated as a literal session name.
function isSessionGlob(pattern) {
  return /[*?]/.test(pattern);
}

function globToRegExp(pattern) {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

// All live tmux session names, in tmux's own listing order.
async function listSessions() {
  const result = await run(["list-sessions", "-F", "#{session_name}"]);
  if (!result.ok) {
    return [];
  }
  return result.stdout.split("\n").filter(Boolean);
}

// Resolve configured session entries to concrete names. Literals pass through
// unchanged (and are still tried even when not currently live, as before);
// glob entries like `foo*` expand to every matching live session. Order
// follows the configured entries, glob matches in tmux's listing order, with
// duplicates removed. tmux is only queried when a glob is actually present, so
// plain-name configs keep their previous behaviour and cost nothing extra.
async function expandSessions(patterns) {
  if (!patterns.some(isSessionGlob)) {
    return [...patterns];
  }
  const live = await listSessions();
  const out = [];
  const add = (name) => {
    if (!out.includes(name)) out.push(name);
  };
  for (const pattern of patterns) {
    if (isSessionGlob(pattern)) {
      const re = globToRegExp(pattern);
      live.filter((name) => re.test(name)).forEach(add);
    } else {
      add(pattern);
    }
  }
  return out;
}

// List panes across several sessions, tagged by session and grouped in the
// order requested. Sessions that don't exist are skipped silently.
async function listPanesForSessions(sessions) {
  const results = await Promise.all(sessions.map((session) => listPanes(session)));
  const panes = [];
  for (const group of results) {
    if (group) {
      panes.push(...group);
    }
  }
  return panes;
}

async function sessionExists(session) {
  const result = await run(["has-session", "-t", `=${session}`]);
  return result.ok;
}

async function resizeWindow(windowId, cols, rows) {
  const result = await run(["resize-window", "-t", windowId, "-x", String(cols), "-y", String(rows)]);
  return result.ok;
}

async function sendText(target, text) {
  const result = await run(["send-keys", "-t", target, "-l", text], 2500);
  return result.ok ? { ok: true, error: "" } : { ok: false, error: result.error };
}

const ALLOWED_KEYS = new Set(["Enter", "Up", "Down", "Left", "Right", "Tab", "Escape", "Space", "Backspace", "C-b", "C-c", "C-u", "C-w", "C-d", "C-l", "C-r"]);

// tmux's send-keys uses its own special-key names; an unrecognized name is sent
// as literal characters instead. "Backspace" is the intuitive name our clients
// send, but tmux only knows it as "BSpace", so translate at the boundary.
const TMUX_KEY_NAMES = { Backspace: "BSpace" };

async function sendKey(target, key) {
  if (!ALLOWED_KEYS.has(key)) {
    return { ok: false, error: `unsupported key: ${key}` };
  }
  const tmuxKey = TMUX_KEY_NAMES[key] || key;
  const result = await run(["send-keys", "-t", target, tmuxKey], 2500);
  return result.ok ? { ok: true, error: "" } : { ok: false, error: result.error };
}

module.exports = {
  activePane,
  paneMeta,
  capturePane,
  capturePanePlain,
  listPanes,
  listPanesForSessions,
  listSessions,
  expandSessions,
  sessionExists,
  resizeWindow,
  sendText,
  sendKey,
};
