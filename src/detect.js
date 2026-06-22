"use strict";

// Per-agent "needs attention" recognizers.
//
// This is the deliberately version-fragile part of the attention feature: it
// keys on the visible TUI of each coding agent, which the agents change between
// releases. Keeping every signature in this one module means a TUI drift is a
// one-file fix, and the unit tests in test/detect.test.js pin them to real
// `tmux capture-pane -p` fixtures so a break is loud.
//
// Each pane is classified into one of:
//   "waiting"    — blocked on a permission/choice prompt (the urgent one)
//   "busy"       — actively working; ignore
//   "idle-input" — finished, sitting at an empty input box awaiting instruction
//   "none"       — not a recognized agent (plain shell, pager, etc.)
//
// detectPaneState({ text, command }) runs the ordered detector list and returns
// the first match. `command` is `#{pane_current_command}` and is the primary
// router; each detector also offers a text-only signature so a pane whose
// foreground command is a wrapper (e.g. `node`) is still recognized.

const STATE = Object.freeze({
  WAITING: "waiting",
  BUSY: "busy",
  IDLE_INPUT: "idle-input",
  NONE: "none",
});

// Confidence per source/strength; lets the scanner and hooks be merged sanely.
const CONFIDENCE = Object.freeze({ waiting: 0.9, busy: 0.85, idleInput: 0.7 });

// --- Claude Code -----------------------------------------------------------
// busy:   spinner with a live elapsed-time + token counter, e.g.
//           "✽ Beaming… (9m 3s · ↓ 42.7k tokens)"  /  "✶ Sock-hopping… (4s · ↓ 111 tokens)"
//         (older builds showed "esc to interrupt"; kept as an alternative.)
// waiting: a highlighted numbered menu line, e.g. "❯ 1. Yes, auto-accept edits".
// idle:    an empty composer box — a line that is just the "❯" prompt arrow.
const CLAUDE_BUSY = /\(\d+m?\s*\d*s\s*·[^)]*tokens?\)|esc to interrupt/;
const CLAUDE_MENU = /❯\s+\d+\.\s/;
const CLAUDE_PROMPT = /^\s*❯\s*$/m;
// Distinctive chrome for command-less identification (the model/footer lines).
const CLAUDE_CHROME = /accept edits on|shift\+tab to cycle|❯\s+\d+\.\s/;

// --- GitHub Copilot CLI ----------------------------------------------------
// busy:    status footer "<spinner> Working   esc cancel"; the spinner glyph
//          animates (○ ◎ ● ◉ …) so key on the stable "Working" + "esc cancel".
// waiting: a boxed approval — "Do you want to run this command?" / "…allow
//          this?" with a numbered "❯ 1. Yes" menu and an invariant
//          "↑/↓ to navigate · enter to select · esc to cancel" footer.
// idle:    the ready footer "/ commands · ? help" under an empty "❯" composer.
// NOTE: Copilot's "❯ 1. Yes" menu also trips Claude's CLAUDE_CHROME, so this
// detector must sit ahead of Claude in DETECTORS; the `copilot` foreground
// command then routes it before the ambiguous chrome is ever consulted.
const COPILOT_BUSY = /\bWorking\b\s+esc cancel/;
const COPILOT_WAITING = /Do you want to (?:run|allow|apply|proceed)\b|↑\/↓ to navigate · enter to select/;
const COPILOT_READY = /\/ commands · \? help/;
const COPILOT_CHROME = /Copilot v\d|\bAIC used\b|\bWorking\s+esc cancel|↑\/↓ to navigate · enter to select/;

// --- Codex -----------------------------------------------------------------
// busy:    status footer "· Working ·" or the "esc to interrupt" hint.
// waiting: approval prompt — "Press enter to confirm or esc to cancel" with a
//          "Would you like to run …?" question and numbered "› 1. Yes" options.
// idle:    status footer "· Ready ·".
const CODEX_BUSY = /·\s*Working\s*·|esc to interrupt/;
const CODEX_WAITING = /Press enter to confirm|Would you like to (?:run|apply|proceed)/;
const CODEX_READY = /·\s*Ready\s*·/;
const CODEX_CHROME = /OpenAI Codex|·\s*(?:Ready|Working)\s*·/;

const DETECTORS = [
  {
    // Ahead of Claude on purpose: Copilot's "❯ 1. Yes" approval menu matches
    // CLAUDE_CHROME, so a command-routed Copilot pane must claim it first.
    name: "copilot",
    matches: ({ command, text }) => command === "copilot" || COPILOT_CHROME.test(text),
    classify: ({ text }) => {
      if (COPILOT_WAITING.test(text)) return STATE.WAITING;
      if (COPILOT_BUSY.test(text)) return STATE.BUSY;
      if (COPILOT_READY.test(text)) return STATE.IDLE_INPUT;
      return STATE.NONE;
    },
  },
  {
    name: "claude",
    matches: ({ command, text }) => command === "claude" || CLAUDE_CHROME.test(text),
    classify: ({ text }) => {
      // Order matters: a busy Claude pane also shows an empty "❯" box, and a
      // menu can briefly co-exist with stale spinner text, so waiting wins.
      if (CLAUDE_MENU.test(text)) return STATE.WAITING;
      if (CLAUDE_BUSY.test(text)) return STATE.BUSY;
      if (CLAUDE_PROMPT.test(text)) return STATE.IDLE_INPUT;
      return STATE.NONE;
    },
  },
  {
    name: "codex",
    matches: ({ command, text }) => command === "codex" || CODEX_CHROME.test(text),
    classify: ({ text }) => {
      if (CODEX_WAITING.test(text)) return STATE.WAITING;
      if (CODEX_BUSY.test(text)) return STATE.BUSY;
      if (CODEX_READY.test(text)) return STATE.IDLE_INPUT;
      return STATE.NONE;
    },
  },
];

function confidenceFor(state) {
  if (state === STATE.WAITING) return CONFIDENCE.waiting;
  if (state === STATE.BUSY) return CONFIDENCE.busy;
  if (state === STATE.IDLE_INPUT) return CONFIDENCE.idleInput;
  return 0;
}

// Classify a single pane. `text` is a plain capture-pane dump; `command` is the
// pane's foreground command (used to route to the right detector and cheaply
// reject shells). Returns { agent, state, confidence }.
function detectPaneState({ text = "", command = "" } = {}) {
  for (const detector of DETECTORS) {
    if (!detector.matches({ command, text })) {
      continue;
    }
    const state = detector.classify({ text });
    if (state !== STATE.NONE) {
      return { agent: detector.name, state, confidence: confidenceFor(state) };
    }
    // A recognized agent in an unclassifiable screen is still "not waiting".
    return { agent: detector.name, state: STATE.NONE, confidence: 0 };
  }
  return { agent: "", state: STATE.NONE, confidence: 0 };
}

module.exports = { detectPaneState, STATE };
