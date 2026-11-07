"use strict";

// Server half of the end-to-end layer (docs/e2e-encryption.md): handshakes,
// sessions, and opening/sealing request envelopes. The wire format and the
// Noise state machine are shared with the clients in public/airc-noise.js.

const crypto = require("node:crypto");
const shared = require("../public/airc-noise");
const { noise } = require("./noise-node");

const MAX_SESSIONS = 256;
const IDLE_MS = 15 * 60 * 1000;
const LIFETIME_MS = 24 * 60 * 60 * 1000;
const REPLAY_WINDOW = 1024; // how far behind the newest seq a request may arrive
const HANDSHAKE_LIMIT_BYTES = 1024;

// Accepts each seq at most once, tolerating reordering within REPLAY_WINDOW.
// check() before decrypting (cheap rejection), commit() only after the message
// authenticated, so a forged envelope can't burn a legitimate seq.
class ReplayWindow {
  constructor() {
    this.max = -1;
    this.seen = new Set();
  }

  check(seq) {
    if (seq > this.max) {
      return true;
    }
    return seq > this.max - REPLAY_WINDOW && !this.seen.has(seq);
  }

  commit(seq) {
    this.seen.add(seq);
    if (seq > this.max) {
      this.max = seq;
      if (this.seen.size > REPLAY_WINDOW) {
        for (const old of this.seen) {
          if (old <= this.max - REPLAY_WINDOW) {
            this.seen.delete(old);
          }
        }
      }
    }
  }
}

// keys: () => [{ level, token }] in the order to try, re-read on each
// handshake so a token change takes effect without a restart.
function createE2e({ keys, serverVersion = "", now = () => Date.now() }) {
  const sessions = new Map(); // session hex -> session

  function expired(session, at) {
    return at - session.lastUsed > IDLE_MS || at - session.createdAt > LIFETIME_MS;
  }

  function evictForNewSession(at) {
    for (const [id, session] of sessions) {
      if (expired(session, at)) {
        sessions.delete(id);
      }
    }
    // Still full: the least recently used goes. Map order is insertion order,
    // and touch() re-inserts, so the first entry is the stalest.
    while (sessions.size >= MAX_SESSIONS) {
      sessions.delete(sessions.keys().next().value);
    }
  }

  // msg1 -> { reply: msg2 bytes, level } or null when no token authenticates it.
  // The level is learned by trial decryption, so no token id is on the wire.
  function handshake(message) {
    if (!(message instanceof Uint8Array) || message.length > HANDSHAKE_LIMIT_BYTES) {
      return null;
    }
    for (const { level, token } of keys()) {
      if (!token) {
        continue;
      }
      const hs = new noise.Handshake({ initiator: false, psk: noise.derivePsk(token), prologue: shared.PROLOGUE });
      try {
        hs.readMessage(message); // the payload (client hello) is informational only
      } catch {
        continue;
      }
      const at = now();
      evictForNewSession(at);
      const id = crypto.randomBytes(shared.SESSION_BYTES);
      const expiresAt = at + LIFETIME_MS;
      const reply = hs.writeMessage(shared.encodeJson({
        session: shared.toHex(id),
        level,
        serverVersion,
        expiresAt: new Date(expiresAt).toISOString(),
      }));
      const { send, receive } = hs.split();
      sessions.set(shared.toHex(id), {
        level,
        send,
        receive,
        replay: new ReplayWindow(),
        createdAt: at,
        lastUsed: at,
      });
      return { reply, level };
    }
    return null;
  }

  // envelope bytes -> { session, seq, header, request } or null. null always
  // means "re-handshake": unknown or expired session, replay, or forgery.
  function open(bytes) {
    const envelope = shared.decodeEnvelope(bytes);
    if (!envelope) {
      return null;
    }
    const key = shared.toHex(envelope.session);
    const session = sessions.get(key);
    const at = now();
    if (!session || expired(session, at)) {
      sessions.delete(key);
      return null;
    }
    if (!session.replay.check(envelope.seq)) {
      return null;
    }
    let request;
    try {
      const plaintext = session.receive.receiveWithNonce(envelope.seq, shared.concat(envelope.header, shared.REQ), envelope.ciphertext);
      request = shared.decodeJson(plaintext);
    } catch {
      return null;
    }
    session.replay.commit(envelope.seq);
    session.lastUsed = at;
    sessions.delete(key); // re-insert: keeps Map order = least recently used first
    sessions.set(key, session);
    return { session, seq: envelope.seq, header: Uint8Array.from(envelope.header), request };
  }

  function seal(opened, response) {
    return opened.session.send.sendWithNonce(opened.seq, shared.concat(opened.header, shared.RES), shared.encodeJson(response));
  }

  return { handshake, open, seal, sessionCount: () => sessions.size };
}

module.exports = { createE2e, ReplayWindow, HANDSHAKE_LIMIT_BYTES, REPLAY_WINDOW, MAX_SESSIONS };
