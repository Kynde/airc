"use strict";

const assert = require("node:assert");
const { test } = require("node:test");

const { noise } = require("../src/noise-node");
const vector = require("./fixtures/noise-nnpsk0-25519-chachapoly-sha256.json");

const hex = (text) => Buffer.from(text, "hex");
const toHex = (bytes) => Buffer.from(bytes).toString("hex");
const EMPTY = new Uint8Array(0);

function vectorPair() {
  const initiator = new noise.Handshake({
    initiator: true,
    psk: hex(vector.init_psks[0]),
    prologue: hex(vector.init_prologue),
    ephemeralPrivate: hex(vector.init_ephemeral),
  });
  const responder = new noise.Handshake({
    initiator: false,
    psk: hex(vector.resp_psks[0]),
    prologue: hex(vector.resp_prologue),
    ephemeralPrivate: hex(vector.resp_ephemeral),
  });
  return { initiator, responder };
}

test("matches the published Noise_NNpsk0_25519_ChaChaPoly_SHA256 vector", () => {
  const { initiator, responder } = vectorPair();
  const [m1, m2, ...transport] = vector.messages;

  const wire1 = initiator.writeMessage(hex(m1.payload));
  assert.strictEqual(toHex(wire1), m1.ciphertext);
  assert.strictEqual(toHex(responder.readMessage(wire1)), m1.payload);

  const wire2 = responder.writeMessage(hex(m2.payload));
  assert.strictEqual(toHex(wire2), m2.ciphertext);
  assert.strictEqual(toHex(initiator.readMessage(wire2)), m2.payload);

  assert.strictEqual(toHex(initiator.handshakeHash), vector.handshake_hash);
  assert.strictEqual(toHex(responder.handshakeHash), vector.handshake_hash);

  // Transport messages keep alternating, initiator first, implicit nonces.
  const init = initiator.split();
  const resp = responder.split();
  transport.forEach((message, index) => {
    const [sender, receiver] = index % 2 === 0 ? [init, resp] : [resp, init];
    const wire = sender.send.send(EMPTY, hex(message.payload));
    assert.strictEqual(toHex(wire), message.ciphertext, `transport message ${index}`);
    assert.strictEqual(toHex(receiver.receive.receive(EMPTY, wire)), message.payload);
  });
});

test("a wrong psk fails on the first message", () => {
  const initiator = new noise.Handshake({ initiator: true, psk: Buffer.alloc(32, 1) });
  const responder = new noise.Handshake({ initiator: false, psk: Buffer.alloc(32, 2) });
  assert.throws(() => responder.readMessage(initiator.writeMessage(EMPTY)));
});

test("any flipped bit in a handshake or transport message is rejected", () => {
  const psk = Buffer.alloc(32, 7);
  const initiator = new noise.Handshake({ initiator: true, psk });
  const wire1 = initiator.writeMessage(Buffer.from("hello"));
  for (const position of [0, 31, 32, wire1.length - 1]) {
    const tampered = Buffer.from(wire1);
    tampered[position] ^= 0x01;
    assert.throws(() => new noise.Handshake({ initiator: false, psk }).readMessage(tampered), `byte ${position}`);
  }

  const responder = new noise.Handshake({ initiator: false, psk });
  responder.readMessage(wire1);
  initiator.readMessage(responder.writeMessage(EMPTY));
  const a = initiator.split();
  const b = responder.split();
  const wire = Buffer.from(a.send.sendWithNonce(5, Buffer.from("ad"), Buffer.from("keys")));
  assert.strictEqual(Buffer.from(b.receive.receiveWithNonce(5, Buffer.from("ad"), wire)).toString(), "keys");
  assert.throws(() => b.receive.receiveWithNonce(6, Buffer.from("ad"), wire), "wrong nonce");
  assert.throws(() => b.receive.receiveWithNonce(5, Buffer.from("AD"), wire), "wrong ad");
  wire[0] ^= 0x01;
  assert.throws(() => b.receive.receiveWithNonce(5, Buffer.from("ad"), wire), "tampered body");
});

test("fresh handshakes with the same psk get different keys", () => {
  const psk = Buffer.alloc(32, 9);
  const keys = [];
  for (let index = 0; index < 2; index += 1) {
    const initiator = new noise.Handshake({ initiator: true, psk });
    const responder = new noise.Handshake({ initiator: false, psk });
    responder.readMessage(initiator.writeMessage(EMPTY));
    initiator.readMessage(responder.writeMessage(EMPTY));
    keys.push(toHex(initiator.split().send.key));
  }
  assert.notStrictEqual(keys[0], keys[1]);
});

test("messages out of turn are refused", () => {
  const initiator = new noise.Handshake({ initiator: true, psk: Buffer.alloc(32, 3) });
  assert.throws(() => initiator.readMessage(Buffer.alloc(48)));
  const responder = new noise.Handshake({ initiator: false, psk: Buffer.alloc(32, 3) });
  assert.throws(() => responder.writeMessage(EMPTY));
  assert.throws(() => initiator.split());
});
