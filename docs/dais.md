# Speaking A Prompt (dais)

Airc's control bar can type, but only a keypress at a time is comfortable in a
car. This feature closes the other half: **a mic button that records a spoken
prompt and types it into the pane you're viewing.**

It pairs Airc with [dais](https://github.com/Kynde/dais), a separate voice
daemon that runs on the same laptop as the Airc server. dais owns the
microphone, the speech recognition and the pasting; Airc only says *"record
now, and deliver it to `%19`"*. No audio ever crosses the network, and the
browser needs no microphone permission — the mic that opens is the **laptop's**.

Off by default. Turn it on with `"dais": { "enabled": true }` in `config.json`.

## What the buttons do

Two buttons appear next to `send` when the control bar is open:

| Button | Action |
|---|---|
| `🎙 speak` | Start recording, aimed at the pane you're viewing. |
| `■ stop` (same button, red + pulsing) | Stop and **transcribe** — the text is typed into that pane. |
| `✕` | Stop and **throw the recording away**. |

It's a latch, not a hold: tap to start, tap again to finish. Nothing is
submitted for you — the transcript lands in the pane's input box and you read it
and tap Airc's own `Enter`. A misheard prompt is a typo you can fix, not
something an agent already acted on.

Tapping the mic also turns **auto mode off**, the same way typing does.
Otherwise auto could slide the view — and therefore your `Enter` tap — to a
different pane than the one the recording is aimed at.

## Availability

The button reports the state of the pairing instead of failing mysteriously:

- **`dais.enabled` false** — no buttons at all. Nothing to explain.
- **enabled, daemon not running** — buttons visible but **greyed out**, with the
  reason in the tooltip. A control that vanishes mid-drive is worse than one
  that says why it can't help.
- **enabled and running** — live. If dais is muted or in dry-run, that's
  appended to the tooltip, because the tap will look like it worked and no text
  will appear.

`GET /api/dais/status` backs this; the browser polls it about once a second
while recording, every four seconds otherwise, and **not at all** while the
control bar is closed — the same "no work when nobody's watching" rule the frame
loop follows.

## Setup

1. Install and run dais (see its own README). Its socket normally lives at
   `$XDG_RUNTIME_DIR/dais/control.sock`.
2. In `config.json`:

   ```json
   "dais": {
     "enabled": true,
     "socket": ""
   }
   ```

   Leave `socket` empty for the default path; set an absolute path if your dais
   runs with a custom `DAIS_RUNTIME_DIR`. A relative path is a startup error.
3. Restart Airc. The startup log line confirms it:

   ```text
   dais dictation enabled (socket: /run/user/1000/dais/control.sock)
   ```

   …with `— daemon not running yet` appended if dais isn't up. That's fine; the
   button greys out and starts working the moment dais does.

Test it against a scratch tmux pane before an agent pane:

```sh
curl -s -XPOST "http://127.0.0.1:8080/api/dais/dictate?k=$CONTROL" \
  -d '{"target":"pane","paneId":"%19","action":"toggle"}'
```

## Security: the control token now opens a microphone

Read this before enabling it on a tunnelled server.

Airc's control token was already a remote-shell credential — it can type into
tmux. With `dais.enabled`, it also **opens the laptop's microphone** and can
read where speech is currently aimed. That is a different *class* of capability,
not just more typing, which is why the feature is opt-in per install rather than
on by default.

Consequences that are deliberate:

- Both routes (`POST /api/dais/dictate`, `GET /api/dais/status`) are
  **control-gated**, and return `404` — never `401` — to a view token. Status is
  control-level even though it's a read: "the mic on that laptop is open right
  now" is not something a read-only share link should report.
- `/api/config` exposes only `dais: { enabled }`. The socket path stays server-side.
- `$DAIS_SOCKET` is deliberately **ignored** by `src/dais.js`. dais's own CLI
  honors it, but if Airc did too, a private test daemon exported in a shell could
  silently re-aim the mic of a running server.
- The pane id takes the same `^%\d+$` path (`resolveInputTarget`) as every
  keystroke, so a client can't hand dais an arbitrary tmux target.

## How the two halves talk

**Control** is one ndjson line over dais's Unix socket, one line back, 2s
timeout:

```json
{"op":"dictate","action":"start","pane":"%19"}
{"ok":true,"mode":"manual-recording","pane":"%19"}
```

`action` is `start`, `stop`, `discard` or `toggle`. Only `start`/`toggle` carry a
pane; `stop` and `discard` act on whatever is recording, so a recording stays
stoppable even if its pane died. The browser always sends `toggle`, so dais
resolves start-vs-stop against its own mode — a browser that missed a poll, or a
recording latched at the laptop itself (`dais-ctl`, `dais-top`), can't be
inverted by a stale button.

dais treats the pane as an **ephemeral, single-use override**: it shadows dais's
own target slot for one recording, is never persisted, and is dropped by the
delivery (or by any mic activity at the laptop). Airc cannot repoint dais's
durable targets, and a forgotten button press can't silently keep stealing
speech.

**Status** is a file read, not a request: the socket's existence says the daemon
is live, a `mic-recording` marker file says the mic is open, and `state.json`
carries mode/target/muted/dry-run. Those files exist for statusline use, so the
poll behind the button costs no socket traffic and needed no new dais op. A
half-written `state.json` (dais rewrites it per transition) is caught and
ignored — the marker still answers the one question that must not be wrong.

Errors keep the two failure modes apart: **503** means Airc couldn't reach dais,
**409** means dais itself refused (a VAD session is already listening, the pane
is gone). Refusal text is shown in the strip's note area, which on a phone
becomes a full-width line so it's actually readable.

## Deliberate divergence from the Android app

`public/app.js` and `MainActivity.kt` are otherwise kept as mirrors, but this
button is **browser-only** on purpose: Android already has IME dictation, so the
gap this fills — a car browser with no dictation at all — doesn't exist there. A
future Android pass could add it for the local-transcription benefits (no cloud
round trip, dais's own audit log and dry-run), but it is not a parity bug.

## Troubleshooting

- **Buttons missing entirely** — `dais.enabled` is false, or you're on a view
  token. Check `GET /api/config`.
- **Buttons greyed out** — no socket at the configured path. Is dais running?
  Does its `DAIS_RUNTIME_DIR` match `dais.socket`?
- **Tap works, no text appears** — dais is muted or in dry-run (the tooltip says
  so), or the confidence gate rejected the utterance. dais notifies on its own
  desktop for that case.
- **`409` with "VAD session active"** — dais is already listening hands-free at
  the laptop. Stop that first; the mic can only be latched one way at a time.
