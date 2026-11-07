// Entry for public/airc-crypto.js: the browser's primitives for the shared
// Noise core (public/airc-noise.js), the same interface as src/noise-node.js.
// Bundled by scripts/vendor/build-airc-crypto.sh; don't edit the output.

import { x25519 } from "@noble/curves/ed25519.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";

function randomBytes(n) {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes); // also available on plain-http origins
  return bytes;
}

export const primitives = {
  x25519PublicKey(privateKey) {
    return x25519.getPublicKey(privateKey);
  },
  x25519(privateKey, publicKey) {
    const shared = x25519.getSharedSecret(privateKey, publicKey);
    // Same rule as the server: an all-zero result means a low-order peer point.
    if (shared.every((byte) => byte === 0)) {
      throw new Error("x25519: low-order point");
    }
    return shared;
  },
  randomBytes,
  sha256(data) {
    return sha256(data);
  },
  hmacSha256(key, data) {
    return hmac(sha256, key, data);
  },
  aeadEncrypt(key, nonce, ad, plaintext) {
    return chacha20poly1305(key, nonce, ad).encrypt(plaintext);
  },
  aeadDecrypt(key, nonce, ad, ciphertext) {
    return chacha20poly1305(key, nonce, ad).decrypt(ciphertext); // throws if forged
  },
};
