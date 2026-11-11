//! Native Bluetooth GNSS receiver transport for the Android app (GeoLibre#3397).
//!
//! The Android WebView exposes neither Web Serial nor Web Bluetooth, so the GPS
//! Tracking tool's external-receiver path cannot reach a Bluetooth puck there.
//! This plugin opens a Serial Port Profile (RFCOMM) socket to a receiver the
//! user has paired in Android settings and streams its bytes to the webview,
//! where the existing NMEA parser takes over (`src/lib/nmea-source.ts`).
//!
//! All of the work happens in Kotlin (`android/`). On every other platform the
//! plugin registers no handler, so its commands reject and the frontend never
//! offers the option (it gates on Tauri + Android).

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("gnss-bluetooth")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin("org.geolibre.gnssbluetooth", "GnssBluetoothPlugin")?;
            Ok(())
        })
        .build()
}
