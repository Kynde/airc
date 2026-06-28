# Where to look

`task :: path # note`. Curated, grep-friendly: one line carries the pointer.
Code wins on conflict — if a pointer is stale, fix or remove it.

## Server (src/)

add an HTTP route :: src/server.js makeServer request handler # giant if-ladder on url.pathname; auth is resolved once near the top, then `authorized`/`canControl` gate each branch
add/raise auth :: src/auth.js authLevel + presentedToken # token sources and level mapping live ONLY here; don't reinvent token parsing in server.js
change a tmux command :: src/tmux.js # every tmux invocation is execFile("tmux", [...]) with array args (no shell); add new ones the same way
ANSI/color rendering :: src/ansi.js ansiToHtml # SGR → spans; everything else stripped. Hand-rolled escaper — the XSS boundary for pane content
config defaults / CLI flags / token gen :: src/config.js DEFAULTS + parseArgs + loadConfig # tokens are generated and PERSISTED back to config.json on first load
pairing/bookmark URL shape :: src/config.js pairingPayload + bookmarkUrl # version 2 payload; LAN-vs-public preference logic
ngrok supervision :: src/ngrok.js startNgrok # spawns the agent, polls 127.0.0.1:4040 for the tunnel URL, backs off and restarts on exit
attention detection signatures :: src/detect.js DETECTORS # per-agent TUI regexes; the version-fragile bit — change here when an agent's UI drifts
attention scan/debounce/HUD state :: src/server.js scanAttention + applyScreenState + attentionItems # screen vs hook precedence, debounce, ranking
agent hook intake :: src/server.js handleAgentEvent (`POST /api/agent/event`) # control-gated; maps coarse event → state, trusted for HOOK_TTL_MS
security headers :: src/server.js request handler top (response.setHeader CSP/...) # CSP relaxed only for `/probe` (inline script); HSTS only when x-forwarded-proto=https
rate limit / WS cap :: src/server.js recordFailedAuth/rateLimited + wsCounts # per-IP, keyed on clientAddress() which trusts X-Forwarded-For

## CLI wrapper (tools/)

start/stop/status/restart :: tools/airc cmdOn/cmdOff/cmdStatus # detached node process; pid/state/log files at repo root, all 0600 and gitignored
pairing commands :: tools/airc cmdPair/cmdPairWeb # pair-app=control token JSON, pair-web=view token URL, pair-web-control=control token URL
entrypoint (foreground) :: tools/airc-tmux # one-liner that execs `node src/server.js "$@"`; tools/airc is the backgrounding wrapper

## Browser viewer (public/)

frame rendering / polling / WS :: public/app.js # WebSocket preferred, HTTP poll fallback; token bootstrapped from `?k=` into localStorage then stripped from the URL bar
browser view-state handshake :: public/app.js sendViewState + src/server.js wsState.viewReady # client must send `{type:"view"}` after WS open; server defers first frame until then to preserve pins
auto-follow target / what disables auto :: public/app.js autoTarget+applyAuto+AUTO_RANK # sticky-by-urgency (waiting>busy>idle, NOT the server's chip order); selectChip keeps auto, picker + first keystroke drop it. Mirror of MainActivity.kt applyAuto/autoRank
viewer markup :: public/index.html ; diagnostics page :: public/probe.html # probe is the only page with an inline <script>
mobile browser layout :: public/app.css mobile media query + public/app.js applyMobileView # responsive toolbar/control dock; phone auto-fit uses a larger minimum font and horizontal scroll
web favicons / homescreen icons :: public/favicon.ico + public/icons/ + public/site.webmanifest + src/server.js static asset routes # generated from Android airc_icon.png
terminal color CSS :: public/app.css # fg-N/bg-N palette classes that ansi.js emits

## Android (android-app/)

everything :: android-app/app/src/main/java/dev/airc/tmuxremote/MainActivity.kt # single big activity: WebView render, endpoint fallback, font controls, prefs
endpoint fallback / LAN rediscovery :: .../MainActivity.kt endpointUrls + maybeRefreshLanUrls + maybePreferLan # lastGoodUrl first; refresh /api/config over tunnel; drop WS to let poll loop try LAN again
auto-follow / attention chips :: .../MainActivity.kt applyAuto+autoRank+selectChip+input TextWatcher # mirror of public/app.js; sticky-by-urgency, chip-tap keeps auto, picker + first keystroke drop it
QR pairing :: .../QrScanActivity.kt # camera scan → pairing payload
app id / version :: android-app/app/build.gradle.kts # applicationId dev.airc.tmuxremote; versionName/versionCode are STATIC on purpose (never bump)

## Build / test

syntax check :: npm run check (= node scripts/check.js) # `node --check` over src/ + public/ ONLY — does NOT run the unit tests
unit tests :: node --test 'test/*.test.js' # detect.js fixtures; not wired into `npm run check` or any npm script
android build/install :: make build / make push / make deploy # APK modeled as a file target; rebuilds only when sources changed
release :: /release <patch|minor|major> or .claude/skills/release # tag is source of truth, v-prefixed; bumps package.json, gh release, fetch tag back
