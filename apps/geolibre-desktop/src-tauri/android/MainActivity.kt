// Replaces the MainActivity that `tauri android init` generates (gen/android is
// not committed, so .github/workflows/android.yml copies this file over the
// generated one after init). Keep the package and the TauriActivity base in
// step with the template.
package org.geolibre.app

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Edge-to-edge (requested above, and enforced on Android 15+ at targetSdk
    // 35+) draws the WebView under the status and navigation bars, where the
    // system eats taps, so the top toolbar stops responding. The page's CSS
    // pads by env(safe-area-inset-*), but older WebViews (e.g. Chromium 109,
    // or HarmonyOS 4's Android WebView) report those insets as 0, so inset
    // the content view natively instead. Consuming the insets leaves the
    // WebView's env() values at 0, so the CSS padding never doubles up.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }
}
