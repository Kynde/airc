"use strict";

// Classify a live tmux pane the way the server's attention scan does: a plain
// capture plus the pane's foreground command, through detectPaneState.
//
//   node scripts/pane-state.js <target> [--save <fixture-name>]
//
// Prints "<agent> <state> (<command>)". --save also writes the capture to
// test/fixtures/<fixture-name>.txt, ready to pin in test/detect.test.js.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { detectPaneState } = require("../src/detect");

const [target, flag, name] = process.argv.slice(2);
if (!target || (flag && (flag !== "--save" || !name))) {
  console.error("usage: node scripts/pane-state.js <target> [--save <fixture-name>]");
  process.exit(2);
}

const tmux = (args) => execFileSync("tmux", args, { encoding: "utf8" });
// Same trimming as capturePanePlain in src/tmux.js.
const text = tmux(["capture-pane", "-p", "-t", target]).replace(/\s+$/u, "");
const command = tmux(["display-message", "-p", "-t", target, "#{pane_current_command}"]).trim();

const { agent, state } = detectPaneState({ text, command });
console.log(`${agent || "-"} ${state} (${command})`);

if (name) {
  const file = path.join(__dirname, "..", "test", "fixtures", `${name}.txt`);
  fs.writeFileSync(file, `${text}\n`);
  console.log(`saved ${path.relative(process.cwd(), file)}`);
}
