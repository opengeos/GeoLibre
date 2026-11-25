//! Thin native IPC adapter for the device-owned archive inventory.

use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_fs::FsExt;

use crate::offline_packages::{
    decode_byte_array, OfflinePackage, PackageDetails, PackageInventory, PackageStore,
    MAX_PACKAGE_BYTES,
};

#[derive(Default)]
pub(crate) struct NativeOfflinePackages(Arc<Mutex<()>>);

fn open_store(app: &AppHandle) -> Result<PackageStore, String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    PackageStore::open(&directory.join("offline-packages"))
}

fn authorize(app: &AppHandle, entry: &mut OfflinePackage) -> Result<(), String> {
    // Only paths returned by the confined native inventory enter the scope.
    // Re-established from disk on each launch; browser storage is not trusted.
    if crate::is_unc_resolved_path(&entry.saved_path) {
        return Err("Offline packages require local storage".into());
    }
    entry.saved_path = crate::canonical_local_path_string(std::path::Path::new(&entry.saved_path))?;
    app.fs_scope()
        .allow_file(&entry.saved_path)
        .map_err(|e| e.to_string())?;
    app.asset_protocol_scope()
        .allow_file(&entry.saved_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn list_native_offline_packages(
    app: AppHandle,
    state: State<'_, NativeOfflinePackages>,
) -> Result<PackageInventory, String> {
    let lock = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "Offline package storage is unavailable")?;
        let mut entries = open_store(&app)?.list()?;
        for entry in &mut entries.packages {
            authorize(&app, entry)?;
        }
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn save_native_offline_package(
    app: AppHandle,
    state: State<'_, NativeOfflinePackages>,
    request: tauri::ipc::Request<'_>,
) -> Result<OfflinePackage, String> {
    let metadata = request
        .headers()
        .get("x-package-metadata")
        .ok_or("Missing offline package metadata")?
        .to_str()
        .map_err(|e| e.to_string())?;
    if metadata.len() > 32 * 1024 {
        return Err("Offline package metadata is too large".into());
    }
    let decoded = percent_encoding::percent_decode_str(metadata)
        .decode_utf8()
        .map_err(|e| e.to_string())?;
    let details: PackageDetails = serde_json::from_str(&decoded).map_err(|e| e.to_string())?;
    let data = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) if bytes.len() <= MAX_PACKAGE_BYTES => bytes.clone(),
        tauri::ipc::InvokeBody::Raw(_) => return Err("Offline package exceeds 512 MiB".into()),
        tauri::ipc::InvokeBody::Json(value) => decode_byte_array(value, MAX_PACKAGE_BYTES)?,
    };
    let lock = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "Offline package storage is unavailable")?;
        let mut entry = open_store(&app)?.save(details, &data)?;
        authorize(&app, &mut entry)?;
        Ok(entry)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn verify_native_offline_package(
    app: AppHandle,
    state: State<'_, NativeOfflinePackages>,
    id: String,
) -> Result<OfflinePackage, String> {
    let lock = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "Offline package storage is unavailable")?;
        let mut entry = open_store(&app)?.verify(&id)?;
        authorize(&app, &mut entry)?;
        Ok(entry)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn update_native_offline_package(
    app: AppHandle,
    state: State<'_, NativeOfflinePackages>,
    id: String,
    name: Option<String>,
    flavor: Option<String>,
) -> Result<OfflinePackage, String> {
    let lock = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "Offline package storage is unavailable")?;
        open_store(&app)?.update(&id, name, flavor)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn delete_native_offline_package(
    app: AppHandle,
    state: State<'_, NativeOfflinePackages>,
    id: String,
) -> Result<(), String> {
    let lock = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "Offline package storage is unavailable")?;
        let store = open_store(&app)?;
        for path in store.archive_paths(&id)? {
            app.state::<crate::local_media_protocol::LocalMediaPools>()
                .release_path(&path)?;
        }
        store.delete(&id)
    })
    .await
    .map_err(|e| e.to_string())?
}
