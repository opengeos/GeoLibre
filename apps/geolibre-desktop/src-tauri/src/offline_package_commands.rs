//! Thin native IPC adapter for the device-owned archive inventory.

use crate::offline_extraction_jobs::OfflineExtractionJobs;
use crate::offline_mbtiles::{self, MbtilesAreaOptions};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_fs::FsExt;

use crate::offline_packages::{
    decode_byte_array, OfflinePackage, PackageDetails, PackageInventory, PackageProblem,
    PackageStore, MAX_PACKAGE_BYTES,
};

#[derive(Default)]
pub(crate) struct NativeOfflinePackages {
    store_lock: Arc<Mutex<()>>,
    extractions: OfflineExtractionJobs,
}

fn open_store(app: &AppHandle) -> Result<PackageStore, String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if crate::is_unc_resolved_path(&directory.to_string_lossy()) {
        return Err("Offline packages require local storage".into());
    }
    let root = directory.join("offline-packages");
    let store = PackageStore::open(&root)?;
    let resolved = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
    if crate::is_unc_resolved_path(&resolved.to_string_lossy()) {
        return Err("Offline packages require local storage".into());
    }
    // Validate UTF-8 and Windows normalization before generating an archive.
    crate::canonical_local_path_string(&resolved)?;
    Ok(store)
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
    let lock = state.store_lock.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "Offline package storage is unavailable")?;
        let mut entries = open_store(&app)?.list()?;
        let mut authorized = Vec::with_capacity(entries.packages.len());
        for mut entry in entries.packages.drain(..) {
            match authorize(&app, &mut entry) {
                Ok(()) => authorized.push(entry),
                Err(error) => entries.problems.push(PackageProblem {
                    id: entry.id().to_string(),
                    error,
                }),
            }
        }
        entries.packages = authorized;
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
    let lock = state.store_lock.clone();
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
    let lock = state.store_lock.clone();
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
    let lock = state.store_lock.clone();
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
    let lock = state.store_lock.clone();
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

#[tauri::command]
pub(crate) fn prepare_native_offline_extraction(
    state: State<'_, NativeOfflinePackages>,
) -> Result<String, String> {
    state.extractions.prepare()
}

#[tauri::command]
pub(crate) fn cancel_native_offline_extraction(
    state: State<'_, NativeOfflinePackages>,
    job_id: String,
) -> Result<(), String> {
    state.extractions.cancel(&job_id)
}

#[tauri::command]
pub(crate) async fn inspect_native_mbtiles_source(
    app: AppHandle,
    state: State<'_, NativeOfflinePackages>,
    job_id: String,
    path: String,
) -> Result<crate::MbtilesMetadata, String> {
    let job = state.extractions.claim(&job_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _job = job;
        let path = crate::local_media_protocol::authorized_mbtiles_source(&app, &path)?;
        let source = offline_mbtiles::open_mbtiles_source(&path, _job.cancelled.clone())?;
        source.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let metadata = offline_mbtiles::source_metadata(&source)?;
        let info =
            crate::read_mbtiles_metadata_from_rows(&path.to_string_lossy(), &source, &metadata)?;
        if _job.cancelled.load(Ordering::Relaxed) {
            return Err("MBTiles inspection canceled".into());
        }
        Ok(info)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeMbtilesExtraction {
    package: OfflinePackage,
    tile_count: usize,
    payload_bytes: u64,
    tile_format: String,
    source_layers: Vec<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtractionProgress {
    job_id: String,
    phase: &'static str,
    tile_count: usize,
    payload_bytes: u64,
}

#[tauri::command]
pub(crate) async fn extract_native_mbtiles_package(
    app: AppHandle,
    state: State<'_, NativeOfflinePackages>,
    job_id: String,
    path: String,
    name: String,
    options: MbtilesAreaOptions,
    flavor: Option<String>,
) -> Result<NativeMbtilesExtraction, String> {
    let job = state.extractions.claim(&job_id)?;
    let lock = state.store_lock.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _job = job;
        let path = crate::local_media_protocol::authorized_mbtiles_source(&app, &path)?;
        let source = offline_mbtiles::open_mbtiles_source(&path, _job.cancelled.clone())?;
        // Keep inspection and the copy on the same read snapshot.
        source.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let metadata = offline_mbtiles::source_metadata(&source)?;
        let info =
            crate::read_mbtiles_metadata_from_rows(&path.to_string_lossy(), &source, &metadata)?;
        offline_mbtiles::validate_source_style(
            &info.tile_type,
            &info.source_layers,
            flavor.is_some(),
        )?;
        if flavor.is_some() {
            offline_mbtiles::validate_source_fields(&info.source_layer_fields)?;
        }
        let mut details = PackageDetails {
            name,
            bbox: options.bbox,
            view_center: None,
            min_zoom: options.min_zoom,
            max_zoom: options.max_zoom,
            flavor,
            tile_type: info.tile_type.clone(),
            archive_format: "mbtiles".into(),
        };
        crate::offline_packages::validate_details(&details)?;
        let _guard = lock
            .lock()
            .map_err(|_| "Offline package storage is unavailable")?;
        let store = open_store(&app)?;
        let mut stats = None;
        let mut last_progress = Instant::now();
        let _ = app.emit(
            "native-offline-extraction-progress",
            ExtractionProgress {
                job_id: job_id.clone(),
                phase: "copying",
                tile_count: 0,
                payload_bytes: 0,
            },
        );
        let mut package = store.generate(
            "mbtiles",
            |destination| {
                let result = offline_mbtiles::extract_mbtiles_area_with_progress(
                    &source,
                    destination,
                    options,
                    || _job.cancelled.load(Ordering::Relaxed),
                    |tile_count, payload_bytes| {
                        if last_progress.elapsed() >= Duration::from_millis(100) {
                            let _ = app.emit(
                                "native-offline-extraction-progress",
                                ExtractionProgress {
                                    job_id: job_id.clone(),
                                    phase: "copying",
                                    tile_count,
                                    payload_bytes,
                                },
                            );
                            last_progress = Instant::now();
                        }
                    },
                )?;
                details.bbox = result.bbox;
                details.view_center = result.view_center;
                details.min_zoom = result.min_zoom;
                details.max_zoom = result.max_zoom;
                stats = Some(result);
                Ok(details)
            },
            || _job.cancelled.load(Ordering::Relaxed),
        )?;
        if let Err(error) = authorize(&app, &mut package) {
            return Err(format!(
                "Offline package {} was saved, but path authorization failed: {error}. The saved package remains in the catalog; do not repeat extraction to recover it.",
                package.id()
            ));
        }
        let stats = stats.ok_or("MBTiles extraction did not produce a result")?;
        let _ = app.emit(
            "native-offline-extraction-progress",
            ExtractionProgress {
                job_id,
                phase: "complete",
                tile_count: stats.tile_count,
                payload_bytes: stats.payload_bytes,
            },
        );
        Ok(NativeMbtilesExtraction {
            package,
            tile_count: stats.tile_count,
            payload_bytes: stats.payload_bytes,
            tile_format: info.format,
            source_layers: info.source_layers,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
