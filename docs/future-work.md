# Future Work

## Endpoint Fallback

Android now tries LAN URLs first, then public/ngrok URLs. Improve this by
remembering the last successful endpoint and periodically probing LAN in the
background so off-LAN use does not pay the LAN timeout on every request.

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

Polling with ETags works and should remain as a fallback. WebSocket worked
through ngrok in Tesla testing and could later reduce unchanged-frame polling.

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
