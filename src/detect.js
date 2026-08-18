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
//   "idle-input" — finished, sitting at the input box awaiting instruction
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

// --- Claude Code -----------------------------------------------------------
// busy:   spinner with a live elapsed-time + token counter, e.g.
//           "✽ Beaming… (9m 3s · ↓ 42.7k tokens)"  /  "✶ Sock-hopping… (4s · ↓ 111 tokens)"
//         Newer builds append a trailing clause after the count, e.g.
//           "… (7m 50s · ↓ 29.8k tokens · still thinking with xhigh effort)",
//         so the token counter is not anchored to the closing paren.
//         (older builds showed "esc to interrupt"; kept as an alternative.)
// waiting: a highlighted numbered menu line, e.g. "❯ 1. Yes, auto-accept edits".
// idle:    the composer box — a line opening with the "❯" prompt arrow. It need
//          not be empty: an agent that finished and left a half-typed prompt
//          sitting there is still awaiting instruction, and anchoring on an
//          empty box dropped those panes out of the HUD entirely.
const CLAUDE_BUSY = /\(\d+m?\s*\d*s\s*·[^)]*tokens?\b|esc to interrupt/;
const CLAUDE_MENU = /❯\s+\d+\.\s/;
const CLAUDE_PROMPT = /^\s*❯(?:\s|$)/m;
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

// --- oh-my-pi (omp) --------------------------------------------------------
// busy:    the working line carries a bracketed interrupt hint, e.g.
//            "⠋ Working… ⟦esc⟧"  /  "⠸ Merging PR 4477 and confirming ⟦esc⟧"
//          The status text is whatever the agent is doing, so the hint is the
//          only fixed part. Its brackets follow omp's `symbolPreset` setting —
//          ⟦⟧ (unicode), ⟨⟩ (nerdfont) or [] (ascii) — so all three count. A
//          command run from the "!" shell prefix uses a different loader,
//          "⠇ Running… (esc to cancel)", which is equally busy.
// waiting: every blocking prompt — tool approval, plan review, the ask tool,
//          an extension's own dialog — renders through one selector, whose
//          help line is invariant across all of them. Tool approvals title the
//          box "Allow tool: <name>" over the "❯ Approve / Deny" options.
// idle:    the composer, under a status line that opens with omp's π mark
//          ("pi" under the ascii preset) — the one piece of the configurable
//          status line that every preset keeps.
// NOTE: the approval box's "❯ Approve" line also trips CLAUDE_PROMPT, so this
// detector must sit ahead of Claude in DETECTORS (see the copilot note above).
const OMP_BUSY = /[⟦⟨[]esc[⟧⟩\]]|\(esc to cancel\)/;
const OMP_WAITING = /up\/down navigate\s+enter (?:select|toggle)|^\s*Allow tool:\s/m;
const OMP_STATUS = /[╭.][─-]{2,}\s*(?:π|pi)\s/;
const OMP_CHROME = /omp v\d|[⟦⟨[]esc[⟧⟩\]]|up\/down navigate\s+enter (?:select|toggle)|^\s*Allow tool:\s/m;

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
    // Ahead of Claude for the same reason Copilot is: omp's approval box lists
    // its options behind "❯", which CLAUDE_PROMPT reads as an idle composer.
    name: "omp",
    matches: ({ command, text }) => command === "omp" || OMP_CHROME.test(text) || OMP_STATUS.test(text),
    classify: ({ text }) => {
      // Waiting first: the selector opens mid-turn, so the working line above
      // it can still be on screen while the agent is blocked on the answer.
      if (OMP_WAITING.test(text)) return STATE.WAITING;
      if (OMP_BUSY.test(text)) return STATE.BUSY;
      if (OMP_STATUS.test(text)) return STATE.IDLE_INPUT;
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

// Classify a single pane. `text` is a plain capture-pane dump; `command` is the
// pane's foreground command (used to route to the right detector and cheaply
// reject shells). Returns { agent, state }.
function detectPaneState({ text = "", command = "" } = {}) {
  for (const detector of DETECTORS) {
    if (!detector.matches({ command, text })) {
      continue;
    }
    const state = detector.classify({ text });
    if (state !== STATE.NONE) {
      return { agent: detector.name, state };
    }
    // A recognized agent in an unclassifiable screen is still "not waiting".
    return { agent: detector.name, state: STATE.NONE };
  }
  return { agent: "", state: STATE.NONE };
}

module.exports = { detectPaneState, STATE };
