# Implementation Notes

## Tmux Capture

Airc mirrors an existing tmux session. tmux already knows the active pane, pane
size, cursor position, ANSI-rendered screen, and pane list, so the server uses
tmux as the source of truth instead of parsing raw PTY output.

Current capture:

```sh
tmux capture-pane -p -e -t <pane-id>
```

Metadata comes from:

```sh
tmux display-message -p -t <target> -F <format>
```

Pane list comes from:

```sh
tmux list-panes -s -t =<session> -F <format>
```

Important tmux edge case: `display-message` can exit 0 with empty format fields
for unknown targets. An empty/non-`%` pane id is treated as "not found".

## Active vs Pinned Pane

The default target follows the session's active pane:

```text
=<session>:
```

Pinned targets are concrete pane ids such as `%5`. The browser stores the pin
in localStorage and the Android app stores it in SharedPreferences. If the
pinned pane disappears, the server returns `pinValid=false` and clients return
to following active.

Input follows the currently viewed target: pinned pane when pinned, otherwise
the active pane.

## Auth Boundary

Static JS/CSS/font assets are public so the page can load reliably even if
cookies are missing. HTML, data, pairing, and input routes require a token.
Unauthorized protected routes intentionally return plain `404`.

`authLevel(request, url, config)` resolves the presented token to:

- `none`
- `view`
- `control`

`viewToken` can view frames/config/panes/health. `controlToken` can also send
input and fetch app pairing data. The browser only shows input controls when
`/api/config` returns `canControl: true`, but the server enforces the boundary.

The bookmark query token bootstraps localStorage and an HttpOnly cookie. During
migration the server accepts both Airc and Swyd header/cookie names.

## ANSI Rendering

`src/ansi.js` handles SGR sequences:

- 16-color palette as CSS classes
- 256-color and truecolor as inline styles
- bold
- dim
- italic
- underline
- reverse video

Other escape sequences are stripped. `tmux capture-pane -e` should mostly
produce SGR, so this is adequate for the current one-pane mirror.

## Polling and ETags

Polling is request-driven. There is no background capture loop.

Flow:

1. Client requests `/api/tmux/frame`.
2. Server resolves active or pinned pane.
3. Server captures tmux.
4. Server hashes pane id, dimensions, cursor, pin validity, and text.
5. Server returns JSON plus `ETag`.
6. Client sends `If-None-Match` on the next request.
7. Server returns `304` when unchanged.

After repeated unchanged frames the browser increases its interval up to
`pollIdleMaxMs`.

## Sizing

The main readability lever is the source tmux pane's cols/rows. Browser and app
font controls only adjust local rendering.

`resizeToViewport` lets the browser send computed `cols` and `rows`; the server
then runs `tmux resize-window`. This is off by default because it reshapes the
same tmux window visible on the laptop.

## Known Rough Edges

- Whole tmux window/multi-pane rendering is not implemented.
- Android endpoint fallback currently retries LAN first for every request, so
  off-LAN use can spend a short timeout before falling back to public/ngrok.
- No WebSocket frame stream yet, although WebSocket through ngrok worked in
  Tesla testing.
- ngrok free tier has the interstitial and one-agent limit.
- Local private LAN access from Tesla was not reliable.
