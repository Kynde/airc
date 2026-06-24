# Attention: follow the pane that needs you

When several coding agents (Claude Code, Codex, Copilot CLI, …) run across tmux panes, airc
can notice each one's state — blocked on a permission prompt, finished and
awaiting the next instruction, or actively working — and surface it.

Two ways it shows up in both clients:

- **Attention chips** — a tap-to-switch chip per pane, in three colors:
  *waiting* (needs you; pulses), *finished* (awaiting input; quiet), and
  *working* (actively running; informational). Waiting chips sort first,
  working last, so a busy agent never buries one that needs you.
- **`auto` toggle** — when on, the view follows the most urgent pane by the
  order *waiting* (asking you something) → *working* → *finished*. Auto is
  *sticky by urgency*: it only moves to a pane strictly more urgent than the one
  you're already watching, so parking on a running agent holds even as others
  work or finish — only something more urgent (e.g. an agent that starts asking)
  pulls you off. Tapping an attention chip nudges the view but keeps auto on;
  what turns auto off is an explicit pick from the pane/session picker, or
  typing into the input box (from the first keystroke, so it can't yank your
  half-typed message to another pane). Note this follow order differs from the
  chip-row order above, where *finished* sorts ahead of *working*.

Switching is non-invasive: airc only mirrors panes, it never changes your real
tmux focus, so auto-follow moves your *view*, not your terminal.

## How detection works

Two sources feed one per-pane attention state on the server:

1. **Screen scan (zero-config).** A server-wide loop captures each non-shell
   pane (`tmux capture-pane -p`) and classifies it with per-agent recognizers in
   [`src/detect.js`](../src/detect.js). States: `waiting` (urgent), `idle-input`
   (ambient), `busy` (working), or none. Shells are skipped via
   `#{pane_current_command}`. The scan runs only while at least one client is
   connected, so an idle server costs nothing.
2. **Agent hooks (exact).** An agent can POST its own state to
   `/api/agent/event`. A hook is authoritative for ~15s, then the screen scan
   takes over again, so hooks give instant, precise signals while everyone else
   still works with no setup.

Screen recognizers key on the agents' TUIs, which drift between releases. They
are all in `src/detect.js` and pinned by fixtures in `test/detect.test.js`
(`node --test test/detect.test.js`); update both together when an agent's UI
changes.

## Config

In `config.json` (see `config.example.json`):

```json
"attention": { "enabled": true, "scanMs": 1500, "debounceScans": 2, "maxPanes": 24 }
```

- `enabled` — master switch; when off, no scan, no API, no client UI.
- `scanMs` — scan cadence (decoupled from the frame `pollMs`).
- `debounceScans` — how many consecutive scans a `waiting`/`idle-input` state
  must persist before it's published (guards against mid-render flicker).
- `maxPanes` — cap on panes scanned per cycle; an over-cap is logged, not silent.

## Wiring agent hooks (optional)

Hooks make detection exact for agents that support them. Each hook POSTs the
pane id (`$TMUX_PANE`) and an event to the local server with the control token.

`event` is one of `waiting` (needs interaction), `busy` (working), `idle`
(finished). Example:

```sh
curl -s -XPOST "http://127.0.0.1:8080/api/agent/event?k=$AIRC_CONTROL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"paneId\":\"$TMUX_PANE\",\"event\":\"waiting\"}"
```

### Claude Code

In Claude Code settings, point the `Notification` hook (fires when Claude needs
input) at the snippet above with `event:"waiting"`, and the `Stop` hook at
`event:"idle"`.

### Codex

Set Codex's `notify` program to a script that maps its event to `waiting` when
Codex is awaiting approval and POSTs as above.

### Copilot CLI

Copilot CLI has no notification/hook mechanism, so it relies on the screen scan
alone — which is zero-config and needs no wiring.

## API

- `GET /api/attention` (view token) — `{ ok, items: [...] }`, ranked
  waiting → idle-input → busy, then oldest within a rank. Used by the HTTP-poll
  fallback; websocket clients get the same list pushed as
  `{ type: "attention", items: [...] }`.
- `POST /api/agent/event` (control token) — `{ paneId, event }`.

Each item: `{ paneId, session, windowName, paneIndex, agent, state, since, source }`,
where `state` is `waiting`, `idle-input`, or `busy`.

## Adding another agent

Add a detector to the ordered list in `src/detect.js` (a `matches`/`classify`
pair), capture real `tmux capture-pane -p` fixtures for its busy / waiting /
idle states into `test/fixtures/`, and assert them in `test/detect.test.js`.
No other code changes are needed.
