# Development

## Architecture

- `src/server.js`: HTTP routes, lifecycle, health, pairing
- `src/tmux.js`: tmux capture, pane listing, resize, input forwarding
- `src/ansi.js`: ANSI SGR to HTML conversion
- `src/auth.js`: token extraction and `authLevel`
- `src/config.js`: config defaults, CLI args, pairing payloads
- `src/ngrok.js`: supervised ngrok child process
- `public/`: browser viewer, probe page, terminal assets
- `tools/airc`: background server wrapper
- `android-app/`: native Kotlin Android client

The browser viewer is the canonical terminal UI. The Android app renders
terminal frames in a WebView and keeps controls native, while sharing the same
server frame/input APIs.

Runtime paths:

```text
Android app -> LAN URL or ngrok URL -> Node server -> tmux
Browser/Tesla -> ngrok URL -> Node server -> tmux
```

The server can supervise ngrok when `ngrok.enabled` is true. `tools/airc` itself
is not systemd-backed; it starts a detached Node process and tracks pid/state/log
files.

## Ports And Pairing

Airc defaults to `8080`.

Local mode:

```sh
tools/airc local --session airc
```

This prepends:

```sh
--host 0.0.0.0 --no-ngrok
```

Pairing payload behavior:

- ngrok mode: `baseUrl` is the configured/public ngrok URL.
- local mode: `baseUrl` prefers the first LAN URL.
- `lanUrls` and `publicUrl` are included so Android can try LAN first and fall
  back to ngrok/public access.
- Browser pairing commands print QR/URL/token values instead of Android JSON.
- `pair-app` uses `controlToken`.
- `pair-web` uses `viewToken`.
- `pair-web-control` uses `controlToken`.

## Server API

- `GET /api/config`
- `GET /api/pairing`
- `GET /api/tmux/frame`
- `GET /api/tmux/panes`
- `POST /api/tmux/input`
- `GET /api/attention` (panes whose agent needs interaction; see [attention.md](attention.md))
- `POST /api/agent/event` (agent hook; control token)
- `GET /api/status`
- `GET /probe`
- `GET /api/probe/poll`
- `GET /healthz`
- `WebSocket /api/tmux/ws`

Unauthenticated static assets:

- `/app.js`
- `/app.css`
- `/fonts/FiraCode-Regular.ttf`

Auth uses generated tokens in `config.json`. `viewToken` can view only;
`controlToken` can view and send input. Requests can use:

- `?k=<token>`
- `X-Airc-Auth: <token>`
- `X-Swyd-Auth: <token>` during migration
- `Authorization: Bearer <token>`
- `airc_auth` cookie
- `swyd_auth` cookie during migration

`GET /api/config` returns `canControl` based on the token presented. Browser UI
controls are shown only when `canControl` is true. `/api/tmux/input` and
`/api/pairing` require the control token and return `404` otherwise.

Unauthorized protected routes return `404`, not `401`, to avoid advertising the
private surface.

`GET /api/config` also returns non-secret URL metadata (`publicUrl`, `lanUrls`)
for clients.

`GET /api/status` returns live ngrok/public-tunnel status and local battery
summary for the browser dashboard.

Input payloads:

```json
{ "target": "active", "text": "hello" }
```

```json
{ "target": "pane", "paneId": "%5", "key": "Enter" }
```

Text uses `tmux send-keys -l`; named keys use `tmux send-keys`.

## Frame Flow

1. Client polls `/api/tmux/frame`.
2. Server resolves the active pane for `config.session`, unless `?pane=%N`
   pins a concrete pane.
3. Server runs `tmux capture-pane -p -e -t <pane-id>`.
4. ANSI SGR is converted to HTML.
5. Response includes pane metadata, cursor position, HTML, and `ETag`.
6. Client sends `If-None-Match`; unchanged frames get `304`.

See [Implementation Notes](implementation-notes.md) for tmux edge cases and
sizing details.

The browser prefers `WebSocket /api/tmux/ws` for frame updates and falls back to
HTTP polling if the socket is unavailable or closes.

## Build And Test

The repo-root `Makefile` wraps the common flow (`make help` lists targets).
It models the APK as a file target whose prerequisites are the Kotlin / res /
manifest / gradle sources, so `make push` only rebuilds when something changed:

```sh
make check    # npm run check
make build    # cd android-app && ./gradlew assembleDebug
make push     # rebuild if needed, then adb install -r
make deploy   # push and launch on the device
```

Equivalent raw commands:

Node/server check:

```sh
npm run check
```

Android build:

```sh
cd android-app
./gradlew --no-daemon assembleDebug
```

Install:

```sh
~/android/platform-tools/adb install -r android-app/app/build/outputs/apk/debug/app-debug.apk
```

SDK/tooling assumptions:

- Android SDK root: `~/android`
- Gradle install: `~/android/gradle-9.4.1`
- JDK 17: `~/android/jdk-17`
- `android-app/local.properties` is machine-local and ignored

## Agent Notes

For fresh coding-agent contexts, also read `AGENTS.md`.

Do not commit:

- `config.json`
- `.airc-server.*`
- `node_modules/`
- `android-app/local.properties`
- Android/Gradle build outputs
