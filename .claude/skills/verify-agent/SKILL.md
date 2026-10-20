---
name: verify-agent
description: Check airc's attention detection against a live coding agent. Use when the user runs /verify-agent <agent> (aomp, omp, codex, ac, pc, claude), or says airc misreads an agent's state. Launches the agent in a scratch tmux session, walks it through idle → waiting → busy → idle, classifies every step through src/detect.js, and fixes the detector plus fixtures when a step reads wrong.
argument-hint: aomp | omp | codex | ac | pc | claude
---

# /verify-agent — live-test airc's detector on one agent

Agents redraw their TUI every few releases, and airc's detector (`src/detect.js`)
matches on screen text, so a new look silently turns a pane's dot grey. This
drives the real agent through each state and checks what airc reads.

## Agents

| arg     | what it is                       | launch                                    | detector |
|---------|----------------------------------|-------------------------------------------|----------|
| `aomp`  | oh-my-pi on AWS Bedrock          | `aomp --approval-mode=always-ask`         | `omp`    |
| `omp`   | oh-my-pi, own providers          | `omp --approval-mode=always-ask`          | `omp`    |
| `codex` | OpenAI Codex                     | `codex -a on-request -s read-only`        | `codex`  |
| `ac`    | Claude Code on AWS Bedrock       | `ac --permission-mode default`            | `claude` |
| `pc`    | Claude Code on the Pro licence   | `pc --permission-mode default`            | `claude` |
| `claude`| Claude Code, project settings    | `claude --permission-mode default`        | `claude` |

The flags make the agent ask before running the probe command, which is the
"waiting" state we need to see. Codex only asks when a command needs to leave
its sandbox, hence the read-only sandbox and a probe that writes a file. `ac`/`pc` are zsh aliases for `~/bin/aclaude`
and `~/bin/pclaude`; both `exec` claude, so tmux still reports `claude`.

Anything else: ask which binary it is and how to make it ask for approval.

## Tools

- `node scripts/pane-state.js <target>` — classifies a live pane exactly as the
  server does (plain capture + `#{pane_current_command}` → `detectPaneState`)
  and prints `<agent> <state> (<command>)`.
- `node scripts/pane-state.js <target> --save <name>` — also writes the capture
  to `test/fixtures/<name>.txt`.

States: `idle-input`, `busy`, `waiting`, `none` (= unrecognised; always a bug
here).

Every expectation below is on BOTH fields: the agent must be the table's
detector name, not just the state right. The agent is what the HUD chip names
the pane by (`omp ai:0`), and detectors run in order, so a screen can be
claimed by the wrong one — omp's "❯ Approve" box reads as Claude's composer
if omp's detector misses it. `claude waiting` on an omp pane is a failure.
The command in parentheses should also be the expected binary; a wrapper that
doesn't `exec` would show up as `bash` here and leave detection to text alone.

## Steps

Work in a scratch dir (`$SCRATCH/verify-<arg>`, under the session scratchpad),
in a detached session named `airc-verify`. Never touch the user's own tmux
sessions — they may well be running the same agent, and reading them with
`pane-state.js` is fine, sending keys is not.

**1. Launch.**
```bash
tmux kill-session -t airc-verify 2>/dev/null
tmux new-session -d -s airc-verify -x 140 -y 45 -c "$DIR"
tmux send-keys -t airc-verify '<launch command>' Enter
```
Start through the shell (not `new-session ... <cmd>`) so zsh aliases resolve.
Give it ~15s, then look at the screen. Claude and Codex ask whether to trust a
new folder first — answer that (Enter) before going on; it is not a state under
test.

**2. Idle.** Expect `<detector> idle-input`.

**3. Waiting.** Send a prompt that needs a shell command:
```bash
tmux send-keys -t airc-verify -l 'Run exactly this shell command: `sleep 30 && touch airc-probe`. Then reply with just OK.'
sleep 0.5; tmux send-keys -t airc-verify Enter
```
(Text and Enter separately: some TUIs eat an Enter that arrives in the same
burst as a paste.) Poll every few seconds until the approval box is up, then
expect `<detector> waiting`.

**4. Busy.** Approve (Enter on the default "Approve"/"Yes" option). During the
30s sleep, expect `<detector> busy`. Check twice, a few seconds apart — a spinner that
reads busy on one frame and not the next is worth catching.

**5. Idle again.** Once it has answered, expect `<detector> idle-input`.

**6. Agent-specific extras**, where they exist:
- omp: its *ask* tool is a second kind of waiting — "Use your ask tool to ask
  me whether I prefer red or blue." → `waiting`. Escape dismisses it.
- claude: a plan-mode exit or AskUserQuestion menu is also `waiting`.

Save every capture you check as a fixture candidate
(`--save <detector>-<state>-<tag>`, tag = agent version or something telling)
— cheap to delete later, and they are the evidence for a fix.

**7. Clean up.** `tmux kill-session -t airc-verify`. Don't try to quit the agent
politely: omp ignores Ctrl-C at the prompt, and anything typed after a failed
quit lands in the agent as a prompt.

## When a step reads wrong

1. Read the saved capture and find what changed: the busy line, the footer, the
   menu's help line, the box title. Use the agent's own source or binary when
   the screen is ambiguous (`strings -n 6 <binary> > $SCRATCH/x.strings`, then
   grep the file — grepping the binary itself with `.{0,N}` context is too slow).
   omp's symbol presets (unicode / nerdfont / ascii) change key glyphs, so
   match all three.
2. Fix the agent's block in `src/detect.js`. Keep the old patterns alongside
   the new ones — running sessions only pick up a new look when restarted —
   and update the block comment to describe both generations.
3. Add the new fixtures to `CASES` in `test/detect.test.js`, and to any
   unhinted-command test for that agent (detection must also work when the
   pane's command is `node`/`bun`).
4. `node --test test/*.test.js` and `npm run check` must pass.
5. Re-run the failing steps live until each reads right, and run
   `pane-state.js` over the user's own panes of that agent as a final check.

Report a table of step → expected (agent + state) → got, and what was fixed. Don't commit
unless asked.
