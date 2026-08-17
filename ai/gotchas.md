# Gotchas

`fact :: detail`. Non-obvious, paid-for knowledge — verify against code/reality
before deleting anything here.

## tmux

tmux display-message cannot validate targets :: it exits 0 with empty/garbage fields for an unknown target and silently falls back to the current client; pane-existence checks must parse the result and require a leading `%` (paneMeta returns null otherwise) — never trust the exit code.
pane ids are the trust boundary for targets :: any client-supplied pane must match `^%\d+$` before reaching tmux (server.js resolveInputTarget + frame/ws view handling); this is what keeps `-t <target>` from being abused.
capture uses `-e`, attention scan does NOT :: `capturePane` passes `-e` (emit SGR) for rendering; `capturePanePlain` omits it because detectors match on text and color codes would only get in the way. Two functions on purpose.
sessions are tried even when dead :: a literal (non-glob) configured session stays in the candidate list even if not currently live, so the active-pane resolver can pick it up the moment it appears; only glob entries are filtered to live sessions.

## Auth & secrets

protected routes return 404, not 401 :: deliberate, to avoid advertising the private surface; an agent expecting 401/403 on bad auth will be surprised.
tokens are auto-generated AND written back :: first `loadConfig` with empty tokens generates them and rewrites config.json (mode 0600). A missing token is not an error — it's a one-time provisioning step. Clearing a token in config.json regenerates a strong one on next start.
weak configured tokens are accepted :: non-empty tokens shorter than 32 chars are NOT replaced automatically; startup logs a warning and keeps running. To rotate, clear the field and restart so loadConfig generates a strong token.
the log is a secret sink, now redacted :: server `log()` masks `?k=…` and `"token":"…"` before writing, because `.airc-server.log` is long-lived on disk. Any NEW code that logs a URL or pairing payload must go through `log()`, not raw `console.log`, or it will leak the control token.
clientAddress trusts X-Forwarded-For :: behind ngrok the first XFF value is taken as the client IP. Rate-limiting and the WS-per-IP cap key on it, so a client that forges XFF can dodge both — these raise the bar against naive guessing, not a determined attacker.
healthz requires a token :: it is NOT loopback-exempt (the old "no XFF + loopback" bypass was removed as proxy-spoofable); `tools/airc` authenticates its own health probe with the control token. A token-less GET /healthz returns 404.

## Attention feature (src/detect.js + scan loop)

detect.js is intentionally version-fragile :: it keys on each coding agent's visible TUI (spinner text, menu glyphs, status footers), which agents change between releases. A break is expected over time; fix it in this one file and the test/fixtures/*.txt captures, which exist precisely so a drift fails loudly.
waiting wins over busy/idle in classification :: a busy Claude pane also shows an empty `❯` box and a menu can co-exist with stale spinner text, so detectors check WAITING first. Don't reorder.
scan self-gates on viewers :: `scanAttention` does nothing unless `viewerCount() > 0` (at least one open websocket). No viewer connected → no scanning, even with `attention.enabled`. Poll-only (no-WS) clients read `GET /api/attention` instead.
hook beats screen for 15s :: a `POST /api/agent/event` signal is authoritative over the screen scan for HOOK_TTL_MS; within that window the scan only refreshes display metadata, not state. Lets hook-capable agents report instantly while everyone else works zero-config.
waiting/idle are debounced, busy/none are immediate :: a new waiting/idle-input state must persist `config.attention.debounceScans` consecutive scans before it's published (kills mid-render false "needs you"); busy and clearing apply at once.
shell panes are skipped :: panes whose `#{pane_current_command}` is in SHELL_COMMANDS (zsh/bash/sh/fish/login/tmux) are not scanned; only candidate (agent-ish) panes count toward `maxPanes`, and excess is logged, never silently dropped.
"esc to interrupt" is Codex's busy marker, NOT Claude's :: current Claude Code shows no such string — its busy signal is the spinner-with-token-counter line (`✽ Beaming… (9m 3s · ↓ 42.7k tokens)`), which is what CLAUDE_BUSY actually matches; `esc to interrupt` is kept only as a legacy fallback. Codex genuinely prints `esc to interrupt` while working. Don't "unify" the two on that string — they earned their separate regexes by being captured live.
Codex in full-auto never renders an approval prompt :: the screen `waiting` detector only fires for Codex when it's run with `--ask-for-approval` (e.g. `on-request`); in default auto mode Codex just runs commands, so there's no on-screen prompt to catch and the hook (`POST /api/agent/event`) is the only reliable Codex `waiting` signal. Claude's plan/permission menu, by contrast, is on-screen and detectable.
re-capture fixtures from a SEPARATE pane :: `test/fixtures/*.txt` were grabbed from live agent panes; capturing from the pane your own agent runs in pollutes the fixture with the agent's own scrollback. Spawn a throwaway tmux window for the target agent, capture that, then kill it.
CLAUDE_BUSY must NOT anchor on the closing paren :: newer Claude appends a clause after the token count, e.g. `(7m 50s · ↓ 29.8k tokens · still thinking with xhigh effort)`, so the regex ends the busy signal at `tokens?\b`, not `tokens?\)`. Anchoring on `)` made a thinking pane miss the busy match and fall through to the empty-`❯` idle check — so a running agent showed as finished. Pinned by `claude-busy-thinking.txt`.
auto-follow order ≠ chip/server order :: the server ranks attention items `waiting → idle-input → busy` (chip row + `GET /api/attention`; busy last so a worker never buries a finished agent), but auto-FOLLOW ranks `waiting → busy → idle-input` — a running agent is worth watching over a finished one. Each client therefore computes its own auto target by rank; do NOT "simplify" applyAuto to follow `attentionList[0]`, that reintroduces the busy-buried-by-idle bug. autoTarget()/AUTO_RANK in public/app.js, applyAuto()/autoRank() in MainActivity.kt — keep the two in lockstep.
auto is sticky BY URGENCY, not just when-empty :: applyAuto only moves to a pane strictly MORE urgent than the one you're viewing (by the rank above), so parking on a running agent holds even as other agents work or finish — only a higher rank (e.g. a fresh `waiting`) pulls you off. What turns auto OFF: the manual pane/session picker (explicit take-over) and the first keystroke in the input box; tapping an attention CHIP does NOT (selectChip pins without setAuto(false), so auto keeps tracking).

## Voice dictation (src/dais.js + the mic button)

enabling dais widens the control token to a MICROPHONE :: the token was already a remote-shell credential (it types into tmux); with `dais.enabled` it can also open the laptop's mic and read where speech is aimed — a new capability class, not more typing. That's the whole reason the feature is opt-in per install, and why both routes 404 (never 401) below control level.
`/api/dais/status` is control-gated, unlike `/api/attention` :: it's a read, but "the mic on that laptop is open right now" is not something a shared read-only link should report — and only a control client can press the button anyway. Don't "fix" it down to view level.
$DAIS_SOCKET is deliberately NOT honored :: dais's own CLI reads that env var; airc takes the socket from its config only. If it honored the env, a private test daemon exported in the operator's shell could silently re-aim the mic of an already-running server.
the status poll reads FILES, not the socket :: socket exists → daemon live; `mic-recording` marker → mic open; `state.json` → mode/target/muted/dry_run. That's why a 1s poll is affordable and why the feature needed no new dais op. A stale `state.json` outliving a crashed daemon must still read as unavailable — `available` comes from the socket alone.
a torn `state.json` is an expected read, not a bug :: dais rewrites it on every transition, so `JSON.parse` failure is caught and dropped on purpose; `available` + `micOpen` come from filesystem existence and still answer the question the button must get right.
the browser always sends `action:"toggle"` :: never start/stop, so dais resolves it against its own mode. A browser that missed a poll — or a recording latched at the laptop with `dais-ctl`/`dais-top` — can't be inverted by a stale button. `stop` transcribes, `discard` throws the recording away (dais's own latch-vs-voice-off rule).
`stop`/`discard` carry no pane on purpose :: only `start`/`toggle` resolve a target. Demanding a live pane to stop would strand an open mic when the pane it was aimed at died.
the mic button greys out, it does not disappear :: hidden only when `dais.enabled` is false (nothing to explain); when configured-but-not-running it stays visible and disabled with the reason in `title`. A control that vanishes mid-drive is worse than one that says why it can't help. Muted/dry-run are appended to the title for the same reason — the tap looks like it worked and no text arrives.
a mic tap drops auto mode :: mirrors "the first keystroke drops auto". Without it, auto could slide the view — and the user's Enter tap — to a different pane than the one the recording is aimed at, since the transcript is typed but never submitted.
503 vs 409 is a real distinction :: 503 = airc couldn't reach dais (`unavailable:true` from src/dais.js), 409 = dais itself refused (VAD session already listening, pane gone). The browser shows `error` either way; keep the split so the log and any future client stay honest.

## Build, test, release

`npm run check` does NOT run tests :: it only runs `node --check` (syntax) over src/ and public/. The detect unit tests run via `node --test 'test/*.test.js'` and are not wired into any npm script or `make check` — run them by hand after touching detect.js.
Android versionName/versionCode are static on purpose :: never bump them in a release; only the git tag + package.json move. (Documented in the release skill, repeated here because it's a natural mistake.)
release version comes from the latest git TAG, not package.json :: package.json may be pre-bumped ahead of the tag; trusting it would skip a number. gh release creates the tag on the remote only — it must be fetched back so `git describe` (= the server/app build string) resolves to the new tag.

## Misc

resizeToViewport reshapes the laptop's real window :: it's not a per-client view size — `tmux resize-window` changes the window everyone (including the user at the laptop) sees. Off by default for this reason.
no systemd unit :: `tools/airc` runs a detached `node` process tracked by `.airc-server.{pid,json,log}`; there is no service. Killing the shell can orphan it; use `tools/airc off`. State files are gitignored.
ngrok free tier = one agent :: a manually-started ngrok blocks airc's supervised child, and the free tier adds an interstitial. If the tunnel won't come up, check for a stray ngrok first (`docs/operations.md` troubleshooting).
Android 127.0.0.1 means the phone :: if a phone pairs from a payload containing `127.0.0.1` (e.g. non-local mode without a LAN bind), the app points at itself. Local mode prefers a LAN URL precisely to avoid this.
WebSocket first frame waits for view state :: server sends `hello` immediately but no frame until the client sends `{type:"view"}`; otherwise a pinned reconnect briefly shows the active pane. Any new WS client must send view state on open and after pin/session/font-fit changes.
Android can recover LAN while on ngrok :: a live tunnel websocket parks HTTP polling, so the app separately refreshes `/api/config` every 30s over the tunnel and probes saved LAN URLs every 15s; when LAN answers it closes the WS so the poll loop reconnects locally.
