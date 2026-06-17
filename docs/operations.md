# Operations

## Running

The tmux session must already exist:

```sh
tmux new -s airc
```

Start local same-WLAN mode:

```sh
tools/airc local --session airc
tools/airc pair
```

Start configured ngrok mode:

```sh
tools/airc on --session airc
tools/airc pair
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

`tools/airc pair` prints a QR code and the JSON payload. The app stores the
profile after QR scan or manual entry.

Re-pair after changing:

- server URL
- server port
- auth token

In local mode, QR payloads should use a LAN URL such as `http://10.x.x.x:8090`.
If the phone saves `127.0.0.1`, re-pair from `tools/airc local ...`; on Android,
`127.0.0.1` means the phone itself.

## App Usage

- The app follows the active tmux pane by default.
- Tap `active` to pick or pin a pane.
- Type in the bottom field, then tap `send` or use the keyboard send action.
- Quick buttons send Up, Down, and Enter.
- `A-` and `A+` adjust app-side font rendering only; they do not resize tmux.

## Display Sizing

Tmux grid size is the main readability lever. For Samsung S23 portrait, a tmux
size around `58x50` has worked well.

If text is too small:

1. Reduce tmux rows/columns.
2. Use `A+` for a small local app-side nudge.

If scrolling appears, reduce tmux rows/columns or use `A-`.

## Troubleshooting

- `swyd` will not start while Airc is running: Airc should default to port
  `8090`; `swyd` defaults to `8080`. Check for old manual `--port 8080` runs.
- QR scan is blurry: move the phone farther away until the QR is sharp, or use
  manual pairing with the printed `baseUrl` and `token`.
- App cannot connect on WLAN: confirm the laptop server was started with
  `tools/airc local`, and confirm the phone is on the same network.
- ADB install fails with `unauthorized`: accept the USB debugging prompt on the
  phone, then rerun `adb install -r ...`.
- Check server state with `tools/airc status`.
- Read logs with `tail -f "$(tools/airc logs)"`.
