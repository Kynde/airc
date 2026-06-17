# Agent Notes

This repo contains a private Android remote for viewing and controlling a laptop
tmux session. Prefer small, direct changes; this is personal tooling, not a
public product.

## Architecture

- Laptop server: dependency-light Node code in `src/`.
- Android client: native Kotlin project in `android-app/`.
- Operational wrapper: `tools/airc`.
- Web fallback/static terminal assets: `public/`.

Important behavior:

- Airc defaults to port `8090`; `../swyd` defaults to `8080`.
- `tools/airc local` prepends `--host 0.0.0.0 --no-ngrok`.
- Pairing payloads in local mode should prefer LAN URLs over `127.0.0.1`.
- The app follows the active pane unless the user pins a pane.
- Text input goes through `tmux send-keys -l`; named quick keys go through
  `tmux send-keys`.
- Tmux grid size is the main readability lever. The app-side `A-`/`A+` controls
  only adjust local rendering.

## Build And Test

Use:

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
