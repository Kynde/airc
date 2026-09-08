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
// busy:   the live spinner line — an animated glyph then a single word ending
//         in the "…" ellipsis, which is the ONE part every build renders:
//           "✽ Cooking…"                                  (nothing to report yet)
//           "✶ Flambéing… (5s · thinking with high effort)"   (no tokens yet)
//           "· Moseying… (6m 28s · ↓ 27.3k tokens · thought for 4s)"
//         The parenthetical is optional and its contents vary (elapsed time,
//         token counter, effort/thinking clause, retry status), so matching it
//         is what kept missing a thinking agent: before the first token of a
//         turn there is no counter at all, and the pane then fell through to
//         the "❯" composer check and reported as FINISHED. The word+ellipsis
//         must be the line's first token — wrapped transcript text ends with
//         "…" too, and the finished-turn marker ("✻ Sautéed for 53s · done
//         4:03 PM") has no ellipsis at all, so neither can trip this.
//         The old time+token parenthetical and "esc to interrupt" are kept as
//         alternatives: they still catch a spinner line clipped by a narrow
//         pane, where the wrap can split the word from its ellipsis.
//         WHERE it matches is half the signature: only the status area just
//         above the composer counts (claudeStatusArea), and only at column 0.
//         An agent that merely TALKS about a spinner — quoting one into its
//         answer, pasting a log, or working on this very file — puts that text
//         in the transcript, which is indented under its "●" bullet and scrolls
//         away from the composer. Scanning the whole screen read those words as
//         work and left a finished agent stuck showing "busy". Across 583 live
//         busy captures the real spinner sat 3-9 lines above the composer,
//         every one of them at column 0.
// waiting: a highlighted numbered menu line, e.g. "❯ 1. Yes, auto-accept edits".
// idle:    the composer box — a line opening with the "❯" prompt arrow. It need
//          not be empty: an agent that finished and left a half-typed prompt
//          sitting there is still awaiting instruction, and anchoring on an
//          empty box dropped those panes out of the HUD entirely.
const CLAUDE_BUSY = /^(?:\S[ \t]+)?[^\s()…]+…(?:[ \t]|$)|\(\d+m?\s*\d*s\s*·[^)]*tokens?\b|esc to interrupt/m;
// How far above the composer the status area reaches. Observed max is 9 lines
// (spinner + a tip or a few todo rows + a blank); 12 leaves room to drift.
const CLAUDE_STATUS_LINES = 12;
const CLAUDE_MENU = /❯\s+\d+\.\s/;
const CLAUDE_PROMPT = /^\s*❯(?:\s|$)/m;
// Same shape, one line at a time: used to find the composer, not to test a screen.
const CLAUDE_PROMPT_LINE = /^\s*❯(?:\s|$)/;
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

// The lines Claude draws between its transcript and its input box — where the
// live spinner lives. Anchored on the LAST "❯" line: the composer is always the
// bottom-most one (earlier "❯" lines are echoed prompts, higher up). A screen
// with no composer at all (a takeover box, a redraw) falls back to the bottom
// of the capture, which is where the status area sits regardless.
function claudeStatusArea(text) {
  const lines = text.split("\n");
  let composer = lines.length;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (CLAUDE_PROMPT_LINE.test(lines[i])) {
      composer = i;
      break;
    }
  }
  return lines.slice(Math.max(0, composer - CLAUDE_STATUS_LINES), composer).join("\n");
}

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
      if (CLAUDE_BUSY.test(claudeStatusArea(text))) return STATE.BUSY;
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
