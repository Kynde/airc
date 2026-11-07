package dev.airc.tmuxremote

import java.nio.ByteBuffer
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject

// Airc's envelope around the Noise transport (docs/e2e-encryption.md), the
// same wire format as public/airc-noise.js:
//
//   POST /api/e2e/hs   body: Noise msg1          -> 200 body: Noise msg2
//   POST /api/e2e      body: header | ciphertext -> 200 body: ciphertext
//   WS   /api/e2e/ws   msg1 -> msg2, then binary frames, implicit nonces
//
// header = version(1) | session(16) | seq(8, big-endian). A request is sealed
// with nonce = seq and AD = header|"req", its response with the same seq and
// AD = header|"res". The token never goes on the wire.
object E2eWire {
    const val VERSION: Byte = 1
    const val SESSION_BYTES = 16
    const val HEADER_BYTES = 1 + SESSION_BYTES + 8
    val PROLOGUE = "airc-e2e-v1".toByteArray()
    val REQ = "req".toByteArray()
    val RES = "res".toByteArray()

    fun header(session: ByteArray, seq: Long): ByteArray =
        ByteBuffer.allocate(HEADER_BYTES).put(VERSION).put(session).putLong(seq).array()

    fun fromHex(text: String): ByteArray {
        require(text.length % 2 == 0 && text.all { it in '0'..'9' || it in 'a'..'f' }) { "bad hex" }
        return NoisePrimitives.hex(text)
    }
}

// A refused handshake: a wrong token (404) or a throttled address (429). Kept
// apart from transport errors so the UI can say "not authorized".
class E2eRefused(val status: Int) : Exception("e2e handshake refused ($status)")

// One HTTP session with the server, (re)established on demand and shared by
// every endpoint (LAN or tunnel): the server keys sessions by id, not by host.
// post(url, body, connectMs, readMs) performs one POST and returns
// (status, body); the caller owns pinning.
class E2eClient(
    token: String,
    private val client: String,
    private val version: String,
    private val post: (url: String, body: ByteArray, connectMs: Int, readMs: Int) -> Pair<Int, ByteArray>,
) {
    class Reply(val status: Int, private val headers: JSONObject, val body: String) {
        fun header(name: String): String? =
            headers.keys().asSequence().firstOrNull { it.equals(name, ignoreCase = true) }?.let { headers.optString(it) }
    }

    private class Session(val id: ByteArray, val transport: Noise.Transport) {
        var seq = 0L
    }

    private val psk = Noise.derivePsk(token)
    private val lock = Any()
    private var session: Session? = null
    @Volatile var level: String = ""
        private set
    @Volatile var serverVersion: String = ""
        private set

    private fun handshake(baseUrl: String, connectMs: Int, readMs: Int): Session {
        val hs = Noise.Handshake(initiator = true, psk = psk, prologue = E2eWire.PROLOGUE)
        val hello = JSONObject().put("client", client).put("version", version).toString().toByteArray()
        val (status, body) = post("$baseUrl/api/e2e/hs", hs.writeMessage(hello), connectMs, readMs)
        if (status !in 200..299) throw E2eRefused(status)
        val reply = JSONObject(String(hs.readMessage(body), Charsets.UTF_8))
        level = reply.optString("level")
        serverVersion = reply.optString("serverVersion")
        val id = E2eWire.fromHex(reply.getString("session"))
        require(id.size == E2eWire.SESSION_BYTES) { "bad session id" }
        return Session(id, hs.split())
    }

    // Concurrent callers share one handshake: the lock is held across it, so a
    // second caller waits and then reuses the fresh session.
    private fun ensureSession(baseUrl: String, connectMs: Int, readMs: Int): Session = synchronized(lock) {
        session ?: handshake(baseUrl, connectMs, readMs).also { session = it }
    }

    fun request(
        baseUrl: String,
        method: String,
        path: String,
        query: String = "",
        body: String = "",
        headers: Map<String, String> = emptyMap(),
        connectMs: Int = 2500,
        readMs: Int = 6000,
    ): Reply {
        repeat(2) {
            val current = ensureSession(baseUrl, connectMs, readMs)
            val seq = synchronized(lock) { current.seq++ } // never reused, even if this attempt fails
            val header = E2eWire.header(current.id, seq)
            val plaintext = JSONObject()
                .put("method", method)
                .put("path", path)
                .put("query", query)
                .put("headers", JSONObject(headers))
                .put("body", body)
                .toString()
                .toByteArray()
            val sealed = current.transport.send.sendWithNonce(seq, header + E2eWire.REQ, plaintext)
            val (status, response) = post("$baseUrl/api/e2e", header + sealed, connectMs, readMs)
            if (status == 401) {
                // Unknown or expired session (e.g. the server restarted): one
                // fresh handshake, then give up. Unauthenticated, so at worst a
                // tunnel forces a re-handshake, which it could do by dropping traffic.
                synchronized(lock) { if (session === current) session = null }
                return@repeat
            }
            if (status !in 200..299) throw java.io.IOException("e2e request failed ($status)")
            val opened = current.transport.receive.receiveWithNonce(seq, header + E2eWire.RES, response)
            val reply = JSONObject(String(opened, Charsets.UTF_8))
            return Reply(reply.optInt("status"), reply.optJSONObject("headers") ?: JSONObject(), reply.optString("body"))
        }
        throw java.io.IOException("e2e session could not be re-established")
    }

    // Forget the session, e.g. after re-pairing with a new token.
    fun reset() = synchronized(lock) { session = null }
}

// The encrypted WebSocket. The callbacks run on OkHttp's reader thread:
// onReady(msg2 payload) once the handshake is done, onMessage(json text) for
// each message after, onDown() once when the socket ends for any reason.
class E2eChannel(
    token: String,
    private val client: String,
    private val version: String,
    private val onReady: (JSONObject) -> Unit,
    private val onMessage: (String) -> Unit,
    private val onDown: () -> Unit,
) {
    private val psk = Noise.derivePsk(token)
    private val handshake = Noise.Handshake(initiator = true, psk = psk, prologue = E2eWire.PROLOGUE)
    @Volatile private var transport: Noise.Transport? = null
    private var socket: WebSocket? = null
    private var down = false

    private fun markDown() {
        val first = synchronized(this) { !down.also { down = true } }
        transport = null
        if (first) onDown()
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            val hello = JSONObject().put("client", client).put("version", version).toString().toByteArray()
            synchronized(this@E2eChannel) { webSocket.send(handshake.writeMessage(hello).toByteString()) }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            try {
                val current = transport
                if (current == null) {
                    val reply = JSONObject(String(handshake.readMessage(bytes.toByteArray()), Charsets.UTF_8))
                    transport = handshake.split()
                    onReady(reply)
                    return
                }
                val text = String(current.receive.receive(ByteArray(0), bytes.toByteArray()), Charsets.UTF_8)
                onMessage(text)
            } catch (_: Exception) {
                // A forged or out-of-order message: the counters can't recover.
                webSocket.cancel()
                markDown()
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            // Never meaningful on this socket.
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
            markDown()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = markDown()

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = markDown()
    }

    // url: the endpoint's base URL (http(s)://...), OkHttp upgrades it.
    fun connect(http: OkHttpClient, baseUrl: String) {
        socket = http.newWebSocket(Request.Builder().url("$baseUrl/api/e2e/ws").build(), listener)
    }

    val ready get() = transport != null

    // Encrypt and enqueue under one lock so nonce order matches send order.
    fun send(json: String): Boolean = synchronized(this) {
        val current = transport ?: return false
        val ws = socket ?: return false
        ws.send(current.send.send(ByteArray(0), json.toByteArray()).toByteString())
    }

    fun close() {
        socket?.close(1000, null)
        markDown()
    }
}
