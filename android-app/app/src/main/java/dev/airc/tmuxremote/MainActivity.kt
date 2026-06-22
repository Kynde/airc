package dev.airc.tmuxremote

import android.Manifest
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.app.AlertDialog
import android.content.Intent
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.graphics.drawable.StateListDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
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
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

data class Profile(
    val name: String,
    val baseUrl: String,
    val token: String,
    val session: String,
    val publicUrl: String = "",
    val lanUrls: List<String> = emptyList()
)

data class Pane(
    val session: String,
    val paneId: String,
    val label: String,
    val active: Boolean
)

// A pane with a notable agent state, as reported by the server's attention
// scan / hooks. state is "waiting" (urgent: blocked on a prompt), "idle-input"
// (ambient: finished, awaiting the next instruction), or "busy" (working).
data class AttentionItem(
    val paneId: String,
    val session: String,
    val windowName: String,
    val paneIndex: Int,
    val agent: String,
    val state: String
)

// Rows rendered in the pane picker: a session header (follows that session's
// active pane) or an indented pane row (pins that exact pane).
sealed class PickerRow {
    data class SessionHeader(val session: String, val following: Boolean) : PickerRow()
    data class PaneRow(val pane: Pane) : PickerRow()
}

class MainActivity : ComponentActivity() {
    private class TerminalWebView(context: Context) : WebView(context) {
        fun maxScrollX(): Int = (computeHorizontalScrollRange() - width).coerceAtLeast(0)
        fun maxScrollY(): Int = (computeVerticalScrollRange() - height).coerceAtLeast(0)
        fun contentHeight(): Int = computeVerticalScrollRange()
    }

    private object Chrome {
        const val bg = 0xFF070B0A.toInt()
        const val surface = 0xFF0A100E.toInt()
        const val primary = 0xFF9EF56C.toInt()
        const val primaryDim = 0xFF6CC458.toInt()
        const val accent = 0xFF16FFFF.toInt()
        const val accent2 = 0xFFFF6EC7.toInt()
        const val muted = 0xFFD5D0AC.toInt()
        const val amber = 0xFFEF9F27.toInt()
        const val danger = 0xFFE24B4A.toInt()
        const val primaryText = 0xFF04240F.toInt()
        const val borderAlpha = 0x4D9EF56C.toInt()
        const val dimBorder = 0x666CC458.toInt()
        const val amberBorder = 0x66EF9F27.toInt()
        const val wash = 0x1F9EF56C
        const val offlineFill = 0xFF140909.toInt()
        const val radiusDp = 6
    }

    private companion object {
        const val TAG = "airc"
        const val FONT_MIN = 7f
        const val FONT_MAX = 24f
        // How often, while connected over the tunnel, to re-fetch the laptop's live LAN
        // addresses so a since-changed IP (e.g. a different router) becomes reachable.
        const val CONFIG_REFRESH_MS = 30000L
        // How often, while streaming over the tunnel, to probe whether the paired LAN
        // addresses are reachable again (i.e. we're back on the home network).
        const val LAN_PREFER_MS = 15000L
    }

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var webView: TerminalWebView
    private lateinit var status: TextView
    private lateinit var statusDot: View
    private lateinit var endpointTag: TextView
    private lateinit var paneButton: Button
    private lateinit var autoButton: Button
    private lateinit var alertsRow: LinearLayout
    private lateinit var alertsScroll: HorizontalScrollView
    private lateinit var input: EditText
    private var profile: Profile? = null
    private var pinnedPane: String = ""
    private var followSession: String = ""
    private var currentSession: String = ""
    private var autoMode: Boolean = false
    private var attentionEnabled: Boolean = false
    private var attentionItems: List<AttentionItem> = emptyList()
    private var lastAttentionJson: String = ""
    private var etag: String? = null
    private var polling = false
    private var ws: WebSocket? = null
    @Volatile private var wsConnected = false
    @Volatile private var wsConnecting = false
    private var lastWsAttemptAt = 0L
    private val httpClient: OkHttpClient by lazy {
        OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    }
    private var lastGoodUrl: String = ""
    private var lastLanProbeAt: Long = 0
    private var lastConfigRefreshAt: Long = 0
    private var lastLanPreferAt: Long = 0
    private var statusPulse: ObjectAnimator? = null
    private var statusDetail: String = "connecting"
    // Build the laptop server reported on the WS `hello`; shown in the status popup.
    private var serverVersion: String = ""
    private var followWebViewLeft = true
    private var followWebViewBottom = true
    private var renderedAnchorTop = 0
    private var touchingWebView = false
    private val monoTypeface: Typeface by lazy { Typeface.create("monospace", Typeface.NORMAL) }

    private val qrLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val contents = result.data?.getStringExtra(QrScanActivity.EXTRA_QR_TEXT)
        if (!contents.isNullOrBlank()) {
            saveProfile(parseProfile(contents))
        }
    }

    private val cameraPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            qrLauncher.launch(Intent(this, QrScanActivity::class.java))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        profile = loadProfile()
        pinnedPane = prefs().getString("pinnedPane", "") ?: ""
        followSession = prefs().getString("followSession", "") ?: ""
        autoMode = prefs().getBoolean("autoMode", false)
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
        closeWebSocket()
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
        closeWebSocket()
        setStatus("paired")
        startPolling()
    }

    // statusBarColor/navigationBarColor are deprecated (no-ops under edge-to-edge on API 35+) but
    // still tint the bars on the older devices this app supports, so keep them with a scoped suppress.
    @Suppress("DEPRECATION")
    private fun applySystemBarColors() {
        window.statusBarColor = Chrome.surface
        window.navigationBarColor = Chrome.bg
    }

    private fun buildUi() {
        applySystemBarColors()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Chrome.bg)
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(8), dp(6), dp(8), dp(6))
            setBackgroundColor(Chrome.surface)
        }
        val statusWrap = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(2), 0, dp(8), 0)
            setOnClickListener { showStatusDetail() }
        }
        statusDot = View(this).apply {
            background = dotDrawable(Chrome.amber, filled = true, glow = false)
            setOnClickListener { showStatusDetail() }
        }
        status = TextView(this).apply {
            text = "connecting"
            typeface = monoTypeface
            setTextColor(Chrome.amber)
            textSize = 12f
            includeFontPadding = false
            letterSpacing = 0.03f
            setSingleLine(true)
            ellipsize = TextUtils.TruncateAt.END
        }
        endpointTag = TextView(this).apply {
            typeface = monoTypeface
            textSize = 11f
            includeFontPadding = false
            letterSpacing = 0.06f
            setSingleLine(true)
            visibility = View.GONE
            setOnClickListener { showStatusDetail() }
        }
        statusWrap.addView(statusDot, LinearLayout.LayoutParams(dp(9), dp(9)).apply {
            rightMargin = dp(7)
        })
        statusWrap.addView(status, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        statusWrap.addView(endpointTag, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            leftMargin = dp(9)
        })
        paneButton = chromeButton("active", ButtonKind.PaneActive) { showPanePicker() }
        // "auto" follows the pane that needs interaction; hidden until the server
        // reports the attention feature is on (set in applyConfig).
        autoButton = chromeButton("auto", ButtonKind.PaneInactive) { toggleAuto() }.apply {
            visibility = View.GONE
        }
        val settingsButton = chromeButton("⚙", ButtonKind.IconAccent) { anchor -> showSettingsMenu(anchor) }
        top.addView(statusWrap, LinearLayout.LayoutParams(0, dp(34), 1f))
        top.addView(autoButton, LinearLayout.LayoutParams(dp(58), dp(34)).apply {
            rightMargin = dp(6)
        })
        top.addView(paneButton, LinearLayout.LayoutParams(dp(112), dp(34)).apply {
            rightMargin = dp(6)
        })
        top.addView(settingsButton, LinearLayout.LayoutParams(dp(42), dp(34)))

        webView = TerminalWebView(this).apply {
            setBackgroundColor(Chrome.bg)
            settings.javaScriptEnabled = true
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            settings.domStorageEnabled = false
            setOnTouchListener { _, event ->
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> touchingWebView = true
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                        touchingWebView = false
                        updateWebViewFollow()
                    }
                }
                false
            }
            setOnScrollChangeListener { _, _, _, _, _ ->
                // Only react to user-driven scrolling. Reflow/programmatic scroll changes (e.g. a
                // font bump growing the content) must not flip the follow state against a stale anchor.
                if (touchingWebView) updateWebViewFollow()
            }
            loadDataWithBaseURL("https://local.airc/", terminalHtml(), "text/html", "UTF-8", null)
        }

        val bottom = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(10), dp(9), dp(10), dp(11))
            setBackgroundColor(Chrome.surface)
        }
        val inputRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        input = EditText(this).apply {
            hint = "type a message"
            setSingleLine(true)
            imeOptions = EditorInfo.IME_ACTION_SEND
            typeface = monoTypeface
            setTextColor(Chrome.muted)
            setHintTextColor(Chrome.primaryDim)
            textSize = 13f
            minHeight = dp(42)
            includeFontPadding = false
            background = roundedStroke(Chrome.bg, Chrome.borderAlpha, Chrome.radiusDp)
            setPadding(dp(10), 0, dp(10), 0)
            setOnEditorActionListener { _, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_SEND) {
                    sendInputText()
                    true
                } else {
                    false
                }
            }
        }
        inputRow.addView(input, LinearLayout.LayoutParams(0, dp(42), 1f).apply {
            rightMargin = dp(7)
        })
        inputRow.addView(chromeButton("send", ButtonKind.Primary) { sendInputText() }, LinearLayout.LayoutParams(dp(84), dp(42)))

        val quickRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        addQuickKey(quickRow, "⌃", 1f) { anchor -> showControlKeys(anchor) }
        addQuickKey(quickRow, "↑", 1f) { sendKey("Up") }
        addQuickKey(quickRow, "↓", 1f) { sendKey("Down") }
        addQuickKey(quickRow, "enter", 1.45f, ButtonKind.Enter) { sendKey("Enter") }

        bottom.addView(inputRow)
        bottom.addView(quickRow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(39)).apply {
            topMargin = dp(8)
        })

        // Attention chips: one tap-to-switch chip per pane that needs you. The
        // row stays GONE (zero height) until something is flagged.
        alertsRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(4), dp(10), dp(4))
            setBackgroundColor(Chrome.surface)
            visibility = View.GONE
        }
        alertsScroll = HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            setBackgroundColor(Chrome.surface)
            addView(alertsRow)
            visibility = View.GONE
        }

        root.addView(top)
        root.addView(alertsScroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        root.addView(webView, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(bottom)
        setContentView(root)
    }

    private enum class ButtonKind {
        Key, Primary, Enter, PaneActive, PaneInactive, IconAccent, Busy
    }

    private fun chromeButton(label: String, kind: ButtonKind = ButtonKind.Key, action: (View) -> Unit): Button {
        return Button(this).apply {
            text = label
            isAllCaps = false
            typeface = monoTypeface
            textSize = if (kind == ButtonKind.IconAccent) 18f else 12f
            includeFontPadding = false
            setSingleLine(true)
            ellipsize = TextUtils.TruncateAt.END
            minHeight = 0
            minimumHeight = 0
            minWidth = 0
            minimumWidth = 0
            stateListAnimator = null
            elevation = 0f
            setPadding(dp(8), 0, dp(8), 0)
            applyButtonKind(kind)
            setOnTouchListener { view, event ->
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        view.scaleX = 0.97f
                        view.scaleY = 0.97f
                    }
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                        view.scaleX = 1f
                        view.scaleY = 1f
                    }
                }
                false
            }
            setOnClickListener { action(it) }
        }
    }

    private fun Button.applyButtonKind(kind: ButtonKind) {
        val (textColor, fill, stroke, pressedFill) = when (kind) {
            ButtonKind.Primary -> arrayOf(Chrome.primaryText, Chrome.primary, Chrome.primary, Chrome.primary)
            ButtonKind.Enter -> arrayOf(Chrome.accent, Chrome.bg, Chrome.accent, Chrome.wash)
            ButtonKind.PaneActive -> arrayOf(Chrome.primaryText, Chrome.primary, Chrome.primary, Chrome.primary)
            ButtonKind.PaneInactive -> arrayOf(Chrome.primaryDim, Chrome.bg, Chrome.dimBorder, Chrome.wash)
            ButtonKind.IconAccent -> arrayOf(Chrome.accent, Chrome.surface, Color.TRANSPARENT, Chrome.wash)
            // Busy: a third attention color (amber) for "working", distinct from
            // the green "finished" and cyan "needs you" chips.
            ButtonKind.Busy -> arrayOf(Chrome.amber, Chrome.bg, Chrome.amberBorder, Chrome.wash)
            ButtonKind.Key -> arrayOf(Chrome.primary, Chrome.bg, Chrome.borderAlpha, Chrome.wash)
        }
        setTextColor(textColor)
        background = stateBackground(fill, stroke, pressedFill)
        if (kind == ButtonKind.Primary || kind == ButtonKind.PaneActive) {
            setShadowLayer(8f, 0f, 0f, Color.argb(150, 158, 245, 108))
        } else if (kind == ButtonKind.Enter || kind == ButtonKind.IconAccent) {
            setShadowLayer(6f, 0f, 0f, Color.argb(120, 22, 255, 255))
        } else if (kind == ButtonKind.Busy) {
            setShadowLayer(6f, 0f, 0f, Color.argb(110, 239, 159, 39))
        } else {
            setShadowLayer(4f, 0f, 0f, Color.argb(85, 158, 245, 108))
        }
    }

    private fun addQuickKey(row: LinearLayout, label: String, weight: Float, kind: ButtonKind = ButtonKind.Key, action: (View) -> Unit) {
        row.addView(chromeButton(label, kind, action), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, weight).apply {
            rightMargin = if (row.childCount < 3) dp(7) else 0
        })
    }

    private fun roundedStroke(fill: Int, stroke: Int, radiusDp: Int): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(radiusDp).toFloat()
            setColor(fill)
            setStroke(dp(1), stroke)
        }
    }

    private fun stateBackground(fill: Int, stroke: Int, pressedFill: Int): StateListDrawable {
        return StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_pressed), roundedStroke(pressedFill, stroke, Chrome.radiusDp))
            addState(intArrayOf(), roundedStroke(fill, stroke, Chrome.radiusDp))
        }
    }

    private fun dotDrawable(color: Int, filled: Boolean, glow: Boolean): LayerDrawable {
        val core = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(if (filled) color else Chrome.offlineFill)
            setStroke(dp(1), color)
        }
        if (!glow) return LayerDrawable(arrayOf(core))
        val halo = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.argb(75, 158, 245, 108))
        }
        return LayerDrawable(arrayOf(halo, core)).apply {
            setLayerInset(1, dp(2), dp(2), dp(2), dp(2))
        }
    }

    private fun setStatus(text: String) {
        statusDetail = text
        val lower = text.lowercase()
        when {
            lower == "live" || lower == "idle" || lower == "sent" || lower == "paired" -> {
                stopStatusPulse()
                status.text = "live"
                status.setTextColor(Chrome.primary)
                statusDot.background = dotDrawable(Chrome.primary, filled = true, glow = true)
                statusDot.alpha = 1f
                updateEndpointTag(connected = true)
            }
            lower == "connecting" || lower.contains("timeout") || lower.contains("failed") || lower.startsWith("http") || lower.startsWith("send") || lower.startsWith("panes") -> {
                status.text = "reconnecting"
                status.setTextColor(Chrome.amber)
                statusDot.background = dotDrawable(Chrome.amber, filled = true, glow = false)
                startStatusPulse()
                updateEndpointTag(connected = false)
            }
            else -> {
                stopStatusPulse()
                status.text = "offline"
                status.setTextColor(Chrome.danger)
                statusDot.background = dotDrawable(Chrome.danger, filled = false, glow = false)
                statusDot.alpha = 1f
                updateEndpointTag(connected = false)
            }
        }
    }

    // The current endpoint is whichever URL last answered (lastGoodUrl). Classify it by host:
    // loopback / private-range / *.local is the LAN; anything else is the ngrok tunnel.
    private fun updateEndpointTag(connected: Boolean) {
        val url = lastGoodUrl
        if (!connected || url.isBlank()) {
            endpointTag.visibility = View.GONE
            return
        }
        val local = isLocalEndpoint(url)
        endpointTag.text = if (local) "wlan" else "ngrok"
        endpointTag.setTextColor(if (local) Chrome.primaryDim else Chrome.accent)
        endpointTag.visibility = View.VISIBLE
    }

    private fun isLocalEndpoint(url: String): Boolean {
        val host = try { URL(url).host?.lowercase() } catch (_: Exception) { null } ?: return false
        if (host == "localhost" || host == "127.0.0.1" || host == "::1" || host.endsWith(".local")) return true
        if (host.startsWith("192.168.") || host.startsWith("10.")) return true
        // 172.16.0.0 - 172.31.255.255
        Regex("^172\\.(\\d{1,3})\\.").find(host)?.groupValues?.get(1)?.toIntOrNull()?.let {
            if (it in 16..31) return true
        }
        return false
    }

    private fun showStatusDetail() {
        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(16), dp(18), dp(6))
            addView(TextView(this@MainActivity).apply {
                text = "Connection status"
                typeface = monoTypeface
                setTextColor(Chrome.primary)
                textSize = 18f
                includeFontPadding = false
            })
            addView(TextView(this@MainActivity).apply {
                text = statusDetail.ifBlank { status.text.toString() }
                typeface = monoTypeface
                setTextColor(Chrome.muted)
                textSize = 13f
                setPadding(0, dp(14), 0, dp(4))
            })
            if (lastGoodUrl.isNotBlank()) {
                addView(TextView(this@MainActivity).apply {
                    val local = isLocalEndpoint(lastGoodUrl)
                    text = "${if (local) "wlan" else "ngrok"} · $lastGoodUrl"
                    typeface = monoTypeface
                    setTextColor(if (local) Chrome.primaryDim else Chrome.accent)
                    textSize = 12f
                    setPadding(0, dp(4), 0, dp(4))
                })
            }
            if (serverVersion.isNotBlank()) {
                addView(TextView(this@MainActivity).apply {
                    text = "server build $serverVersion"
                    typeface = monoTypeface
                    setTextColor(Chrome.muted)
                    textSize = 12f
                    setPadding(0, dp(4), 0, dp(4))
                })
            }
        }
        AlertDialog.Builder(this)
            .setView(body)
            .setPositiveButton("OK", null)
            .create()
            .apply {
                setOnShowListener {
                    window?.setBackgroundDrawable(roundedStroke(Chrome.surface, Chrome.borderAlpha, Chrome.radiusDp))
                    getButton(AlertDialog.BUTTON_POSITIVE)?.apply {
                        typeface = monoTypeface
                        setTextColor(Chrome.accent)
                        textSize = 13f
                    }
                }
                show()
            }
    }

    private fun showAboutDialog() {
        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(18), dp(20), dp(18), dp(8))
            addView(ImageView(this@MainActivity).apply {
                setImageResource(R.drawable.airc_icon)
            }, LinearLayout.LayoutParams(dp(88), dp(88)))
            addView(TextView(this@MainActivity).apply {
                text = "airc"
                typeface = monoTypeface
                setTextColor(Chrome.primary)
                textSize = 22f
                includeFontPadding = false
                letterSpacing = 0.06f
                setPadding(0, dp(14), 0, 0)
            })
            addView(TextView(this@MainActivity).apply {
                text = "tmux remote"
                typeface = monoTypeface
                setTextColor(Chrome.primaryDim)
                textSize = 12f
                includeFontPadding = false
                setPadding(0, dp(2), 0, 0)
            })
            addView(TextView(this@MainActivity).apply {
                text = "build ${BuildConfig.GIT_DESCRIBE}"
                typeface = monoTypeface
                setTextColor(Chrome.muted)
                textSize = 13f
                setPadding(0, dp(16), 0, dp(4))
            })
        }
        AlertDialog.Builder(this)
            .setView(body)
            .setPositiveButton("OK", null)
            .create()
            .apply {
                setOnShowListener {
                    window?.setBackgroundDrawable(roundedStroke(Chrome.surface, Chrome.borderAlpha, Chrome.radiusDp))
                    getButton(AlertDialog.BUTTON_POSITIVE)?.apply {
                        typeface = monoTypeface
                        setTextColor(Chrome.accent)
                        textSize = 13f
                    }
                }
                show()
            }
    }

    private fun startStatusPulse() {
        if (statusPulse?.isRunning == true) return
        statusDot.alpha = 1f
        statusPulse = ObjectAnimator.ofFloat(statusDot, View.ALPHA, 1f, 0.35f, 1f).apply {
            duration = 1600
            repeatCount = ValueAnimator.INFINITE
            repeatMode = ValueAnimator.RESTART
            start()
        }
    }

    private fun stopStatusPulse() {
        statusPulse?.cancel()
        statusPulse = null
        statusDot.alpha = 1f
    }

    private fun showSettingsMenu(anchor: View) {
        lateinit var popup: PopupWindow
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(10), dp(9), dp(10), dp(10))
            background = roundedStroke(Chrome.surface, Chrome.borderAlpha, Chrome.radiusDp)
            addView(TextView(this@MainActivity).apply {
                text = "settings"
                typeface = monoTypeface
                setTextColor(Chrome.accent)
                textSize = 11f
                includeFontPadding = false
                letterSpacing = 0.04f
                setPadding(dp(2), 0, dp(2), dp(8))
            })
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                addView(chromeButton("font -", ButtonKind.Key) { adjustFont(-1) }, LinearLayout.LayoutParams(0, dp(38), 1f).apply {
                    rightMargin = dp(7)
                })
                addView(chromeButton("font +", ButtonKind.Key) { adjustFont(1) }, LinearLayout.LayoutParams(0, dp(38), 1f))
            }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = dp(7)
            })
            addView(chromeButton("auto-fit font", ButtonKind.Key) {
                popup.dismiss()
                resetFontToAuto()
            }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(38)).apply {
                bottomMargin = dp(7)
            })
            addView(chromeButton("pair laptop", ButtonKind.Key) {
                popup.dismiss()
                showPairDialog()
            }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(38)).apply {
                bottomMargin = dp(7)
            })
            addView(chromeButton("about", ButtonKind.Key) {
                popup.dismiss()
                showAboutDialog()
            }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(38)))
        }
        popup = PopupWindow(panel, dp(178), LinearLayout.LayoutParams.WRAP_CONTENT, true).apply {
            isOutsideTouchable = true
            elevation = dp(6).toFloat()
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        }
        popup.showAsDropDown(anchor, -dp(136), dp(7), Gravity.NO_GRAVITY)
    }

    private fun showControlKeys(anchor: View) {
        lateinit var popup: PopupWindow
        val keys = listOf("Esc" to "Escape", "Tab" to "Tab", "BS" to "Backspace", "^B" to "C-b", "^C" to "C-c", "^U" to "C-u", "^W" to "C-w", "^D" to "C-d", "^L" to "C-l", "^R" to "C-r")
        // Beyond 8 buttons a single row overflows narrow screens, so wrap into rows.
        val perRow = (keys.size + 1) / 2
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(8), dp(8), dp(8), dp(8))
            background = roundedStroke(Chrome.surface, Chrome.borderAlpha, Chrome.radiusDp)
            keys.chunked(perRow).forEachIndexed { rowIndex, rowKeys ->
                addView(LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.HORIZONTAL
                    rowKeys.forEachIndexed { index, (label, key) ->
                        addView(chromeButton(label, ButtonKind.Key) {
                            popup.dismiss()
                            sendKey(key)
                        }, LinearLayout.LayoutParams(dp(38), dp(40)).apply {
                            if (index < rowKeys.size - 1) rightMargin = dp(6)
                        })
                    }
                }, LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply {
                    if (rowIndex > 0) topMargin = dp(6)
                })
            }
        }
        popup = PopupWindow(container, LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT, true).apply {
            isOutsideTouchable = true
            elevation = dp(6).toFloat()
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        }
        container.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
        popup.showAsDropDown(anchor, 0, -(anchor.height + container.measuredHeight + dp(7)), Gravity.NO_GRAVITY)
    }

    private fun adjustFont(delta: Int) {
        webView.evaluateJavascript("window.bumpFont && window.bumpFont($delta)") { result ->
            anchorWebViewIfFollowing(result)
            parseFontSize(result)?.let { prefs().edit().putFloat("fontSizePx", it).apply() }
        }
    }

    private fun resetFontToAuto() {
        prefs().edit().remove("fontSizePx").apply()
        webView.evaluateJavascript("window.resetFont && window.resetFont()") { result ->
            anchorWebViewIfFollowing(result)
        }
    }

    private fun parseFontSize(json: String?): Float? {
        if (json.isNullOrBlank() || json == "null") return null
        return try {
            val arr = JSONArray(json)
            if (arr.length() >= 3) arr.getDouble(2).toFloat() else null
        } catch (_: Exception) {
            null
        }
    }

    private fun updateWebViewFollow() {
        val maxX = webView.maxScrollX()
        followWebViewLeft = webView.scrollX <= dp(2) || maxX == 0
        // The native scroll range extends past the rendered bottom into blank grid rows, so anchor
        // sits above the true scroll end. Treat at-or-below the anchor as following so scrolling
        // back down always reacquires the lock; only scrolling up (into history) releases it.
        followWebViewBottom = webView.scrollY >= renderedAnchorTop - dp(2)
    }

    // JS reports rendered-content bottom and full grid height in CSS pixels; the WebView's own
    // viewport/scroll metrics are unreliable here, so we map that CSS ratio onto the native scroll
    // range to anchor on rendered content instead of the blank grid bottom.
    private fun anchorWebViewIfFollowing(anchorJson: String?) {
        val anchor = parseAnchor(anchorJson) ?: return
        webView.post {
            applyAnchor(anchor)
            webView.postDelayed({ applyAnchor(anchor) }, 80)
        }
    }

    private fun applyAnchor(anchor: Pair<Double, Double>) {
        val (renderedBottomCss, fullHeightCss) = anchor
        val fullNative = webView.contentHeight()
        val nativeBottom = if (fullHeightCss > 0) renderedBottomCss / fullHeightCss * fullNative else fullNative.toDouble()
        renderedAnchorTop = (nativeBottom - webView.height).toInt().coerceIn(0, webView.maxScrollY())
        if (!followWebViewBottom || touchingWebView) return
        val x = if (followWebViewLeft) 0 else webView.scrollX
        webView.scrollTo(x, renderedAnchorTop)
    }

    private fun parseAnchor(anchorJson: String?): Pair<Double, Double>? {
        if (anchorJson.isNullOrBlank() || anchorJson == "null") return null
        return try {
            val arr = JSONArray(anchorJson)
            if (arr.length() < 2) null else arr.getDouble(0) to arr.getDouble(1)
        } catch (_: Exception) {
            null
        }
    }

    private fun terminalHtml(): String {
        val savedFont = prefs().getFloat("fontSizePx", 0f)
        val hasManual = savedFont in FONT_MIN..FONT_MAX
        val initMode = if (hasManual) "manual" else "auto"
        val initSize = if (hasManual) savedFont else 13f
        return """
            <!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
            :root{--bg:#070B0A;--surface:#0A100E;--primary:#9EF56C;--primary-dim:#6CC458;--accent:#16FFFF;--accent-2:#FF6EC7;--muted:#D5D0AC;--amber:#EF9F27;--danger:#E24B4A}
            html,body{height:100%;margin:0;background:var(--bg);color:var(--muted);overflow:auto}
            body{font-family:'Fira Code',monospace}
            #wrap{position:relative;min-height:100%;padding:9px 10px;box-sizing:border-box;background:radial-gradient(circle at 50% 0,rgba(158,245,108,.055),transparent 30%),var(--bg)}
            #wrap:after{content:"";pointer-events:none;position:fixed;inset:0;background:linear-gradient(rgba(255,255,255,.025) 50%,rgba(0,0,0,.045) 50%);background-size:100% 4px;mix-blend-mode:screen}
            #term{margin:0;white-space:pre;font-size:12px;line-height:1.16;text-shadow:0 0 5px rgba(158,245,108,.25)}
            #cursor{position:absolute;background:var(--primary);opacity:.7;box-shadow:0 0 8px rgba(158,245,108,.75);animation:blink 1.1s step-end infinite}
            @keyframes blink{50%{opacity:.1}}
            .fg-0{color:#26302b}.fg-1{color:var(--danger)}.fg-2{color:var(--primary)}.fg-3{color:var(--amber)}.fg-4{color:#70b7ff}.fg-5{color:var(--accent-2)}.fg-6{color:var(--accent)}.fg-7{color:var(--muted)}
            .fg-8{color:#66746c}.fg-9{color:#ff7d7c}.fg-10{color:#b7ff91}.fg-11{color:#ffd064}.fg-12{color:#8fc7ff}.fg-13{color:#ff99d8}.fg-14{color:#8fffff}.fg-15{color:#fffbe5}
            .bg-0{background:#26302b}.bg-1{background:var(--danger)}.bg-2{background:var(--primary)}.bg-3{background:var(--amber)}.bg-4{background:#70b7ff}.bg-5{background:var(--accent-2)}.bg-6{background:var(--accent)}.bg-7{background:var(--muted)}
            .bg-8{background:#66746c}.bg-9{background:#ff7d7c}.bg-10{background:#b7ff91}.bg-11{background:#ffd064}.bg-12{background:#8fc7ff}.bg-13{background:#ff99d8}.bg-14{background:#8fffff}.bg-15{background:#fffbe5}
            .fg-inv{color:var(--bg)}.bg-inv{background:var(--primary)}.b{font-weight:700}.dim{opacity:.6}.i{font-style:italic}.u{text-decoration:underline}
            </style></head><body><div id="wrap"><pre id="term"></pre><div id="cursor"></div></div>
            <script>
            let cols=0,rows=0,cursor=null,ch=7.2,line=15,scale=1.06,fontMode='$initMode',fontSize=$initSize;
            const lh=1.16,FMIN=7,FMAX=24;
            function term(){return document.getElementById('term');}
            function wrap(){return document.getElementById('wrap');}
            // Bottom of actually-rendered content (CSS px), so the native side can anchor here
            // rather than scrolling down into the blank grid rows below it.
            function renderedBottom(){const t=term();return t.offsetTop+Math.max(line,t.getBoundingClientRect().height)+9;}
            // Full grid height (CSS px); native maps the renderedBottom/fullHeight ratio onto its scroll range.
            function fullHeight(){const w=wrap();return w.offsetTop+w.getBoundingClientRect().height;}
            function anchorTarget(){return [renderedBottom(),fullHeight()];}
            function measure(size){const p=document.createElement('span');p.style.cssText="position:absolute;visibility:hidden;white-space:pre;font:"+size+"px 'Fira Code',monospace";p.textContent='0'.repeat(50);document.body.appendChild(p);const w=p.getBoundingClientRect().width;p.remove();return w>0?w/50:size*.6;}
            function sizeGrid(){const w=20+cols*ch,h=18+rows*line,el=wrap();el.style.minWidth=w+'px';el.style.minHeight=h+'px';}
            function computedLine(t,size){const v=parseFloat(getComputedStyle(t).lineHeight);return Number.isFinite(v)&&v>0?v:size*lh;}
            // Auto-fit picks the largest size that fits all columns across the viewport width.
            function autoSize(){ const base=(innerWidth-20)/(cols*.6); return Math.max(FMIN,Math.min(FMAX,Math.floor(base*scale*2)/2)); }
            function fit(){ if(cols>0&&rows>0){ const s=fontMode==='manual'?fontSize:autoSize(); const t=term(); t.style.fontSize=s+'px'; ch=measure(s); line=computedLine(t,s); sizeGrid(); place(); } }
            // A-/A+ nudge the current displayed size by 1px (web parity) and lock to manual sizing.
            // Returns [renderedBottom, fullHeight, fontSize] so the native side can persist the size.
            window.bumpFont=function(delta){ const cur=parseFloat(term().style.fontSize)||autoSize(); fontSize=Math.max(FMIN,Math.min(FMAX,cur+delta)); fontMode='manual'; fit(); return anchorTarget().concat(fontSize); };
            window.resetFont=function(){ fontMode='auto'; fit(); return anchorTarget(); };
            function place(){ const c=document.getElementById('cursor'),t=term(); if(!cursor){c.style.display='none';return} c.style.display='block'; c.style.left=(t.offsetLeft+cursor.x*ch)+'px'; c.style.top=(t.offsetTop+cursor.y*line)+'px'; c.style.width=ch+'px'; c.style.height=line+'px'; }
            function render(frame){ term().innerHTML=frame.html||''; cols=frame.cols||0; rows=frame.rows||0; cursor=frame.cursor; fit(); return anchorTarget(); }
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
        maybeRefreshLanUrls()
        if (wsConnected) {
            // While the websocket streams over the tunnel, HTTP polling (and its LAN re-probe)
            // is suspended, so check separately whether we're back on the home network.
            maybePreferLan()
            // The websocket streams frames; keep a slow watchdog so HTTP polling resumes if it drops.
            handler.postDelayed({ pollOnce() }, 1000)
            return
        }
        val current = profile ?: return
        thread {
            var handled = false
            try {
                // session is sent in both cases so a vanished pin falls back to its session.
                val params = mutableListOf<String>()
                if (followSession.isNotBlank()) params.add("session=${URLEncoder.encode(followSession, "UTF-8")}")
                if (pinnedPane.isNotBlank()) params.add("pane=${URLEncoder.encode(pinnedPane, "UTF-8")}")
                val query = if (params.isEmpty()) "" else "?${params.joinToString("&")}"
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
                            renderFrame(JSONObject(json))
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
                // The websocket pushes attention; the poll fallback must fetch it.
                if (handled && lastGoodUrl.isNotBlank()) fetchAttention(current, lastGoodUrl)
            } catch (error: Exception) {
                postStatus(error.message ?: "offline")
            } finally {
                // Only upgrade to a websocket once an HTTP poll has confirmed a reachable endpoint,
                // and back off so a server that allows HTTP but blocks the upgrade isn't hammered.
                if (handled && !wsConnected && !wsConnecting && lastGoodUrl.isNotBlank() &&
                    System.currentTimeMillis() - lastWsAttemptAt > 5000) {
                    val url = lastGoodUrl
                    handler.post { connectWebSocket(url) }
                }
                handler.postDelayed({ pollOnce() }, 750)
            }
        }
    }

    // Pull the attention list once over HTTP, for the poll fallback path. Called
    // on the poll worker thread; hands results back to the UI thread.
    private fun fetchAttention(current: Profile, baseUrl: String) {
        try {
            val connection = (URL("$baseUrl/api/attention").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                setRequestProperty("X-Airc-Auth", current.token)
                connectTimeout = 2500
                readTimeout = 6000
            }
            if (connection.responseCode !in 200..299) return
            val payload = JSONObject(connection.inputStream.bufferedReader().readText())
            val items = payload.optJSONArray("items")?.let { parseAttention(it) } ?: emptyList()
            handler.post { applyAttention(items) }
        } catch (_: Exception) {
            // Transient; the next poll retries.
        }
    }

    // The paired lanUrls are a snapshot of the laptop's IPs at pairing time, so they go stale
    // when the laptop later joins a different network. While we're reaching it over the tunnel,
    // periodically pull its live addresses from /api/config and merge them in; the existing LAN
    // re-probe (endpointUrls) then discovers the laptop directly without re-pairing.
    private fun maybeRefreshLanUrls() {
        val current = profile ?: return
        // Only worth doing when the active route is the tunnel; on LAN there's nothing to gain.
        if (lastGoodUrl.isBlank() || isLocalEndpoint(lastGoodUrl)) return
        val now = System.currentTimeMillis()
        if (now - lastConfigRefreshAt < CONFIG_REFRESH_MS) return
        lastConfigRefreshAt = now
        thread {
            try {
                val connection = (URL("$lastGoodUrl/api/config").openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    setRequestProperty("X-Airc-Auth", current.token)
                    connectTimeout = 2500
                    readTimeout = 6000
                }
                if (connection.responseCode !in 200..299) return@thread
                val payload = JSONObject(connection.inputStream.bufferedReader().readText())
                val freshLan = jsonArrayToList(payload.optJSONArray("lanUrls"))
                val freshPublic = payload.optString("publicUrl").trim().trimEnd('/')
                handler.post { applyDiscoveredEndpoints(freshLan, freshPublic) }
            } catch (_: Exception) {
                // Best-effort refresh; the tunnel keeps working regardless.
            }
        }
    }

    private fun applyDiscoveredEndpoints(freshLan: List<String>, freshPublic: String) {
        val current = profile ?: return
        val publicUrl = if (freshPublic.isNotBlank()) freshPublic else current.publicUrl
        // An empty list means the laptop reported no LAN IPs right now; keep the existing
        // snapshot (and don't bother dropping the tunnel) over a transient interface blip.
        val lanUrls = if (freshLan.isNotEmpty()) freshLan else current.lanUrls
        val lanChanged = lanUrls != current.lanUrls
        if (lanChanged && BuildConfig.DEBUG) Log.i(TAG, "config refresh: lanUrls ${current.lanUrls} -> $lanUrls")
        if (!lanChanged && publicUrl == current.publicUrl) return
        profile = current.copy(lanUrls = lanUrls, publicUrl = publicUrl)
        prefs().edit()
            .putString("lanUrls", JSONArray(lanUrls).toString())
            .putString("publicUrl", publicUrl)
            .apply()
        if (lanChanged) {
            // Let the next poll probe the refreshed LAN addresses right away. A live websocket
            // keeps HTTP polling (and thus the LAN probe) suspended, so drop it; the poll loop
            // resumes, tries LAN first, and reconnects over whichever endpoint answers.
            lastLanProbeAt = 0
            if (wsConnected || wsConnecting) closeWebSocket()
        }
    }

    // A live websocket keeps the HTTP poll loop (and its LAN re-probe in endpointUrls) parked,
    // so a tunnel connection would never notice the LAN coming back on its own. While streaming
    // over the tunnel, probe the paired LAN addresses directly from the phone; the first that
    // answers means we're home, so drop the tunnel and force the next poll to prefer LAN.
    private fun maybePreferLan() {
        val current = profile ?: return
        // Throttle the whole check (incl. its diagnostics) to one heartbeat per interval.
        val now = System.currentTimeMillis()
        if (now - lastLanPreferAt < LAN_PREFER_MS) return
        lastLanPreferAt = now
        val lan = current.lanUrls.map { it.trim().trimEnd('/') }.filter { it.isNotBlank() }
        if (BuildConfig.DEBUG) Log.i(TAG, "prefer-lan: route=$lastGoodUrl local=${isLocalEndpoint(lastGoodUrl)} ws=$wsConnected lan=$lan")
        // Only relevant while a websocket is up and the active route is the tunnel.
        if (!wsConnected || lastGoodUrl.isBlank() || isLocalEndpoint(lastGoodUrl)) return
        if (lan.isEmpty()) return
        thread {
            for (baseUrl in lan) {
                try {
                    val connection = (URL("$baseUrl/api/config").openConnection() as HttpURLConnection).apply {
                        requestMethod = "GET"
                        setRequestProperty("X-Airc-Auth", current.token)
                        connectTimeout = 1500
                        readTimeout = 2500
                    }
                    val code = connection.responseCode
                    connection.disconnect()
                    if (BuildConfig.DEBUG) Log.i(TAG, "prefer-lan probe $baseUrl -> HTTP $code")
                    if (code in 200..299) {
                        if (BuildConfig.DEBUG) Log.i(TAG, "prefer-lan: $baseUrl reachable, dropping tunnel")
                        handler.post {
                            // Make the resumed poll try LAN first, then drop the tunnel so it resumes.
                            lastLanProbeAt = 0
                            closeWebSocket()
                        }
                        return@thread
                    }
                } catch (error: Exception) {
                    // Not reachable on this address; try the next.
                    if (BuildConfig.DEBUG) Log.i(TAG, "prefer-lan probe $baseUrl -> ${error.javaClass.simpleName}: ${error.message}")
                }
            }
            if (BuildConfig.DEBUG) Log.i(TAG, "prefer-lan: no LAN address reachable, staying on tunnel")
        }
    }

    private fun renderFrame(frame: JSONObject) {
        if (frame.optBoolean("ok")) {
            val frameSession = frame.optString("session")
            currentSession = frameSession
            // A pin that no longer resolves drops back to following its session.
            if (pinnedPane.isNotBlank() && !frame.optBoolean("pinValid", true)) {
                pinnedPane = ""
                followSession = frameSession
                prefs().edit().putString("pinnedPane", "").putString("followSession", frameSession).apply()
            }
            val where = "${frame.optString("windowName")}:${frame.optInt("paneIndex")}"
            val label = if (pinnedPane.isBlank()) "$frameSession $where" else "pin $frameSession $where"
            handler.post {
                paneButton.text = label
                setStatus("live")
                webView.evaluateJavascript("render($frame)") { result ->
                    anchorWebViewIfFollowing(result)
                }
            }
        } else {
            postStatus(frame.optString("error", "error"))
        }
    }

    private fun connectWebSocket(baseUrl: String) {
        if (wsConnected || wsConnecting) return
        val current = profile ?: return
        wsConnecting = true
        lastWsAttemptAt = System.currentTimeMillis()
        val request = Request.Builder()
            .url("$baseUrl/api/tmux/ws")
            .header("X-Airc-Auth", current.token)
            .build()
        ws = httpClient.newWebSocket(request, wsListener)
    }

    private val wsListener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            wsConnecting = false
            wsConnected = true
            sendViewState(webSocket)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            handleWsMessage(text)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
            markWsDown()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            markWsDown()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            markWsDown()
        }
    }

    private fun handleWsMessage(text: String) {
        val msg = try { JSONObject(text) } catch (_: Exception) { return }
        when (msg.optString("type")) {
            "hello" -> msg.optString("serverVersion").takeIf { it.isNotBlank() }?.let { serverVersion = it }
            "frame" -> msg.optJSONObject("frame")?.let { renderFrame(it) }
            "heartbeat" -> postStatus("idle")
            "attention" -> msg.optJSONArray("items")?.let { arr ->
                handler.post { applyAttention(parseAttention(arr)) }
            }
            "error" -> postStatus(msg.optString("error", "error"))
        }
    }

    private fun sendViewState(socket: WebSocket? = ws) {
        // session is sent even with a pin so a vanished pin falls back to its session.
        socket?.send(JSONObject().put("type", "view").put("pane", pinnedPane).put("session", followSession).toString())
    }

    private fun markWsDown() {
        wsConnected = false
        wsConnecting = false
        ws = null
    }

    private fun closeWebSocket() {
        ws?.close(1000, null)
        markWsDown()
    }

    private fun postStatus(text: String) {
        handler.post { setStatus(text) }
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
            payload.put("session", followSession)
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

    // Group the /api/tmux/panes payload into session headers + pane rows. Only
    // sessions with live panes are listed; a configured-but-dead session has no
    // panes, so it's left out. The server's session order decides ordering,
    // then any extra pane-sessions follow.
    private fun buildPickerRows(payload: JSONObject): List<PickerRow> {
        val arr: JSONArray = payload.optJSONArray("panes") ?: JSONArray()
        val bySession = linkedMapOf<String, MutableList<Pane>>()
        for (i in 0 until arr.length()) {
            val item = arr.getJSONObject(i)
            val session = item.optString("session")
            val id = item.getString("paneId")
            val title = item.optString("paneTitle")
            val windowName = item.optString("windowName")
            val titlePart = if (title.isNotBlank() && title != windowName) " - $title" else ""
            val label = "${if (item.optBoolean("active")) "* " else ""}${item.optInt("windowIndex")}:$windowName.${item.optInt("paneIndex")}$titlePart (${item.optInt("width")}x${item.optInt("height")})"
            bySession.getOrPut(session) { mutableListOf() }.add(Pane(session, id, label, pinnedPane == id))
        }
        val order = mutableListOf<String>()
        val sessionsArr = payload.optJSONArray("sessions")
        if (sessionsArr != null) {
            for (i in 0 until sessionsArr.length()) {
                val s = sessionsArr.optString(i)
                if (s.isNotBlank() && s in bySession && s !in order) order.add(s)
            }
        }
        for (s in bySession.keys) { if (s !in order) order.add(s) }
        val rows = mutableListOf<PickerRow>()
        for (session in order) {
            // Highlight the followed session, or the one currently shown if none chosen.
            val following = pinnedPane.isBlank() &&
                (if (followSession.isNotBlank()) followSession == session else currentSession == session)
            rows.add(PickerRow.SessionHeader(session, following))
            bySession[session]?.forEach { rows.add(PickerRow.PaneRow(it)) }
        }
        return rows
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
                        handler.post { showPaneDialog(buildPickerRows(payload)) }
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

    private fun showPaneDialog(rows: List<PickerRow>) {
        lateinit var dialog: AlertDialog
        val list = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(10), dp(9), dp(10), dp(10))
            addView(TextView(this@MainActivity).apply {
                text = "sessions"
                typeface = monoTypeface
                setTextColor(Chrome.accent)
                textSize = 11f
                includeFontPadding = false
                letterSpacing = 0.04f
                setPadding(dp(2), 0, dp(2), dp(8))
            })
            rows.forEachIndexed { index, row ->
                val button = when (row) {
                    is PickerRow.SessionHeader -> {
                        val kind = if (row.following) ButtonKind.PaneActive else ButtonKind.PaneInactive
                        chromeButton(row.session, kind) {
                            dialog.dismiss()
                            selectFollow(row.session)
                        }
                    }
                    is PickerRow.PaneRow -> {
                        val kind = if (row.pane.active) ButtonKind.PaneActive else ButtonKind.PaneInactive
                        chromeButton(row.pane.label, kind) {
                            dialog.dismiss()
                            selectPane(row.pane)
                        }
                    }
                }
                val indent = if (row is PickerRow.PaneRow) dp(16) else 0
                button.gravity = Gravity.CENTER_VERTICAL or Gravity.START
                button.setPadding(dp(12), 0, dp(12), 0)
                addView(button, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(40)).apply {
                    leftMargin = indent
                    if (index < rows.lastIndex) bottomMargin = dp(7)
                })
            }
        }
        val scroller = ScrollView(this).apply {
            isVerticalScrollBarEnabled = false
            addView(list)
        }
        dialog = AlertDialog.Builder(this)
            .setView(scroller)
            .create()
            .apply {
                setOnShowListener {
                    window?.setBackgroundDrawable(roundedStroke(Chrome.surface, Chrome.borderAlpha, Chrome.radiusDp))
                }
            }
        dialog.show()
    }

    private fun selectFollow(session: String) {
        setAuto(false) // an explicit session choice is a manual override
        pinnedPane = ""
        followSession = session
        prefs().edit().putString("pinnedPane", "").putString("followSession", session).apply()
        etag = null
        sendViewState()
        paneButton.text = session
    }

    private fun selectPane(pane: Pane) {
        setAuto(false) // an explicit pane choice is a manual override
        applyPin(pane.paneId, pane.session, "pin ${pane.label}")
    }

    // Pin the view to a pane without touching auto mode. Shared by the manual
    // picker (via selectPane, which also disables auto) and auto-follow.
    private fun applyPin(paneId: String, session: String, label: String) {
        pinnedPane = paneId
        followSession = session
        prefs().edit().putString("pinnedPane", paneId).putString("followSession", session).apply()
        etag = null
        sendViewState()
        paneButton.text = label
    }

    private fun parseAttention(arr: org.json.JSONArray): List<AttentionItem> {
        val out = mutableListOf<AttentionItem>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            out.add(
                AttentionItem(
                    paneId = o.optString("paneId"),
                    session = o.optString("session"),
                    windowName = o.optString("windowName"),
                    paneIndex = o.optInt("paneIndex"),
                    agent = o.optString("agent"),
                    state = o.optString("state")
                )
            )
        }
        return out
    }

    // Fold a fresh attention list into the UI: render the chips and, if auto is
    // on, follow the most urgent pane. Server already sorts urgent-first.
    // Receiving any attention payload means the server has the feature enabled
    // (it stays silent otherwise), so this is also where the auto button appears.
    private fun applyAttention(items: List<AttentionItem>) {
        if (!attentionEnabled) {
            attentionEnabled = true
            autoButton.visibility = View.VISIBLE
            autoButton.applyButtonKind(if (autoMode) ButtonKind.Enter else ButtonKind.PaneInactive)
        }
        val json = items.joinToString("|") { "${it.paneId}:${it.state}" }
        if (json == lastAttentionJson) {
            applyAuto() // list unchanged, but auto may have just been toggled
            return
        }
        lastAttentionJson = json
        attentionItems = items
        renderAttentionChips()
        applyAuto()
    }

    private fun renderAttentionChips() {
        alertsRow.removeAllViews()
        for (item in attentionItems) {
            // Three states, three styles: waiting (cyan ●, needs you), busy
            // (amber ◐, working), finished (green ○, awaiting next instruction).
            val mark = when (item.state) {
                "waiting" -> "● "
                "busy" -> "◐ "
                else -> "○ "
            }
            val kind = when (item.state) {
                "waiting" -> ButtonKind.Enter
                "busy" -> ButtonKind.Busy
                else -> ButtonKind.PaneInactive
            }
            val agent = item.agent.ifBlank { "agent" }
            val chip = chromeButton(
                "$mark$agent ${item.windowName}:${item.paneIndex}",
                kind
            ) {
                selectPane(Pane(item.session, item.paneId, "${item.windowName}:${item.paneIndex}", false))
            }
            alertsRow.addView(chip, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(30)).apply {
                rightMargin = dp(6)
            })
        }
        val show = attentionEnabled && attentionItems.isNotEmpty()
        alertsRow.visibility = if (show) View.VISIBLE else View.GONE
        alertsScroll.visibility = if (show) View.VISIBLE else View.GONE
    }

    private fun toggleAuto() {
        setAuto(!autoMode)
    }

    private fun setAuto(on: Boolean) {
        if (autoMode == on) return
        autoMode = on
        prefs().edit().putBoolean("autoMode", on).apply()
        autoButton.applyButtonKind(if (on) ButtonKind.Enter else ButtonKind.PaneInactive)
        applyAuto()
    }

    // When auto is on, pin the most urgent pane that needs a human (waiting,
    // then finished). A merely-busy pane is shown but never followed — chasing
    // whatever is working would make the view jumpy. Sticky: if nothing needs
    // attention, hold the current view rather than jumping.
    private fun applyAuto() {
        if (!autoMode) return
        val target = attentionItems.firstOrNull { it.state != "busy" } ?: return
        if (target.paneId != pinnedPane) {
            applyPin(target.paneId, target.session, "pin ${target.windowName}:${target.paneIndex}")
        }
    }

    private fun showPairDialog() {
        // Mirror the input row's field styling so the dialog matches the chrome.
        fun field(hintText: String, value: String, uri: Boolean): EditText =
            EditText(this).apply {
                hint = hintText
                setText(value)
                setSingleLine(true)
                typeface = monoTypeface
                setTextColor(Chrome.muted)
                setHintTextColor(Chrome.primaryDim)
                textSize = 13f
                minHeight = dp(42)
                includeFontPadding = false
                background = roundedStroke(Chrome.bg, Chrome.borderAlpha, Chrome.radiusDp)
                setPadding(dp(10), 0, dp(10), 0)
                if (uri) inputType = android.text.InputType.TYPE_TEXT_VARIATION_URI
            }
        val url = field("Base URL", profile?.baseUrl ?: "", true)
        val token = field("Token", profile?.token ?: "", false)
        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(16), dp(18), dp(6))
            addView(TextView(this@MainActivity).apply {
                text = "Pair laptop"
                typeface = monoTypeface
                setTextColor(Chrome.primary)
                textSize = 18f
                includeFontPadding = false
            })
            addView(url, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(42)).apply {
                topMargin = dp(16)
            })
            addView(token, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(42)).apply {
                topMargin = dp(8)
            })
        }
        AlertDialog.Builder(this)
            .setView(body)
            .setPositiveButton("Save") { _, _ ->
                saveProfile(Profile("Laptop tmux", url.text.toString(), token.text.toString(), ""))
            }
            .setNegativeButton("Scan QR") { _, _ -> scanQr() }
            .setNeutralButton("Cancel", null)
            .create()
            .apply {
                setOnShowListener {
                    window?.setBackgroundDrawable(roundedStroke(Chrome.surface, Chrome.borderAlpha, Chrome.radiusDp))
                    for (which in intArrayOf(AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE, AlertDialog.BUTTON_NEUTRAL)) {
                        getButton(which)?.apply {
                            typeface = monoTypeface
                            setTextColor(Chrome.accent)
                            textSize = 13f
                        }
                    }
                }
                show()
            }
    }

    private fun scanQr() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
            return
        }
        qrLauncher.launch(Intent(this, QrScanActivity::class.java))
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
        if (BuildConfig.DEBUG) Log.i(TAG, "endpoint switched: $lastGoodUrl -> $normalized")
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
