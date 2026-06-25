# Installation

This covers everything beyond the [60-second Quick Start](README.md#60-second-quick-start):
full prerequisites, public access with ngrok, and building the optional Android
app. For day-to-day running and troubleshooting, see
[docs/operations.md](docs/operations.md).

## Contents

- [Prerequisites](#prerequisites)
- [Server setup](#server-setup)
- [Public access with ngrok](#public-access-with-ngrok)
- [LAN and tunnel at the same time](#lan-and-tunnel-at-the-same-time)
- [Building the Android app](#building-the-android-app)
- [Zsh completions](#zsh-completions)

## Prerequisites

For the server (the only thing you strictly need):

- **Node.js ≥ 20**
- **tmux**
- A POSIX shell. Developed on Linux; macOS should work.

Optional, depending on how far you take it:

- **ngrok** — only for [public/away-from-home access](#public-access-with-ngrok).
- **Android SDK + JDK 17** — only if you want to [build the Android app](#building-the-android-app).

## Server setup

```sh
git clone https://github.com/Kynde/airc.git
cd airc
npm install
```

The only runtime dependency is `qrcode-terminal` (for printing pairing QR codes).

You do **not** need to create `config.json` by hand. On first run Airc writes one
for you with strong, randomly generated `viewToken` and `controlToken` values and
locks it to `0600`. If you'd rather start from a template:

```sh
cp config.example.json config.json
```

Leave `viewToken`/`controlToken` empty and Airc fills them in; set them yourself
only if you want specific values (they must be ≥ 32 chars or Airc warns).

Then start it on your LAN and pair a browser:

```sh
tmux new -s main
tools/airc local --session main
tools/airc pair-web
```

`tools/airc local` is shorthand for starting the server with `--host 0.0.0.0
--no-ngrok`, i.e. reachable on your LAN with no tunnel. See
[docs/operations.md](docs/operations.md) for the rest of the runtime commands.

### config.json keys worth knowing

| Key | Default | Meaning |
|---|---|---|
| `host` | `127.0.0.1` | Bind address. `0.0.0.0` exposes it on the LAN (what `local` sets). |
| `port` | `8080` | HTTP port. |
| `sessions` | `["main"]` | tmux session name(s) to follow; supports `*`/`?` globs. |
| `viewToken` / `controlToken` | auto-generated | View-only vs. can-type tokens. |
| `theme` | `dark` | Initial browser theme. |
| `ngrok.enabled` | `false` | Start a tunnel? Off by default — see below. |
| `ngrok.domain` | placeholder | Your reserved ngrok domain. |

## Public access with ngrok

LAN mode only reaches devices on the same Wi-Fi. To view from mobile data,
another network, or a car on the road, run Airc behind a public tunnel.
[ngrok](https://ngrok.com) is the supported option — its free tier gives you one
reusable static domain, which makes a durable bookmark (handy for a Tesla).

> Airc ships with `ngrok.enabled: false` and a **placeholder** domain. The steps
> below are what turn it on; nothing here happens until you do them.

**1. Install the ngrok agent** and sign up for a free account:
<https://ngrok.com/download>.

**2. Add your authtoken** (one time, from your ngrok dashboard):

```sh
ngrok config add-authtoken <YOUR_AUTHTOKEN>
```

**3. Claim a free static domain** in the dashboard
(Universal Gateway → Domains). You'll get something like
`your-name-1234.ngrok-free.dev`.

**4. Point Airc at it** in `config.json`:

```json
{
  "ngrok": {
    "enabled": true,
    "domain": "your-name-1234.ngrok-free.dev",
    "binary": "ngrok",
    "apiUrl": "http://127.0.0.1:4040"
  }
}
```

- `domain` — the reserved domain from step 3 (no `https://`). **Replace the
  placeholder**, or the tunnel will fail to bind a domain you don't own.
- `binary` — path to the ngrok agent if it isn't on your `$PATH`.
- `apiUrl` — ngrok's local API; Airc reads the live tunnel URL from it. The
  default is correct unless you've changed ngrok's `web_addr`.

**5. Start in tunnel mode and pair:**

```sh
tools/airc on --session main   # Airc supervises the ngrok child process
tools/airc pair-web            # QR/URL now points at your public domain
```

Airc starts and restarts the ngrok agent for you while the server runs; you do
not run `ngrok` separately.

**Notes on the free tier:**

- Only **one** active ngrok agent session is allowed. If you already have an
  `ngrok` running manually, it will block Airc's supervised child — stop it first.
- Free domains show an interstitial warning page on first visit in a browser.
- If the tunnel doesn't come up, check the log:
  `tail -f "$(tools/airc logs)"`.

## LAN and tunnel at the same time

Handy if you want the phone/app to use a fast direct LAN connection at home and
the tunnel only when you're away. The server has to bind a non-loopback address
**and** keep ngrok enabled:

```sh
tools/airc on --session main --host 0.0.0.0
```

(or set `"host": "0.0.0.0"` in `config.json`). With the default `host:
127.0.0.1`, only ngrok can reach the server — same-Wi-Fi devices get
connection-refused. Verify the bind:

```sh
ss -tlnp | grep 8080      # should show 0.0.0.0:8080, not 127.0.0.1:8080
```

The Android app stores both URL families from one pairing and fails over between
them automatically. More detail in
[docs/operations.md](docs/operations.md#app-usage).

## Building the Android app

The app is **optional** — the browser viewer needs none of this. There's no
prebuilt APK yet, so you build it once.

Requirements:

- Android SDK
- JDK 17
- A device (or emulator) with USB debugging enabled for installation

The repo-root `Makefile` wraps the common flow and only rebuilds when sources
changed:

```sh
make build    # assemble the debug APK
make push     # rebuild if needed, then adb install -r
make deploy   # push and launch on the device
make help     # list all targets
```

Equivalent raw commands, from `android-app/`:

```sh
cd android-app
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

This project was built against Android SDK at `~/android`, Gradle
`~/android/gradle-9.4.1`, and JDK 17 at `~/android/jdk-17`; the Gradle wrapper is
checked in. Adjust paths for your setup — `android-app/local.properties` (your
SDK path) is machine-local and git-ignored. See
[docs/development.md](docs/development.md#build-and-test) for the full build/test
notes.

Once installed, open **Airc Tmux**, tap `pair`, and scan the QR from
`tools/airc pair-app`. The app stores the profile, so you only re-pair when the
server address or a token changes.

## Zsh completions

`completions/_airc` completes subcommands, `status --json`, and the server flags
for `on`/`local`/`restart` (with live tmux session names for `--session`). Put it
on your `$fpath`:

```sh
ln -s "$PWD/completions/_airc" ~/.zsh/completion/_airc   # a dir on your $fpath
```

Restart zsh (or rerun `compinit`) to load it.
