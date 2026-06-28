package dev.airc.tmuxremote

import android.util.Base64
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSession
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

// Trust-on-first-use pinning for the LAN server's self-signed cert. The cert's
// SHA-256 fingerprint arrives in the QR pairing payload; here we accept a leaf
// whose fingerprint matches the pin and DELEGATE everything else to the platform
// default trust manager. That delegation is what keeps the ngrok tunnel (a real
// CA cert) working through the same client — only the pinned LAN cert skips the
// normal CA + hostname checks (the LAN IP has no CA-valid name to verify).
object Pinning {

    // Base64 of the cert's DER SHA-256 — must match the server's certFingerprint
    // (config.js certFingerprint(): crypto.createHash("sha256").update(der).digest("base64")).
    private fun fingerprintOf(cert: X509Certificate): String =
        Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(cert.encoded), Base64.NO_WRAP)

    private fun systemTrustManager(): X509TrustManager {
        val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        factory.init(null as KeyStore?)
        return factory.trustManagers.filterIsInstance<X509TrustManager>().first()
    }

    private class PinnedTrustManager(
        private val fingerprint: String,
        private val delegate: X509TrustManager,
    ) : X509TrustManager {
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            val leaf = chain?.firstOrNull()
            if (leaf != null && fingerprintOf(leaf) == fingerprint) {
                return
            }
            delegate.checkServerTrusted(chain, authType)
        }

        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) =
            delegate.checkClientTrusted(chain, authType)

        override fun getAcceptedIssuers(): Array<X509Certificate> = delegate.acceptedIssuers
    }

    // Bundle the three pieces a caller needs to install on OkHttp / HttpsURLConnection.
    class Pinned(
        val trustManager: X509TrustManager,
        val socketFactory: SSLSocketFactory,
        val hostnameVerifier: HostnameVerifier,
    )

    // Build pinning material for one fingerprint, or null when none is set (the
    // caller then leaves the connection on default trust — e.g. an old payload).
    fun forFingerprint(fingerprint: String): Pinned? {
        if (fingerprint.isBlank()) return null
        val system = systemTrustManager()
        val trustManager = PinnedTrustManager(fingerprint, system)
        val sslContext = SSLContext.getInstance("TLS")
        sslContext.init(null, arrayOf<javax.net.ssl.TrustManager>(trustManager), null)
        // Accept the hostname only for the matching pinned leaf (the LAN IP has no
        // CA-valid name); anything else falls back to strict default verification.
        val defaultVerifier = javax.net.ssl.HttpsURLConnection.getDefaultHostnameVerifier()
        val verifier = HostnameVerifier { hostname, session: SSLSession ->
            val leaf = session.peerCertificates.firstOrNull() as? X509Certificate
            if (leaf != null && fingerprintOf(leaf) == fingerprint) {
                true
            } else {
                defaultVerifier.verify(hostname, session)
            }
        }
        return Pinned(trustManager, sslContext.socketFactory, verifier)
    }
}
