# Agent Notes

This repo contains a private AI remote control for viewing and controlling a
laptop tmux session from Android or a browser. Prefer small, direct changes;
this is personal tooling, not a public product.

## Start Here

`ai/` is a curated, grep-friendly index of repo-specific ground truth — read it
before greping from scratch, and add to it when you learn something non-obvious:

- `ai/glossary.md` — easily-confused vocabulary, one `TERM :: definition` per line.
- `ai/where-to-look.md` — `task :: path` pointers for "to do X, start in Y".
- `ai/gotchas.md` — silent-failure and version-fragile knowledge (auth, tmux
  capture, the attention scanner, anything that logs).

Code wins on conflict: if a fact there is stale, fix the file.

## Architecture

- Laptop server: dependency-light Node code in `src/`.
- Android client: native Kotlin project in `android-app/`.
- Operational wrapper: `tools/airc`.
- Browser viewer/static terminal assets: `public/`.

Important behavior:

- Airc defaults to port `8080`.
- `tools/airc local` prepends `--host 0.0.0.0 --no-ngrok`.
- Pairing payloads in local mode should prefer LAN URLs over `127.0.0.1`.
- Auth uses `viewToken` and `controlToken`; permissions come from the token.
- Browser UI reads `canControl` from `/api/config`; the backend still enforces
  `/api/tmux/input` with the control token.
- `tools/airc pair-app` prints Android JSON with the control token.
- `tools/airc pair-web` prints a browser URL with the view token.
- `tools/airc pair-web-control` prints a browser URL with the control token.
- The Android app stores LAN and public URLs, tries LAN first, and falls back to
  public/ngrok.
- The app follows the active pane unless the user pins a pane.
- Browser controls follow the currently viewed pane.
- Text input goes through `tmux send-keys -l`; named quick keys go through
  `tmux send-keys`.
- Tmux grid size is the main readability lever. The app-side `A-`/`A+` controls
  only adjust local rendering.
- Tesla/browser access should use ngrok/public URLs; local private LAN access
  from Tesla was unreliable in testing.

## Build And Test

Use the repo-root `Makefile` (`make help` lists targets); `make push`/`deploy`
rebuild only when sources changed:

```sh
make check                  # npm run check
make build                  # cd android-app && ./gradlew assembleDebug
make push                   # rebuild if needed, then adb install -r
```

Or the raw equivalents:

```sh
npm run check
cd android-app && ./gradlew --no-daemon assembleDebug
```

Android SDK/tooling is expected under `~/android`; `android-app/local.properties`
is intentionally ignored and may point to the local SDK.

When using adb from this environment, sandboxed commands may fail to start the
adb daemon. Rerun adb commands with escalation when needed.

## Git Hygiene

Do not commit runtime or machine-local files:

- `config.json`
- `.airc-server.*`
- `node_modules/`
- `android-app/local.properties`
- Android/Gradle build directories

Before committing, check `git status --short` and keep commits focused.
