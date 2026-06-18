<p align="center">
  <img src="docs/airc-logo.png" alt="Airc Tmux logo" width="120" height="120">
</p>

# Airc Tmux Remote

AI remote control for a tmux session, typically an AI coding tool (codex,
claude code, etc) using a phone, tablet, or browser. Kind of like the Claude
remote control, but not tied to a specific AI tool.

## Overview

Private remote display/input for a laptop tmux session. The laptop runs a small
Node server that captures tmux panes, serves a browser viewer, and accepts
authenticated input only from control tokens. The Android app stores both LAN
and public endpoints when paired and can fall back between them.

## Quick Start

Start a same-WLAN server for a tmux session:

```sh
tools/airc local --session airc
tools/airc pair-app
```

Then open **Airc Tmux** on the phone, tap `pair`, and scan the QR. The app
stores the URL/token, so pairing is only needed again when the server address or
token changes.

Start configured ngrok/public mode for browser viewing:

```sh
tools/airc on --session airc
tools/airc pair-web
```

Useful commands:

```sh
tools/airc status
tools/airc pair-app
tools/airc pair-web
tools/airc pair-web-control
tools/airc off
tools/airc logs
```

Use `tools/airc on --session airc` for configured ngrok mode. Use
`tools/airc local --session airc` when the phone and laptop are on the same
network; local mode binds `0.0.0.0`, disables ngrok, and makes the QR prefer a
LAN URL instead of `127.0.0.1`.

Airc uses two tokens. `viewToken` can view only. `controlToken` can view and
send tmux input from the Android app or trusted browser UI. `pair-web` prints a
QR/URL with the view token; `pair-web-control` prints one with the control
token.

## Android App

The app has:

- tmux pane display with ANSI colors and cursor position
- follow-active-pane mode by default
- pane picker for pinning input/display to a specific pane
- Android keyboard text input, including dictation support from the system IME
- quick keys for Up, Down, Enter
- `A-` / `A+` app-side font adjustment
- QR or manual pairing
- LAN/public endpoint fallback from one pairing payload

## Browser Viewer

The browser viewer is the merged Swyd-style interface for Tesla, tablets, and
desktop browsers: active-pane following, pinning, theme, pause, font
fit/manual sizing, and ETag polling. With a `viewToken` it is read-only. With a
`controlToken` it also shows text, Up, Down, and Enter controls that target the
currently viewed pane.

For Samsung S23 portrait, a tmux size around `58x50` has worked well. Tmux
window size is the main readability lever; the app then fits that grid into the
available screen.

<p align="center">
  <img src="docs/airc_ui_in_tesla.jpg" alt="Airc in action in a Tesla" width="800" height="600">
</p>

## Build And Install

Android SDK root on this machine is `~/android`. The repo-root `Makefile`
wraps the common flow and only rebuilds when sources changed:

```sh
make build    # assemble the debug APK
make push     # rebuild if needed, then adb install -r
make deploy   # push and launch on the device
make help     # list all targets
```

Equivalent raw commands, building from `android-app/`:

```sh
cd android-app
./gradlew assembleDebug
~/android/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Gradle is installed at `~/android/gradle-9.4.1`; JDK 17 is installed at
`~/android/jdk-17`; the Gradle wrapper is checked in for normal builds.

## More Docs

- [Docs index](docs/README.md): recommended reading order
- [Operations](docs/operations.md): running, pairing, sizing, troubleshooting
- [Development](docs/development.md): architecture, APIs, build/test notes
- [Implementation Notes](docs/implementation-notes.md): tmux capture, auth,
  polling, sizing
- [Tesla Browser Findings](docs/tesla-browser.md): in-car browser/network notes
- [Future Work](docs/future-work.md): known next improvements

## Files

- `tools/airc`: start/stop/status/pair wrapper for the laptop server
- `src/server.js`: HTTP API and lifecycle
- `src/tmux.js`: tmux capture, pane listing, and input forwarding
- `android-app/`: native Android client
- `config.example.json`: server config defaults
