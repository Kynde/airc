package dev.airc.tmuxremote

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import kotlin.concurrent.thread

data class Profile(
    val name: String,
    val baseUrl: String,
    val token: String,
    val session: String,
    val publicUrl: String = "",
    val lanUrls: List<String> = emptyList()
)

data class Pane(
    val paneId: String,
    val label: String,
    val active: Boolean
)

class MainActivity : ComponentActivity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var webView: WebView
    private lateinit var status: TextView
    private lateinit var paneButton: Button
    private lateinit var input: EditText
    private var profile: Profile? = null
    private var pinnedPane: String = ""
    private var etag: String? = null
    private var polling = false
    private var lastGoodUrl: String = ""
    private var lastLanProbeAt: Long = 0

    private val qrLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val contents = result.data?.getStringExtra(QrScanActivity.EXTRA_QR_TEXT)
        if (!contents.isNullOrBlank()) {
            saveProfile(parseProfile(contents))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        profile = loadProfile()
        pinnedPane = prefs().getString("pinnedPane", "") ?: ""
        lastGoodUrl = prefs().getString("lastGoodUrl", "") ?: ""
        buildUi()
        if (profile == null) {
            showPairDialog()
        } else {
            startPolling()
        }
    }

    override fun onDestroy() {
        polling = false
        super.onDestroy()
    }

    private fun prefs() = getSharedPreferences("airc-tmux-remote", Context.MODE_PRIVATE)

    private fun loadProfile(): Profile? {
        val prefs = prefs()
        val baseUrl = prefs.getString("baseUrl", "") ?: ""
        val token = prefs.getString("token", "") ?: ""
        if (baseUrl.isBlank() || token.isBlank()) return null
        return Profile(
            prefs.getString("name", "Laptop tmux") ?: "Laptop tmux",
            baseUrl.trimEnd('/'),
            token,
            prefs.getString("session", "") ?: "",
            prefs.getString("publicUrl", "") ?: "",
            parseStoredUrls(prefs.getString("lanUrls", "[]") ?: "[]")
        )
    }

    private fun saveProfile(next: Profile) {
        profile = next.copy(baseUrl = next.baseUrl.trimEnd('/'))
        prefs().edit()
            .putString("name", profile!!.name)
            .putString("baseUrl", profile!!.baseUrl)
            .putString("token", profile!!.token)
            .putString("session", profile!!.session)
            .putString("publicUrl", profile!!.publicUrl.trimEnd('/'))
            .putString("lanUrls", JSONArray(profile!!.lanUrls.map { it.trimEnd('/') }).toString())
            .apply()
        etag = null
        lastGoodUrl = ""
        prefs().edit().remove("lastGoodUrl").apply()
        status.text = "paired"
        startPolling()
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(16, 19, 20))
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(6), dp(4), dp(6), dp(4))
            setBackgroundColor(Color.rgb(23, 29, 28))
        }
        status = TextView(this).apply {
            text = "connecting"
            setTextColor(Color.rgb(215, 225, 223))
            textSize = 15f
            minWidth = dp(72)
        }
        paneButton = compactButton("active") { showPanePicker() }
        val pair = compactButton("pair") { showPairDialog() }
        top.addView(status)
        top.addView(paneButton, LinearLayout.LayoutParams(0, dp(42), 1f))
        top.addView(pair)

        webView = WebView(this).apply {
            setBackgroundColor(Color.rgb(5, 7, 7))
            settings.javaScriptEnabled = true
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            settings.domStorageEnabled = false
            loadDataWithBaseURL("https://local.airc/", terminalHtml(), "text/html", "UTF-8", null)
        }

        val bottom = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(6), dp(5), dp(6), dp(5))
            setBackgroundColor(Color.rgb(23, 29, 28))
        }
        val inputRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        input = EditText(this).apply {
            hint = "text"
            setSingleLine(true)
            imeOptions = EditorInfo.IME_ACTION_SEND
            setTextColor(Color.WHITE)
            setHintTextColor(Color.rgb(147, 163, 159))
            textSize = 16f
            minHeight = dp(42)
            setPadding(dp(8), 0, dp(8), 0)
            setOnEditorActionListener { _, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_SEND) {
                    sendInputText()
                    true
                } else {
                    false
                }
            }
        }
        inputRow.addView(input, LinearLayout.LayoutParams(0, dp(42), 1f))
        inputRow.addView(compactButton("send") { sendInputText() }, LinearLayout.LayoutParams(dp(82), dp(42)))

        val quickRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        quickRow.addView(compactButton("A-") { adjustFont(-1) }, LinearLayout.LayoutParams(0, dp(38), 1f))
        quickRow.addView(compactButton("A+") { adjustFont(1) }, LinearLayout.LayoutParams(0, dp(38), 1f))
        quickRow.addView(compactButton("^") { sendKey("Up") }, LinearLayout.LayoutParams(0, dp(38), 1f))
        quickRow.addView(compactButton("v") { sendKey("Down") }, LinearLayout.LayoutParams(0, dp(38), 1f))
        quickRow.addView(compactButton("enter") { sendKey("Enter") }, LinearLayout.LayoutParams(0, dp(38), 1.4f))

        bottom.addView(inputRow)
        bottom.addView(quickRow)

        root.addView(top)
        root.addView(webView, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(bottom)
        setContentView(root)
    }

    private fun compactButton(label: String, action: () -> Unit): Button {
        return Button(this).apply {
            text = label
            isAllCaps = false
            textSize = 16f
            minHeight = 0
            minimumHeight = 0
            minWidth = 0
            minimumWidth = 0
            setPadding(dp(6), 0, dp(6), 0)
            setOnClickListener { action() }
        }
    }

    private fun adjustFont(delta: Int) {
        webView.evaluateJavascript("bumpFont($delta)", null)
    }

    private fun terminalHtml(): String {
        return """
            <!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
            html,body{height:100%;margin:0;background:#050707;color:#d7e1df;overflow:auto}
            body{font-family:monospace}
            #wrap{position:relative;min-height:100%;padding:8px;box-sizing:border-box}
            #term{margin:0;white-space:pre;font-size:12px;line-height:1.16}
            #cursor{position:absolute;background:#d7e1df;opacity:.65;animation:blink 1.1s step-end infinite}
            @keyframes blink{50%{opacity:.1}}
            .fg-0{color:#363b40}.fg-1{color:#ff7070}.fg-2{color:#49d17d}.fg-3{color:#d4a72c}.fg-4{color:#58a6ff}.fg-5{color:#d2a8ff}.fg-6{color:#56d4dd}.fg-7{color:#d7e1df}
            .fg-8{color:#8b949e}.fg-9{color:#ff8f8f}.fg-10{color:#70e39b}.fg-11{color:#eac55f}.fg-12{color:#79c0ff}.fg-13{color:#dcbdfb}.fg-14{color:#76e3ea}.fg-15{color:#fff}
            .bg-0{background:#363b40}.bg-1{background:#ff7070}.bg-2{background:#49d17d}.bg-3{background:#d4a72c}.bg-4{background:#58a6ff}.bg-5{background:#d2a8ff}.bg-6{background:#56d4dd}.bg-7{background:#d7e1df}
            .bg-8{background:#8b949e}.bg-9{background:#ff8f8f}.bg-10{background:#70e39b}.bg-11{background:#eac55f}.bg-12{background:#79c0ff}.bg-13{background:#dcbdfb}.bg-14{background:#76e3ea}.bg-15{background:#fff}
            .fg-inv{color:#050707}.bg-inv{background:#d7e1df}.b{font-weight:700}.dim{opacity:.6}.i{font-style:italic}.u{text-decoration:underline}
            </style></head><body><div id="wrap"><pre id="term"></pre><div id="cursor"></div></div>
            <script>
            let cols=0,rows=0,cursor=null,ch=7.2,line=15,scale=1.06,manual=0;
            const lh=1.16;
            function fit(){ if(cols>0&&rows>0){ const base=Math.min((innerWidth-16)/(cols*.6),(innerHeight-16)/(rows*lh)); const s=Math.max(7,Math.min(24,Math.floor((base*scale+manual)*2)/2)); const t=document.getElementById('term'); t.style.fontSize=s+'px'; ch=s*.6; line=s*lh; place(); } }
            function bumpFont(delta){ manual=Math.max(-4,Math.min(4,manual+delta*.5)); fit(); }
            function place(){ const c=document.getElementById('cursor'); if(!cursor){c.style.display='none';return} c.style.display='block'; c.style.left=(8+cursor.x*ch)+'px'; c.style.top=(8+cursor.y*line)+'px'; c.style.width=ch+'px'; c.style.height=line+'px'; }
            function render(frame){ document.getElementById('term').innerHTML=frame.html||''; cols=frame.cols||0; rows=frame.rows||0; cursor=frame.cursor; fit(); }
            addEventListener('resize',fit);
            </script></body></html>
        """.trimIndent()
    }

    private fun startPolling() {
        if (polling) return
        polling = true
        pollOnce()
    }

    private fun pollOnce() {
        if (!polling) return
        val current = profile ?: return
        thread {
            try {
                val query = if (pinnedPane.isNotBlank()) "?pane=${URLEncoder.encode(pinnedPane, "UTF-8")}" else ""
                var handled = false
                var lastError = "offline"
                for (baseUrl in endpointUrls(current)) {
                    try {
                        val connection = (URL("$baseUrl/api/tmux/frame$query").openConnection() as HttpURLConnection).apply {
                            requestMethod = "GET"
                            setRequestProperty("X-Airc-Auth", current.token)
                            etag?.let { setRequestProperty("If-None-Match", it) }
                            connectTimeout = 2500
                            readTimeout = 6000
                        }
                        val code = connection.responseCode
                        if (code == 304) {
                            rememberEndpoint(baseUrl)
                            postStatus("idle")
                            handled = true
                            break
                        } else if (code in 200..299) {
                            rememberEndpoint(baseUrl)
                            etag = connection.getHeaderField("ETag")
                            val json = connection.inputStream.bufferedReader().readText()
                            val frame = JSONObject(json)
                            if (frame.optBoolean("ok")) {
                                val label = if (pinnedPane.isBlank()) "active" else "pin ${frame.optString("paneId")}"
                                handler.post {
                                    paneButton.text = label
                                    status.text = "live"
                                    webView.evaluateJavascript("render(${frame.toString()})", null)
                                }
                            } else {
                                postStatus(frame.optString("error", "error"))
                            }
                            handled = true
                            break
                        } else {
                            lastError = "HTTP $code"
                        }
                    } catch (error: Exception) {
                        lastError = error.message ?: "offline"
                    }
                }
                if (!handled) postStatus(lastError)
            } catch (error: Exception) {
                postStatus(error.message ?: "offline")
            } finally {
                handler.postDelayed({ pollOnce() }, 750)
            }
        }
    }

    private fun postStatus(text: String) {
        handler.post { status.text = text.take(28) }
    }

    private fun sendInputText() {
        val text = input.text.toString()
        if (text.isEmpty()) return
        input.setText("")
        sendInput(JSONObject().put("text", text))
    }

    private fun sendKey(key: String) {
        sendInput(JSONObject().put("key", key))
    }

    private fun sendInput(payload: JSONObject) {
        val current = profile ?: return
        if (pinnedPane.isBlank()) {
            payload.put("target", "active")
        } else {
            payload.put("target", "pane")
            payload.put("paneId", pinnedPane)
        }
        thread {
            var sent = false
            var lastError = "send failed"
            try {
                val body = payload.toString()
                for (baseUrl in endpointUrls(current)) {
                    try {
                        val connection = (URL("$baseUrl/api/tmux/input").openConnection() as HttpURLConnection).apply {
                            requestMethod = "POST"
                            doOutput = true
                            setRequestProperty("Content-Type", "application/json; charset=utf-8")
                            setRequestProperty("X-Airc-Auth", current.token)
                            connectTimeout = 2500
                            readTimeout = 6000
                        }
                        OutputStreamWriter(connection.outputStream, StandardCharsets.UTF_8).use { it.write(body) }
                        val code = connection.responseCode
                        if (code in 200..299) {
                            rememberEndpoint(baseUrl)
                            postStatus("sent")
                            etag = null
                            sent = true
                            break
                        }
                        lastError = "send $code"
                    } catch (error: Exception) {
                        lastError = error.message ?: "send failed"
                    }
                }
            } catch (error: Exception) {
                lastError = error.message ?: "send failed"
            }
            if (!sent) postStatus(lastError)
        }
    }

    private fun showPanePicker() {
        val current = profile ?: return
        thread {
            var loaded = false
            var lastError = "panes failed"
            try {
                for (baseUrl in endpointUrls(current)) {
                    try {
                        val connection = (URL("$baseUrl/api/tmux/panes").openConnection() as HttpURLConnection).apply {
                            requestMethod = "GET"
                            setRequestProperty("X-Airc-Auth", current.token)
                            connectTimeout = 2500
                            readTimeout = 6000
                        }
                        val payload = JSONObject(connection.inputStream.bufferedReader().readText())
                        rememberEndpoint(baseUrl)
                        val panes = mutableListOf(Pane("", "Follow active pane", pinnedPane.isBlank()))
                        val arr: JSONArray = payload.optJSONArray("panes") ?: JSONArray()
                        for (i in 0 until arr.length()) {
                            val item = arr.getJSONObject(i)
                            val id = item.getString("paneId")
                            panes.add(Pane(
                                id,
                                "${if (item.optBoolean("active")) "* " else ""}${item.optInt("windowIndex")}:${item.optString("windowName")}.${item.optInt("paneIndex")} (${item.optInt("width")}x${item.optInt("height")})",
                                pinnedPane == id
                            ))
                        }
                        handler.post {
                            AlertDialog.Builder(this)
                                .setTitle("Panes")
                                .setItems(panes.map { it.label }.toTypedArray()) { _, which ->
                                    pinnedPane = panes[which].paneId
                                    prefs().edit().putString("pinnedPane", pinnedPane).apply()
                                    etag = null
                                    paneButton.text = if (pinnedPane.isBlank()) "active" else panes[which].label
                                }
                                .show()
                        }
                        loaded = true
                        break
                    } catch (error: Exception) {
                        lastError = error.message ?: "panes failed"
                    }
                }
            } catch (error: Exception) {
                lastError = error.message ?: "panes failed"
            }
            if (!loaded) postStatus(lastError)
        }
    }

    private fun showPairDialog() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), 0, dp(16), 0)
        }
        val url = EditText(this).apply {
            hint = "Base URL"
            setText(profile?.baseUrl ?: "")
            inputType = android.text.InputType.TYPE_TEXT_VARIATION_URI
        }
        val token = EditText(this).apply {
            hint = "Token"
            setText(profile?.token ?: "")
        }
        root.addView(url)
        root.addView(token)
        AlertDialog.Builder(this)
            .setTitle("Pair laptop")
            .setView(root)
            .setPositiveButton("Save") { _, _ ->
                saveProfile(Profile("Laptop tmux", url.text.toString(), token.text.toString(), ""))
            }
            .setNegativeButton("Scan QR") { _, _ -> scanQr() }
            .setNeutralButton("Cancel", null)
            .show()
    }

    private fun scanQr() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), 41)
            return
        }
        qrLauncher.launch(Intent(this, QrScanActivity::class.java))
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 41 && grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            scanQr()
        }
    }

    private fun parseProfile(raw: String): Profile {
        val trimmed = raw.trim()
        return if (trimmed.startsWith("{")) {
            val json = JSONObject(trimmed)
            val configuredBaseUrl = json.getString("baseUrl")
            val lanUrls = json.optJSONArray("lanUrls")
            val preferredBaseUrl = if (isLoopbackUrl(configuredBaseUrl) && lanUrls != null && lanUrls.length() > 0) {
                lanUrls.getString(0)
            } else {
                configuredBaseUrl
            }
            Profile(
                json.optString("name", "Laptop tmux"),
                preferredBaseUrl,
                json.getString("token"),
                json.optString("session", ""),
                json.optString("publicUrl", configuredBaseUrl),
                jsonArrayToList(lanUrls)
            )
        } else {
            val url = URL(trimmed)
            val params = url.query.orEmpty().split("&").mapNotNull {
                val parts = it.split("=", limit = 2)
                if (parts.size == 2) parts[0] to java.net.URLDecoder.decode(parts[1], "UTF-8") else null
            }.toMap()
            val baseUrl = "${url.protocol}://${url.authority}"
            Profile("Laptop tmux", baseUrl, params["k"] ?: "", "", baseUrl)
        }
    }

    private fun endpointUrls(current: Profile): List<String> {
        val normalizedLan = current.lanUrls.map { it.trim().trimEnd('/') }.filter { it.isNotBlank() }
        val normalizedLast = lastGoodUrl.trim().trimEnd('/')
        val now = System.currentTimeMillis()
        val shouldProbeLan = normalizedLan.isNotEmpty() &&
            normalizedLast.isNotBlank() &&
            normalizedLast !in normalizedLan &&
            now - lastLanProbeAt > 30000
        if (shouldProbeLan) {
            lastLanProbeAt = now
        }
        val preferred = if (shouldProbeLan) normalizedLan + normalizedLast else listOf(normalizedLast)
        return (preferred + normalizedLan + current.baseUrl + current.publicUrl)
            .map { it.trim().trimEnd('/') }
            .filter { it.isNotBlank() }
            .distinct()
    }

    private fun rememberEndpoint(baseUrl: String) {
        val normalized = baseUrl.trim().trimEnd('/')
        if (normalized.isBlank() || normalized == lastGoodUrl) return
        lastGoodUrl = normalized
        prefs().edit().putString("lastGoodUrl", normalized).apply()
    }

    private fun jsonArrayToList(array: JSONArray?): List<String> {
        val out = mutableListOf<String>()
        if (array == null) return out
        for (i in 0 until array.length()) {
            val value = array.optString(i, "").trim().trimEnd('/')
            if (value.isNotBlank()) out.add(value)
        }
        return out
    }

    private fun parseStoredUrls(raw: String): List<String> {
        return try {
            jsonArrayToList(JSONArray(raw))
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun isLoopbackUrl(value: String): Boolean {
        return try {
            val host = URL(value).host
            host == "127.0.0.1" || host == "localhost" || host == "::1"
        } catch (_: Exception) {
            false
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
