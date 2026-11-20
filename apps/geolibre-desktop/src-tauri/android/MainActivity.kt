// Replaces the MainActivity that `tauri android init` generates (gen/android is
// not committed, so .github/workflows/android.yml copies this file over the
// generated one after init). Keep the package and the TauriActivity base in
// step with the template.
package org.geolibre.app

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) {
        val found = findWebView(view.getChildAt(i))
        if (found != null) return found
      }
    }
    return null
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Edge-to-edge (requested above, and enforced on Android 15+ at targetSdk
    // 35+) draws the WebView under the status and navigation bars, where the
    // system eats taps, so the top toolbar stops responding. The page's CSS
    // pads by env(safe-area-inset-*), but older WebViews (e.g. Chromium 109,
    // or HarmonyOS 4's Android WebView) report those insets as 0, so inset
    // the content view natively instead. Consuming the insets leaves the
    // WebView's env() values at 0, so the CSS padding never doubles up. The
    // IME inset is included because edge-to-edge also stops the keyboard from
    // resizing the window; without it the keyboard covers focused inputs.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }

    // Route hardware/predictive back gestures into the WebView's LIFO mobile
    // back stack first (`mobile-back-stack.ts`). If a BottomSheet, menu
    // drill-down, or field crosshair overlay calls `event.preventDefault()`,
    // stay in the app; otherwise delegate back to Android's default behavior.
    val backCallback = object : OnBackPressedCallback(true) {
      private fun passBackToSystem() {
        isEnabled = false
        onBackPressedDispatcher.onBackPressed()
        isEnabled = true
      }

      override fun handleOnBackPressed() {
        val webView = findWebView(content)
        if (webView == null) {
          passBackToSystem()
          return
        }
        webView.evaluateJavascript(
          "(function(){var e=new CustomEvent('geolibre:android-back',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;})()",
        ) { result ->
          if (result != "true") {
            passBackToSystem()
          }
        }
      }
    }
    onBackPressedDispatcher.addCallback(this, backCallback)
  }
}
