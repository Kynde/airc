# Future Work

## Endpoint Fallback

Android now remembers the last successful endpoint and periodically probes LAN
again when using public/ngrok. Further improvement: probe LAN in the background
instead of doing the periodic LAN retry inline with a foreground request.

## Systemd

`tools/airc` currently manages a detached Node process with pid/state/log files.
A user systemd unit would be useful if Airc should survive shell/session cleanup
or start automatically.

Potential shape:

- `tools/airc install-service`
- `tools/airc service on|off|status|logs`
- optional templated unit only if separate instances become useful

## Fit and Sizing

Make the default Tesla viewport smooth and readable.

Questions:

- What exact cols/rows are comfortable in the normal `1180x919` viewport?
- Should Airc create/manage a dedicated tmux window size?
- Should `resizeToViewport` become a preset rather than a boolean?
- Should there be named display presets like `tesla-normal`, `tesla-park`,
  `phone`, and `desktop`?

## Session Management

Potential tooling:

- create the tmux session if missing
- launch a configured command in that session
- set a viewer-friendly initial size
- show session status in `tools/airc status`

## Transport

WebSockets are now the browser's preferred transport, with HTTP polling kept as
a fallback. Further improvement: add explicit latency/transport indicators and
avoid capturing faster than the browser can render.

## Multi-Pane / Window View

Current viewer shows one pane.

Possible approaches:

1. capture every pane and reconstruct the tmux layout in HTML
2. attach a hidden tmux client to a pseudo-terminal and capture the whole drawn
   window
3. keep one-pane view as primary and make pane switching fast

Approach 3 is good enough for now.

## Security

Potential hardening:

- token rotation command
- expiry/session token layer
- optional basic auth or ngrok/Cloudflare access policy
- explicit "public tunnel active" indicator in CLI/browser UI
