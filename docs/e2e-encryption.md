# End-to-End Encryption Through HTTP Tunnels (design)

Status: **implemented.** The server, the browser viewer and the Android app
speak only this protocol, and no token is accepted in plaintext. The decisions
it rests on are listed at the end. It shipped as one breaking cut-over: the
server regenerates both tokens once (`tokenEpoch` in config.json), and every
client is reinstalled and re-paired, so there is no compatibility mode.

## Why

Airc reaches the outside world through HTTP forwarders: ngrok, Tailscale
Funnel, Cloudflare Tunnel, a reverse proxy. That flexibility is the point and we
keep it. But every one of them that terminates TLS sees the traffic in plaintext:
the token on every request (`?k=`, `X-Airc-Auth`, the `airc_auth` cookie), every
keystroke, and every terminal frame. The control token types into a shell, so
anyone who reads one request through the tunnel owns the laptop until the token
is rotated.

Switching to raw TLS forwarding (TCP passthrough) would fix that but loses the
connectivity we rely on: ngrok's free tier only forwards HTTP. So instead we
**encrypt inside HTTP**. The forwarder still carries ordinary HTTP requests and
a WebSocket, but their bodies are ciphertext between the Airc client and the
Airc server.

## What it protects, per client

| Threat | Android app | Browser |
|---|---|---|
| Tunnel that only reads: logs, inspection, a leak of stored traffic | **Protected** | **Protected** |
| Tunnel that tampers with responses | **Protected** | **Not protected** |
| A recorded session, decrypted after the token later leaks | **Protected** (forward secrecy) | **Protected** (forward secrecy) |
| Replay of a captured request (e.g. a second "Enter") | **Protected** | **Protected** |
| Wi-Fi sniffer on the LAN | Protected (already pinned TLS) | **Protected** (new) |
| Cross-site page forging requests (CSRF) or opening the WebSocket | **Protected** | **Protected** (new) |
| Compromised laptop or phone | No | No |

Why the browser can't be protected against a tampering tunnel: the tunnel also
delivers `index.html` and `app.js`. A tunnel that rewrites responses can serve
an `app.js` that reads the token from storage and sends it home. No standard
browser mechanism closes this. Subresource Integrity is declared by the very
HTML the attacker serves, and a cached service worker gets replaced on its next
update check. The app doesn't have this problem: its code comes from the APK,
and its secret comes from a QR code scanned in person.

So for the browser this layer stops *eavesdropping*, not *tampering*. The docs
will say so, and for browser use over a tunnel they will recommend the view
token.

What stays visible to the tunnel in every case: that this is Airc, when
requests happen, how big they are, and how many clients are connected. Static
assets (`/app.js`, fonts, icons) stay plaintext; they're public anyway.

## Building blocks

- **Handshake:** the Noise Protocol Framework, pattern
  `Noise_NNpsk0_25519_ChaChaPoly_SHA256`
  ([spec](https://noiseprotocol.org/noise.html)). A standard design with
  published test vectors, so each implementation can be checked against the
  same reference rather than only against each other.
  - `psk0`: both sides prove they know the token without ever sending it. A
    tunnel without the token can neither impersonate the server nor read the
    session.
  - `NN` + ephemeral keys: each session gets fresh keys, so a recorded session
    stays unreadable even if the token leaks later (forward secrecy).
- **Transport:** Noise's per-direction ChaCha20-Poly1305 keys from `Split()`,
  with **explicit 64-bit nonces** and a sliding replay window (Noise spec §11.4,
  "out-of-order transport messages"). This is the WireGuard construction:
  Noise handshake, then counter plus anti-replay window. HTTP needs it because
  requests run in parallel and arrive out of order.
- **Pre-shared key:** `psk = HKDF-SHA256(ikm = token, info = "airc e2e v1 psk")`,
  32 bytes. Each client uses its own token. The server learns the level by trial
  decryption: it tries the control PSK, then the view PSK, on the first
  handshake message. No token identifier appears on the wire.
- **Prologue:** `"airc-e2e-v1"`, which binds the protocol version into the
  handshake.

The client's token stays what it is today (24 random bytes, base64url). The
change is that it becomes key material and is never transmitted.

## Protocol

### Handshake (HTTP)

```
POST /api/e2e/hs            body: Noise msg1  (-> psk, e  + encrypted payload)
200                         body: Noise msg2  (<- e, ee   + encrypted payload)
```

- **msg1 payload** (encrypted under the PSK-derived key): `{ client: "android" |
  "browser", version }`. This is the one message without forward secrecy:
  there's no DH result in its key yet, so anyone who later gets the token can
  read it. It must never carry anything sensitive.
- **msg2 payload**: `{ session: <16 random bytes>, level: "view" | "control",
  serverVersion, expiresAt }`.
- A wrong token fails authentication on msg1. The server answers with the same
  generic 404 as today and counts it against the failed-auth throttle.
- **A replayed msg1 is harmless.** Completing the session needs the original
  client's ephemeral private key. Each replay still costs the server a pending
  slot, so sessions are capped in number and expire.

### Requests (HTTP)

Every API call goes through **one** endpoint, so even the path is hidden:

```
POST /api/e2e
Content-Type: application/octet-stream
body: ver(1) | session(16) | seq(8, big-endian) | ciphertext
```

- **Ciphertext:** the client-to-server key encrypts it with nonce = `seq` and
  AAD = the 25-byte header plus `"req"`.
- **Plaintext:** `{ method, path, query, headers: { "If-None-Match"? }, body }`.
  The server dispatches it to the existing handler, as if it had arrived
  directly.
- **Response:** always HTTP 200. Its body is encrypted with the server-to-client
  key, the **same `seq`** as nonce (the keys differ per direction, so no nonce
  is reused), and AAD = header plus `"res"`. Plaintext: `{ status, headers:
  { ETag? }, body }`. Because the response is bound to its request's `seq`, a
  tunnel can't swap responses between requests.
- **seq:** a counter per session that only goes up on the client. The server
  rejects any `seq` it has already seen or that falls below its window (≥ 256
  entries).
- **Retries** always re-encrypt under a new `seq`. Resending a body as-is would
  be rejected as a replay.
- **Errors outside the envelope** are unauthenticated. If the session is unknown
  or expired, or decryption fails, the client re-handshakes once and then
  reports an error. A forged error can only make the client re-handshake, which
  a tunnel can cause anyway by dropping traffic.

### WebSocket

```
GET /api/e2e/ws   (no token)
-> binary: Noise msg1      <- binary: Noise msg2
then binary transport messages, each with an implicit counter (WS is ordered)
```

- **Its own handshake per connection,** so no key or nonce space is shared with
  HTTP sessions.
- **Inside:** today's JSON messages (`hello`, `view`, frames) unchanged.
- **No compression.** Ciphertext doesn't compress, so `permessage-deflate` is
  not negotiated on this path, and nothing is compressed before encrypting
  either (decided; revisit only if mobile bandwidth becomes a problem).

### Sessions

- Kept in server memory, so a restart drops them all and clients re-handshake.
- Idle expiry 15 minutes, absolute expiry 24 hours, total count capped.
- **Weak tokens:** a recorded handshake lets an attacker test guesses offline. A
  random 24-byte token makes that infeasible, but a short user-chosen one does
  not. The server refuses to start with a token shorter than 128 bits, where
  today it only warns.

## Clients

### Android

- **No plaintext path at all.** The app never sends its token, on any route.
- **Built-in crypto only, `minSdk` 26 → 33 (Android 13).** Android's own
  providers have everything from API 33: X25519 as `XDH` in `KeyPairGenerator`,
  `KeyAgreement` and `KeyFactory` (33+), `ChaCha20/Poly1305/NoPadding` (28+),
  and `HmacSHA256` (1+), per the Android reference pages. So no crypto library
  is added. A raw 32-byte peer key is imported by prefixing the fixed X25519
  SPKI header and using `X509EncodedKeySpec`.
- **One code path for LAN and tunnel:** a single `E2eSession` wraps all HTTP
  calls and the OkHttp WebSocket. On the LAN the session runs inside the
  existing pinned TLS; through a tunnel, inside the tunnel's HTTPS.
- Pinning (`Pinning.kt`) stays as the outer layer on the LAN.

### Browser

- **Token in the URL fragment.** Bookmark and QR links change from `?k=TOKEN`
  to `#k=TOKEN`. Browsers never send the fragment, so the token stops crossing
  the wire even on the very first load. `app.js` moves it to `localStorage` and
  removes it from the address bar with `history.replaceState`.
- **Crypto library.** The crypto comes from small audited libraries
  (`@noble/curves`, `@noble/ciphers`, `@noble/hashes`), checked into `public/`
  at pinned versions. There is no CDN and no build step. The browser's
  built-in WebCrypto isn't an option because it works only on HTTPS origins:
  over a tunnel it would be available, but not on `http://10.x.x.x` on the
  LAN.
- **Tesla:** Chrome 140 (see `tesla-browser.md`) runs these libraries without
  issue. The car only reaches Airc through a tunnel anyway.
- The `airc_auth` cookie and `?k=` go away. With no ambient credential left, a
  cross-site page can't forge input or open the WebSocket (CSRF and
  cross-site WebSocket hijacking), and no `Origin` or `Content-Type` checks
  are needed to stop it.
- `/probe` (the car diagnostics page) and `/api/probe/poll` currently
  authenticate through that cookie. They move ahead of the auth check and
  become public. They only return the server time and the caller's own
  address, and this way they keep working in the car without the encryption
  client.

### Local tools (CLI, agent hooks)

`tools/airc` and the agent hooks (`docs/attention.md`) currently send the
control token in plaintext to `127.0.0.1:8080`. Tunnels also arrive at that
address from the local agent, so the server can't distinguish "local tool" from
"anyone through the tunnel." They move to a **Unix domain socket**
(`.airc.sock`, mode `0600`), where file permissions are the authentication and
no tunnel can reach it. Hooks switch to `curl --unix-socket`.

## Rollout: one cut-over

No config switch and no transition mode: the HTTP listener stops accepting
plaintext tokens altogether, in every form (`?k=`, cookie, `Authorization`,
`X-Airc-Auth`). Work proceeds in this order, on a branch, and merges when all
three clients work:

1. **Shared core and server.** The Noise core is one JS module used by both the
   server and the browser, checked against the published test vectors. The
   server gains the `/api/e2e*` endpoints and the Unix socket, and loses
   plaintext token auth.
2. **Android.** A Kotlin Noise core passing the same vectors in JVM unit tests,
   then `E2eSession` for all calls, and `minSdk` 33.
3. **Browser.** The fragment token, the vendored libraries, and the client.
4. **Fresh tokens.** On upgrade the server **regenerates both tokens**. The old
   ones have crossed ngrok in plaintext for as long as the tunnel has been in
   use, so they must be treated as exposed. Then every client is re-paired.

## Testing

- **Vectors:** the published Noise vectors for `NNpsk0_25519_ChaChaPoly_SHA256`,
  checked in Node and in Android JVM tests.
- **Interop:** a Node client against the real server, and the Android core
  against a captured server transcript.
- **Recording proxy:** run real clients through a local HTTP proxy that saves
  every byte, then assert that neither token nor any terminal text appears in
  the capture.
- **Negative tests:** a flipped bit in any field, a replayed `seq`, swapped
  responses, a wrong token, a view session calling a control endpoint, an
  expired session, and a weak token with E2E on.
- **In the car:** the Tesla over the tunnel, where frame latency must stay
  acceptable.

## Decisions

1. **Android crypto:** raise `minSdk` to 33 and use only the platform
   providers. No library.
2. **Compression:** none for now.
3. **Server identity:** `NNpsk0` now. With it, anyone holding a token can act as
   the server toward clients using the same token, so a shared view link lets
   its holder, if they also control the tunnel, show fake screens to view-only
   clients. Adding a server static key to the QR and fragment (`NKpsk0`) closes
   this later without other protocol changes.
4. **End state:** encryption is mandatory from the start, with no plaintext mode.

## Related findings from the security reviews

From the two earlier reviews, how each item relates to this design:

- **Fixed already, independent of this:**
  - the pre-auth crash on a malformed Host;
  - the app accepting tunnel-supplied endpoints;
  - unbounded WebSocket decompression;
  - the forgeable `X-Forwarded-For` throttle and its unbounded map;
  - Android backup of the token;
  - ngrok's local inspector recording requests, now `--inspect=false`.
- **Closed by this design:** CSRF and cross-site WebSocket access (no ambient
  credentials remain); the token sniffable on LAN HTTP; the token in ngrok's or
  any forwarder's logs.
- **Decided, unchanged:**
  - Configured `sessions` stay a navigation default, not an access limit.
  - The failed-auth throttle keeps dropping only wrong attempts, so one attacker
    behind a shared tunnel address can't lock the owner out. With 192-bit tokens
    it's resource hygiene, not brute-force protection.
- **Still open, outside this design:**
  - `tools/airc rotate-tokens` (in `future-work.md`). It matters more once
    tokens are long-lived key material.
  - `.airc-server.log` is never rotated and records every request with its
    address.
  - `0.0.0.0` binding also exposes the listener on VPN and Docker interfaces.
    Only the handshake endpoint is reachable there without a token, but binding
    to the LAN address would be tidier.
