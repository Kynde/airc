# Glossary

One line per term: `TERM :: definition`. Keep entries grep-friendly — a single
line should carry the whole fact.

viewToken :: token that can only view (frames/config/panes/status/health/attention); generated into config.json if absent. See [[controlToken]].
controlToken :: token that can view AND send input + fetch pairing + post agent events; = a remote-shell credential because input is `tmux send-keys`. Falls back to a legacy `authToken` config key if present.
authLevel :: src/auth.js resolves a presented token to one of `control` / `view` / `none`; the only auth primitive. `none` on a protected route returns 404, never 401 (don't advertise the surface).
presented token :: the token from (in order) `?k=` query, `airc_auth`/`swyd_auth` cookie, `Authorization: Bearer`, `X-Airc-Auth`, or `X-Swyd-Auth` header. The `swyd_*` names are accepted for migration only.
canControl :: `/api/config` field telling the browser UI whether to show input controls; cosmetic — the server independently enforces controlToken on `/api/tmux/input`, `/api/pairing`, `/api/agent/event`.
active pane :: the target when nothing is pinned; resolved as tmux target `=<session>:` and falls back across all configured sessions (sessions[0] first) so losing one session switches rather than blanks. See [[pin]].
pin :: a concrete pane id like `%5` the client locks onto; stored client-side (browser localStorage / Android SharedPreferences). A vanished pin → server returns `pinValid=false` and the client reverts to active.
session glob :: a configured `sessions` entry containing `*` or `?` (e.g. `foo*`) expands to every matching LIVE session, in tmux listing order; entries without glob chars stay exact and are tried even when dead. Resolved in tmux.js expandSessions.
frame :: one captured pane as JSON — pane metadata + cursor + ANSI-rendered `html` + ETag; identical shape whether delivered via `GET /api/tmux/frame` or a WebSocket `{type:"frame"}` message.
ETag :: sha1 over session|paneId|WxH|cursor|pinValid + capture text; drives `If-None-Match`→304 on the poll path and change-detection on the WS path. Capture is request-driven — no background loop unless a viewer is connected (except the attention scan).
attention :: feature that scans NON-viewed panes for coding agents that need interaction and surfaces them; states are waiting/busy/idle-input/none. Config under `config.attention`. See [[detector]], [[attention scan]].
detector :: a per-agent recognizer in src/detect.js keying on the agent's visible TUI; deliberately version-fragile, pinned by fixtures in test/. `detectPaneState({text, command})` returns `{agent, state, confidence}`.
attention scan :: the server-wide `setInterval(scanAttention, config.attention.scanMs)` loop; self-gates on `viewerCount() > 0` (open websockets), captures candidate panes PLAIN (no `-e`), classifies, and debounces. See [[hook event]].
hook event :: an agent-reported state via `POST /api/agent/event` (`{paneId, event: waiting|busy|idle}`); authoritative over the screen scan for HOOK_TTL_MS (15s). Control-gated.
resizeToViewport :: opt-in (default off) mode where the browser sends computed cols/rows and the server runs `tmux resize-window` — which reshapes the SAME tmux window visible on the laptop, hence off by default. Throttled to ≥2s between resizes.
local mode :: `tools/airc local` = `--host 0.0.0.0 --no-ngrok` prepended; binds the LAN interface and prefers a LAN URL in pairing payloads. See [[on mode]].
on mode :: `tools/airc on` = configured ngrok/public mode; `host` stays at its config value (default `127.0.0.1`, which only ngrok can reach). See [[local mode]].
pairing payload :: JSON (`type:"airc-tmux-remote"`, version 2) the Android app scans/saves, carrying baseUrl + controlToken + sessions + lanUrls + publicUrl so the app can try LAN first and fall back to public.
SERVER_VERSION :: build string shown in the UI/status, resolved once at startup via `git describe --tags --always --dirty` (falls back to `v<package.json version>` outside a git tree). The Android app mirrors the same `git describe` scheme.
