"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { detectPaneState, STATE } = require("../src/detect");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", `${name}.txt`), "utf8");

// Each case pairs a real `tmux capture-pane -p` fixture with the foreground
// command tmux would report, so detection is exercised exactly as the scanner
// drives it.
const CASES = [
  { name: "claude-waiting", command: "claude", agent: "claude", state: STATE.WAITING },
  { name: "claude-busy", command: "claude", agent: "claude", state: STATE.BUSY },
  { name: "claude-busy-thinking", command: "claude", agent: "claude", state: STATE.BUSY },
  // The first seconds of a turn: the spinner is up but there is no token
  // counter yet — bare ("✽ Cooking…"), then with an effort clause but still no
  // count. Matching the counter read both of these as a FINISHED agent.
  { name: "claude-busy-spinner", command: "claude", agent: "claude", state: STATE.BUSY },
  { name: "claude-busy-effort", command: "claude", agent: "claude", state: STATE.BUSY },
  { name: "claude-idle", command: "claude", agent: "claude", state: STATE.IDLE_INPUT },
  // Finished, but with a half-typed prompt left in the composer: still idle,
  // still awaiting instruction. Anchoring idle on an *empty* "❯" line dropped
  // these panes out of the attention HUD entirely.
  { name: "claude-idle-draft", command: "claude", agent: "claude", state: STATE.IDLE_INPUT },
  // Finished, but the transcript QUOTES spinner lines (an agent that pasted a
  // log, or that works on this very file). Scanning the whole screen read those
  // words as work and pinned the pane orange long after the turn ended, so this
  // capture keeps the busy match bounded to the status area above the composer.
  { name: "claude-idle-quoting-spinner", command: "claude", agent: "claude", state: STATE.IDLE_INPUT },
  { name: "codex-waiting", command: "codex", agent: "codex", state: STATE.WAITING },
  { name: "codex-busy", command: "codex", agent: "codex", state: STATE.BUSY },
  { name: "codex-idle", command: "codex", agent: "codex", state: STATE.IDLE_INPUT },
  { name: "omp-waiting", command: "omp", agent: "omp", state: STATE.WAITING },
  { name: "omp-busy", command: "omp", agent: "omp", state: STATE.BUSY },
  { name: "omp-idle", command: "omp", agent: "omp", state: STATE.IDLE_INPUT },
  { name: "copilot-waiting", command: "copilot", agent: "copilot", state: STATE.WAITING },
  { name: "copilot-busy", command: "copilot", agent: "copilot", state: STATE.BUSY },
  { name: "copilot-idle", command: "copilot", agent: "copilot", state: STATE.IDLE_INPUT },
];

for (const c of CASES) {
  test(`${c.name} → ${c.agent}/${c.state}`, () => {
    const result = detectPaneState({ text: fixture(c.name), command: c.command });
    assert.strictEqual(result.agent, c.agent, `agent for ${c.name}`);
    assert.strictEqual(result.state, c.state, `state for ${c.name}`);
  });
}

// Negatives: a plain shell and a pager must never be flagged, by command and by
// content (a shell whose foreground command is momentarily something else still
// must not trip an agent signature).
for (const name of ["shell", "pager"]) {
  test(`${name} → not an agent`, () => {
    const byCommand = detectPaneState({ text: fixture(name), command: "zsh" });
    assert.strictEqual(byCommand.state, STATE.NONE, `${name} state`);
    assert.strictEqual(byCommand.agent, "", `${name} agent`);
  });
}

// Identification must work even when the foreground command is a wrapper (the
// real-world `node`/`python` launcher case), via on-screen chrome alone.
test("claude recognized without command hint", () => {
  const result = detectPaneState({ text: fixture("claude-waiting"), command: "node" });
  assert.strictEqual(result.agent, "claude");
  assert.strictEqual(result.state, STATE.WAITING);
});

test("codex recognized without command hint", () => {
  const result = detectPaneState({ text: fixture("codex-busy"), command: "node" });
  assert.strictEqual(result.agent, "codex");
  assert.strictEqual(result.state, STATE.BUSY);
});

test("copilot recognized without command hint", () => {
  const result = detectPaneState({ text: fixture("copilot-busy"), command: "node" });
  assert.strictEqual(result.agent, "copilot");
  assert.strictEqual(result.state, STATE.BUSY);
});

test("omp recognized without command hint", () => {
  const result = detectPaneState({ text: fixture("omp-busy"), command: "node" });
  assert.strictEqual(result.agent, "omp");
  assert.strictEqual(result.state, STATE.BUSY);
});

// Regression: omp's approval box lists "❯ Approve" / "  Deny", and that first
// line is exactly Claude's idle-composer signature, so a waiting omp pane must
// still be claimed by the omp detector (which sits ahead of claude) — including
// when the command hint is a wrapper and can't disambiguate.
test("omp waiting not misattributed to claude", () => {
  for (const command of ["omp", "node"]) {
    const result = detectPaneState({ text: fixture("omp-waiting"), command });
    assert.strictEqual(result.agent, "omp", `agent with command=${command}`);
    assert.strictEqual(result.state, STATE.WAITING, `state with command=${command}`);
  }
});

// Regression: Copilot's "❯ 1. Yes" approval menu also matches Claude's chrome,
// so a waiting Copilot pane must still be claimed by the copilot detector
// (which sits ahead of claude) even when the command hint can't disambiguate.
test("copilot waiting not misattributed to claude", () => {
  for (const command of ["copilot", "node"]) {
    const result = detectPaneState({ text: fixture("copilot-waiting"), command });
    assert.strictEqual(result.agent, "copilot", `agent with command=${command}`);
    assert.strictEqual(result.state, STATE.WAITING, `state with command=${command}`);
  }
});
