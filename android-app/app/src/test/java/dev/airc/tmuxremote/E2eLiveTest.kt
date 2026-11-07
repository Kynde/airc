package dev.airc.tmuxremote

import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

// Interop against a running server (skipped unless both are set):
//   AIRC_E2E_URL=http://127.0.0.1:18765 AIRC_E2E_TOKEN=<control token> \
//     ./gradlew testDebugUnitTest --tests '*E2eLiveTest*'
class E2eLiveTest {
    private val baseUrl = System.getenv("AIRC_E2E_URL") ?: ""
    private val token = System.getenv("AIRC_E2E_TOKEN") ?: ""

    private fun post(url: String, body: ByteArray, connectMs: Int, readMs: Int): Pair<Int, ByteArray> {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = connectMs
            readTimeout = readMs
        }
        connection.outputStream.use { it.write(body) }
        val code = connection.responseCode
        val stream = if (code in 200..299) connection.inputStream else connection.errorStream
        return code to (stream?.use { it.readBytes() } ?: ByteArray(0))
    }

    @Test
    fun requestsAndTheStreamWorkAgainstTheServer() {
        assumeTrue(baseUrl.isNotBlank() && token.isNotBlank())
        val client = E2eClient(token, "android-test", "", ::post)
        val config = client.request(baseUrl, "GET", "/api/config")
        assertEquals(200, config.status)
        assertEquals("control", JSONObject(config.body).getString("authLevel"))
        assertEquals("control", client.level)
        assertEquals(200, client.request(baseUrl, "GET", "/api/pairing").status)

        // ETag round trip inside the envelope.
        val frame = client.request(baseUrl, "GET", "/api/tmux/frame")
        frame.header("ETag")?.let { etag ->
            assertEquals(304, client.request(baseUrl, "GET", "/api/tmux/frame", headers = mapOf("If-None-Match" to etag)).status)
        }

        assertThrows(E2eRefused::class.java) {
            E2eClient("x".repeat(32), "android-test", "", ::post).request(baseUrl, "GET", "/api/config")
        }

        val types = mutableListOf<String>()
        val got = CountDownLatch(1)
        lateinit var channel: E2eChannel
        channel = E2eChannel(token, "android-test", "",
            onReady = { channel.send(JSONObject().put("type", "view").put("pane", "").put("session", "").toString()) },
            onMessage = { text ->
                synchronized(types) { types.add(JSONObject(text).optString("type")) }
                if ("frame" in types || "error" in types) got.countDown()
            },
            onDown = { got.countDown() })
        channel.connect(OkHttpClient(), baseUrl)
        assertTrue("no frame in time", got.await(5, TimeUnit.SECONDS))
        channel.close()
        assertTrue(types.toString(), types.first() == "hello" && ("frame" in types || "error" in types))
    }
}
