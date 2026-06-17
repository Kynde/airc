# Development

## Architecture

- `src/server.js`: HTTP routes, lifecycle, health, pairing
- `src/tmux.js`: tmux capture, pane listing, resize, input forwarding
- `src/config.js`: config defaults, CLI args, pairing payloads
- `src/ngrok.js`: supervised ngrok child process
- `public/`: browser/WebView terminal assets
- `tools/airc`: background server wrapper
- `android-app/`: native Kotlin Android client

The browser viewer is the canonical Swyd-style terminal UI. The Android app
renders terminal frames in a WebView and keeps controls native, while sharing
the same server frame/input APIs.

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

## Server API

- `GET /api/config`
- `GET /api/pairing`
- `GET /api/tmux/frame`
- `GET /api/tmux/panes`
- `POST /api/tmux/input`
- `GET /probe`
- `GET /api/probe/poll`
- `GET /healthz`

Auth uses generated tokens in `config.json`. `viewToken` can view only;
`controlToken` can view and send input. Requests can use:

- `?k=<token>`
- `X-Airc-Auth: <token>`
- `X-Swyd-Auth: <token>` during migration
- `Authorization: Bearer <token>`
- `airc_auth` cookie

`GET /api/config` returns `canControl` based on the token presented. Browser UI
controls are shown only when `canControl` is true. `/api/tmux/input` and
`/api/pairing` require the control token and return `404` otherwise.

Input payloads:

```json
{ "target": "active", "text": "hello" }
```

```json
{ "target": "pane", "paneId": "%5", "key": "Enter" }
```

Text uses `tmux send-keys -l`; named keys use `tmux send-keys`.

## Build And Test

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
