package dev.airc.tmuxremote

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

// The same published vector the server and browser are checked against
// (test/fixtures in the repo root; unit tests run from android-app/app).
class NoiseTest {
    private val vector = JSONObject(File("../../test/fixtures/noise-nnpsk0-25519-chachapoly-sha256.json").readText())
    private fun hex(text: String) = NoisePrimitives.hex(text)
    private fun ByteArray.toHex() = joinToString("") { "%02x".format(it) }
    private val empty = ByteArray(0)

    @Test
    fun matchesThePublishedVector() {
        val initiator = Noise.Handshake(
            initiator = true,
            psk = hex(vector.getJSONArray("init_psks").getString(0)),
            prologue = hex(vector.getString("init_prologue")),
            ephemeralPrivate = hex(vector.getString("init_ephemeral")),
        )
        val responder = Noise.Handshake(
            initiator = false,
            psk = hex(vector.getJSONArray("resp_psks").getString(0)),
            prologue = hex(vector.getString("resp_prologue")),
            ephemeralPrivate = hex(vector.getString("resp_ephemeral")),
        )
        val messages = vector.getJSONArray("messages")
        val m1 = messages.getJSONObject(0)
        val m2 = messages.getJSONObject(1)

        val wire1 = initiator.writeMessage(hex(m1.getString("payload")))
        assertEquals(m1.getString("ciphertext"), wire1.toHex())
        assertEquals(m1.getString("payload"), responder.readMessage(wire1).toHex())
        val wire2 = responder.writeMessage(hex(m2.getString("payload")))
        assertEquals(m2.getString("ciphertext"), wire2.toHex())
        assertEquals(m2.getString("payload"), initiator.readMessage(wire2).toHex())
        assertEquals(vector.getString("handshake_hash"), initiator.handshakeHash.toHex())
        assertEquals(vector.getString("handshake_hash"), responder.handshakeHash.toHex())

        val init = initiator.split()
        val resp = responder.split()
        for (index in 2 until messages.length()) {
            val message = messages.getJSONObject(index)
            val (sender, receiver) = if (index % 2 == 0) init to resp else resp to init
            val wire = sender.send.send(empty, hex(message.getString("payload")))
            assertEquals("transport message $index", message.getString("ciphertext"), wire.toHex())
            assertEquals(message.getString("payload"), receiver.receive.receive(empty, wire).toHex())
        }
    }

    @Test
    fun derivesTheSamePskAsTheServer() {
        // node -e 'console.log(Buffer.from(require("./src/noise-node").noise.derivePsk("t".repeat(32))).toString("hex"))'
        assertEquals("21a2c8b902525d5b0bc6134067f3289318239df802315ba367ce7b4bdd9f9b19", Noise.derivePsk("t".repeat(32)).toHex())
    }

    @Test
    fun aWrongPskFailsOnTheFirstMessage() {
        val initiator = Noise.Handshake(initiator = true, psk = ByteArray(32) { 1 })
        val responder = Noise.Handshake(initiator = false, psk = ByteArray(32) { 2 })
        assertThrows(Exception::class.java) { responder.readMessage(initiator.writeMessage()) }
    }

    @Test
    fun tamperingAndWrongNoncesAreRejected() {
        val psk = ByteArray(32) { 7 }
        val initiator = Noise.Handshake(initiator = true, psk = psk)
        val responder = Noise.Handshake(initiator = false, psk = psk)
        val wire1 = initiator.writeMessage("hello".toByteArray())
        val tampered = wire1.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }
        assertThrows(Exception::class.java) { Noise.Handshake(initiator = false, psk = psk).readMessage(tampered) }
        responder.readMessage(wire1)
        initiator.readMessage(responder.writeMessage())
        val a = initiator.split()
        val b = responder.split()
        val ad = "ad".toByteArray()
        val wire = a.send.sendWithNonce(5, ad, "keys".toByteArray())
        assertArrayEquals("keys".toByteArray(), b.receive.receiveWithNonce(5, ad, wire))
        assertThrows(Exception::class.java) { b.receive.receiveWithNonce(6, ad, wire) }
        assertThrows(Exception::class.java) { b.receive.receiveWithNonce(5, "AD".toByteArray(), wire) }
    }

    @Test
    fun freshHandshakesGetDifferentKeysAndOutOfTurnIsRefused() {
        val psk = ByteArray(32) { 9 }
        val keys = (0 until 2).map {
            val initiator = Noise.Handshake(initiator = true, psk = psk)
            val responder = Noise.Handshake(initiator = false, psk = psk)
            responder.readMessage(initiator.writeMessage())
            initiator.readMessage(responder.writeMessage())
            initiator.split().send.key.toHex()
        }
        assertFalse(keys[0] == keys[1])
        val initiator = Noise.Handshake(initiator = true, psk = psk)
        assertThrows(NoiseException::class.java) { initiator.readMessage(ByteArray(48)) }
        assertThrows(NoiseException::class.java) { initiator.split() }
    }

    @Test
    fun aLowOrderPointIsRefused() {
        assertThrows(Exception::class.java) { NoisePrimitives.x25519(NoisePrimitives.randomBytes(32), ByteArray(32)) }
    }
}
