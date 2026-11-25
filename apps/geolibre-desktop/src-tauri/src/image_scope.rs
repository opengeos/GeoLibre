//! Image selection without persistent scope grants: the native image picker,
//! the one-shot allowlist `read_selected_image` consumes, and the startup
//! cleanup of legacy per-image grants in the persisted-scope files.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const PERSISTED_SCOPE_FILES: [&str; 2] = [".persisted-scope", ".persisted-scope-asset"];
const PERSISTED_PHOTO_EXTENSIONS: [&str; 6] = [".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"];
const IMAGE_PICKER_EXTENSIONS: [&str; 8] =
    ["jpg", "jpeg", "png", "webp", "heic", "heif", "tif", "tiff"];

#[derive(Deserialize, Serialize)]
struct PersistedScopeState {
    allowed_paths: Vec<String>,
    forbidden_patterns: Vec<String>,
}

#[derive(Default)]
pub(crate) struct SelectedImagePaths(Mutex<HashSet<PathBuf>>);

fn is_persisted_image_file(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    PERSISTED_PHOTO_EXTENSIONS
        .iter()
        .any(|extension| lower.ends_with(extension))
}

fn is_image_picker_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            IMAGE_PICKER_EXTENSIONS
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
}

/// Remove legacy per-image grants before persisted-scope synchronously replays
/// them. Photo workflows consume or embed image bytes during the current
/// session, so these grants are not needed after restart.
pub(crate) fn prune_persisted_image_scopes(app: &tauri::AppHandle) {
    let Ok(app_data_dir) = app.path().app_data_dir() else {
        return;
    };
    for file_name in PERSISTED_SCOPE_FILES {
        let path = app_data_dir.join(file_name);
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        let Ok(mut state) = bincode::deserialize::<PersistedScopeState>(&bytes) else {
            continue;
        };
        let original_len = state.allowed_paths.len();
        state
            .allowed_paths
            .retain(|allowed| !is_persisted_image_file(allowed));
        if state.allowed_paths.len() == original_len {
            continue;
        }
        if let Ok(compacted) = bincode::serialize(&state) {
            let _ = fs::write(path, compacted);
        }
    }
}
/// Pick images without adding them to Tauri's filesystem or asset scopes. The
/// returned paths enter a short-lived native allowlist and can only be consumed
/// by `read_selected_image`.
#[tauri::command]
pub(crate) async fn pick_image_paths(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dialog_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .add_filter("Images", &IMAGE_PICKER_EXTENSIONS)
            .blocking_pick_files()
    })
    .await
    .map_err(|error| format!("Could not open the image picker: {error}"))?
    .unwrap_or_default();

    let mut paths = Vec::with_capacity(selected.len());
    for file in selected {
        let path = file
            .into_path()
            .map_err(|error| format!("Could not resolve a selected image path: {error}"))?;
        if is_image_picker_path(&path) {
            paths.push(path);
        }
    }
    app.state::<SelectedImagePaths>()
        .0
        .lock()
        .map_err(|_| "Could not lock the selected-image allowlist".to_string())?
        .extend(paths.iter().cloned());
    Ok(paths
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

/// Read one image explicitly selected by `pick_image_paths`, then remove its
/// path from the allowlist. This avoids both persistent grants and access to
/// unselected sibling files.
#[tauri::command]
pub(crate) fn read_selected_image(
    app: tauri::AppHandle,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let path = PathBuf::from(path);
    let selected = app.state::<SelectedImagePaths>();
    {
        let mut allowed = selected
            .0
            .lock()
            .map_err(|_| "Could not lock the selected-image allowlist".to_string())?;
        if !allowed.remove(&path) {
            return Err("Refusing to read an image that was not selected".to_string());
        }
    }
    fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|error| format!("Could not read selected image: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{is_image_picker_path, is_persisted_image_file};

    #[test]
    fn recognizes_only_persisted_image_file_grants() {
        assert!(is_persisted_image_file(
            r"\\?\UNC\server\drone photos\IMG_0042.JPEG"
        ));
        // TIFF grants may belong to persistent GeoTIFF raster layers, so the
        // startup migration must leave them intact even though the photo
        // importer also accepts TIFF images.
        assert!(!is_persisted_image_file(r"X:\survey\ortho.tif"));
        // Directory patterns must survive even when their names contain an
        // image-looking segment, as must unrelated project and vector grants.
        assert!(!is_persisted_image_file(r"X:\survey\photos\**"));
        assert!(!is_persisted_image_file(r"X:\survey\map.geolibre"));
        assert!(!is_persisted_image_file(r"X:\survey\points.geojson"));
    }

    #[test]
    fn native_image_picker_rejects_paths_outside_its_filter() {
        assert!(is_image_picker_path(std::path::Path::new(
            r"X:\survey\PHOTO.JPEG"
        )));
        assert!(is_image_picker_path(std::path::Path::new(
            r"X:\survey\ortho.tiff"
        )));
        assert!(!is_image_picker_path(std::path::Path::new(
            r"X:\survey\notes.txt"
        )));
    }
}
