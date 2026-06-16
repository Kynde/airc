package dev.airc.tmuxremote

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.TextView
import com.google.zxing.ResultPoint
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.journeyapps.barcodescanner.camera.CameraSettings

class QrScanActivity : Activity() {
    private lateinit var scanner: DecoratedBarcodeView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        scanner = DecoratedBarcodeView(this).apply {
            setStatusText("Scan Airc pairing QR")
            cameraSettings = CameraSettings().apply {
                focusMode = CameraSettings.FocusMode.CONTINUOUS
                isAutoFocusEnabled = true
                isContinuousFocusEnabled = true
                isBarcodeSceneModeEnabled = true
                isMeteringEnabled = true
                isExposureEnabled = true
            }
        }

        val hint = TextView(this).apply {
            text = "Move the phone back until the QR is sharp"
            setTextColor(0xffffffff.toInt())
            setBackgroundColor(0x66000000)
            gravity = Gravity.CENTER
            setPadding(16, 12, 16, 12)
        }

        setContentView(FrameLayout(this).apply {
            addView(scanner, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            ))
            addView(hint, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM
            ))
        })

        scanner.decodeContinuous(object : BarcodeCallback {
            override fun barcodeResult(result: BarcodeResult) {
                val text = result.text ?: return
                scanner.pause()
                setResult(RESULT_OK, Intent().putExtra(EXTRA_QR_TEXT, text))
                finish()
            }

            override fun possibleResultPoints(resultPoints: MutableList<ResultPoint>?) {
                // No overlay needed.
            }
        })
    }

    override fun onResume() {
        super.onResume()
        scanner.resume()
    }

    override fun onPause() {
        scanner.pause()
        super.onPause()
    }

    companion object {
        const val EXTRA_QR_TEXT = "dev.airc.tmuxremote.QR_TEXT"
    }
}
