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
  { name: "claude-idle", command: "claude", agent: "claude", state: STATE.IDLE_INPUT },
  { name: "codex-waiting", command: "codex", agent: "codex", state: STATE.WAITING },
  { name: "codex-busy", command: "codex", agent: "codex", state: STATE.BUSY },
  { name: "codex-idle", command: "codex", agent: "codex", state: STATE.IDLE_INPUT },
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
