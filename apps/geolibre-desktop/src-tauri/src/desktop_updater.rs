//! Signed desktop auto-updater commands backed by `tauri-plugin-updater`.
//!
//! Only enabled on non-Store desktop builds:
//! - Mac App Store (`feature = "mas"`) and mobile targets compile this module
//!   out cleanly and expose stateless stubs so no store build includes an
//!   in-app updater.
//! - Windows Microsoft Store (MSIX) builds are also blocked at runtime using
//!   `is_msix_install` (Microsoft Store policy 10.2.5).
//! - Local/dev builds without updater endpoints or a minisign public key in
//!   `tauri.conf.json` return `configured: false` instead of failing.

use serde::Serialize;

/// Whether `tauri-plugin-updater` was registered for this run.
///
/// Managed only on builds that compile the updater in. The plugin is skipped
/// when the Tauri config has no `plugins.updater` block, and its
/// `UpdaterExt` accessors panic when the plugin state is absent, so the
/// commands below consult this flag first.
#[allow(dead_code)]
pub struct DesktopUpdaterEnabled(pub bool);

/// Returns whether the Tauri config carries usable updater settings.
///
/// `tauri-plugin-updater` deserializes `plugins.updater` while the app is
/// built and aborts startup when that fails, for example on a missing block
/// ("invalid type: null, expected struct Config", issue #3631), a missing
/// `pubkey`, a malformed endpoint, or (in release builds) a non-HTTPS one. Running the plugin's own deserializer
/// here catches every one of those, so the plugin is registered only when it
/// will initialize. An empty `pubkey` deserializes but cannot verify any
/// update, so it counts as unconfigured too.
///
/// Args:
///     updater: The raw `plugins.updater` value from the Tauri config, if any.
///
/// Returns:
///     `true` when the plugin's config accepts the value and it has a
///     non-empty `pubkey`.
#[cfg(all(
    any(target_os = "macos", target_os = "windows", target_os = "linux"),
    feature = "desktop-updater",
    not(feature = "mas")
))]
pub fn updater_plugin_configured(updater: Option<&serde_json::Value>) -> bool {
    let Some(value) = updater.filter(|value| !value.is_null()) else {
        eprintln!("[GeoLibre] Signed desktop updater disabled: no plugins.updater config.");
        return false;
    };
    match serde_json::from_value::<tauri_plugin_updater::Config>(value.clone()) {
        Ok(config) if !config.pubkey.trim().is_empty() => true,
        Ok(_) => {
            eprintln!(
                "[GeoLibre] Signed desktop updater disabled: plugins.updater.pubkey is empty."
            );
            false
        }
        Err(error) => {
            eprintln!("[GeoLibre] Signed desktop updater disabled: invalid plugins.updater config: {error}");
            false
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateCheckResult {
    pub configured: bool,
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
}

#[cfg(all(
    any(target_os = "macos", target_os = "windows", target_os = "linux"),
    feature = "desktop-updater",
    not(feature = "mas")
))]
mod active {
    use super::DesktopUpdateCheckResult;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    use tauri_plugin_updater::UpdaterExt;

    /// Finite timeout for updater manifest check requests.
    const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(15);
    /// Finite timeout for downloading signed installer binaries.
    const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);

    static INSTALL_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

    struct InstallInFlightGuard;

    impl InstallInFlightGuard {
        fn try_acquire() -> Option<Self> {
            if INSTALL_IN_FLIGHT
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                Some(Self)
            } else {
                None
            }
        }
    }

    impl Drop for InstallInFlightGuard {
        fn drop(&mut self) {
            INSTALL_IN_FLIGHT.store(false, Ordering::SeqCst);
        }
    }

    fn store_managed_build() -> bool {
        #[cfg(target_os = "windows")]
        {
            if let Ok(exe) = std::env::current_exe() {
                return crate::is_msix_install(&exe);
            }
        }
        false
    }

    /// Whether the updater plugin was registered at startup (see `lib.rs`).
    fn plugin_registered(app: &tauri::AppHandle) -> bool {
        use tauri::Manager;
        app.try_state::<super::DesktopUpdaterEnabled>()
            .is_some_and(|enabled| enabled.0)
    }

    fn build_updater(
        app: &tauri::AppHandle,
    ) -> Result<tauri_plugin_updater::Updater, tauri_plugin_updater::Error> {
        app.updater_builder().timeout(UPDATE_CHECK_TIMEOUT).build()
    }

    pub(super) async fn check(app: tauri::AppHandle) -> Result<DesktopUpdateCheckResult, String> {
        let current_version = app.package_info().version.to_string();
        if store_managed_build() || !plugin_registered(&app) {
            return Ok(DesktopUpdateCheckResult {
                configured: false,
                available: false,
                current_version,
                version: None,
                notes: None,
                date: None,
            });
        }
        let updater = match build_updater(&app) {
            Ok(updater) => updater,
            Err(error) => {
                // Updater endpoints / minisign pubkey are omitted in dev builds;
                // log the reason so a misconfigured release build is diagnosable.
                eprintln!("[GeoLibre] Signed desktop updater unavailable: {error}");
                return Ok(DesktopUpdateCheckResult {
                    configured: false,
                    available: false,
                    current_version,
                    version: None,
                    notes: None,
                    date: None,
                });
            }
        };
        let update = updater
            .check()
            .await
            .map_err(|error| format!("Could not check for signed desktop updates: {error}"))?;
        match update {
            Some(update) => Ok(DesktopUpdateCheckResult {
                configured: true,
                available: true,
                current_version,
                version: Some(update.version),
                notes: update.body,
                date: update.date.map(|d| d.to_string()),
            }),
            None => Ok(DesktopUpdateCheckResult {
                configured: true,
                available: false,
                current_version,
                version: None,
                notes: None,
                date: None,
            }),
        }
    }

    pub(super) async fn install(app: tauri::AppHandle) -> Result<bool, String> {
        if store_managed_build() {
            return Err("In-app updates are managed by the Microsoft Store.".to_string());
        }
        if !plugin_registered(&app) {
            return Err("Signed auto-updater is not configured for this build.".to_string());
        }
        let _guard = InstallInFlightGuard::try_acquire().ok_or_else(|| {
            "A signed desktop update installation is already in progress.".to_string()
        })?;
        let updater = build_updater(&app)
            .map_err(|_| "Signed auto-updater is not configured for this build.".to_string())?;
        let Some(mut update) = updater
            .check()
            .await
            .map_err(|error| format!("Could not check for signed desktop updates: {error}"))?
        else {
            return Ok(false);
        };
        // tauri-plugin-updater 2.14.x does not copy the builder timeout into
        // the returned `Update`, so apply a finite download deadline explicitly.
        update.timeout = Some(UPDATE_DOWNLOAD_TIMEOUT);
        update
            .download_and_install(|_chunk, _total| {}, || {})
            .await
            .map_err(|error| format!("Could not download or install desktop update: {error}"))?;
        app.restart();
    }
}

#[tauri::command]
pub async fn check_desktop_update(
    app: tauri::AppHandle,
) -> Result<DesktopUpdateCheckResult, String> {
    #[cfg(all(
        any(target_os = "macos", target_os = "windows", target_os = "linux"),
        feature = "desktop-updater",
        not(feature = "mas")
    ))]
    {
        active::check(app).await
    }
    #[cfg(not(all(
        any(target_os = "macos", target_os = "windows", target_os = "linux"),
        feature = "desktop-updater",
        not(feature = "mas")
    )))]
    {
        Ok(DesktopUpdateCheckResult {
            configured: false,
            available: false,
            current_version: app.package_info().version.to_string(),
            version: None,
            notes: None,
            date: None,
        })
    }
}

#[tauri::command]
pub async fn install_desktop_update(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(all(
        any(target_os = "macos", target_os = "windows", target_os = "linux"),
        feature = "desktop-updater",
        not(feature = "mas")
    ))]
    {
        active::install(app).await
    }
    #[cfg(not(all(
        any(target_os = "macos", target_os = "windows", target_os = "linux"),
        feature = "desktop-updater",
        not(feature = "mas")
    )))]
    {
        let _ = app;
        Err("Signed auto-updates are not available in this build of GeoLibre.".to_string())
    }
}

#[cfg(all(
    test,
    any(target_os = "macos", target_os = "windows", target_os = "linux"),
    feature = "desktop-updater",
    not(feature = "mas")
))]
mod tests {
    use super::updater_plugin_configured;
    use serde_json::json;

    const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu";

    #[test]
    fn missing_or_incomplete_updater_config_is_not_configured() {
        assert!(!updater_plugin_configured(None));
        assert!(!updater_plugin_configured(Some(&json!(null))));
        assert!(!updater_plugin_configured(Some(&json!({}))));
        assert!(!updater_plugin_configured(Some(
            &json!({ "endpoints": ["https://example.com/latest.json"] })
        )));
        assert!(!updater_plugin_configured(Some(&json!({ "pubkey": "  " }))));
    }

    #[test]
    fn updater_config_the_plugin_rejects_is_not_configured() {
        // A pubkey alone is not enough: the plugin also deserializes the rest
        // of the block, and a malformed endpoint aborts startup just the same.
        assert!(!updater_plugin_configured(Some(&json!({
            "pubkey": PUBKEY,
            "endpoints": ["not a url"]
        }))));
        assert!(!updater_plugin_configured(Some(&json!({
            "pubkey": PUBKEY,
            "endpoints": "https://example.com/latest.json"
        }))));
    }

    #[test]
    fn valid_updater_config_is_configured() {
        assert!(updater_plugin_configured(Some(&json!({
            "pubkey": PUBKEY,
            "endpoints": ["https://example.com/latest.json"]
        }))));
    }

    #[test]
    fn shipped_tauri_config_matches_updater_registration() {
        // Guards issue #3631: a plugins.updater block that ships must be one
        // the plugin accepts, or the updater is silently disabled.
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = config
            .get("plugins")
            .and_then(|plugins| plugins.get("updater"));
        if updater.is_some() {
            assert!(
                updater_plugin_configured(updater),
                "plugins.updater must be a valid tauri-plugin-updater config with a pubkey"
            );
        }
    }
}
