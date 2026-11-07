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

    return { Handshake, CipherState };
  }

  return { PROTOCOL_NAME, createNoise, concat, utf8 };
});
