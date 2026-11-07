package dev.airc.tmuxremote

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

// Noise_NNpsk0_25519_ChaChaPoly_SHA256, the handshake and transport ciphers of
// Airc's end-to-end layer (docs/e2e-encryption.md). A line-for-line port of
// the state machine in public/airc-noise.js, checked against the same published
// vector (app/src/test). Platform JCA only: XDH needs API 33, hence minSdk 33.
//
//   -> psk, e
//   <- e, ee

object NoisePrimitives {
    // Fixed DER wrappers that turn raw 32-byte X25519 keys into PKCS#8 / SPKI.
    private val PKCS8_PREFIX = hex("302e020100300506032b656e04220420")
    private val SPKI_PREFIX = hex("302a300506032b656e032100")
    private val BASE_POINT = ByteArray(32).also { it[0] = 9 }
    private val random = SecureRandom()

    fun randomBytes(n: Int): ByteArray = ByteArray(n).also { random.nextBytes(it) }

    fun x25519(privateKey: ByteArray, publicKey: ByteArray): ByteArray {
        val factory = KeyFactory.getInstance("XDH")
        val agreement = KeyAgreement.getInstance("XDH")
        agreement.init(factory.generatePrivate(PKCS8EncodedKeySpec(PKCS8_PREFIX + privateKey)))
        agreement.doPhase(factory.generatePublic(X509EncodedKeySpec(SPKI_PREFIX + publicKey)), true)
        val shared = agreement.generateSecret()
        // Same rule as the server: an all-zero result means a low-order peer
        // point. Providers differ on whether they check, so check here.
        require(shared.any { it != 0.toByte() }) { "x25519: low-order point" }
        return shared
    }

    // X25519(k, 9). JCA has no "public key from raw private key" call, but the
    // definition of the public key is exactly this.
    fun x25519PublicKey(privateKey: ByteArray): ByteArray = x25519(privateKey, BASE_POINT)

    fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

    fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        // SecretKeySpec refuses an empty key; Noise never passes one.
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    private fun chacha(mode: Int, key: ByteArray, nonce: ByteArray, ad: ByteArray, input: ByteArray): ByteArray {
        // Android's Conscrypt names it ChaCha20/Poly1305/NoPadding; the desktop
        // JDK (unit tests) only knows ChaCha20-Poly1305.
        val cipher = try {
            Cipher.getInstance("ChaCha20/Poly1305/NoPadding")
        } catch (e: java.security.GeneralSecurityException) {
            Cipher.getInstance("ChaCha20-Poly1305")
        }
        cipher.init(mode, SecretKeySpec(key, "ChaCha20"), IvParameterSpec(nonce))
        cipher.updateAAD(ad)
        return cipher.doFinal(input)
    }

    fun aeadEncrypt(key: ByteArray, nonce: ByteArray, ad: ByteArray, plaintext: ByteArray): ByteArray =
        chacha(Cipher.ENCRYPT_MODE, key, nonce, ad, plaintext)

    // Throws (AEADBadTagException) if forged.
    fun aeadDecrypt(key: ByteArray, nonce: ByteArray, ad: ByteArray, ciphertext: ByteArray): ByteArray =
        chacha(Cipher.DECRYPT_MODE, key, nonce, ad, ciphertext)

    fun hex(text: String): ByteArray = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}

class NoiseException(message: String) : Exception(message)

object Noise {
    const val PROTOCOL_NAME = "Noise_NNpsk0_25519_ChaChaPoly_SHA256"
    private const val DHLEN = 32
    private const val HASHLEN = 32
    private const val TAGLEN = 16
    private val EMPTY = ByteArray(0)
    private val PSK_INFO = "airc e2e v1 psk".toByteArray()
    private val p = NoisePrimitives

    // ChaChaPoly nonce: 32 bits of zeros, then the 64-bit counter little-endian.
    fun chachaNonce(n: Long): ByteArray {
        if (n < 0 || n == Long.MAX_VALUE) throw NoiseException("noise: nonce out of range")
        return ByteBuffer.allocate(12).order(ByteOrder.LITTLE_ENDIAN).putInt(0).putLong(n).array()
    }

    // HKDF as Noise defines it (section 4.3), with 2 or 3 outputs.
    private fun hkdf(chainingKey: ByteArray, ikm: ByteArray, outputs: Int): List<ByteArray> {
        val tempKey = p.hmacSha256(chainingKey, ikm)
        val out1 = p.hmacSha256(tempKey, byteArrayOf(1))
        val out2 = p.hmacSha256(tempKey, out1 + byteArrayOf(2))
        if (outputs == 2) return listOf(out1, out2)
        return listOf(out1, out2, p.hmacSha256(tempKey, out2 + byteArrayOf(3)))
    }

    // RFC 5869 HKDF-SHA256 with one output block: turns a token into the
    // 32-byte Noise psk. (Noise's own HKDF above is a different construction.)
    fun derivePsk(token: String): ByteArray {
        val prk = p.hmacSha256(ByteArray(32), token.toByteArray(Charsets.UTF_8))
        return p.hmacSha256(prk, PSK_INFO + byteArrayOf(1))
    }

    // One direction of a transport. send/receive use (and advance) the implicit
    // counter, for an ordered channel such as a WebSocket. The *WithNonce forms
    // take an explicit counter, for HTTP requests (spec section 11.4); the
    // caller then owns uniqueness (sender) and replay rejection (receiver).
    class CipherState(val key: ByteArray) {
        var n = 0L
            private set

        fun sendWithNonce(nonce: Long, ad: ByteArray, plaintext: ByteArray): ByteArray =
            p.aeadEncrypt(key, chachaNonce(nonce), ad, plaintext)

        fun receiveWithNonce(nonce: Long, ad: ByteArray, ciphertext: ByteArray): ByteArray {
            if (ciphertext.size < TAGLEN) throw NoiseException("noise: message too short")
            return p.aeadDecrypt(key, chachaNonce(nonce), ad, ciphertext)
        }

        @Synchronized
        fun send(ad: ByteArray, plaintext: ByteArray): ByteArray = sendWithNonce(n, ad, plaintext).also { n += 1 }

        // n advances only after the message authenticated.
        @Synchronized
        fun receive(ad: ByteArray, ciphertext: ByteArray): ByteArray = receiveWithNonce(n, ad, ciphertext).also { n += 1 }
    }

    class Transport(val send: CipherState, val receive: CipherState)

    // SymmetricState plus HandshakeState for NNpsk0 only. Message 1 is always
    // initiator -> responder, message 2 the reverse. ephemeralPrivate exists for
    // the test vectors; leave it out otherwise.
    class Handshake(
        private val initiator: Boolean,
        private val psk: ByteArray,
        prologue: ByteArray = EMPTY,
        ephemeralPrivate: ByteArray? = null,
    ) {
        private var ePriv: ByteArray? = ephemeralPrivate ?: p.randomBytes(DHLEN)
        private val ePub: ByteArray = p.x25519PublicKey(ePriv!!)
        private var re: ByteArray? = null
        private var step = 0 // messages processed so far: 0, 1, then 2 = complete
        private var h: ByteArray
        private var ck: ByteArray
        private var k: ByteArray? = null
        private var n = 0L

        init {
            if (psk.size != 32) throw NoiseException("noise: psk must be 32 bytes")
            // InitializeSymmetric: the name is longer than HASHLEN, so h = HASH(name).
            val name = PROTOCOL_NAME.toByteArray()
            h = if (name.size <= HASHLEN) name + ByteArray(HASHLEN - name.size) else p.sha256(name)
            ck = h
            mixHash(prologue)
        }

        val complete get() = step == 2
        val handshakeHash get() = h

        private fun mixHash(data: ByteArray) {
            h = p.sha256(h + data)
        }

        private fun mixKey(ikm: ByteArray) {
            val (nextCk, tempK) = hkdf(ck, ikm, 2)
            ck = nextCk
            k = tempK
            n = 0
        }

        private fun mixKeyAndHash(ikm: ByteArray) {
            val (nextCk, tempH, tempK) = hkdf(ck, ikm, 3)
            ck = nextCk
            mixHash(tempH)
            k = tempK
            n = 0
        }

        private fun encryptAndHash(plaintext: ByteArray): ByteArray {
            val key = k
            val ciphertext = if (key != null) p.aeadEncrypt(key, chachaNonce(n), h, plaintext).also { n += 1 } else plaintext
            mixHash(ciphertext)
            return ciphertext
        }

        private fun decryptAndHash(ciphertext: ByteArray): ByteArray {
            val key = k
            val plaintext = if (key != null) p.aeadDecrypt(key, chachaNonce(n), h, ciphertext).also { n += 1 } else ciphertext
            mixHash(ciphertext)
            return plaintext
        }

        // The `e` token in a psk handshake: MixHash(e) then MixKey(e).
        private fun mixEphemeral(publicKey: ByteArray) {
            mixHash(publicKey)
            mixKey(publicKey)
        }

        private fun ourTurn() = if (initiator) step == 0 else step == 1

        fun writeMessage(payload: ByteArray = EMPTY): ByteArray {
            if (step >= 2 || !ourTurn()) throw NoiseException("noise: not our turn to write")
            if (step == 0) {
                mixKeyAndHash(psk) // psk
                mixEphemeral(ePub) // e
            } else {
                mixEphemeral(ePub) // e
                mixKey(p.x25519(ePriv!!, re!!)) // ee
            }
            val out = ePub + encryptAndHash(payload)
            step += 1
            return out
        }

        fun readMessage(message: ByteArray): ByteArray {
            if (step >= 2 || ourTurn()) throw NoiseException("noise: not our turn to read")
            if (message.size < DHLEN + TAGLEN) throw NoiseException("noise: handshake message too short")
            val peer = message.copyOfRange(0, DHLEN)
            if (step == 0) {
                mixKeyAndHash(psk) // psk
                mixEphemeral(peer) // e
            } else {
                mixEphemeral(peer) // e
                mixKey(p.x25519(ePriv!!, peer)) // ee
            }
            val payload = decryptAndHash(message.copyOfRange(DHLEN, message.size))
            re = peer
            step += 1
            return payload
        }

        // Split: the first key encrypts initiator -> responder, the second the
        // reverse. Returned from this side's point of view.
        fun split(): Transport {
            if (!complete) throw NoiseException("noise: handshake not complete")
            val (k1, k2) = hkdf(ck, EMPTY, 2)
            ePriv = null
            k = null
            return if (initiator) Transport(CipherState(k1), CipherState(k2)) else Transport(CipherState(k2), CipherState(k1))
        }
    }
}
