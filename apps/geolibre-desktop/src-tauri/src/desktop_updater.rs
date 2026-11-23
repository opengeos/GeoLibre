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
    not(feature = "mas")
))]
mod active {
    use super::DesktopUpdateCheckResult;
    use tauri_plugin_updater::UpdaterExt;

    fn store_managed_build() -> bool {
        #[cfg(target_os = "windows")]
        {
            if let Ok(exe) = std::env::current_exe() {
                return crate::is_msix_install(&exe);
            }
        }
        false
    }

    pub(super) async fn check(app: tauri::AppHandle) -> Result<DesktopUpdateCheckResult, String> {
        let current_version = app.package_info().version.to_string();
        if store_managed_build() {
            return Ok(DesktopUpdateCheckResult {
                configured: false,
                available: false,
                current_version,
                version: None,
                notes: None,
                date: None,
            });
        }
        let updater = match app.updater() {
            Ok(updater) => updater,
            Err(_) => {
                // Updater endpoints / minisign pubkey are omitted in dev builds.
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
        let updater = app
            .updater()
            .map_err(|_| "Signed auto-updater is not configured for this build.".to_string())?;
        let Some(update) = updater
            .check()
            .await
            .map_err(|error| format!("Could not check for signed desktop updates: {error}"))?
        else {
            return Ok(false);
        };
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
        not(feature = "mas")
    ))]
    {
        active::check(app).await
    }
    #[cfg(not(all(
        any(target_os = "macos", target_os = "windows", target_os = "linux"),
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
        not(feature = "mas")
    ))]
    {
        active::install(app).await
    }
    #[cfg(not(all(
        any(target_os = "macos", target_os = "windows", target_os = "linux"),
        not(feature = "mas")
    )))]
    {
        let _ = app;
        Err("Signed auto-updates are not available in this build of GeoLibre.".to_string())
    }
}
