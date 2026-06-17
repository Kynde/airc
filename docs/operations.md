# Operations

## Running

The tmux session must already exist:

```sh
tmux new -s airc
```

Start local same-WLAN mode:

```sh
tools/airc local --session airc
tools/airc pair-app
```

Start configured ngrok mode:

```sh
tools/airc on --session airc
tools/airc pair-web
```

Common commands:

```sh
tools/airc status
tools/airc off
tools/airc logs
```

Runtime state is written to ignored files:

- `.airc-server.pid`
- `.airc-server.json`
- `.airc-server.log`

## Pairing

Pairing commands print QR codes plus manual values:

- `tools/airc pair-app`: Android JSON with the control token, public URL, and
  LAN URLs.
- `tools/airc pair-web`: browser URL/token with the view token.
- `tools/airc pair-web-control`: browser URL/token with the control token.

`tools/airc pair` remains an alias for `pair-app`. The Android app stores the
profile after QR scan or manual entry.

Re-pair after changing:

- server URL
- server port
- auth token

Airc stores separate `viewToken` and `controlToken` values. The view token can
only load the terminal viewer. The control token can also send text and quick
keys. The browser viewer shows input controls only when opened with the control
token.

In local mode, QR payloads should use a LAN URL such as `http://10.x.x.x:8080`.
If the phone saves `127.0.0.1`, re-pair from `tools/airc local ...`; on Android,
`127.0.0.1` means the phone itself.

## App Usage

- The app follows the active tmux pane by default.
- Tap `active` to pick or pin a pane.
- Type in the bottom field, then tap `send` or use the keyboard send action.
- Quick buttons send Up, Down, and Enter.
- `A-` and `A+` adjust app-side font rendering only; they do not resize tmux.
- If the pairing payload includes both LAN and public URLs, the app tries LAN
  first and falls back to the public URL.

## Display Sizing

Tmux grid size is the main readability lever. For Samsung S23 portrait, a tmux
size around `58x50` has worked well.

If text is too small:

1. Reduce tmux rows/columns.
2. Use `A+` for a small local app-side nudge.

If scrolling appears, reduce tmux rows/columns or use `A-`.

## Troubleshooting

- Another service will not start while Airc is running: Airc defaults to port
  `8080`. Check for old manual runs on the same port.
- QR scan is blurry: move the phone farther away until the QR is sharp, or use
  manual pairing with the printed `baseUrl` and `token`.
- App cannot connect on WLAN: confirm the laptop server was started with
  `tools/airc local`, and confirm the phone is on the same network.
- ADB install fails with `unauthorized`: accept the USB debugging prompt on the
  phone, then rerun `adb install -r ...`.
- Check server state with `tools/airc status`.
- Read logs with `tail -f "$(tools/airc logs)"`.
