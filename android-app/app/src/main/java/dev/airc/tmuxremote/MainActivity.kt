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
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.PopupWindow
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
        const val wash = 0x1F9EF56C
        const val offlineFill = 0xFF140909.toInt()
        const val radiusDp = 6
    }

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var webView: TerminalWebView
    private lateinit var status: TextView
    private lateinit var statusDot: View
    private lateinit var paneButton: Button
    private lateinit var input: EditText
    private var profile: Profile? = null
    private var pinnedPane: String = ""
    private var etag: String? = null
    private var polling = false
    private var lastGoodUrl: String = ""
    private var lastLanProbeAt: Long = 0
    private var statusPulse: ObjectAnimator? = null
    private var statusDetail: String = "connecting"
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
        setStatus("paired")
        startPolling()
    }

    private fun buildUi() {
        window.statusBarColor = Chrome.surface
        window.navigationBarColor = Chrome.bg
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
        statusWrap.addView(statusDot, LinearLayout.LayoutParams(dp(9), dp(9)).apply {
            rightMargin = dp(7)
        })
        statusWrap.addView(status, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        paneButton = chromeButton("active", ButtonKind.PaneActive) { showPanePicker() }
        val settingsButton = chromeButton("⚙", ButtonKind.IconAccent) { anchor -> showSettingsMenu(anchor) }
        top.addView(statusWrap, LinearLayout.LayoutParams(0, dp(34), 1f))
        top.addView(paneButton, LinearLayout.LayoutParams(dp(112), dp(34)).apply {
            leftMargin = dp(6)
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
        addQuickKey(quickRow, "A-", 1f) { adjustFont(-1) }
        addQuickKey(quickRow, "A+", 1f) { adjustFont(1) }
        addQuickKey(quickRow, "^", 1f) { sendKey("Up") }
        addQuickKey(quickRow, "v", 1f) { sendKey("Down") }
        addQuickKey(quickRow, "enter", 1.45f, ButtonKind.Enter) { sendKey("Enter") }

        bottom.addView(inputRow)
        bottom.addView(quickRow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(39)).apply {
            topMargin = dp(8)
        })

        root.addView(top)
        root.addView(webView, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(bottom)
        setContentView(root)
    }

    private enum class ButtonKind {
        Key, Primary, Enter, PaneActive, PaneInactive, IconAccent
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
            ButtonKind.Key -> arrayOf(Chrome.primary, Chrome.bg, Chrome.borderAlpha, Chrome.wash)
        }
        setTextColor(textColor)
        background = stateBackground(fill, stroke, pressedFill)
        if (kind == ButtonKind.Primary || kind == ButtonKind.PaneActive) {
            setShadowLayer(8f, 0f, 0f, Color.argb(150, 158, 245, 108))
        } else if (kind == ButtonKind.Enter || kind == ButtonKind.IconAccent) {
            setShadowLayer(6f, 0f, 0f, Color.argb(120, 22, 255, 255))
        } else {
            setShadowLayer(4f, 0f, 0f, Color.argb(85, 158, 245, 108))
        }
    }

    private fun addQuickKey(row: LinearLayout, label: String, weight: Float, kind: ButtonKind = ButtonKind.Key, action: () -> Unit) {
        row.addView(chromeButton(label, kind) { action() }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, weight).apply {
            rightMargin = if (row.childCount < 4) dp(7) else 0
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
            }
            lower == "connecting" || lower.contains("timeout") || lower.contains("failed") || lower.startsWith("http") || lower.startsWith("send") || lower.startsWith("panes") -> {
                status.text = "reconnecting"
                status.setTextColor(Chrome.amber)
                statusDot.background = dotDrawable(Chrome.amber, filled = true, glow = false)
                startStatusPulse()
            }
            else -> {
                stopStatusPulse()
                status.text = "offline"
                status.setTextColor(Chrome.danger)
                statusDot.background = dotDrawable(Chrome.danger, filled = false, glow = false)
                statusDot.alpha = 1f
            }
        }
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
            addView(chromeButton("pair laptop", ButtonKind.Key) {
                popup.dismiss()
                showPairDialog()
            }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(38)))
        }
        popup = PopupWindow(panel, dp(178), LinearLayout.LayoutParams.WRAP_CONTENT, true).apply {
            isOutsideTouchable = true
            elevation = dp(6).toFloat()
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        }
        popup.showAsDropDown(anchor, -dp(136), dp(7), Gravity.NO_GRAVITY)
    }

    private fun adjustFont(delta: Int) {
        webView.evaluateJavascript("window.bumpFont && window.bumpFont($delta)") { result ->
            anchorWebViewIfFollowing(result)
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
            let cols=0,rows=0,cursor=null,ch=7.2,line=15,scale=1.06,fontMode='auto',fontSize=13;
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
            window.bumpFont=function(delta){ const cur=parseFloat(term().style.fontSize)||autoSize(); fontSize=Math.max(FMIN,Math.min(FMAX,cur+delta)); fontMode='manual'; fit(); return anchorTarget(); };
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
                                    setStatus("live")
                                    webView.evaluateJavascript("render(${frame.toString()})") { result ->
                                        anchorWebViewIfFollowing(result)
                                    }
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
