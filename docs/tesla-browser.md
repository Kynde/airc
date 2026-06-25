# Tesla Browser Findings

Measurements came from in-car Airc proof-of-concept tests in June 2026.

## Network

Direct local hotspot access failed:

- laptop and phone could open `http://10.204.192.28:8080/`
- Tesla could not open the same address

Likely cause: Tesla browser/network routing or policy around private local
addresses, especially `10.0.0.0/8`.

Working public-tunnel options:

- Cloudflare TryCloudflare worked.
- ngrok worked and is preferred for now because the assigned free dev domain is
  reusable as a stable Tesla bookmark.

## Browser Capabilities

Observed user agent:

```text
Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.207 Safari/537.36
```

Observed normal viewport:

```text
1180 x 919 CSS px
devicePixelRatio: 1
```

Fullscreen-stretched mode in Park:

```text
1920 x 1089 CSS px
available screen: 1920 x 1200
```

This is not true fullscreen because the location bar remains visible.

Working APIs:

- `fetch`
- repeated HTTP polling
- WebSocket through ngrok
- `EventSource` exists
- cookies
- localStorage

`navigator.language` was observed as `fi`.

## Rendering

Do not trust system monospace fonts in Tesla.

Results:

- bundled Fira Code renders aligned
- generic `monospace` is not aligned
- `Courier New` stack is not aligned

Therefore terminal text must use the bundled `public/fonts/FiraCode-Regular.ttf`
font served by Airc.

## Confirmed In-Car Behavior

- The viewer stays live while driving.
- Latency is minor and acceptable.
- The CSS cursor is visible and correctly positioned.
- Pane switching from the top pane picker works well.
- A single tmux pane is already useful.

## Fit/Sizing Notes

Text sizing is not fully solved.

Observed:

- a quarter-size Konsole window fit well
- a full half-window had too many columns/rows, causing auto-fit to shrink text
  too much
- raising Konsole font size helped because it reduced the pane's cols/rows

Important conclusion: the main lever is the source tmux pane dimensions, not
only browser font scaling.

Candidate directions:

- keep using a deliberately narrow/tall tmux session
- cap target cols/rows
- enable `resizeToViewport` after more testing
- add presets for Tesla normal viewport and Park viewport
