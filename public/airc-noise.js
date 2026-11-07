"use strict";

// Noise_NNpsk0_25519_ChaChaPoly_SHA256: the handshake and transport ciphers of
// Airc's end-to-end layer (docs/e2e-encryption.md). Implements revision 34 of
// the Noise spec (https://noiseprotocol.org/noise.html) for this one pattern:
//
//   -> psk, e
//   <- e, ee
//
// Only the state machine lives here. The cryptographic primitives are passed
// in, so the same code runs on the server (node:crypto) and in the browser (an
// audited JS library), and the published test vectors check both. Byte values
// are Uint8Array throughout (a Node Buffer is one).
//
// primitives = {
//   x25519PublicKey(privateKey32) -> publicKey32
//   x25519(privateKey32, publicKey32) -> shared32   (throws on a low-order point)
//   randomBytes(n) -> bytes
//   sha256(data) -> digest32
//   hmacSha256(key, data) -> mac32
//   aeadEncrypt(key32, nonce12, ad, plaintext) -> ciphertext||tag16
//   aeadDecrypt(key32, nonce12, ad, ciphertext||tag16) -> plaintext   (throws if forged)
// }
//
// Loaded as a plain <script> it defines globalThis.AircNoise; under Node,
// require() returns the same object.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AircNoise = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const PROTOCOL_NAME = "Noise_NNpsk0_25519_ChaChaPoly_SHA256";
  const DHLEN = 32;
  const HASHLEN = 32;
  const TAGLEN = 16;
  const EMPTY = new Uint8Array(0);
  // Noise reserves 2^64-1. Counters here never get near 2^53, but cap at the
  // largest exactly representable integer so a nonce can never repeat silently.
  const MAX_NONCE = Number.MAX_SAFE_INTEGER;

  function concat(...parts) {
    let length = 0;
    for (const part of parts) {
      length += part.length;
    }
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  function utf8(text) {
    return new TextEncoder().encode(text);
  }

  // ChaChaPoly nonce: 32 bits of zeros, then the 64-bit counter little-endian.
  function chachaNonce(n) {
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_NONCE) {
      throw new Error("noise: nonce out of range");
    }
    const nonce = new Uint8Array(12);
    new DataView(nonce.buffer).setBigUint64(4, BigInt(n), true);
    return nonce;
  }

  function createNoise(p) {
    // HKDF as Noise defines it (section 4.3), with 2 or 3 outputs.
    function hkdf(chainingKey, ikm, outputs) {
      const tempKey = p.hmacSha256(chainingKey, ikm);
      const out1 = p.hmacSha256(tempKey, Uint8Array.of(0x01));
      const out2 = p.hmacSha256(tempKey, concat(out1, Uint8Array.of(0x02)));
      if (outputs === 2) {
        return [out1, out2];
      }
      const out3 = p.hmacSha256(tempKey, concat(out2, Uint8Array.of(0x03)));
      return [out1, out2, out3];
    }

    // One direction of a transport. send/receive use (and advance) the
    // implicit counter, for an ordered channel such as a WebSocket.
    // sendWithNonce/receiveWithNonce take an explicit counter, for HTTP
    // requests that can arrive out of order (spec section 11.4); the caller
    // then owns uniqueness (sender) and replay rejection (receiver).
    class CipherState {
      constructor(key) {
        this.key = key;
        this.n = 0;
      }

      sendWithNonce(n, ad, plaintext) {
        return p.aeadEncrypt(this.key, chachaNonce(n), ad, plaintext);
      }

      receiveWithNonce(n, ad, ciphertext) {
        if (ciphertext.length < TAGLEN) {
          throw new Error("noise: message too short");
        }
        return p.aeadDecrypt(this.key, chachaNonce(n), ad, ciphertext);
      }

      send(ad, plaintext) {
        const out = this.sendWithNonce(this.n, ad, plaintext);
        this.n += 1;
        return out;
      }

      receive(ad, ciphertext) {
        const out = this.receiveWithNonce(this.n, ad, ciphertext);
        this.n += 1; // only after it authenticated: a forged message doesn't consume a nonce
        return out;
      }
    }

    // The handshake: SymmetricState plus HandshakeState for NNpsk0 only.
    // Message 1 is always initiator -> responder, message 2 the reverse.
    // options: { initiator, psk (32 bytes), prologue, ephemeralPrivate? }.
    // ephemeralPrivate exists for the test vectors; leave it out otherwise.
    class Handshake {
      constructor({ initiator, psk, prologue = EMPTY, ephemeralPrivate = null }) {
        if (!psk || psk.length !== 32) {
          throw new Error("noise: psk must be 32 bytes");
        }
        this.initiator = Boolean(initiator);
        this.psk = psk;
        this.ePriv = ephemeralPrivate || p.randomBytes(DHLEN);
        this.ePub = p.x25519PublicKey(this.ePriv);
        this.re = null;
        this.step = 0; // messages processed so far: 0, 1, then 2 = complete
        // InitializeSymmetric: the name is longer than HASHLEN, so h = HASH(name).
        const name = utf8(PROTOCOL_NAME);
        this.h = name.length <= HASHLEN ? concat(name, new Uint8Array(HASHLEN - name.length)) : p.sha256(name);
        this.ck = this.h;
        this.k = null;
        this.n = 0;
        this.mixHash(prologue);
      }

      mixHash(data) {
        this.h = p.sha256(concat(this.h, data));
      }

      mixKey(ikm) {
        const [ck, tempK] = hkdf(this.ck, ikm, 2);
        this.ck = ck;
        this.k = tempK;
        this.n = 0;
      }

      mixKeyAndHash(ikm) {
        const [ck, tempH, tempK] = hkdf(this.ck, ikm, 3);
        this.ck = ck;
        this.mixHash(tempH);
        this.k = tempK;
        this.n = 0;
      }

      encryptAndHash(plaintext) {
        // k is always set here (psk0 keys the very first payload), but follow
        // the spec rather than assume it.
        const ciphertext = this.k ? p.aeadEncrypt(this.k, chachaNonce(this.n), this.h, plaintext) : plaintext;
        if (this.k) {
          this.n += 1;
        }
        this.mixHash(ciphertext);
        return ciphertext;
      }

      decryptAndHash(ciphertext) {
        const plaintext = this.k ? p.aeadDecrypt(this.k, chachaNonce(this.n), this.h, ciphertext) : ciphertext;
        if (this.k) {
          this.n += 1;
        }
        this.mixHash(ciphertext);
        return plaintext;
      }

      // The `e` token in a psk handshake: MixHash(e) then MixKey(e).
      mixEphemeral(publicKey) {
        this.mixHash(publicKey);
        this.mixKey(publicKey);
      }

      ourTurn() {
        return this.initiator ? this.step === 0 : this.step === 1;
      }

      writeMessage(payload = EMPTY) {
        if (this.step >= 2 || !this.ourTurn()) {
          throw new Error("noise: not our turn to write");
        }
        let out;
        if (this.step === 0) {
          this.mixKeyAndHash(this.psk); // psk
          this.mixEphemeral(this.ePub); // e
          out = concat(this.ePub, this.encryptAndHash(payload));
        } else {
          this.mixEphemeral(this.ePub); // e
          this.mixKey(p.x25519(this.ePriv, this.re)); // ee
          out = concat(this.ePub, this.encryptAndHash(payload));
        }
        this.step += 1;
        return out;
      }

      readMessage(message) {
        if (this.step >= 2 || this.ourTurn()) {
          throw new Error("noise: not our turn to read");
        }
        if (message.length < DHLEN + TAGLEN) {
          throw new Error("noise: handshake message too short");
        }
        const re = message.subarray(0, DHLEN);
        let payload;
        if (this.step === 0) {
          this.mixKeyAndHash(this.psk); // psk
          this.mixEphemeral(re); // e
          payload = this.decryptAndHash(message.subarray(DHLEN));
        } else {
          this.mixEphemeral(re); // e
          this.mixKey(p.x25519(this.ePriv, re)); // ee
          payload = this.decryptAndHash(message.subarray(DHLEN));
        }
        this.re = Uint8Array.from(re);
        this.step += 1;
        return payload;
      }

      get complete() {
        return this.step === 2;
      }

      get handshakeHash() {
        return this.h;
      }

      // Split: the first key encrypts initiator -> responder, the second the
      // reverse. Returned from this side's point of view.
      split() {
        if (!this.complete) {
          throw new Error("noise: handshake not complete");
        }
        const [k1, k2] = hkdf(this.ck, EMPTY, 2);
        const toResponder = new CipherState(k1);
        const toInitiator = new CipherState(k2);
        // Drop handshake secrets; only the transport keys live on.
        this.ePriv = null;
        this.k = null;
        this.ck = null;
        return this.initiator
          ? { send: toResponder, receive: toInitiator }
          : { send: toInitiator, receive: toResponder };
      }
    }

    // RFC 5869 HKDF-SHA256 with one output block: turns a token into the
    // 32-byte Noise psk. (Noise's own HKDF above is a different construction.)
    function derivePsk(token) {
      const prk = p.hmacSha256(new Uint8Array(32), utf8(token));
      return p.hmacSha256(prk, concat(PSK_INFO, Uint8Array.of(0x01)));
    }

    return { Handshake, CipherState, derivePsk };
  }

  // ---------------------------------------------------------------------------
  // Airc's envelope around the Noise transport (docs/e2e-encryption.md).
  //
  //   POST /api/e2e/hs   body: Noise msg1          -> 200 body: Noise msg2
  //   POST /api/e2e      body: header | ciphertext -> 200 body: ciphertext
  //
  // header = version(1) | session(16) | seq(8, big-endian). The request is
  // encrypted client->server with nonce = seq and AD = header|"req"; its
  // response server->client with the same seq and AD = header|"res", which
  // binds each response to its request.

  const E2E_VERSION = 1;
  const PROLOGUE = utf8("airc-e2e-v1");
  const PSK_INFO = utf8("airc e2e v1 psk");
  const SESSION_BYTES = 16;
  const HEADER_BYTES = 1 + SESSION_BYTES + 8;
  const REQ = utf8("req");
  const RES = utf8("res");

  function encodeHeader(session, seq) {
    const header = new Uint8Array(HEADER_BYTES);
    header[0] = E2E_VERSION;
    header.set(session, 1);
    new DataView(header.buffer).setBigUint64(1 + SESSION_BYTES, BigInt(seq), false);
    return header;
  }

  // Returns null for anything that isn't a well-formed version-1 envelope.
  function decodeEnvelope(bytes) {
    if (bytes.length < HEADER_BYTES + 16 || bytes[0] !== E2E_VERSION) {
      return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const seq = view.getBigUint64(1 + SESSION_BYTES, false);
    if (seq > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    return {
      header: bytes.subarray(0, HEADER_BYTES),
      session: bytes.subarray(1, 1 + SESSION_BYTES),
      seq: Number(seq),
      ciphertext: bytes.subarray(HEADER_BYTES),
    };
  }

  function toHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function fromHex(text) {
    if (typeof text !== "string" || !/^([0-9a-f]{2})*$/.test(text)) {
      throw new Error("bad hex");
    }
    const out = new Uint8Array(text.length / 2);
    for (let index = 0; index < out.length; index += 1) {
      out[index] = parseInt(text.slice(index * 2, index * 2 + 2), 16);
    }
    return out;
  }

  const decodeJson = (bytes) => JSON.parse(new TextDecoder().decode(bytes));
  const encodeJson = (value) => utf8(JSON.stringify(value));

  // The client half: one HTTP session, (re)established on demand.
  // options: { noise, token, client: "browser" | "android" | ..., version?,
  //            baseUrl?: "" (same origin), fetch?: globalThis.fetch }
  // request(method, path, { query?, body?, headers? }) resolves to
  // { status, headers, body } with body as text, like the plaintext API.
  class Client {
    constructor({ noise, token, client, version = "", baseUrl = "", fetch: fetchImpl }) {
      this.noise = noise;
      this.psk = noise.derivePsk(token);
      this.hello = { client, version };
      this.baseUrl = baseUrl;
      this.fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
      this.session = null;
      this.pending = null;
      this.level = "";
    }

    async handshake() {
      const hs = new this.noise.Handshake({ initiator: true, psk: this.psk, prologue: PROLOGUE });
      const response = await this.fetch(`${this.baseUrl}/api/e2e/hs`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: hs.writeMessage(encodeJson(this.hello)),
        cache: "no-store",
      });
      if (!response.ok) {
        // A wrong token and an unreachable server look alike on purpose.
        const error = new Error(`e2e handshake refused (${response.status})`);
        error.status = response.status;
        throw error;
      }
      const reply = decodeJson(hs.readMessage(new Uint8Array(await response.arrayBuffer())));
      const { send, receive } = hs.split();
      this.level = reply.level;
      this.session = { id: fromHex(reply.session), send, receive, seq: 0 };
      return reply;
    }

    async ensureSession() {
      if (this.session) {
        return this.session;
      }
      // Concurrent first requests share one handshake.
      if (!this.pending) {
        this.pending = this.handshake().finally(() => {
          this.pending = null;
        });
      }
      await this.pending;
      return this.session;
    }

    async request(method, path, { query = "", body = "", headers = {} } = {}) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const session = await this.ensureSession();
        const seq = session.seq;
        session.seq += 1; // never reused, even if this attempt fails
        const header = encodeHeader(session.id, seq);
        const plaintext = encodeJson({ method, path, query, headers, body });
        const ciphertext = session.send.sendWithNonce(seq, concat(header, REQ), plaintext);
        const response = await this.fetch(`${this.baseUrl}/api/e2e`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: concat(header, ciphertext),
          cache: "no-store",
        });
        if (response.status === 401) {
          // Unknown or expired session (e.g. the server restarted): one fresh
          // handshake, then give up. Unauthenticated, so at worst a tunnel
          // forces a re-handshake, which it could do by dropping traffic.
          if (this.session === session) {
            this.session = null;
          }
          continue;
        }
        if (!response.ok) {
          throw new Error(`e2e request failed (${response.status})`);
        }
        const sealed = new Uint8Array(await response.arrayBuffer());
        return decodeJson(session.receive.receiveWithNonce(seq, concat(header, RES), sealed));
      }
      throw new Error("e2e session could not be re-established");
    }
  }

  // The encrypted WebSocket: /api/e2e/ws, first message Noise msg1, then every
  // message a binary frame under the channel's own keys (implicit nonces; a
  // WebSocket is ordered). JSON in, JSON out, like the plaintext socket.
  // options: { noise, token, client, version?, url (ws:// or wss://),
  //            WebSocket?: globalThis.WebSocket }
  // Set onopen(hello), onmessage(json), onclose() before calling connect().
  class Channel {
    constructor({ noise, token, client, version = "", url, WebSocket: WebSocketImpl }) {
      this.noise = noise;
      this.psk = noise.derivePsk(token);
      this.hello = { client, version };
      this.url = url;
      this.WebSocket = WebSocketImpl || globalThis.WebSocket;
      this.cipher = null;
      this.level = "";
      this.onopen = () => {};
      this.onmessage = () => {};
      this.onclose = () => {};
    }

    connect() {
      const hs = new this.noise.Handshake({ initiator: true, psk: this.psk, prologue: PROLOGUE });
      const ws = new this.WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onopen = () => ws.send(hs.writeMessage(encodeJson(this.hello)));
      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          return; // never meaningful on this socket
        }
        const bytes = new Uint8Array(event.data);
        let payload;
        try {
          if (!this.cipher) {
            const reply = decodeJson(hs.readMessage(bytes));
            this.cipher = hs.split();
            this.level = reply.level;
            this.onopen(reply);
            return;
          }
          payload = decodeJson(this.cipher.receive.receive(EMPTY, bytes));
        } catch {
          // A forged or out-of-order message: the counters can't recover.
          ws.close();
          return;
        }
        this.onmessage(payload);
      };
      ws.onclose = () => {
        this.cipher = null;
        this.onclose();
      };
      ws.onerror = () => {};
    }

    send(payload) {
      if (!this.cipher || this.ws.readyState !== 1) {
        return false;
      }
      this.ws.send(this.cipher.send.send(EMPTY, encodeJson(payload)));
      return true;
    }

    close() {
      if (this.ws) {
        this.ws.close();
      }
    }
  }

  return {
    PROTOCOL_NAME,
    E2E_VERSION,
    PROLOGUE,
    SESSION_BYTES,
    HEADER_BYTES,
    REQ,
    RES,
    createNoise,
    concat,
    utf8,
    encodeHeader,
    decodeEnvelope,
    toHex,
    fromHex,
    encodeJson,
    decodeJson,
    Client,
    Channel,
  };
});
