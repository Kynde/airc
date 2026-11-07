"use strict";

// node:crypto primitives for the shared Noise core (public/airc-noise.js).
// No third-party code on the server side: OpenSSL provides X25519,
// ChaCha20-Poly1305, SHA-256 and HMAC.

const crypto = require("node:crypto");
const { createNoise } = require("../public/airc-noise");

// Fixed DER wrappers that turn raw 32-byte X25519 keys into PKCS#8 / SPKI.
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

function privateKeyObject(raw) {
  return crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
}

function publicKeyObject(raw) {
  return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

const primitives = {
  x25519PublicKey(privateKey) {
    const spki = crypto.createPublicKey(privateKeyObject(privateKey)).export({ format: "der", type: "spki" });
    return spki.subarray(spki.length - 32);
  },
  x25519(privateKey, publicKey) {
    // OpenSSL refuses an all-zero result (a low-order peer point) by throwing.
    return crypto.diffieHellman({ privateKey: privateKeyObject(privateKey), publicKey: publicKeyObject(publicKey) });
  },
  randomBytes(n) {
    return crypto.randomBytes(n);
  },
  sha256(data) {
    return crypto.createHash("sha256").update(data).digest();
  },
  hmacSha256(key, data) {
    return crypto.createHmac("sha256", key).update(data).digest();
  },
  aeadEncrypt(key, nonce, ad, plaintext) {
    const cipher = crypto.createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    cipher.setAAD(ad, { plaintextLength: plaintext.length });
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  },
  aeadDecrypt(key, nonce, ad, ciphertext) {
    const body = ciphertext.subarray(0, ciphertext.length - 16);
    const decipher = crypto.createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    decipher.setAAD(ad, { plaintextLength: body.length });
    return Buffer.concat([decipher.update(body), decipher.final()]); // final() throws if forged
  },
};

module.exports = { primitives, noise: createNoise(primitives) };
