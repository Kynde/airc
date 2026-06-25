# Operations

## Running

The tmux session must already exist:

```sh
tmux new -s main
```

Start local same-WLAN mode (the default, no accounts needed):

```sh
tools/airc local --session main
tools/airc pair-app
```

Start configured ngrok mode (requires ngrok setup — see
[INSTALLATION.md](../INSTALLATION.md#public-access-with-ngrok)):

```sh
tools/airc on --session main
tools/airc pair-web
```

`tools/airc local` prepends `--host 0.0.0.0 --no-ngrok`. Use `tools/airc on`
when the configured ngrok tunnel should be started by the server; ngrok ships
disabled (`ngrok.enabled: false`), so `on` is a no-tunnel local run until you
enable and configure it.

To serve **both** LAN and ngrok at once (so a phone uses a direct LAN connection
at home and the tunnel away), the server must bind a non-loopback address while
ngrok stays enabled. `host` defaults to `127.0.0.1`, which only ngrok can reach
(it dials `localhost` on the laptop) — the LAN interface is left unbound, so
same-WLAN phones get connection-refused. Set `"host": "0.0.0.0"` in
`config.json` (or pass `--host 0.0.0.0` to `tools/airc on`) so the LAN interface
is bound too. Verify the bind with `ss -tlnp | grep 8080`: it should show
`0.0.0.0:8080`, not `127.0.0.1:8080`.

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

Airc does not currently install or use a systemd unit. The wrapper starts a
detached Node process and manages it through those state files.

## Pairing

Pairing commands print QR codes plus manual values:

- `tools/airc pair-app`: Android JSON with the control token, preferred URL,
  public URL, and LAN URLs.
- `tools/airc pair-web`: browser QR/URL/token with the view token.
- `tools/airc pair-web-control`: browser QR/URL/token with the control token.

`tools/airc pair` remains an alias for `pair-app`. The Android app stores the
profile after QR scan or manual entry.

Re-pair after changing:

- server URL
- server port
- `viewToken` or `controlToken`

Airc stores separate `viewToken` and `controlToken` values. The view token can
only load the terminal viewer. The control token can also send text and quick
keys. The browser viewer shows input controls only when opened with the control
token.

In local mode, QR payloads should use a LAN URL such as `http://10.x.x.x:8080`.
If the phone saves `127.0.0.1`, re-pair from `tools/airc local ...`; on Android,
`127.0.0.1` means the phone itself.

For Android fallback between LAN and public/ngrok access, pair while the payload
contains both URL families. If the app was paired from `tools/airc local`, it may
only know LAN URLs because local mode disables ngrok.

## App Usage

- The app follows the active tmux pane by default.
- Tap `active` to pick or pin a pane. The picker lists only sessions that are
  currently live; configured sessions that aren't running are omitted.
- A configured `sessions` entry may use shell-style globs (`*` matches any run
  of characters, `?` a single one), so `foo*` follows every live session whose
  name starts with `foo`. Entries without glob characters stay exact matches.
- Type in the bottom field, then tap `send` or use the keyboard send action.
- Quick buttons send Up, Down, and Enter.
- `A-` and `A+` adjust app-side font rendering only; they do not resize tmux.
- If the pairing payload includes both LAN and public URLs, the app tries LAN
  first and falls back to the public URL.
- The app remembers the last successful endpoint. When it is using a public URL,
  it periodically tries LAN again, so returning to the same network switches
  back automatically — including while a websocket is actively streaming, by
  probing the LAN addresses on a background thread and dropping the tunnel once
  one answers. This only works if the laptop is actually reachable on the LAN
  (server bound to `0.0.0.0`, both devices on a network that doesn't isolate
  clients); otherwise the public URL keeps carrying the connection.
- While connected over the public URL, the app also periodically pulls the
  laptop's current LAN addresses from `/api/config` and merges them into its
  stored list. So if the laptop later joins a different network (a new IP the
  pairing snapshot never had), the app discovers it and switches to a direct LAN
  connection on its own — no re-pairing needed. This works whenever both devices
  share a network that does not isolate clients; on guest/AP-isolated networks
  the public URL continues to carry the connection.

## Browser Usage

Use `tools/airc pair-web` for read-only browser viewing. This is the expected
Tesla bookmark flow because Tesla local/private LAN access was unreliable in
testing.

Use `tools/airc pair-web-control` only for trusted browsers. It prints a QR and
URL with the control token; it does not open a browser from the CLI. Browser
controls send input to the currently viewed pane.

`/probe` is available after auth for browser diagnostics.

The browser top row shows public tunnel liveness and laptop battery status when
available. Frame updates use WebSockets when supported and fall back to polling.

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
- ngrok tunnel does not come up: check `tail -f "$(tools/airc logs)"`. The
  ngrok free tier allows only one active agent session, so a manually started
  ngrok can block Airc's supervised child.
- QR scan is blurry: move the phone farther away until the QR is sharp, or use
  manual pairing with the printed `baseUrl` and `token`.
- App cannot connect on WLAN: confirm the server is bound to a non-loopback
  address (`ss -tlnp | grep 8080` should show `0.0.0.0:8080`; set
  `"host": "0.0.0.0"` if it shows `127.0.0.1`), and that the phone is on the same
  network.
- App stays on ngrok at home and never switches to LAN: watch the app's
  decisions with `adb logcat -s airc:I`. A `prefer-lan probe ... -> HTTP 200`
  followed by `endpoint switched:` means it flipped to LAN; a `ConnectException`
  means the server is loopback-bound or a firewall blocks the port, and a
  `SocketTimeoutException` means that address is on an unreachable subnet (e.g. a
  VPN/`tun0` IP the laptop also advertises, which is harmless noise).
- Tesla cannot connect to a LAN URL: use ngrok/public browser pairing. Tesla
  hotspot-local/private address access failed in earlier tests.
- ADB install fails with `unauthorized`: accept the USB debugging prompt on the
  phone, then rerun `adb install -r ...`.
- Check server state with `tools/airc status`.
- Read logs with `tail -f "$(tools/airc logs)"`.
