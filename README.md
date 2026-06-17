<p align="center">
  <img src="docs/airc-logo.png" alt="Airc Tmux logo" width="120" height="120">
</p>

# Airc Tmux Remote

Allows user to control a tmux session, typically an AI coding tool (codex, claude code, etc) using a phone.
Kind of like the claude remote control, but actually works and not strictly tied to any specific AI tool.

## Overview

Private Android remote display/input for a laptop tmux session. The laptop runs
a small Node server that captures tmux panes and accepts authenticated input;
the phone runs a native Kotlin app with a WebView terminal, pane picker, Android
keyboard input, and quick keys.

## Quick Start

Start a same-WLAN server for a tmux session:

```sh
tools/airc local --session airc
tools/airc pair
```

Then open **Airc Tmux** on the phone, tap `pair`, and scan the QR. The app
stores the URL/token, so pairing is only needed again when the server address or
token changes.

Useful commands:

```sh
tools/airc status
tools/airc pair
tools/airc off
tools/airc logs
```

Use `tools/airc on --session airc` for configured ngrok mode. Use
`tools/airc local --session airc` when the phone and laptop are on the same
network; local mode binds `0.0.0.0`, disables ngrok, and makes the QR prefer a
LAN URL instead of `127.0.0.1`.

Airc defaults to port `8090` so it can run alongside `../swyd`, which defaults
to `8080`.

## Android App

The app has:

- tmux pane display with ANSI colors and cursor position
- follow-active-pane mode by default
- pane picker for pinning input/display to a specific pane
- Android keyboard text input, including dictation support from the system IME
- quick keys for Up, Down, Enter
- `A-` / `A+` app-side font adjustment
- QR or manual pairing

For Samsung S23 portrait, a tmux size around `58x50` has worked well. Tmux
window size is the main readability lever; the app then fits that grid into the
available screen.

## Build And Install

Android SDK root on this machine is `~/android`. Build from
`android-app/`:

```sh
cd android-app
./gradlew assembleDebug
~/android/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Gradle is installed at `~/android/gradle-9.4.1`; JDK 17 is installed at
`~/android/jdk-17`; the Gradle wrapper is checked in for normal builds.

## More Docs

- [Operations](docs/operations.md): running, pairing, sizing, troubleshooting
- [Development](docs/development.md): architecture, APIs, build/test notes

## Files

- `tools/airc`: start/stop/status/pair wrapper for the laptop server
- `src/server.js`: HTTP API and lifecycle
- `src/tmux.js`: tmux capture, pane listing, and input forwarding
- `android-app/`: native Android client
- `config.example.json`: server config defaults
