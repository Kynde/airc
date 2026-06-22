# ai/

Curated, AI-friendly context for this repository. Treat it as ground truth on
the same footing as code — when a fact here disagrees with the code, the code
wins and the file gets fixed.

## Purpose

Reduce the cost of reconstructing airc-specific context every agent session.
Only facts that are **hard to infer from the source or the human docs**
(`docs/`, `AGENTS.md`) belong here: invariants whose violation fails silently,
distinctions that are easy to confuse, the version-fragile bits, and "where do
I even start" pointers. Nothing a quick read of the code already states.

## How content gets added

- Small, human-verified chunks — checked against reality before landing.
- Opportunistic: when a discovery during normal work would have saved real time
  had it been written down, it goes here.
- Code wins on conflict; stale entries get fixed or deleted.

## Layout

- `glossary.md` — one line per term, `TERM :: definition`. Grep-friendly.
- `where-to-look.md` — `task :: path # note` pointers. Grep-friendly.
- `gotchas.md` — `fact :: detail` lines; the non-obvious, paid-for knowledge.
  Read before touching auth, tmux capture, the attention scanner, or anything
  that logs.

## Orientation (the 30-second version)

airc mirrors and controls a **laptop tmux session** from an Android app or a
browser. A dependency-light Node server (`src/`, only runtime dep is
`qrcode-terminal`) captures panes via the `tmux` CLI and serves frames as
ANSI→HTML over HTTP + WebSocket; `tools/airc` is the operational wrapper that
runs the server detached. The control token grants `tmux send-keys` into a live
shell, so it is effectively a remote-shell credential — treat it accordingly.
The Android client is native Kotlin in `android-app/` that renders frames in a
WebView. See `docs/development.md` and `AGENTS.md` for the human-facing tour.
