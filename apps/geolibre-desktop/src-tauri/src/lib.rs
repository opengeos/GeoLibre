// Earth Engine sign-in uses Google's OAuth loopback-redirect flow, which binds
// a listener on 127.0.0.1 to accept the browser's redirect. Accepting an
// inbound connection requires the `com.apple.security.network.server`
// entitlement, which App Review rejects for an app that otherwise only makes
// outgoing requests (guideline 2.4.5, submission 76036eca). Both Apple App
// Store targets therefore compile the whole flow out and hide the Earth Engine
// UI, so no Apple build ever binds a listening socket: the `mas` (macOS) build,
// and iOS — which ships through the same review pipeline and has no way to
// justify a listener either. Every other target (Developer ID macOS, Windows,
// Linux, Android, web) keeps it. See docs/mac-app-store.md.
#[cfg(not(any(feature = "mas", target_os = "ios")))]
mod earth_engine_oauth;
// App Store stub, mirroring the `native_duckdb` pattern below: the commands stay
// in the handler list (so a stale panel state or an external plugin gets a clear
// message instead of an "unknown command" error) but no socket is ever bound.
#[cfg(any(feature = "mas", target_os = "ios"))]
mod earth_engine_oauth {
    const UNAVAILABLE: &str = "Earth Engine sign-in is not available in the App Store build of GeoLibre.";

    #[tauri::command]
    pub fn start_earth_engine_oauth(_client_id: String) -> Result<serde_json::Value, String> {
        Err(UNAVAILABLE.to_string())
    }

    #[tauri::command]
    pub fn poll_earth_engine_oauth(_state_id: String) -> Result<Option<serde_json::Value>, String> {
        Err(UNAVAILABLE.to_string())
    }
}
#[cfg(feature = "native-duckdb")]
mod native_duckdb;
#[cfg(not(feature = "native-duckdb"))]
mod native_duckdb {
    #[tauri::command]
    pub async fn count_native_vector_file_features(
        _path: String,
        _layer: Option<String>,
    ) -> Result<usize, String> {
        Err("Native DuckDB is not enabled in this build.".to_string())
    }

    #[tauri::command]
    pub async fn load_native_vector_file(
        _path: String,
        _layer: Option<String>,
        _override_source_crs: Option<String>,
    ) -> Result<serde_json::Value, String> {
        Err("Native DuckDB is not enabled in this build.".to_string())
    }
}

// The `mas` (Mac App Store) feature builds for the App Sandbox, where the app
// may neither download executable code (guideline 2.5.2) nor spawn it. DuckDB
// loads its spatial extension as unsigned native code at runtime, so the two
// features can never be combined.
#[cfg(all(feature = "mas", feature = "native-duckdb"))]
compile_error!("the `mas` (Mac App Store) build must not enable `native-duckdb`: DuckDB loads its spatial extension as unsigned native code at runtime, which App Sandbox and App Store guideline 2.5.2 forbid.");

use earth_engine_oauth::{poll_earth_engine_oauth, start_earth_engine_oauth};
#[cfg(not(any(feature = "mas", target_os = "ios")))]
use earth_engine_oauth::EarthEngineOAuthState;
use flate2::read::{GzDecoder, ZlibDecoder};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(not(feature = "mas"))]
use std::collections::{HashSet, VecDeque};
use std::env;
#[cfg(not(feature = "mas"))]
use std::ffi::OsStr;
use std::fs;
#[cfg(not(feature = "mas"))]
use std::fs::File;
use std::io::Read;
#[cfg(not(feature = "mas"))]
use std::io::{BufRead, BufReader, Cursor, Write};
#[cfg(not(feature = "mas"))]
use std::net::TcpListener;
use std::path::{Path, PathBuf};
#[cfg(not(feature = "mas"))]
use std::process::{Child, Command, Stdio};
#[cfg(not(feature = "mas"))]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(not(feature = "mas"))]
use std::sync::{Arc, Mutex};
#[cfg(not(feature = "mas"))]
use std::thread;
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_fs::FsExt;

// OAuth popups are a desktop-only, multi-window concept; Android/iOS have no
// equivalent, and `WebviewWindowBuilder::{on_new_window, window_features}` do
// not exist on the mobile runtime.
#[cfg(desktop)]
static POPUP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[cfg(not(feature = "mas"))]
const MARTIN_VERSION: &str = "martin-v1.10.1";
#[cfg(not(feature = "mas"))]
const MARTIN_RELEASE_BASE_URL: &str = "https://github.com/maplibre/martin/releases/download";
#[cfg(not(feature = "mas"))]
const MARTIN_START_ATTEMPTS: usize = 3;
#[cfg(not(feature = "mas"))]
const MARTIN_HEALTH_ATTEMPTS: usize = 30;
#[cfg(not(feature = "mas"))]
const SIDECAR_HEALTH_ATTEMPTS: usize = 180;
#[cfg(not(feature = "mas"))]
const SIDECAR_PORT: u16 = 8765;
// The sidecar's PostGIS endpoints refuse every destination until this variable
// names the allowed hosts — the check that stops a *shared* deployment (the
// Docker image, where the sidecar is reachable same-origin through the nginx
// proxy) from being pointed at arbitrary internal databases. See
// `_validate_postgis_target` in
// backend/geolibre_server/geolibre_server/app/postgis.py.
#[cfg(not(feature = "mas"))]
const POSTGIS_HOSTS_ENV: &str = "GEOLIBRE_POSTGIS_HOSTS";
// Desktop is the case that restriction is not aimed at: the sidecar is
// loopback-bound, token-authenticated, and spawned for one user who is also its
// operator, so it would only mean a user cannot reach their own database
// without setting an environment variable for a process the app launches.
#[cfg(not(feature = "mas"))]
const POSTGIS_HOSTS_DESKTOP_DEFAULT: &str = "*";
// The desktop JupyterLab server for the Notebook panel. Loopback-bound and
// token-gated; uses its own uv project environment so it never disturbs the
// FastAPI sidecar's env. First start can be slow while uv syncs JupyterLab.
#[cfg(not(feature = "mas"))]
const JUPYTER_PORT: u16 = 8766;
// Polled once per second, so up to ~4 minutes — generous headroom for the
// first-run `uv sync` of JupyterLab on a cold cache.
#[cfg(not(feature = "mas"))]
const JUPYTER_HEALTH_ATTEMPTS: usize = 240;
#[cfg(not(feature = "mas"))]
const UV_INSTALL_BASE_URL: &str = "https://astral.sh/uv";
const REMOTE_TILE_TIMEOUT_SECS: u64 = 8;
const REMOTE_TILE_CONNECT_TIMEOUT_SECS: u64 = 4;
const URL_RESOLVE_TIMEOUT_SECS: u64 = 15;
/// Ceiling for a caller-supplied `fetch_url_bytes` budget. The default suits a
/// tile; callers that download a whole dataset (Add Vector Layer) ask for more,
/// but not without bound, so a bad value cannot wedge a request indefinitely.
const MAX_FETCH_TIMEOUT_SECS: u64 = 600;

#[cfg(all(unix, not(feature = "mas")))]
const SIGTERM: i32 = 15;
#[cfg(all(unix, not(feature = "mas")))]
const SIGKILL: i32 = 9;

#[cfg(all(unix, not(feature = "mas")))]
unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

#[cfg(not(feature = "mas"))]
struct MartinServerState {
    process: Mutex<Option<MartinProcess>>,
}

#[cfg(not(feature = "mas"))]
struct SidecarServerState {
    process: Mutex<Option<SidecarProcess>>,
    // Serialize start/stop across every UI surface that can request the shared
    // sidecar. Without this, two callers can both pass the reuse check and race
    // to bind the fixed port, or a restart can overlap the previous teardown.
    lifecycle: Mutex<()>,
}

#[cfg(not(feature = "mas"))]
struct JupyterServerState {
    process: Mutex<Option<JupyterProcess>>,
    // Token of the currently running server, so a reuse path can hand the same
    // URL back without restarting.
    token: Mutex<Option<String>>,
    // Held for the whole of start_jupyter_server_blocking so two concurrent
    // start calls can't both spawn on the same port (the loser would exit 1).
    startup: Mutex<()>,
}

#[cfg(not(feature = "mas"))]
struct MartinProcess {
    child: Child,
}

#[cfg(not(feature = "mas"))]
struct SidecarProcess {
    child: Child,
}

#[cfg(not(feature = "mas"))]
struct JupyterProcess {
    child: Child,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalPluginManifest {
    id: String,
    name: String,
    version: String,
    entry: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    style: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalPluginBundle {
    archive_name: String,
    manifest: ExternalPluginManifest,
    entry_source: String,
    style_source: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalPluginBundleError {
    archive_name: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalPluginBundleLoadResult {
    plugins_directories: Vec<String>,
    bundles: Vec<ExternalPluginBundle>,
    errors: Vec<ExternalPluginBundleError>,
}

#[cfg(not(feature = "mas"))]
impl SidecarProcess {
    fn terminate(&mut self) {
        terminate_sidecar_child(&mut self.child);
    }
}

#[cfg(not(feature = "mas"))]
impl Drop for MartinProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(not(feature = "mas"))]
impl Drop for SidecarProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg(not(feature = "mas"))]
impl JupyterProcess {
    fn terminate(&mut self) {
        // Same process-group teardown as the sidecar (the child is spawned with
        // its own group, so this reaps `uv`/`jupyter`/kernel descendants).
        terminate_sidecar_child(&mut self.child);
    }
}

#[cfg(not(feature = "mas"))]
impl Drop for JupyterProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_linux_webkit();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Must init after the fs plugin: it restores previously-granted fs
        // scope (e.g. Browser-panel pinned folders) so they survive a restart.
        //
        // SECURITY / SCOPE NOTE (deliberate, maintainer-approved): this persists
        // *every* dialog-granted fs scope for the life of the install, not just
        // Browser-panel folder pins — "Open Vector File", "Open Raster", "Save
        // Project As", etc. also extend fs scope to the picked path, and all of
        // those now survive a restart. There is also no per-path "forget", so
        // unpinning a folder in the Browser panel removes the UI pin but does
        // not revoke its (persisted) read scope. Accepted for durable pins;
        // revisit if a narrower per-source scope or a revoke path is wanted.
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_geolocation::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init());

    // The Earth Engine OAuth loopback listener is compiled out of the Apple App
    // Store builds (see the module gate at the top of this file); the stub
    // commands are stateless, so the state goes with it.
    #[cfg(not(any(feature = "mas", target_os = "ios")))]
    let builder = builder.manage(EarthEngineOAuthState::default());

    // The Martin/sidecar/Jupyter process managers exist only where the commands
    // that spawn those processes do; the MAS build compiles both out together.
    #[cfg(not(feature = "mas"))]
    let builder = builder
        .manage(MartinServerState {
            process: Mutex::new(None),
        })
        .manage(SidecarServerState {
            process: Mutex::new(None),
            lifecycle: Mutex::new(()),
        })
        .manage(JupyterServerState {
            process: Mutex::new(None),
            token: Mutex::new(None),
            startup: Mutex::new(()),
        });

    builder
        .invoke_handler(tauri::generate_handler![
            close_oauth_popups,
            native_duckdb::count_native_vector_file_features,
            ensure_martin_binary,
            fetch_url_bytes,
            install_external_plugin_archive,
            native_duckdb::load_native_vector_file,
            load_external_plugin_bundles,
            read_admin_profile,
            read_env_vars,
            allow_raster_asset,
            read_local_file,
            read_project_file,
            read_shapefile_siblings,
            resolve_url_redirect,
            read_mbtiles_metadata,
            read_mbtiles_tile,
            start_martin_server,
            stop_martin_server,
            start_geolibre_sidecar,
            stop_geolibre_sidecar,
            start_jupyter_server,
            stop_jupyter_server,
            start_earth_engine_oauth,
            poll_earth_engine_oauth
        ])
        .setup(|app| {
            create_main_window(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running GeoLibre Desktop");
}

/// Whether `read_project_file` may read `path`: an absolute local path (POSIX
/// `/...` or a Windows drive-letter `C:\...`, never a UNC `\\host\share`), free
/// of `..` traversal, ending in a GeoLibre project extension — `.geolibre` or
/// `.geolibre.json`. These are the canonical formats `saveProject` writes and
/// `isGeoLibreProjectPath` recognizes in `tauri-io.ts`.
///
/// Without this, the command was an arbitrary local-file reader: any webview JS
/// or loaded plugin could `invoke("read_project_file", { path: "~/.ssh/id_rsa" })`
/// and receive the contents. A bare `.json` extension is deliberately NOT
/// accepted: plenty of real secrets are JSON (GCP service-account keys,
/// `application_default_credentials.json`, editor/CLI configs with tokens), so
/// requiring the `.geolibre` marker keeps those out while still reading every
/// real project. Byte-oriented like `is_allowed_local_vector_path` so Windows
/// paths behave the same on any host.
pub(crate) fn is_allowed_project_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    let is_separator = |byte: u8| byte == b'/' || byte == b'\\';

    // Reject UNC paths ("\\server\share" and "//server/share").
    if bytes.len() >= 2 && is_separator(bytes[0]) && is_separator(bytes[1]) {
        return false;
    }

    let is_posix_absolute = bytes.first() == Some(&b'/');
    let is_windows_drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && is_separator(bytes[2]);
    if !is_posix_absolute && !is_windows_drive {
        return false;
    }

    if path.split(['/', '\\']).any(|segment| segment == "..") {
        return false;
    }

    let lower = path.to_ascii_lowercase();
    lower.ends_with(".geolibre") || lower.ends_with(".geolibre.json")
}

#[tauri::command]
fn read_project_file(path: String) -> Result<String, String> {
    if !is_allowed_project_path(&path) {
        return Err(format!(
            "Refusing to read \"{path}\": not an absolute local project file path"
        ));
    }
    // Resolve symlinks and re-check the extension, so a symlink named
    // `*.geolibre`/`*.geolibre.json` can't redirect the read to an arbitrary
    // target (e.g. `~/notes.geolibre.json -> ~/.ssh/id_rsa`). Only the resolved
    // extension is re-checked (not the full guard): `canonicalize` yields a
    // `\\?\C:\…` verbatim path on Windows, which the UNC check would reject.
    let canonical =
        fs::canonicalize(&path).map_err(|error| format!("Could not read project file: {error}"))?;
    let resolved = canonical.to_string_lossy().to_ascii_lowercase();
    if !(resolved.ends_with(".geolibre") || resolved.ends_with(".geolibre.json")) {
        return Err(format!(
            "Refusing to read \"{path}\": resolves to a non-project file"
        ));
    }
    fs::read_to_string(&canonical).map_err(|error| format!("Could not read project file: {error}"))
}

/// Local vector file extensions the restore path may re-read (lowercased, no
/// dot). Mirrors `VECTOR_FILE_DIALOG_EXTENSIONS` in `tauri-io.ts`; keep the two
/// in step.
// SYNC: VECTOR_FILE_DIALOG_EXTENSIONS in src/lib/tauri-io.ts — grep "SYNC:" to
// find the partner list and update both together.
const RESTORABLE_VECTOR_EXTENSIONS: [&str; 17] = [
    "geojson",
    "json",
    "gpkg",
    "geoparquet",
    "parquet",
    "fgb",
    "flatgeobuf",
    "csv",
    "tsv",
    "kml",
    "kmz",
    "gml",
    "gpx",
    "dxf",
    "tab",
    "shp",
    "zip",
];

/// Whether the renderer is permitted to re-read `path` through `read_local_file`:
/// an absolute local path (POSIX `/...` or a Windows drive-letter `C:\...`, never
/// a UNC `\\host\share`), free of `..` traversal segments, ending in a known
/// vector extension.
///
/// This is a Rust-side backstop mirroring the frontend guard
/// (`isAbsoluteLocalPath` + `hasPathTraversal` + `isRestorableVectorPath` in
/// `tauri-io.ts`). It narrows the attack surface of a compromised webview or
/// rogue plugin: arbitrary system files (`/etc/passwd`, SSH keys, most shell and
/// app configs) are blocked. It does not make the command harmless — the
/// allowlist still includes broad extensions like `json`, so a script that knows
/// the path of a JSON-shaped secret could still read it — but it bounds reads to
/// the vector formats the restore path actually needs. The checks are
/// byte-oriented rather than `std::path` based so they behave identically for the
/// Windows-style paths a project may carry regardless of the host the binary
/// runs on.
pub(crate) fn is_allowed_local_vector_path(path: &str) -> bool {
    // Absolute, non-UNC, no `..` traversal — split into `is_safe_absolute_path`
    // so the security-relevant byte-parsing lives in one place rather than being
    // duplicated.
    if !is_safe_absolute_path(path) {
        return false;
    }

    // Known vector extension, case-insensitive, matching the JS
    // `RESTORABLE_VECTOR_PATH` regex (built from `VECTOR_FILE_DIALOG_EXTENSIONS`).
    // `rsplit_once` takes the text after the final dot without allocating.
    let lower = path.to_ascii_lowercase();
    lower
        .rsplit_once('.')
        .is_some_and(|(_, extension)| RESTORABLE_VECTOR_EXTENSIONS.contains(&extension))
}

/// Read a local file's raw bytes so a project's file-referenced vector layers
/// can be re-read when the project is reopened.
///
/// On reopen, a layer saved as a file reference carries only its absolute
/// `sourcePath` (stored in the `.geolibre.json`); that path was never picked or
/// dropped this session, so it sits outside the `fs` plugin's runtime scope and
/// the JS `readFile`/`readTextFile` reject it. This reads the file directly,
/// mirroring `read_project_file` (which bypasses the same scope to read the
/// project file itself). The path is validated here by
/// `is_allowed_local_vector_path` (absolute, no `..` traversal, known vector
/// extension) so the command cannot be abused to read arbitrary files even if
/// the frontend guard is bypassed. Bytes are returned as a raw IPC response (an
/// `ArrayBuffer` on the JS side) so a large GeoJSON does not pay the cost of a
/// JSON number array.
#[tauri::command]
fn read_local_file(path: String) -> Result<tauri::ipc::Response, String> {
    if !is_allowed_local_vector_path(&path) {
        return Err(format!(
            "Refusing to read \"{path}\": not an absolute local vector file path"
        ));
    }
    fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|error| format!("Could not read local file: {error}"))
}

/// Add one GeoTIFF to the asset-protocol scope. The filesystem and asset scopes
/// are separate in Tauri; dialogs and native drops grant the former, but
/// maplibre-gl-raster fetches through the latter for range reads. A GeoTIFF
/// referenced by an imported project -- QGIS (`.qgs`/`.qgz`) or ArcGIS Pro
/// (`.aprx`/`.mapx`) -- is also accepted when that project file itself was
/// explicitly selected by the user.
#[tauri::command]
fn allow_raster_asset(
    app: tauri::AppHandle,
    path: String,
    import_project_path: Option<String>,
) -> Result<(), String> {
    let lower = path.to_ascii_lowercase();
    if !is_safe_absolute_path(&path) || !(lower.ends_with(".tif") || lower.ends_with(".tiff")) {
        return Err(format!(
            "Refusing to expose \"{path}\": not an absolute GeoTIFF path"
        ));
    }
    let selected_import_project = import_project_path.is_some_and(|project_path| {
        let lower = project_path.to_ascii_lowercase();
        is_safe_absolute_path(&project_path)
            && (lower.ends_with(".qgs")
                || lower.ends_with(".qgz")
                || lower.ends_with(".aprx")
                || lower.ends_with(".mapx"))
            && app.fs_scope().is_allowed(&project_path)
    });
    if !app.fs_scope().is_allowed(&path) && !selected_import_project {
        return Err(format!(
            "Refusing to expose \"{path}\": neither the file nor its imported project was selected by the user"
        ));
    }
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|error| format!("Could not authorize local raster: {error}"))
}

/// Shapefile sidecar extensions read alongside a `.shp` (lowercased, no dot).
const SHAPEFILE_SIDECAR_EXTENSIONS: [&str; 16] = [
    "shx", "dbf", "prj", "cpg", "sbn", "sbx", "qix", "qpj", "cst", "aih", "ain", "atx", "ixs",
    "mxs", "fbn", "fbx",
];

#[derive(Serialize)]
struct ShapefileSibling {
    /// `<shp base>.<lowercased sidecar extension>`, matching the `.shp` base name
    /// so GDAL resolves the sidecar when reading the `.shp` directly.
    name: String,
    data: Vec<u8>,
}

/// Read a shapefile's sidecar files (`.shx`, `.dbf`, `.prj`, `.cpg`, ...) sitting
/// next to the given `.shp`, so a loose `.shp` can be loaded without the user
/// selecting every component.
///
/// The JS `fs` plugin can only read paths the user explicitly picked or dropped,
/// so it cannot reach a sidecar that was not selected; this reads them directly.
/// It is scoped to shapefile sidecar extensions, so it cannot read arbitrary
/// files. The directory is matched case-insensitively (handling `.SHX`/`.DBF` and
/// mixed-case base names), and each sidecar is returned under the `.shp`'s base
/// name with a lowercased extension so the registered names line up. Missing
/// siblings are skipped; an unreadable directory yields an empty list.
#[tauri::command]
fn read_shapefile_siblings(path: String) -> Result<Vec<ShapefileSibling>, String> {
    let shp = Path::new(&path);
    let Some(parent) = shp.parent() else {
        return Ok(Vec::new());
    };
    let Some(stem) = shp.file_stem().and_then(|stem| stem.to_str()) else {
        return Ok(Vec::new());
    };
    let entries = match fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()),
    };
    let mut siblings = Vec::new();
    for entry in entries.flatten() {
        let entry_path = entry.path();
        if !entry_path.is_file() {
            continue;
        }
        let (Some(entry_stem), Some(extension)) = (
            entry_path.file_stem().and_then(|stem| stem.to_str()),
            entry_path
                .extension()
                .and_then(|extension| extension.to_str()),
        ) else {
            continue;
        };
        if !entry_stem.eq_ignore_ascii_case(stem) {
            continue;
        }
        let extension = extension.to_ascii_lowercase();
        if !SHAPEFILE_SIDECAR_EXTENSIONS.contains(&extension.as_str()) {
            continue;
        }
        if let Ok(data) = fs::read(&entry_path) {
            siblings.push(ShapefileSibling {
                name: format!("{stem}.{extension}"),
                data,
            });
        }
    }
    Ok(siblings)
}

/// Whether `path` is a safe absolute local path: an absolute POSIX (`/...`) or
/// Windows drive-letter (`C:\...`) path, never a UNC (`\\host\share`) share, and
/// free of `..` traversal segments. The shared absolute/non-UNC/no-traversal
/// guard behind [`is_allowed_local_vector_path`], kept separate so that
/// byte-parsing lives in one place rather than being duplicated per caller.
fn is_safe_absolute_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    let is_separator = |byte: u8| byte == b'/' || byte == b'\\';
    if bytes.len() >= 2 && is_separator(bytes[0]) && is_separator(bytes[1]) {
        return false;
    }
    let is_posix_absolute = bytes.first() == Some(&b'/');
    let is_windows_drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && is_separator(bytes[2]);
    if !is_posix_absolute && !is_windows_drive {
        return false;
    }
    !path.split(['/', '\\']).any(|segment| segment == "..")
}

/// Read the optional admin UI-profile file (`<app_config_dir>/admin-profile.json`).
///
/// Returns `Ok(None)` when the file is absent so a missing file is not an error;
/// administrators drop one in to pre-configure and optionally lock the UI profile
/// for a deployment. See `docs/ui-profiles.md`.
#[tauri::command]
fn read_admin_profile(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Could not resolve config directory: {error}"))?;
    let path = config_dir.join("admin-profile.json");
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read admin profile: {error}")),
    }
}

/// The only environment variable names `read_env_vars` will ever return. This
/// is a hard, server-side boundary: external plugins and any other JavaScript
/// run in the same (unsandboxed) webview can `invoke("read_env_vars", …)` with
/// arbitrary names, so the allowlist cannot live in the frontend alone or a
/// malicious caller could exfiltrate unrelated shell secrets (SSH_AUTH_SOCK,
/// GITHUB_TOKEN, ambient cloud credentials, …). Kept in sync with
/// `OS_ENV_VAR_NAMES` in `apps/geolibre-desktop/src/lib/assistant/provider.ts`
/// — the `assistant-os-env` test parses this list and asserts the two match.
const ALLOWED_ENV_VARS: &[&str] = &[
    "GEOLIBRE_ASSISTANT_PROVIDER",
    "GEOLIBRE_ASSISTANT_MODEL",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OLLAMA_BASE_URL",
    "OLLAMA_MODEL",
    "OPENAI_COMPATIBLE_BASE_URL",
    "OPENAI_COMPATIBLE_API_KEY",
    "OPENAI_COMPATIBLE_MODEL",
    "TAVILY_API_KEY",
];

/// Read the AI Assistant's allowlisted variables from the OS environment.
///
/// Only names in `ALLOWED_ENV_VARS` that the caller requests are returned,
/// and only when present and non-empty, so the desktop app never leaks the full
/// process environment — nor any variable outside the allowlist — into the
/// webview. This lets the assistant source provider API keys from the user's
/// system/shell environment instead of the project file (issue #1141), keeping
/// secrets out of the saved `.geolibre.json`.
#[tauri::command]
fn read_env_vars(names: Vec<String>) -> std::collections::HashMap<String, String> {
    names
        .into_iter()
        .filter(|name| ALLOWED_ENV_VARS.contains(&name.as_str()))
        .filter_map(|name| {
            let value = env::var(&name).ok()?;
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some((name, trimmed.to_string()))
            }
        })
        .collect()
}

#[tauri::command]
fn close_oauth_popups(app: tauri::AppHandle) {
    for window in app.webview_windows().values() {
        let is_oauth_popup = window.label().starts_with("oauthPopup")
            || window
                .title()
                .map(|title| {
                    title.contains("Earth Engine sign-in")
                        || title.contains("accounts.google.com")
                        || title.contains("Google")
                })
                .unwrap_or(false);
        if is_oauth_popup {
            let _ = window.close();
        }
    }
}

/// Error surfaced when a fetch would reach a blocked address.
const SSRF_BLOCKED_MESSAGE: &str =
    "Refusing to fetch a link-local, unspecified, or multicast address";

/// Path to a PEM bundle of extra CA certificate(s) to trust for server
/// verification, on top of the OS trust store (issue #1220).
const HTTP_CA_CERT_ENV: &str = "GEOLIBRE_HTTP_CA_CERT";
/// Path to the client certificate to present for mutual TLS. A `.pem` file
/// (certificate chain plus an unencrypted PKCS#8 private key) or a PKCS#12
/// bundle (`.p12`/`.pfx`, optionally passphrase-protected).
const HTTP_CLIENT_CERT_ENV: &str = "GEOLIBRE_HTTP_CLIENT_CERT";
/// Passphrase for a PKCS#12 client certificate. Its presence also forces the
/// PKCS#12 code path for a client cert that lacks a recognised extension.
const HTTP_CLIENT_CERT_PASSWORD_ENV: &str = "GEOLIBRE_HTTP_CLIENT_CERT_PASSWORD";

/// Whether an IP sits in a range a webview- or plugin-triggered fetch must not
/// reach. This is the SSRF guard for [`fetch_url_bytes`] and
/// [`resolve_url_redirect`]: those commands issue requests from the desktop
/// process's network position and hand the body/redirect back to the webview, so
/// without this a rogue plugin could read cloud metadata (169.254.169.254) — the
/// classic SSRF target — that browser `fetch` cannot reach because of CORS.
///
/// Loopback and private/LAN ranges are deliberately NOT blocked: the app is
/// built to load XYZ tiles, COGs, and PMTiles from a user's own
/// `http://localhost:<port>` or LAN dev server (issue #387), and these commands
/// are the desktop fetch path for that data. Blocking them would break a
/// documented workflow. Sensitive loopback services (the Python sidecar, the
/// Jupyter server) are individually token-gated, so the residual reachability of
/// loopback/LAN is acceptable; link-local/metadata, which has no such guard, is
/// blocked.
fn is_disallowed_ip(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            v4.is_link_local() // 169.254.0.0/16 (incl. cloud metadata)
                || v4.is_unspecified() // 0.0.0.0
                || v4.is_broadcast()
                || v4.is_multicast()
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_disallowed_ip(IpAddr::V4(mapped));
            }
            let segments = v6.segments();
            // Deprecated IPv4-compatible form `::a.b.c.d` (all-zero 96-bit
            // prefix, no `ffff` marker, and not `::`/`::1`). `to_ipv4_mapped`
            // only covers `::ffff:a.b.c.d`, so classify the embedded IPv4 here
            // too — otherwise `::169.254.169.254` would slip past the guard.
            if segments[..6].iter().all(|&s| s == 0) && !(segments[6] == 0 && segments[7] <= 1) {
                let embedded = std::net::Ipv4Addr::new(
                    (segments[6] >> 8) as u8,
                    (segments[6] & 0xff) as u8,
                    (segments[7] >> 8) as u8,
                    (segments[7] & 0xff) as u8,
                );
                return is_disallowed_ip(IpAddr::V4(embedded));
            }
            // Not handled: 6to4 (2002::/16) and Teredo (2001::/32) also embed an
            // IPv4 address, so e.g. 2002:a9fe:a9fe:: could reach 169.254.169.254.
            // These transition mechanisms are effectively defunct and unrouted on
            // modern hosts, so the practical risk is negligible; noted so this
            // isn't mistaken for full coverage of every IPv4-embedding form.
            v6.is_unspecified()
                || v6.is_multicast()
                // fe80::/10 link-local
                || (segments[0] & 0xffc0) == 0xfe80
        }
    }
}

/// Reject a parsed URL that is non-HTTP(S) or whose host resolves to a
/// private/loopback/link-local address. Hostname hosts are resolved and rejected
/// if *any* resolved address is disallowed, so a name that points at an internal
/// IP cannot slip through.
fn url_is_fetchable(url: &reqwest::Url) -> Result<(), String> {
    use std::net::ToSocketAddrs;
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("Unsupported URL scheme: {other}")),
    }
    let host = url
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?;
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        return if is_disallowed_ip(ip) {
            Err(SSRF_BLOCKED_MESSAGE.to_string())
        } else {
            Ok(())
        };
    }
    let port = url.port_or_known_default().unwrap_or(0);
    let mut resolved_any = false;
    for addr in (bare, port)
        .to_socket_addrs()
        .map_err(|error| format!("Could not resolve host {bare}: {error}"))?
    {
        resolved_any = true;
        if is_disallowed_ip(addr.ip()) {
            return Err(SSRF_BLOCKED_MESSAGE.to_string());
        }
    }
    if resolved_any {
        Ok(())
    } else {
        Err(format!("Could not resolve host {bare}"))
    }
}

/// Parse and SSRF-validate a URL string before a request is issued.
fn ensure_fetchable_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|error| format!("Invalid URL: {error}"))?;
    url_is_fetchable(&parsed)
}

/// A redirect policy that re-applies [`url_is_fetchable`] to every hop, so a
/// public URL that 3xx-redirects to an internal address is not followed.
///
/// A blocked hop fails the request via `attempt.error` rather than
/// `attempt.stop`: stopping makes reqwest hand the 30x response back as `Ok`,
/// which reaches the frontend as a bland "Request failed with status 302" that
/// [`is_ssrf_guard_error`] cannot recognise — and an unrecognised failure is
/// retried by the webview's unguarded `fetch`, which would follow the very
/// redirect this policy refused. Failing with [`SSRF_BLOCKED_MESSAGE`] in the
/// error's source chain keeps that fallback closed. The hop cap still uses
/// `stop`: an over-long but otherwise allowed chain is not an SSRF rejection
/// and must not be reported as one.
fn guarded_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 10 {
            return attempt.stop();
        }
        match url_is_fetchable(attempt.url()) {
            Ok(()) => attempt.follow(),
            Err(_) => attempt.error(SSRF_BLOCKED_MESSAGE),
        }
    })
}

/// True when a reqwest failure was caused by the SSRF guard rather than by the
/// network.
///
/// Neither guard's rejection is visible in the top-level `Display`: the redirect
/// policy's error is wrapped in reqwest's "error following redirect", and
/// [`GuardedDnsResolver`]'s is wrapped by the connector. Both keep
/// [`SSRF_BLOCKED_MESSAGE`] in the source chain, so walk it.
fn is_ssrf_guard_error(error: &dyn std::error::Error) -> bool {
    let mut current = Some(error);
    while let Some(error) = current {
        if error.to_string().contains(SSRF_BLOCKED_MESSAGE) {
            return true;
        }
        current = error.source();
    }
    false
}

/// Renders a request failure for the frontend, preserving
/// [`SSRF_BLOCKED_MESSAGE`] verbatim when the guard was what refused it.
///
/// `isBlockedUrlError` in `src/lib/vector-url-fetch.ts` matches on that wording
/// to decide whether retrying in the webview is safe, so a guard rejection that
/// reaches it as a generic transport error fails *open* into an unguarded fetch.
fn request_error_message(error: &reqwest::Error) -> String {
    if is_ssrf_guard_error(error) {
        return SSRF_BLOCKED_MESSAGE.to_string();
    }
    format!("Request failed: {error}")
}

/// A DNS resolver that drops any address in a blocked range, so reqwest connects
/// only to IPs that passed [`is_disallowed_ip`].
///
/// [`url_is_fetchable`] validates the host *before* the request, but reqwest
/// re-resolves the name when it opens the connection, so a check-then-connect
/// gap remains: an attacker controlling DNS (short TTL) could answer the
/// pre-check with a public IP and the actual connection with `169.254.169.254`.
/// Enforcing the filter inside the resolver reqwest actually uses — for the
/// initial request and every redirect hop — closes that rebinding window.
struct GuardedDnsResolver;

impl reqwest::dns::Resolve for GuardedDnsResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        use std::net::ToSocketAddrs;
        Box::pin(async move {
            let host = name.as_str().to_string();
            // std getaddrinfo blocks, but these are low-volume tile/URL fetches.
            let resolved = (host.as_str(), 0u16).to_socket_addrs();
            let addrs: Vec<std::net::SocketAddr> = match resolved {
                Ok(iter) => iter.filter(|addr| !is_disallowed_ip(addr.ip())).collect(),
                Err(error) => {
                    return Err(Box::new(error) as Box<dyn std::error::Error + Send + Sync>);
                }
            };
            if addrs.is_empty() {
                return Err(SSRF_BLOCKED_MESSAGE.into());
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// A client certificate for mutual TLS, tagged by the backend it needs.
///
/// The rustls backend (our default) reads a PEM identity directly. PKCS#12
/// bundles, which is what Windows exports and what carries a passphrase, are
/// only parseable by the native-tls backend, so those requests switch backends
/// for that one client (issue #1220).
enum ClientIdentity {
    /// PEM identity (certificate chain plus an unencrypted PKCS#8 key), rustls.
    Pem(reqwest::Identity),
    /// PKCS#12 identity, native-tls. Not available on Android, which does not
    /// ship the native-tls backend (openssl-sys has no NDK cross build).
    #[cfg(not(target_os = "android"))]
    Pkcs12(reqwest::Identity),
}

/// Whether a client certificate should be read as PKCS#12 rather than PEM.
///
/// A `.p12`/`.pfx` extension or a supplied passphrase selects PKCS#12; anything
/// else is treated as PEM.
fn client_cert_is_pkcs12(path: &std::path::Path, has_password: bool) -> bool {
    if has_password {
        return true;
    }
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("p12") | Some("pfx")
    )
}

/// A passphrase without a certificate path is a misconfiguration: the passphrase
/// alone configures nothing, so it is surfaced as an error rather than silently
/// dropped (issue #1220).
fn client_cert_password_without_path(has_cert_path: bool, has_password: bool) -> bool {
    has_password && !has_cert_path
}

/// Load extra CA certificate(s) named by [`HTTP_CA_CERT_ENV`], if any. A
/// set-but-empty value (common from `CA_CERT=${SECRET:-}` env interpolation) is
/// treated as unset rather than read as the path `""`.
fn extra_ca_certificates() -> Result<Vec<reqwest::Certificate>, String> {
    let Some(path) = env::var_os(HTTP_CA_CERT_ENV).filter(|value| !value.is_empty()) else {
        return Ok(Vec::new());
    };
    let path = PathBuf::from(path);
    let pem = fs::read(&path)
        .map_err(|error| format!("Could not read CA certificate {}: {error}", path.display()))?;
    reqwest::Certificate::from_pem_bundle(&pem)
        .map_err(|error| format!("Could not parse CA certificate {}: {error}", path.display()))
}

/// Load the mutual-TLS client identity named by [`HTTP_CLIENT_CERT_ENV`], if any.
fn client_identity() -> Result<Option<ClientIdentity>, String> {
    // Treat missing or empty as unset: env interpolation in Docker/K8s/.env
    // tooling (e.g. `PASSWORD=${SECRET:-}`) commonly yields "" rather than
    // leaving the variable unset, which must not force the PKCS#12 path or trip
    // the stray-passphrase error below. A non-UTF-8 value is surfaced as an error
    // rather than dropped, since the PKCS#12 loader takes a `&str` passphrase.
    let password = match env::var(HTTP_CLIENT_CERT_PASSWORD_ENV) {
        Ok(value) if value.is_empty() => None,
        Ok(value) => Some(value),
        Err(env::VarError::NotPresent) => None,
        Err(env::VarError::NotUnicode(_)) => {
            return Err(format!(
                "{HTTP_CLIENT_CERT_PASSWORD_ENV} is not valid UTF-8"
            ));
        }
    };
    // A set-but-empty cert path is likewise treated as unset, so it does not
    // bypass the stray-passphrase guard below or fail later on `fs::read("")`.
    let Some(path) = env::var_os(HTTP_CLIENT_CERT_ENV).filter(|value| !value.is_empty()) else {
        if client_cert_password_without_path(false, password.is_some()) {
            return Err(format!(
                "{HTTP_CLIENT_CERT_PASSWORD_ENV} is set but {HTTP_CLIENT_CERT_ENV} is not; \
                 set the client certificate path or unset the passphrase"
            ));
        }
        return Ok(None);
    };
    let path = PathBuf::from(path);
    let bytes = fs::read(&path).map_err(|error| {
        format!(
            "Could not read client certificate {}: {error}",
            path.display()
        )
    })?;
    if client_cert_is_pkcs12(&path, password.is_some()) {
        #[cfg(not(target_os = "android"))]
        {
            let identity =
                reqwest::Identity::from_pkcs12_der(&bytes, password.as_deref().unwrap_or(""))
                    .map_err(|error| {
                        format!(
                            "Could not load PKCS#12 client certificate {}: {error}",
                            path.display()
                        )
                    })?;
            Ok(Some(ClientIdentity::Pkcs12(identity)))
        }
        // Android lacks the native-tls backend that parses PKCS#12, so surface a
        // clear error rather than silently misreading the bundle as PEM.
        #[cfg(target_os = "android")]
        {
            Err(format!(
                "PKCS#12 client certificates are not supported on this platform: {}",
                path.display()
            ))
        }
    } else {
        let identity = reqwest::Identity::from_pem(&bytes).map_err(|error| {
            format!(
                "Could not load PEM client certificate {}: {error}",
                path.display()
            )
        })?;
        Ok(Some(ClientIdentity::Pem(identity)))
    }
}

/// A blocking HTTP client that enforces the SSRF guard at connect time (via
/// [`GuardedDnsResolver`]) and re-validates redirect hops.
///
/// The client trusts the OS certificate store (via the `rustls-tls-native-roots`
/// feature) so enterprise CAs work, and presents a client certificate for
/// mutual TLS when one is configured (issue #1220).
///
/// It is built once and cached: the client carries a connection pool and, when
/// mutual TLS is configured, certificate material read and parsed from disk,
/// none of which changes during a run. Callers set their own per-request
/// deadline with [`reqwest::blocking::RequestBuilder::timeout`]. reqwest's
/// blocking `Client` is `Arc`-backed, so cloning the cached instance is cheap. A
/// load error is cached too: the config is static, so re-reading a bad
/// certificate would fail identically.
fn guarded_http_client() -> Result<reqwest::blocking::Client, String> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::blocking::Client, String>> =
        std::sync::OnceLock::new();
    CLIENT.get_or_init(build_guarded_http_client).clone()
}

fn build_guarded_http_client() -> Result<reqwest::blocking::Client, String> {
    // The SSRF guard (GuardedDnsResolver + redirect re-validation) is applied
    // here, independent of the TLS backend chosen below, so it holds on both the
    // rustls and native-tls paths.
    let mut builder = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(REMOTE_TILE_CONNECT_TIMEOUT_SECS))
        .redirect(guarded_redirect_policy())
        .dns_resolver(std::sync::Arc::new(GuardedDnsResolver))
        .user_agent("GeoLibre Desktop");

    for certificate in extra_ca_certificates()? {
        builder = builder.add_root_certificate(certificate);
    }

    builder = match client_identity()? {
        // PKCS#12 identities are only understood by native-tls, which also reads
        // the OS trust store on every platform; switch this one client over.
        // (Not reachable on Android — client_identity errors out there.)
        #[cfg(not(target_os = "android"))]
        Some(ClientIdentity::Pkcs12(identity)) => builder.use_native_tls().identity(identity),
        Some(ClientIdentity::Pem(identity)) => builder.use_rustls_tls().identity(identity),
        None => builder.use_rustls_tls(),
    };

    builder
        .build()
        .map_err(|error| format!("Could not create HTTP client: {error}"))
}

/// Fetches a URL's bytes, bypassing browser CORS.
///
/// `timeout_secs` overrides the tile-sized default for callers that download a
/// whole dataset rather than a tile; it is clamped to
/// `[REMOTE_TILE_TIMEOUT_SECS, MAX_FETCH_TIMEOUT_SECS]`, so the budget can only
/// ever be raised and never removed.
#[tauri::command]
async fn fetch_url_bytes(url: String, timeout_secs: Option<u64>) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_url_bytes_blocking(url, timeout_secs))
        .await
        .map_err(|error| format!("Tile fetch task failed: {error}"))?
}

/// Resolves the request budget for a fetch, defaulting to the tile timeout and
/// clamping a caller-supplied value into `[REMOTE_TILE_TIMEOUT_SECS,
/// MAX_FETCH_TIMEOUT_SECS]`. A caller can therefore only ever raise the budget,
/// and never past the ceiling or down to zero (which reqwest reads as "no
/// timeout" and would let a stalled request hang forever).
fn resolve_fetch_timeout_secs(timeout_secs: Option<u64>) -> u64 {
    timeout_secs
        .unwrap_or(REMOTE_TILE_TIMEOUT_SECS)
        .clamp(REMOTE_TILE_TIMEOUT_SECS, MAX_FETCH_TIMEOUT_SECS)
}

fn fetch_url_bytes_blocking(url: String, timeout_secs: Option<u64>) -> Result<Vec<u8>, String> {
    ensure_fetchable_url(&url)?;

    let client = guarded_http_client()?;
    let timeout = resolve_fetch_timeout_secs(timeout_secs);

    let response = client
        .get(&url)
        .timeout(Duration::from_secs(timeout))
        .send()
        .map_err(|error| request_error_message(&error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Request failed with status {status}"));
    }

    response
        .bytes()
        .map(|bytes| bytes.to_vec())
        .map_err(|error| format!("Could not read response body: {error}"))
}

/// Install a packaged plugin from a local `.zip` archive into GeoLibre's
/// app-data `plugins/` directory so it persists across restarts and is picked up
/// by the regular plugin scan. The archive is validated first (parsing
/// `plugin.json`, enforcing the manifest rules, and confirming the entry and
/// optional style are present and within the size limit), so only a loadable
/// plugin lands in the plugins directory. Returns the installed plugin id.
#[cfg(not(feature = "mas"))]
#[tauri::command]
async fn install_external_plugin_archive(
    app: tauri::AppHandle,
    source_path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install_external_plugin_archive_blocking(&app, source_path)
    })
    .await
    .map_err(|error| format!("Plugin install task failed: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn install_external_plugin_archive_blocking(
    app: &tauri::AppHandle,
    source_path: String,
) -> Result<String, String> {
    let source = PathBuf::from(&source_path);
    if !is_zip_path(&source) {
        return Err("Plugin file must be a .zip archive".to_string());
    }

    // Validate the archive up front by loading it the same way the startup scan
    // does; this rejects a malformed manifest, a missing/oversized entry, or an
    // unsafe asset path before any file is written.
    let bundle = load_external_plugin_archive(&source, &source_path)?;
    let plugin_id = bundle.manifest.id;

    let plugins_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("plugins");
    fs::create_dir_all(&plugins_dir)
        .map_err(|error| format!("Could not create plugins directory: {error}"))?;

    let destination = plugins_dir.join(plugin_archive_file_name(&plugin_id));

    // Reinstalling from a file already inside the plugins directory (e.g. the
    // user re-selects the installed copy) would otherwise truncate the source
    // mid-copy. Treat the no-op copy as a successful install.
    let same_file = source
        .canonicalize()
        .ok()
        .zip(destination.canonicalize().ok())
        .map(|(from, to)| from == to)
        .unwrap_or(false);
    if !same_file {
        fs::copy(&source, &destination)
            .map_err(|error| format!("Could not install plugin archive: {error}"))?;
    }

    Ok(plugin_id)
}

/// Build a filesystem-safe `<id>.zip` name for an installed plugin archive.
///
/// The manifest `id` is validated for emptiness and whitespace but not for
/// filesystem safety, so any character outside `[A-Za-z0-9._-]` is replaced with
/// `_` and leading dots are stripped to keep the name from escaping the plugins
/// directory or producing a hidden file. Using the id as the file name gives a
/// reinstall natural overwrite semantics.
#[cfg(not(feature = "mas"))]
fn plugin_archive_file_name(id: &str) -> String {
    let sanitized: String = id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric()
                || character == '-'
                || character == '_'
                || character == '.'
            {
                character
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = sanitized.trim_start_matches('.');
    let safe = if trimmed.is_empty() {
        "plugin"
    } else {
        trimmed
    };
    format!("{safe}.zip")
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
async fn load_external_plugin_bundles(
    app: tauri::AppHandle,
    additional_plugin_directories: Vec<String>,
) -> Result<ExternalPluginBundleLoadResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        load_external_plugin_bundles_blocking(&app, additional_plugin_directories)
    })
    .await
    .map_err(|error| format!("External plugin scan task failed: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn load_external_plugin_bundles_blocking(
    app: &tauri::AppHandle,
    additional_plugin_directories: Vec<String>,
) -> Result<ExternalPluginBundleLoadResult, String> {
    let plugins_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("plugins");

    fs::create_dir_all(&plugins_dir)
        .map_err(|error| format!("Could not create plugins directory: {error}"))?;

    let mut plugin_dirs = Vec::new();
    let mut seen_dirs = HashSet::new();
    for directory in additional_plugin_directories {
        let directory = directory.trim();
        if directory.is_empty() {
            continue;
        }
        let path = PathBuf::from(directory);
        let key = normalize_path_key(&path);
        if seen_dirs.insert(key) {
            plugin_dirs.push(path);
        }
    }
    if seen_dirs.insert(normalize_path_key(&plugins_dir)) {
        plugin_dirs.push(plugins_dir);
    }

    let mut bundles = Vec::new();
    let mut errors = Vec::new();
    for plugin_dir in &plugin_dirs {
        scan_external_plugin_directory(plugin_dir, &mut bundles, &mut errors);
    }

    Ok(ExternalPluginBundleLoadResult {
        plugins_directories: plugin_dirs
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect(),
        bundles,
        errors,
    })
}

#[cfg(not(feature = "mas"))]
fn normalize_path_key(path: &Path) -> String {
    // Canonicalize so symlinks and case differences on case-insensitive file
    // systems (Windows, macOS) dedupe to one key; fall back to the raw path
    // when it does not exist yet.
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    canonical.to_string_lossy().replace('\\', "/")
}

#[cfg(not(feature = "mas"))]
fn scan_external_plugin_directory(
    plugin_dir: &Path,
    bundles: &mut Vec<ExternalPluginBundle>,
    errors: &mut Vec<ExternalPluginBundleError>,
) {
    if !plugin_dir.exists() {
        // User-configured development directories may not exist yet; the app
        // data plugins directory is always created before scanning. Skip
        // silently instead of warning on every startup.
        return;
    }

    if plugin_dir.join("plugin.json").is_file() {
        let bundle_name = plugin_dir.to_string_lossy().to_string();
        match load_external_plugin_directory(plugin_dir, &bundle_name) {
            Ok(bundle) => bundles.push(bundle),
            Err(message) => errors.push(ExternalPluginBundleError {
                archive_name: bundle_name,
                message,
            }),
        }
        return;
    }

    let mut entries = match fs::read_dir(plugin_dir) {
        Ok(entries) => entries.filter_map(Result::ok).collect::<Vec<_>>(),
        Err(error) => {
            errors.push(ExternalPluginBundleError {
                archive_name: plugin_dir.to_string_lossy().to_string(),
                message: format!("Could not read plugins directory: {error}"),
            });
            return;
        }
    };
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_string());

    for entry in entries {
        let path = entry.path();
        // Resolve through path metadata rather than the directory entry so
        // symlinked zips and plugin directories are followed, not skipped.
        let metadata = match path.metadata() {
            Ok(metadata) => metadata,
            Err(error) => {
                errors.push(ExternalPluginBundleError {
                    archive_name: path.to_string_lossy().to_string(),
                    message: format!("Could not inspect plugin entry: {error}"),
                });
                continue;
            }
        };

        if metadata.is_file() && is_zip_path(&path) {
            let bundle_name = path.to_string_lossy().to_string();
            match load_external_plugin_archive(&path, &bundle_name) {
                Ok(bundle) => bundles.push(bundle),
                Err(message) => errors.push(ExternalPluginBundleError {
                    archive_name: bundle_name,
                    message,
                }),
            }
        } else if metadata.is_dir() && path.join("plugin.json").is_file() {
            let bundle_name = path.to_string_lossy().to_string();
            match load_external_plugin_directory(&path, &bundle_name) {
                Ok(bundle) => bundles.push(bundle),
                Err(message) => errors.push(ExternalPluginBundleError {
                    archive_name: bundle_name,
                    message,
                }),
            }
        }
    }
}

#[cfg(not(feature = "mas"))]
fn is_zip_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
}

#[cfg(not(feature = "mas"))]
fn load_external_plugin_archive(
    path: &Path,
    archive_name: &str,
) -> Result<ExternalPluginBundle, String> {
    let file = File::open(path).map_err(|error| format!("Could not open zip: {error}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("Could not read zip: {error}"))?;
    // Tolerate a wrapping folder (`my-plugin/plugin.json`) as produced by zipping
    // a plugin directory, not just a root `plugin.json`. The entry/style paths
    // then resolve against the manifest's own directory.
    let manifest_path = find_zip_manifest_path(&archive)
        .ok_or_else(|| "Plugin archive is missing a plugin.json".to_string())?;
    let prefix = manifest_path
        .strip_suffix("plugin.json")
        .unwrap_or("")
        .to_string();
    let manifest_text = read_zip_text_entry(&mut archive, &manifest_path, "plugin manifest")?;
    let manifest: ExternalPluginManifest = serde_json::from_str(&manifest_text)
        .map_err(|error| format!("Could not parse plugin.json: {error}"))?;
    validate_external_plugin_manifest(&manifest)?;

    let entry_source = read_zip_text_entry(
        &mut archive,
        &format!("{prefix}{}", manifest.entry),
        "plugin entry",
    )?;
    let style_source = match manifest.style.as_deref() {
        Some(style) => Some(read_zip_text_entry(
            &mut archive,
            &format!("{prefix}{style}"),
            "plugin style",
        )?),
        None => None,
    };

    Ok(ExternalPluginBundle {
        archive_name: archive_name.to_string(),
        manifest,
        entry_source,
        style_source,
    })
}

/// Find plugin.json inside a zip, tolerating a single wrapping folder. Prefers a
/// root `plugin.json`, otherwise returns the shallowest `*/plugin.json`, ignoring
/// the `__MACOSX/` metadata folder macOS adds to archives. Returns the manifest's
/// full path within the archive, or None when no plugin.json is present.
#[cfg(not(feature = "mas"))]
fn find_zip_manifest_path<R: Read + std::io::Seek>(archive: &zip::ZipArchive<R>) -> Option<String> {
    let names: Vec<&str> = archive.file_names().collect();
    if names.contains(&"plugin.json") {
        return Some("plugin.json".to_string());
    }
    let mut best: Option<&str> = None;
    let mut best_depth = usize::MAX;
    for name in names {
        if name.starts_with("__MACOSX/") || !name.ends_with("/plugin.json") {
            continue;
        }
        let depth = name.matches('/').count();
        if depth < best_depth || (depth == best_depth && best.is_none_or(|b| name < b)) {
            best = Some(name);
            best_depth = depth;
        }
    }
    best.map(str::to_string)
}

#[cfg(not(feature = "mas"))]
fn load_external_plugin_directory(
    path: &Path,
    archive_name: &str,
) -> Result<ExternalPluginBundle, String> {
    let manifest_text = read_fs_text_entry(path, "plugin.json", "plugin manifest")?;
    let manifest: ExternalPluginManifest = serde_json::from_str(&manifest_text)
        .map_err(|error| format!("Could not parse plugin.json: {error}"))?;
    validate_external_plugin_manifest(&manifest)?;

    let entry_source = read_fs_text_entry(path, &manifest.entry, "plugin entry")?;
    let style_source = match manifest.style.as_deref() {
        Some(style) => Some(read_fs_text_entry(path, style, "plugin style")?),
        None => None,
    };

    Ok(ExternalPluginBundle {
        archive_name: archive_name.to_string(),
        manifest,
        entry_source,
        style_source,
    })
}

#[cfg(not(feature = "mas"))]
fn read_fs_text_entry(root: &Path, entry_name: &str, label: &str) -> Result<String, String> {
    let entry_path = root.join(entry_name);
    if !entry_path.is_file() {
        return Err(format!(
            "Could not read {label} '{entry_name}': file does not exist"
        ));
    }

    let file = File::open(&entry_path)
        .map_err(|error| format!("Could not read {label} '{entry_name}': {error}"))?;
    let mut text = String::new();
    file.take(MAX_PLUGIN_ENTRY_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|error| format!("Could not read {label} '{entry_name}' as UTF-8: {error}"))?;
    if text.len() as u64 > MAX_PLUGIN_ENTRY_BYTES {
        return Err(format!(
            "{label} '{entry_name}' exceeds the {}-MB size limit",
            MAX_PLUGIN_ENTRY_BYTES / (1024 * 1024)
        ));
    }
    Ok(text)
}

#[cfg(not(feature = "mas"))]
const MAX_PLUGIN_ENTRY_BYTES: u64 = 50 * 1024 * 1024;

#[cfg(not(feature = "mas"))]
fn read_zip_text_entry<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    entry_name: &str,
    label: &str,
) -> Result<String, String> {
    let entry = archive
        .by_name(entry_name)
        .map_err(|error| format!("Could not read {label} '{entry_name}': {error}"))?;
    if entry.is_dir() {
        return Err(format!("{label} '{entry_name}' must be a file"));
    }

    // Cap the actual bytes read instead of trusting the zip header size,
    // which a hand-crafted archive can spoof.
    let mut text = String::new();
    entry
        .take(MAX_PLUGIN_ENTRY_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|error| format!("Could not read {label} '{entry_name}' as UTF-8: {error}"))?;
    if text.len() as u64 > MAX_PLUGIN_ENTRY_BYTES {
        return Err(format!(
            "{label} '{entry_name}' exceeds the {}-MB size limit",
            MAX_PLUGIN_ENTRY_BYTES / (1024 * 1024)
        ));
    }
    Ok(text)
}

#[cfg(not(feature = "mas"))]
fn validate_external_plugin_manifest(manifest: &ExternalPluginManifest) -> Result<(), String> {
    validate_required_manifest_string("id", &manifest.id)?;
    validate_required_manifest_string("name", &manifest.name)?;
    validate_required_manifest_string("version", &manifest.version)?;
    validate_required_manifest_string("entry", &manifest.entry)?;
    validate_external_plugin_path("entry", &manifest.entry)?;
    if !manifest.entry.ends_with(".js") && !manifest.entry.ends_with(".mjs") {
        return Err("entry must point to a .js or .mjs file".to_string());
    }

    if let Some(description) = manifest.description.as_deref() {
        validate_optional_manifest_string("description", description)?;
    }
    if let Some(style) = manifest.style.as_deref() {
        validate_optional_manifest_string("style", style)?;
        validate_external_plugin_path("style", style)?;
        if !style.ends_with(".css") {
            return Err("style must point to a .css file".to_string());
        }
    }

    Ok(())
}

#[cfg(not(feature = "mas"))]
fn validate_required_manifest_string(field: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if value.trim() != value {
        return Err(format!(
            "{field} must not have leading or trailing whitespace"
        ));
    }
    Ok(())
}

#[cfg(not(feature = "mas"))]
fn validate_optional_manifest_string(field: &str, value: &str) -> Result<(), String> {
    if value.trim() != value {
        return Err(format!(
            "{field} must not have leading or trailing whitespace"
        ));
    }
    Ok(())
}

#[cfg(not(feature = "mas"))]
fn validate_external_plugin_path(field: &str, value: &str) -> Result<(), String> {
    if value.starts_with('/') {
        return Err(format!("{field} must be a relative path"));
    }
    if value.contains('\\') {
        return Err(format!("{field} must use forward slashes"));
    }
    if value.contains(':') {
        return Err(format!(
            "{field} must not contain drive letters or ':' characters"
        ));
    }
    if value
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(format!(
            "{field} must not contain empty, '.', or '..' segments"
        ));
    }
    Ok(())
}

#[tauri::command]
async fn resolve_url_redirect(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_url_redirect_blocking(url))
        .await
        .map_err(|error| format!("URL resolve task failed: {error}"))?
}

fn resolve_url_redirect_blocking(url: String) -> Result<String, String> {
    ensure_fetchable_url(&url)?;

    let client = guarded_http_client()?;
    let timeout = Duration::from_secs(URL_RESOLVE_TIMEOUT_SECS);

    if let Ok(head_response) = client.head(&url).timeout(timeout).send() {
        if has_xyz_placeholders(head_response.url().as_str()) {
            return Ok(head_response.url().to_string());
        }
    }

    let response = client
        .get(&url)
        .header("accept", "application/json, text/plain;q=0.9, */*;q=0.8")
        .timeout(timeout)
        .send()
        .map_err(|error| request_error_message(&error))?;
    if has_xyz_placeholders(response.url().as_str()) {
        return Ok(response.url().to_string());
    }

    let body = response
        .text()
        .map_err(|error| format!("Could not read response body: {error}"))?;

    resolved_url_from_body(&body).ok_or_else(|| "Could not resolve URL".to_string())
}

fn has_xyz_placeholders(url: &str) -> bool {
    let normalized = url.to_ascii_lowercase();
    (normalized.contains("{z}") || normalized.contains("%7bz%7d"))
        && (normalized.contains("{x}") || normalized.contains("%7bx%7d"))
        && (normalized.contains("{y}") || normalized.contains("%7by%7d"))
}

fn resolved_url_from_body(body: &str) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.starts_with("https://") || trimmed.starts_with("http://") {
        return Some(trimmed.to_string());
    }

    let value: Value = serde_json::from_str(trimmed).ok()?;
    resolved_url_from_json(&value)
}

fn resolved_url_from_json(value: &Value) -> Option<String> {
    if let Some(url) = value.as_str() {
        return http_url(url);
    }

    let object = value.as_object()?;
    for key in ["url", "tileUrl", "tile_url"] {
        if let Some(url) = object.get(key).and_then(Value::as_str).and_then(http_url) {
            return Some(url);
        }
    }

    object
        .get("tiles")
        .and_then(Value::as_array)
        .and_then(|tiles| tiles.first())
        .and_then(Value::as_str)
        .and_then(http_url)
}

fn http_url(url: &str) -> Option<String> {
    if url.starts_with("https://") || url.starts_with("http://") {
        Some(url.to_string())
    } else {
        None
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MartinBinaryInfo {
    path: String,
    downloaded: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MartinServerInfo {
    base_url: String,
    binary_path: String,
    port: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarServerInfo {
    base_url: String,
    port: u16,
    /// Per-launch bearer token the frontend must send on every sidecar request
    /// (see [`sidecar_token`]).
    token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JupyterServerInfo {
    url: String,
    port: u16,
    token: String,
}

// Mac App Store stubs. The App Sandbox forbids spawning downloaded executables
// and guideline 2.5.2 forbids downloading executable code, so the `mas` feature
// compiles out everything that does either: the Python sidecar, the Jupyter
// server, the Martin tile server, the managed uv install, and external plugin
// installation. Each stub keeps the real command's name, signature, and Ok type
// so the generate_handler! list and the frontend's invoke calls are unchanged;
// they fail with a clear message instead. DuckDB-WASM processing and the
// plugins bundled into the app are unaffected.
#[cfg(feature = "mas")]
#[tauri::command]
fn ensure_martin_binary(_app: tauri::AppHandle) -> Result<MartinBinaryInfo, String> {
    Err("The Martin tile server is not available in the Mac App Store build.".to_string())
}

#[cfg(feature = "mas")]
#[tauri::command]
async fn start_martin_server(
    _app: tauri::AppHandle,
    _connection_string: String,
    _default_srid: Option<String>,
) -> Result<MartinServerInfo, String> {
    Err("The Martin tile server is not available in the Mac App Store build.".to_string())
}

// The real command borrows tauri::State<MartinServerState>, but that state is
// neither defined nor managed in this build, so the stub takes no argument (the
// frontend passes none; state is injected server-side).
#[cfg(feature = "mas")]
#[tauri::command]
fn stop_martin_server() -> Result<(), String> {
    Err("The Martin tile server is not available in the Mac App Store build.".to_string())
}

#[cfg(feature = "mas")]
#[tauri::command]
async fn start_geolibre_sidecar(_app: tauri::AppHandle) -> Result<SidecarServerInfo, String> {
    Err("The GeoLibre processing server is not available in the Mac App Store build.".to_string())
}

#[cfg(feature = "mas")]
#[tauri::command]
async fn stop_geolibre_sidecar(_app: tauri::AppHandle) -> Result<(), String> {
    Err("The GeoLibre processing server is not available in the Mac App Store build.".to_string())
}

#[cfg(feature = "mas")]
#[tauri::command]
async fn start_jupyter_server(_app: tauri::AppHandle) -> Result<JupyterServerInfo, String> {
    Err("The Jupyter notebook server is not available in the Mac App Store build.".to_string())
}

#[cfg(feature = "mas")]
#[tauri::command]
async fn stop_jupyter_server(_app: tauri::AppHandle) -> Result<(), String> {
    Err("The Jupyter notebook server is not available in the Mac App Store build.".to_string())
}

#[cfg(feature = "mas")]
#[tauri::command]
async fn install_external_plugin_archive(
    _app: tauri::AppHandle,
    _source_path: String,
) -> Result<String, String> {
    Err("External plugin installation is not available in the Mac App Store build.".to_string())
}

// Succeeds with an empty scan rather than erroring, so the startup plugin load
// degrades silently instead of surfacing a failure on every launch.
#[cfg(feature = "mas")]
#[tauri::command]
async fn load_external_plugin_bundles(
    _app: tauri::AppHandle,
    _additional_plugin_directories: Vec<String>,
) -> Result<ExternalPluginBundleLoadResult, String> {
    Ok(ExternalPluginBundleLoadResult {
        plugins_directories: Vec::new(),
        bundles: Vec::new(),
        errors: Vec::new(),
    })
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
fn ensure_martin_binary(app: tauri::AppHandle) -> Result<MartinBinaryInfo, String> {
    ensure_martin_binary_path(&app)
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
async fn start_martin_server(
    app: tauri::AppHandle,
    connection_string: String,
    default_srid: Option<String>,
) -> Result<MartinServerInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        start_martin_server_blocking(app, connection_string, default_srid)
    })
    .await
    .map_err(|error| format!("Could not join Martin startup task: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn start_martin_server_blocking(
    app: tauri::AppHandle,
    connection_string: String,
    default_srid: Option<String>,
) -> Result<MartinServerInfo, String> {
    if connection_string.trim().is_empty() {
        return Err("Enter a PostgreSQL connection string.".to_string());
    }

    let binary = ensure_martin_binary_path(&app)?;
    let state = app.state::<MartinServerState>();
    {
        let process = state
            .process
            .lock()
            .map_err(|_| "Could not lock Martin process state.".to_string())?;
        if process.is_some() {
            return Err(
                "A Martin server is already running. Stop it before starting a new one."
                    .to_string(),
            );
        }
    }

    let mut last_error = "Could not start Martin.".to_string();
    for _ in 0..MARTIN_START_ATTEMPTS {
        match spawn_martin_server(
            &binary.path,
            connection_string.trim(),
            default_srid.as_deref(),
        ) {
            Ok(info) => {
                let mut process = state
                    .process
                    .lock()
                    .map_err(|_| "Could not lock Martin process state.".to_string())?;
                if process.is_some() {
                    drop(info.process);
                    return Err(
                        "A Martin server is already running. Stop it before starting a new one."
                            .to_string(),
                    );
                }
                *process = Some(info.process);
                return Ok(MartinServerInfo {
                    base_url: info.base_url,
                    binary_path: binary.path,
                    port: info.port,
                });
            }
            Err(error) => {
                last_error = error;
            }
        }
    }

    Err(last_error)
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
fn stop_martin_server(state: tauri::State<MartinServerState>) -> Result<(), String> {
    let mut process = state
        .process
        .lock()
        .map_err(|_| "Could not lock Martin process state.".to_string())?;
    *process = None;
    Ok(())
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
async fn start_geolibre_sidecar(app: tauri::AppHandle) -> Result<SidecarServerInfo, String> {
    tauri::async_runtime::spawn_blocking(move || start_geolibre_sidecar_blocking(app))
        .await
        .map_err(|error| format!("Could not join sidecar startup task: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn add_main_sidecar_extras(command: &mut Command) {
    command
        .arg("--extra")
        .arg("ml")
        .arg("--extra")
        .arg("postgis");
}

#[cfg(not(feature = "mas"))]
fn start_geolibre_sidecar_blocking(app: tauri::AppHandle) -> Result<SidecarServerInfo, String> {
    let base_url = sidecar_base_url();
    let state = app.state::<SidecarServerState>();
    let _lifecycle = state
        .lifecycle
        .lock()
        .map_err(|_| "Could not lock sidecar lifecycle.".to_string())?;
    {
        let mut process = state
            .process
            .lock()
            .map_err(|_| "Could not lock sidecar process state.".to_string())?;
        if let Some(sidecar) = process.as_mut() {
            if sidecar
                .child
                .try_wait()
                .map_err(|error| format!("Could not inspect sidecar process: {error}"))?
                .is_none()
            {
                return Ok(SidecarServerInfo {
                    base_url,
                    port: SIDECAR_PORT,
                    token: sidecar_token().to_string(),
                });
            }
            *process = None;
        }
    }

    if sidecar_health_is_ready(&base_url) {
        if sidecar_accepts_token(&base_url, sidecar_token()) {
            return Ok(SidecarServerInfo {
                base_url,
                port: SIDECAR_PORT,
                token: sidecar_token().to_string(),
            });
        }
        // A sidecar is listening but rejects this session's token — usually an
        // orphan from a previous app launch. Reclaim it when the OS-specific
        // listener inspection can prove it is one of our sidecars. The process
        // identity guard prevents terminating an unrelated service that happens
        // to use the same port.
        terminate_sidecar_listeners_on_port(SIDECAR_PORT)?;
        // Bind-testing the port is the authoritative check that the reclaim
        // worked: a listener we could not terminate may also have stopped
        // answering /health, and falling through to spawn would then surface as
        // an opaque uvicorn "address already in use" instead of this message.
        if !wait_for_port_free(SIDECAR_PORT) {
            return Err(
                "A GeoLibre processing server from a previous session is still \
                 running on port 8765 but does not accept this session's token. \
                 Quit any stray GeoLibre processes and try again."
                    .to_string(),
            );
        }
    }

    let uv = ensure_managed_uv(&app)?;
    let project_dir = sidecar_project_dir(&app)?;
    let runtime_dir = app_runtime_dir(&app)?;
    // A value already in the environment wins, so a desktop user who does want
    // the allowlist can narrow it by launching the app with it set.
    let postgis_hosts = env::var(POSTGIS_HOSTS_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| POSTGIS_HOSTS_DESKTOP_DEFAULT.to_string());

    let mut command = Command::new(&uv);
    command
        .arg("run")
        // Read the bundled uv.lock as-is: never re-lock, never write to the
        // project directory. See the same flag in start_jupyter_server_blocking.
        .arg("--frozen")
        .arg("--project")
        .arg(&project_dir);
    // The main sidecar serves both the AI segmentation proxy and editable
    // PostGIS layers. Unlike whitebox/conversion (separate managed venvs),
    // neither feature has a lazy bootstrap, so both extras must be synced into
    // the sidecar environment here.
    add_main_sidecar_extras(&mut command);
    command
        .arg("uvicorn")
        .arg("geolibre_server.app.main:app")
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(SIDECAR_PORT.to_string())
        .current_dir(&project_dir)
        .env("GEOLIBRE_UV", &uv)
        .env("GEOLIBRE_SIDECAR_TOKEN", sidecar_token())
        .env("GEOLIBRE_RUNTIME_DIR", &runtime_dir)
        .env(POSTGIS_HOSTS_ENV, &postgis_hosts)
        .env("UV_CACHE_DIR", runtime_dir.join("uv-cache"))
        .env("UV_PYTHON_INSTALL_DIR", runtime_dir.join("uv-python"))
        .env("UV_PROJECT_ENVIRONMENT", runtime_dir.join("sidecar-server"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_sidecar_process(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start GeoLibre sidecar: {error}"))?;
    // Drain both pipes from the moment we spawn. Reading them only after the
    // child exits (the old shape) deadlocks a cold-cache `uv sync`, whose
    // per-package output overflows the 64 KB pipe long before uvicorn can bind:
    // the child blocks on write, never becomes ready, and the failure surfaces
    // as a bare timeout with no output to explain it.
    let output = CapturedOutput::attach(&mut child);

    if let Err(error) = wait_for_sidecar_health(&base_url, &mut child, &output) {
        terminate_sidecar_child(&mut child);
        return Err(error);
    }

    let mut process = state
        .process
        .lock()
        .map_err(|_| "Could not lock sidecar process state.".to_string())?;
    if process.is_some() {
        let mut duplicate = SidecarProcess { child };
        duplicate.terminate();
    } else {
        *process = Some(SidecarProcess { child });
    }

    Ok(SidecarServerInfo {
        base_url,
        port: SIDECAR_PORT,
        token: sidecar_token().to_string(),
    })
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
async fn stop_geolibre_sidecar(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_geolibre_sidecar_blocking(app))
        .await
        .map_err(|error| format!("Could not join sidecar stop task: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn stop_geolibre_sidecar_blocking(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<SidecarServerState>();
    let _lifecycle = state
        .lifecycle
        .lock()
        .map_err(|_| "Could not lock sidecar lifecycle.".to_string())?;
    {
        let mut process = state
            .process
            .lock()
            .map_err(|_| "Could not lock sidecar process state.".to_string())?;
        // SidecarProcess::Drop calls terminate() automatically, so taking the
        // value out is enough to tear down the child. Calling terminate() here
        // as well would double-signal the (possibly recycled) process group.
        let taken = process.take();
        drop(process); // release the MutexGuard before the 250 ms SIGTERM grace
        drop(taken); // terminate() runs here, outside the lock
    }

    let base_url = sidecar_base_url();
    if sidecar_health_is_ready(&base_url) {
        request_sidecar_shutdown(&base_url);
        wait_for_sidecar_stop(&base_url);
    }
    if sidecar_health_is_ready(&base_url) {
        terminate_sidecar_listeners_on_port(SIDECAR_PORT)?;
        wait_for_sidecar_stop(&base_url);
    }
    if sidecar_health_is_ready(&base_url) {
        return Err(format!(
            "GeoLibre sidecar is still running on port {SIDECAR_PORT}."
        ));
    }
    Ok(())
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
async fn start_jupyter_server(app: tauri::AppHandle) -> Result<JupyterServerInfo, String> {
    tauri::async_runtime::spawn_blocking(move || start_jupyter_server_blocking(app))
        .await
        .map_err(|error| format!("Could not join Jupyter startup task: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn start_jupyter_server_blocking(app: tauri::AppHandle) -> Result<JupyterServerInfo, String> {
    let state = app.state::<JupyterServerState>();
    // Serialize the whole startup. Concurrent calls (e.g. React StrictMode
    // double-invoking the Notebook panel's mount effect in dev) would otherwise
    // both pass the reuse check below and both spawn on JUPYTER_PORT; with
    // `--port-retries=0` the loser fails to bind and exits 1. The second caller
    // blocks here, then finds the live process in the reuse check and returns it.
    let _startup = state
        .startup
        .lock()
        .map_err(|_| "Could not lock Jupyter startup.".to_string())?;
    // Reuse an already-running server: hand back the same URL + token.
    {
        let mut process = state
            .process
            .lock()
            .map_err(|_| "Could not lock Jupyter process state.".to_string())?;
        if let Some(server) = process.as_mut() {
            if server
                .child
                .try_wait()
                .map_err(|error| format!("Could not inspect Jupyter process: {error}"))?
                .is_none()
            {
                let token = state
                    .token
                    .lock()
                    .map_err(|_| "Could not lock Jupyter token.".to_string())?
                    .clone()
                    .unwrap_or_default();
                return Ok(JupyterServerInfo {
                    url: jupyter_base_url(),
                    port: JUPYTER_PORT,
                    token,
                });
            }
            *process = None;
        }
    }

    let runtime_dir = app_runtime_dir(&app)?;

    // A Jupyter server from a previous app session may still hold the port. We
    // can't reuse it (its per-launch token is unknown to us), and because we
    // spawn with `--ServerApp.port_retries=0`, a new server would fail to bind
    // and exit 1 ("exited before it was ready") while the orphan lingers. Clear
    // any stale listener and wait for the port to free before spawning.
    let _ = terminate_jupyter_listeners_on_port(JUPYTER_PORT, &runtime_dir);
    // Best-effort here: if the port never frees, the spawn below fails with
    // Jupyter's own bind error, which is already reported to the user.
    let _ = wait_for_port_free(JUPYTER_PORT);

    let uv = ensure_managed_uv(&app)?;
    let project_dir = sidecar_project_dir(&app)?;
    let config_path = project_dir.join("jupyter_server_config.py");
    // Notebooks are saved here (the JupyterLab file browser root). Jupyter is
    // launched with `--ServerApp.root_dir` pointing at this directory and
    // refuses to start when it is missing, so a creation failure has to surface
    // here. Swallowing it reached the user several steps later as an opaque
    // "Bad config encountered during initialization: No such directory"
    // (issue #1642).
    let notebooks_dir = runtime_dir.join("notebooks");
    fs::create_dir_all(&notebooks_dir).map_err(|error| {
        format!(
            "Could not create the notebooks directory {}: {error}",
            notebooks_dir.display()
        )
    })?;
    // Seed the starter Welcome notebook (the same one bundled into JupyterLite on
    // web) on first run only, so we never clobber a user's edits.
    let welcome_dest = notebooks_dir.join("Welcome.ipynb");
    if !welcome_dest.exists() {
        let _ = fs::copy(
            project_dir.join("notebook_examples").join("Welcome.ipynb"),
            &welcome_dest,
        );
    }
    // Make the kernel-side `geolibre` client importable from any notebook: copy
    // it out of the bundled backend resource into a dedicated lib dir placed on
    // the kernel's PYTHONPATH (so `import geolibre` works regardless of where the
    // notebook lives).
    // Not fatal, unlike the notebooks root: Jupyter starts fine without this
    // one, and losing it only costs `import geolibre` inside the notebooks. So
    // report it rather than failing the whole panel -- but do report it, since
    // silently discarding the result is what made #1642 so hard to read.
    let lib_dir = runtime_dir.join("notebook-lib");
    if let Err(error) = fs::create_dir_all(&lib_dir) {
        eprintln!(
            "Jupyter: could not create the notebook library directory {} ({error}); \
             `import geolibre` will not resolve in notebooks.",
            lib_dir.display()
        );
    }
    let _ = fs::copy(
        project_dir.join("notebook_client.py"),
        lib_dir.join("geolibre.py"),
    );
    let token = generate_jupyter_token();

    let mut command = Command::new(&uv);
    command
        .arg("run")
        // Read the bundled uv.lock as-is. Without this uv re-locks whenever it
        // thinks the lock is stale and WRITES uv.lock back into the project
        // directory — which in an installed build is the read-only resource dir
        // (C:\Program Files\..., /usr/lib/GeoLibre Desktop/...). That write fails
        // with "Permission denied" and uv exits 2, which reached the user as the
        // opaque "Jupyter server exited before it was ready (exit code: 2)".
        // `--frozen` also keeps a released build pinned to the versions it was
        // tested against instead of re-resolving against live PyPI per machine.
        .arg("--frozen")
        .arg("--project")
        .arg(&project_dir)
        // The `notebook` extra carries JupyterLab. Synced into a dedicated
        // project environment so it never disturbs the FastAPI sidecar's env
        // (which syncs the `ml` extra).
        .arg("--extra")
        .arg("notebook")
        .arg("jupyter")
        .arg("lab")
        .arg("--no-browser")
        .arg(format!("--config={}", config_path.display()))
        .arg("--ServerApp.ip=127.0.0.1")
        .arg(format!("--ServerApp.port={JUPYTER_PORT}"))
        // Fail fast instead of hopping to another port we'd never discover.
        .arg("--ServerApp.port_retries=0")
        .arg(format!("--ServerApp.root_dir={}", notebooks_dir.display()))
        .arg(format!("--IdentityProvider.token={token}"))
        .current_dir(&project_dir)
        .env("GEOLIBRE_UV", &uv)
        .env("GEOLIBRE_RUNTIME_DIR", &runtime_dir)
        .env("UV_CACHE_DIR", runtime_dir.join("uv-cache"))
        .env("UV_PYTHON_INSTALL_DIR", runtime_dir.join("uv-python"))
        .env("UV_PROJECT_ENVIRONMENT", runtime_dir.join("jupyter-server"))
        // Prepend the bundled `geolibre` client to the kernel import path,
        // preserving any inherited PYTHONPATH rather than replacing it.
        .env("PYTHONPATH", prepend_pythonpath(&lib_dir))
        .stdin(Stdio::null())
        // Pipe (don't inherit) stdout/stderr, and drain both on background
        // threads via CapturedOutput. Inheriting used to be the only way to keep
        // a chatty child — `uv sync` of JupyterLab plus JupyterLab's own startup
        // write a lot — from filling an undrained 64 KB pipe and blocking before
        // it could become ready. But release builds are GUI-subsystem
        // (`windows_subsystem = "windows"`), and a desktop-launched app on Linux
        // has no terminal either, so inherited output went nowhere and a startup
        // failure surfaced as a bare exit status with no way to find the cause.
        // Draining keeps the child unblocked, tees the log to the parent's stdio
        // for dev terminals, and keeps the tail so the error can quote it.
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_sidecar_process(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start Jupyter server: {error}"))?;
    let output = CapturedOutput::attach(&mut child);

    let base_url = jupyter_base_url();
    if let Err(error) = wait_for_jupyter_health(&base_url, &token, &mut child, &output) {
        terminate_sidecar_child(&mut child);
        return Err(error);
    }

    // We hold the startup lock, so no concurrent start could have stored a
    // process; record ours as the live server.
    *state
        .process
        .lock()
        .map_err(|_| "Could not lock Jupyter process state.".to_string())? =
        Some(JupyterProcess { child });
    *state
        .token
        .lock()
        .map_err(|_| "Could not lock Jupyter token.".to_string())? = Some(token.clone());

    Ok(JupyterServerInfo {
        url: base_url,
        port: JUPYTER_PORT,
        token,
    })
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
async fn stop_jupyter_server(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_jupyter_server_blocking(app))
        .await
        .map_err(|error| format!("Could not join Jupyter stop task: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn stop_jupyter_server_blocking(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<JupyterServerState>();
    {
        let mut process = state
            .process
            .lock()
            .map_err(|_| "Could not lock Jupyter process state.".to_string())?;
        // JupyterProcess::Drop terminates the child's process group; taking the
        // value out is enough (see stop_geolibre_sidecar_blocking).
        let taken = process.take();
        drop(process);
        drop(taken);
    }
    if let Ok(mut token) = state.token.lock() {
        *token = None;
    }
    // Backstop: reap anything still bound to the port (no-op when nothing of
    // ours is listening). Best-effort, because the child this call exists to
    // clean up after is already gone by now: returning an error here would
    // leave the frontend believing the server it just stopped is still running
    // (stopJupyterServer only clears its state once this invoke resolves).
    // Best-effort, but not silent: skipping the backstop is what a later
    // "stale Jupyter still holding the port" report would trace back to.
    match app_runtime_dir(&app) {
        Ok(runtime_dir) => {
            let _ = terminate_jupyter_listeners_on_port(JUPYTER_PORT, &runtime_dir);
        }
        Err(error) => eprintln!("Jupyter: skipping the port {JUPYTER_PORT} backstop ({error})."),
    }
    Ok(())
}

/// Directory holding everything the app installs at runtime (the managed uv, its
/// caches and project environments, and the notebook root). Lives under the
/// per-user app data directory, so nothing outside it belongs to us.
#[cfg(not(feature = "mas"))]
fn app_runtime_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("runtime"))
}

#[cfg(not(feature = "mas"))]
fn jupyter_base_url() -> String {
    format!("http://127.0.0.1:{JUPYTER_PORT}")
}

// Wait (briefly) until `port` can be bound, i.e. a just-terminated listener has
// fully released it. Binding then dropping leaves a small race window, but it is
// enough to avoid a `--port-retries=0` bind failure right after killing an orphan.
// Returns whether the port actually came free within the timeout, so a caller
// that can report a better error than the failed spawn is able to bail out.
#[cfg(not(feature = "mas"))]
fn wait_for_port_free(port: u16) -> bool {
    for _ in 0..20 {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

// Prepend `dir` to any inherited PYTHONPATH (platform separator), so a user's
// existing value is preserved rather than clobbered. The inherited value is
// taken *after* AppImage sanitation, so the AppDir entry AppRun injects is not
// carried into the child (see appdir_free_path_var).
#[cfg(not(feature = "mas"))]
fn prepend_pythonpath(dir: &Path) -> String {
    let dir = dir.display().to_string();
    match appdir_free_path_var("PYTHONPATH") {
        Some(existing) if !existing.is_empty() => {
            let sep = if cfg!(windows) { ";" } else { ":" };
            format!("{dir}{sep}{existing}")
        }
        _ => dir,
    }
}

#[cfg(not(feature = "mas"))]
fn jupyter_health_is_ready(
    client: &reqwest::blocking::Client,
    base_url: &str,
    token: &str,
) -> bool {
    client
        .get(format!("{base_url}/api/status"))
        .header("Authorization", format!("token {token}"))
        .send()
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

#[cfg(not(feature = "mas"))]
fn wait_for_jupyter_health(
    base_url: &str,
    token: &str,
    child: &mut Child,
    output: &CapturedOutput,
) -> Result<(), String> {
    // Build the HTTP client once and reuse it across all health polls (this loop
    // runs up to JUPYTER_HEALTH_ATTEMPTS = 240 times).
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
        .map_err(|error| format!("Could not build HTTP client: {error}"))?;
    for _ in 0..JUPYTER_HEALTH_ATTEMPTS {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not inspect Jupyter process: {error}"))?
        {
            return Err(child_failure_message(
                &format!("Jupyter server exited before it was ready (exit status: {status})."),
                output,
            ));
        }

        if jupyter_health_is_ready(&client, base_url, token) {
            return Ok(());
        }

        thread::sleep(Duration::from_secs(1));
    }

    Err(child_failure_message(
        "Jupyter server did not become ready in time.",
        output,
    ))
}

// Append the tail of a managed child's output to a failure summary. That output
// is the only thing that identifies *why* startup failed (a uv resolution error,
// a missing `jupyter` executable, a port conflict...), and in an installed build
// there is no terminal to read it from, so it has to travel with the error.
// Shared by the Jupyter and sidecar waiters, and by both of their failure paths
// (early exit and timeout), so no path can quietly drop the one useful detail.
#[cfg(not(feature = "mas"))]
fn child_failure_message(summary: &str, output: &CapturedOutput) -> String {
    // The child may have only just exited, with its last lines still in flight.
    output.settle();
    let tail = output.tail();
    if tail.is_empty() {
        format!("{summary} It produced no output.")
    } else {
        format!("{summary}\n\nLast output:\n{tail}")
    }
}

// A loopback-bound, per-launch token for the desktop Jupyter server. It is the
// only barrier once the XSRF check is disabled for the embedded iframe (see
// jupyter_server_config.py), so use the OS CSPRNG (128 random bits) rather than
// anything derived from the clock/pid.
#[cfg(not(feature = "mas"))]
fn generate_jupyter_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("OS CSPRNG (getrandom) unavailable");
    let mut token = String::with_capacity(32);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(token, "{byte:02x}");
    }
    token
}

#[cfg(not(feature = "mas"))]
fn sidecar_base_url() -> String {
    format!("http://127.0.0.1:{SIDECAR_PORT}")
}

/// A per-launch shared secret the frontend must present on every sidecar
/// request. The sidecar binds loopback and is CORS-restricted, but neither stops
/// a cross-origin simple POST (CSRF) or a DNS-rebinding read; this token does.
///
/// Generated once per desktop process (128 CSPRNG bits) and reused for the
/// process lifetime so the early-return paths of `start_geolibre_sidecar` (when
/// the sidecar is already running) hand back the same token that was injected
/// via `GEOLIBRE_SIDECAR_TOKEN` at spawn time. A sidecar started outside this
/// process (e.g. a `python -m` dev run) leaves the env var unset and simply does
/// not enforce the token, so those flows keep working.
#[cfg(not(feature = "mas"))]
fn sidecar_token() -> &'static str {
    static TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TOKEN.get_or_init(generate_jupyter_token)
}

#[cfg(not(feature = "mas"))]
fn sidecar_health_is_ready(base_url: &str) -> bool {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(500))
        .build();
    let Ok(client) = client else {
        return false;
    };
    client
        .get(format!("{base_url}/health"))
        .send()
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

/// Whether the sidecar already listening at `base_url` accepts `token`.
///
/// `/health` is token-exempt, so it cannot reveal a token mismatch. This probes
/// `/algorithms` (a cheap authenticated endpoint) *with* the token so an orphan
/// sidecar from a previous launch — started with a different per-launch token,
/// and not killed because `Drop` doesn't run on `SIGKILL` — is detected rather
/// than silently 401ing every later request. A tokenless dev sidecar
/// (`GEOLIBRE_SIDECAR_TOKEN` unset) accepts any header and returns 200, so it is
/// still reused.
#[cfg(not(feature = "mas"))]
fn sidecar_accepts_token(base_url: &str, token: &str) -> bool {
    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
    else {
        return false;
    };
    client
        .get(format!("{base_url}/algorithms"))
        .header("x-geolibre-token", token)
        .send()
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

#[cfg(not(feature = "mas"))]
fn request_sidecar_shutdown(base_url: &str) {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(500))
        .build();
    if let Ok(client) = client {
        // /shutdown is token-protected (only /health is exempt), so attach this
        // session's token. This shuts down a sidecar we started or adopted (same
        // token); a true cross-launch orphan (different token) 401s and falls
        // through to the force-kill path, as before.
        let _ = client
            .post(format!("{base_url}/shutdown"))
            .header("x-geolibre-token", sidecar_token())
            .send();
    }
}

#[cfg(not(feature = "mas"))]
fn wait_for_sidecar_stop(base_url: &str) {
    for _ in 0..20 {
        if !sidecar_health_is_ready(base_url) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(not(feature = "mas"))]
fn wait_for_sidecar_health(
    base_url: &str,
    child: &mut Child,
    output: &CapturedOutput,
) -> Result<(), String> {
    for _ in 0..SIDECAR_HEALTH_ATTEMPTS {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not inspect sidecar process: {error}"))?
        {
            return Err(child_failure_message(
                &format!("GeoLibre sidecar exited before it was ready: {status}"),
                output,
            ));
        }

        if sidecar_health_is_ready(base_url) {
            return Ok(());
        }

        thread::sleep(Duration::from_secs(1));
    }

    Err(child_failure_message(
        "GeoLibre sidecar did not become ready in time.",
        output,
    ))
}

// How many trailing output lines a captured child keeps, and how many of them a
// failure message quotes. The log is a ring buffer so a chatty child (uv sync +
// JupyterLab startup write hundreds of lines) can never grow without bound, and
// the tail is what matters: the error that killed the process is at the end.
#[cfg(not(feature = "mas"))]
const CAPTURED_LOG_MAX_LINES: usize = 200;
#[cfg(not(feature = "mas"))]
const CAPTURED_LOG_REPORTED_LINES: usize = 20;
// How long a failure report waits for the reader threads to reach EOF before
// quoting what they have. `try_wait` reports the exit as soon as the process is
// reaped, which can be before the readers have consumed the last lines still
// sitting in the pipe — and those last lines are the error itself. Waiting is
// necessarily *bounded*: `uv` spawns `jupyter`, which spawns kernels that
// inherit these same pipe handles, so a grandchild outliving the child keeps the
// write end open and EOF never arrives. An unbounded join would hang the Tauri
// command forever, which is worse than a truncated tail.
#[cfg(not(feature = "mas"))]
const CAPTURED_LOG_SETTLE: Duration = Duration::from_millis(500);
#[cfg(not(feature = "mas"))]
const CAPTURED_LOG_SETTLE_POLL: Duration = Duration::from_millis(10);

/// The trailing output of a spawned child, drained on background threads.
///
/// `Stdio::piped()` alone is not enough for a child we only poll for health: an
/// undrained OS pipe fills at ~64 KB and blocks the writer forever, so a chatty
/// child would hang instead of becoming ready. These readers consume both
/// streams continuously, keep the last `CAPTURED_LOG_MAX_LINES` in memory, and
/// echo each line to the parent's own stdio so a dev terminal still shows the
/// live log.
#[cfg(not(feature = "mas"))]
#[derive(Clone)]
struct CapturedOutput {
    lines: Arc<Mutex<VecDeque<String>>>,
    // Reader threads that have not yet seen EOF. Drives `settle`.
    draining: Arc<AtomicUsize>,
}

#[cfg(not(feature = "mas"))]
impl CapturedOutput {
    fn new() -> Self {
        Self {
            lines: Arc::new(Mutex::new(VecDeque::with_capacity(CAPTURED_LOG_MAX_LINES))),
            draining: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Take the child's piped stdout/stderr and start draining them.
    fn attach(child: &mut Child) -> Self {
        let captured = Self::new();
        if let Some(stdout) = child.stdout.take() {
            captured.drain(stdout, false);
        }
        if let Some(stderr) = child.stderr.take() {
            captured.drain(stderr, true);
        }
        captured
    }

    fn drain<R>(&self, stream: R, is_stderr: bool)
    where
        R: Read + Send + 'static,
    {
        let captured = self.clone();
        // Registered before the thread starts, so a `settle` racing the spawn
        // still sees this reader as outstanding.
        self.draining.fetch_add(1, Ordering::SeqCst);
        // Detached: the thread ends on its own when the pipe closes at child
        // exit. `settle` waits on the counter rather than a JoinHandle so the
        // wait can be bounded (see CAPTURED_LOG_SETTLE).
        thread::spawn(move || {
            for line in BufReader::new(stream).lines() {
                let Ok(line) = line else { break };
                // Tee to the parent's stdio. In a dev terminal this preserves
                // the old inherit-style live log; in a bundled GUI build (no
                // console on Windows) it is simply discarded.
                if is_stderr {
                    let _ = writeln!(std::io::stderr(), "{line}");
                } else {
                    let _ = writeln!(std::io::stdout(), "{line}");
                }
                captured.push(line);
            }
            captured.draining.fetch_sub(1, Ordering::SeqCst);
        });
    }

    /// Give the reader threads a bounded moment to reach EOF, so a report made
    /// right after `try_wait` sees the child's final lines instead of racing
    /// them. Returns early once every reader is done; otherwise gives up at
    /// `CAPTURED_LOG_SETTLE` and lets the caller quote a partial tail.
    fn settle(&self) {
        let deadline = CAPTURED_LOG_SETTLE.as_millis() / CAPTURED_LOG_SETTLE_POLL.as_millis();
        for _ in 0..deadline {
            if self.draining.load(Ordering::SeqCst) == 0 {
                return;
            }
            thread::sleep(CAPTURED_LOG_SETTLE_POLL);
        }
    }

    /// Record one line, evicting the oldest once the ring buffer is full.
    fn push(&self, line: String) {
        let Ok(mut lines) = self.lines.lock() else {
            return;
        };
        while lines.len() >= CAPTURED_LOG_MAX_LINES {
            lines.pop_front();
        }
        lines.push_back(line);
    }

    /// The last few captured lines, blank-trimmed, for an error message.
    /// Empty when the child produced no output at all.
    fn tail(&self) -> String {
        let Ok(lines) = self.lines.lock() else {
            return String::new();
        };
        let start = lines.len().saturating_sub(CAPTURED_LOG_REPORTED_LINES);
        lines
            .iter()
            .skip(start)
            .map(|line| line.trim_end())
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// The AppImage mount root, when running from an AppImage. `APPDIR` is exported
/// by AppRun and is the prefix of everything it injects.
#[cfg(not(feature = "mas"))]
fn appimage_dir() -> Option<String> {
    env::var("APPDIR").ok().filter(|dir| !dir.is_empty())
}

/// Read a `PATH`-style variable with any entry that points inside the AppImage
/// mount removed. Returns `None` when the variable is unset or every entry was
/// an AppDir entry (so the caller unsets it rather than passing an empty value).
/// Outside an AppImage the value is returned untouched.
#[cfg(not(feature = "mas"))]
fn appdir_free_path_var(name: &str) -> Option<String> {
    let value = env::var(name).ok()?;
    let Some(appdir) = appimage_dir() else {
        return Some(value);
    };
    let sep = if cfg!(windows) { ';' } else { ':' };
    let kept: Vec<&str> = value
        .split(sep)
        .filter(|entry| !entry.is_empty() && !entry.starts_with(appdir.as_str()))
        .collect();
    if kept.is_empty() {
        None
    } else {
        Some(kept.join(&sep.to_string()))
    }
}

/// Undo the environment an AppImage forces on every child process.
///
/// AppImageKit's AppRun exports a fixed set of variables so the bundled GUI can
/// find its own libraries, including:
///
/// ```text
/// PYTHONHOME=$APPDIR/usr/
/// PYTHONPATH=$APPDIR/usr/share/pyshared/:$PYTHONPATH
/// LD_LIBRARY_PATH=$APPDIR/usr/lib/:…:$LD_LIBRARY_PATH
/// ```
///
/// They leak into everything we spawn. `PYTHONHOME` is the fatal one: a Python
/// that honours it looks for its standard library under the AppImage mount,
/// finds no `encodings` module, and aborts with "Failed to import encodings
/// module" before executing a line of code. That killed `uv`'s build backend —
/// and so the Notebook panel and the sidecar — in every AppImage build, while
/// the .deb/.rpm (which have no AppRun) were unaffected.
///
/// We never want an inherited `PYTHONHOME`: the interpreter is chosen by uv and
/// the project environment we point it at, so drop it unconditionally rather
/// than only under an AppImage. The two search paths keep any entries the user
/// legitimately set and lose only the AppDir ones.
#[cfg(not(feature = "mas"))]
fn clear_appimage_python_env(command: &mut Command) {
    command.env_remove("PYTHONHOME");
    for name in ["LD_LIBRARY_PATH", "PYTHONPATH"] {
        // The Jupyter launch sets its own PYTHONPATH (already AppDir-free, via
        // prepend_pythonpath) before this runs, and overwriting it here would
        // drop the notebook-lib directory that makes `import geolibre` work.
        if command
            .get_envs()
            .any(|(key, value)| key == OsStr::new(name) && value.is_some())
        {
            continue;
        }
        match appdir_free_path_var(name) {
            Some(value) => command.env(name, value),
            None => command.env_remove(name),
        };
    }
}

#[cfg(not(feature = "mas"))]
fn configure_sidecar_process(command: &mut Command) {
    // Both callers (the sidecar and Jupyter launches) run Python through uv.
    clear_appimage_python_env(command);
    configure_sidecar_process_impl(command);
}

#[cfg(all(unix, not(feature = "mas")))]
fn configure_sidecar_process_impl(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
}

#[cfg(all(not(unix), not(feature = "mas")))]
fn configure_sidecar_process_impl(command: &mut Command) {
    hide_console_window(command);
}

/// Keep a spawned console program from opening a console window.
///
/// Release builds are GUI-subsystem (`windows_subsystem = "windows"`), so they
/// have no console of their own. Spawning `uv.exe` (a console program) then
/// makes Windows allocate a fresh console *window* for it, which appears on the
/// user's desktop and stays for as long as the child runs -- for the Notebook
/// panel that is the whole session. `CREATE_NO_WINDOW` runs the child without
/// one. Output is unaffected: every caller already pipes stdout/stderr and
/// drains them (see CapturedOutput).
#[cfg(all(target_os = "windows", not(feature = "mas")))]
fn hide_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(all(not(target_os = "windows"), not(feature = "mas")))]
fn hide_console_window(_command: &mut Command) {}

#[cfg(not(feature = "mas"))]
fn terminate_sidecar_child(child: &mut Child) {
    terminate_sidecar_process_group(child);
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(all(unix, not(feature = "mas")))]
fn terminate_sidecar_process_group(child: &mut Child) {
    // Guard the negation: a PID that wrapped to a non-positive i32 would make
    // `kill` target process group 0 (the caller's own group, including the
    // Tauri parent) or overflow on i32::MIN.
    let Some(process_group) = i32::try_from(child.id())
        .ok()
        .filter(|pid| *pid > 0)
        .and_then(|pid| pid.checked_neg())
    else {
        return;
    };
    let _ = unsafe { kill(process_group, SIGTERM) };
    thread::sleep(Duration::from_millis(250));
    let _ = unsafe { kill(process_group, SIGKILL) };
}

#[cfg(all(not(unix), not(feature = "mas")))]
fn terminate_sidecar_process_group(_child: &mut Child) {}

#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn terminate_sidecar_listeners_on_port(port: u16) -> Result<(), String> {
    terminate_listeners_on_port(port, is_geolibre_sidecar_process)
}

// Reap a stale Jupyter server that still holds the port (e.g. orphaned by a
// non-graceful exit of a previous app session). Recognized by its cmdline so we
// never touch an unrelated jupyter (the user's own JupyterHub, etc.).
#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn terminate_jupyter_listeners_on_port(
    port: u16,
    _runtime_dir: &std::path::Path,
) -> Result<(), String> {
    terminate_listeners_on_port(port, is_geolibre_jupyter_process)
}

// Known gap: still a no-op on macOS (there is no /proc, and the Windows IP
// Helper route below does not exist either). The current session's child is
// reaped on exit via JupyterProcess::Drop, but an orphan left by a *previous*
// crashed session can keep holding the port, in which case the next launch
// fails to bind and surfaces "exited before it was ready". An lsof-based
// port-owner lookup would be needed to close this.
#[cfg(all(
    not(target_os = "linux"),
    not(target_os = "windows"),
    not(feature = "mas")
))]
fn terminate_jupyter_listeners_on_port(
    _port: u16,
    _runtime_dir: &std::path::Path,
) -> Result<(), String> {
    Ok(())
}

// Windows equivalent of the Linux reaper (issue #1643): an orphaned Jupyter
// server from a crashed session keeps holding 8766, and every later launch dies
// with "the port 8766 is already in use" until the user kills it by hand.
//
// There is no /proc here, so the owner of the listening socket comes from the IP
// Helper TCP table, and "is it ours?" is answered by the process image path: we
// only ever terminate a listener whose executable lives inside this user's own
// GeoLibre runtime directory (the uv-managed environment under
// `%APPDATA%\org.geolibre.desktop\runtime\`). A Jupyter the user installed
// themselves lives outside it and is left alone. The sidecar's port keeps its
// no-op: unlike Jupyter it already reports an actionable message of its own
// when the port stays busy (see start_geolibre_sidecar_blocking).
#[cfg(all(target_os = "windows", not(feature = "mas")))]
fn terminate_jupyter_listeners_on_port(
    port: u16,
    runtime_dir: &std::path::Path,
) -> Result<(), String> {
    for pid in listening_tcp_pids(port) {
        terminate_listener_under(pid, runtime_dir);
    }
    Ok(())
}

// PIDs of the processes listening on `port`, over both IPv4 and IPv6. The two
// families are read independently: a machine with IPv6 disabled outright can
// fail the second read, and letting that discard the IPv4 result would drop the
// orphan we are here to reclaim (Jupyter binds 127.0.0.1, so it is nearly
// always the IPv4 table that holds it).
#[cfg(all(target_os = "windows", not(feature = "mas")))]
fn listening_tcp_pids(port: u16) -> HashSet<u32> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID,
    };

    // The address families as GetExtendedTcpTable wants them: a plain u32, not
    // the u16 `ADDRESS_FAMILY` the WinSock module exports.
    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;

    let mut pids = HashSet::new();
    match extended_tcp_table(AF_INET) {
        Ok(table) => collect_owner_pids::<MIB_TCPROW_OWNER_PID>(
            &table,
            port,
            |row| (row.dwLocalPort, row.dwOwningPid),
            &mut pids,
        ),
        Err(error) => eprintln!("Jupyter: {error}"),
    }
    match extended_tcp_table(AF_INET6) {
        Ok(table) => collect_owner_pids::<MIB_TCP6ROW_OWNER_PID>(
            &table,
            port,
            |row| (row.dwLocalPort, row.dwOwningPid),
            &mut pids,
        ),
        Err(error) => eprintln!("Jupyter: {error}"),
    }
    pids
}

// Walk one MIB_TCP*TABLE_OWNER_PID and collect the PIDs listening on `port`.
// Both the IPv4 and IPv6 tables have the same shape -- a DWORD entry count
// followed by the rows -- so the row type and the two fields we need are the
// only things that differ.
#[cfg(all(target_os = "windows", not(feature = "mas")))]
fn collect_owner_pids<Row>(
    buffer: &[u32],
    port: u16,
    fields: fn(&Row) -> (u32, u32),
    pids: &mut HashSet<u32>,
) {
    use std::mem::{size_of, size_of_val};

    if buffer.is_empty() {
        return;
    }
    let base = buffer.as_ptr();
    // SAFETY: `buffer` is a u32-aligned allocation that GetExtendedTcpTable
    // filled for this table class, and it holds at least the leading entry
    // count. Every row type here has 4-byte alignment, so the rows -- which
    // start one DWORD in -- are aligned too. The walk is capped at the number
    // of rows the allocation can actually hold, so an entry count that
    // disagrees with the reported size cannot read past the end.
    let count = unsafe { *base } as usize;
    let capacity = (size_of_val(buffer) - size_of::<u32>()) / size_of::<Row>();
    let rows = unsafe { base.add(1) }.cast::<Row>();
    for index in 0..count.min(capacity) {
        let (local_port, owning_pid) = fields(unsafe { &*rows.add(index) });
        if tcp_table_port(local_port) == port {
            pids.insert(owning_pid);
        }
    }
}

// Read the TCP listener table for one address family into a u32-aligned buffer.
// GetExtendedTcpTable reports the size it needs on the first (null) call, but
// the table can grow between that call and the read, so retry a bounded number
// of times rather than trusting the first answer.
#[cfg(all(target_os = "windows", not(feature = "mas")))]
fn extended_tcp_table(family: u32) -> Result<Vec<u32>, String> {
    use std::mem::size_of;
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, TCP_TABLE_OWNER_PID_LISTENER,
    };

    const NO_ERROR: u32 = 0;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
    const ATTEMPTS: usize = 8;

    let mut size: u32 = 0;
    let mut buffer: Vec<u32> = Vec::new();
    for _ in 0..ATTEMPTS {
        // SAFETY: the pointer and `size` describe the same allocation (null and
        // zero on the sizing call, which is what the API asks for), and the API
        // only writes within `size` bytes.
        let result = unsafe {
            GetExtendedTcpTable(
                if buffer.is_empty() {
                    std::ptr::null_mut()
                } else {
                    buffer.as_mut_ptr().cast()
                },
                &mut size,
                0, // unsorted: we look up a single port
                family,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        match result {
            NO_ERROR => return Ok(buffer),
            ERROR_INSUFFICIENT_BUFFER => {
                if size == 0 {
                    return Ok(Vec::new());
                }
                buffer = vec![0u32; (size as usize).div_ceil(size_of::<u32>())];
            }
            other => {
                return Err(format!(
                    "Could not read the TCP listener table for address family {family}: \
                     Windows error {other}."
                ))
            }
        }
    }
    Err("Could not read the TCP listener table: it kept growing between calls.".to_string())
}

// Terminate `pid`, but only if its executable lives inside `runtime_dir`. Does
// nothing when the process has already exited or we may not touch it.
//
// The image check and the kill deliberately share ONE handle. An open handle
// pins the process object, so the PID cannot be recycled onto some unrelated
// process in between -- re-opening by PID to terminate would leave exactly that
// window, and the whole point of the image check is that we never kill a
// process that is not ours.
//
// Windows has no SIGTERM, so unlike the Linux path there is no graceful step to
// try first: an orphan from a previous session has no channel we can ask it to
// shut down through.
#[cfg(all(target_os = "windows", not(feature = "mas")))]
fn terminate_listener_under(pid: u32, runtime_dir: &Path) {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, TerminateProcess, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };

    // SAFETY: one handle for both the query and the kill; closed on every path.
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
            0,
            pid,
        )
    };
    if process.is_null() {
        return;
    }
    // Sized for an extended-length path rather than MAX_PATH, so a deeply
    // nested app-data directory is not silently truncated into a non-match.
    let mut buffer = vec![0u16; 32_768];
    let mut length = buffer.len() as u32;
    // SAFETY: `buffer` holds `length` u16s; on success the API sets `length` to
    // the number it wrote, which is never more than the value passed in.
    let queried = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            buffer.as_mut_ptr(),
            &mut length,
        )
    };
    if queried != 0 {
        let image = PathBuf::from(OsString::from_wide(
            &buffer[..(length as usize).min(buffer.len())],
        ));
        if path_is_under(&image, runtime_dir) {
            // SAFETY: the same handle, opened with PROCESS_TERMINATE above.
            let _ = unsafe { TerminateProcess(process, 1) };
        }
    }
    let _ = unsafe { CloseHandle(process) };
}

// MIB_TCP*ROW_OWNER_PID keeps the local port in the low word of a DWORD, in
// network byte order.
#[cfg(any(all(target_os = "windows", not(feature = "mas")), test))]
fn tcp_table_port(value: u32) -> u16 {
    u16::from_be((value & 0xFFFF) as u16)
}

// Whether `path` sits inside `root`. Compared with separators normalized and
// case folded, because Windows paths are case-insensitive and the image path
// the OS reports need not spell the directory the way we built it. The trailing
// separator is what keeps `...\runtime` from matching `...\runtime-old`.
//
// Folding is ASCII-only on purpose. What actually varies between the path we
// built and the one the OS reports is the drive letter and the segments we
// wrote ourselves, all ASCII; the rest (a user's name in the profile path) is
// byte-identical on both sides. Unicode `to_lowercase` would buy nothing there
// and can change a string's length (Turkish dotless I, sharp S), which would
// misalign the prefix comparison.
#[cfg(any(all(target_os = "windows", not(feature = "mas")), test))]
fn path_is_under(path: &Path, root: &Path) -> bool {
    fn normalize(value: &Path) -> String {
        value
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase()
    }

    let root = normalize(root);
    let root = root.trim_end_matches('\\');
    if root.is_empty() {
        return false;
    }
    normalize(path).starts_with(&format!("{root}\\"))
}

// Kill the processes listening on `port` that `is_ours` recognizes (SIGTERM then
// SIGKILL). The `is_ours` guard prevents killing an unrelated process that
// happens to hold the port.
#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn terminate_listeners_on_port(port: u16, is_ours: fn(i32) -> bool) -> Result<(), String> {
    let inodes = listening_tcp_inodes(port)?;
    if inodes.is_empty() {
        return Ok(());
    }

    let mut pids = HashSet::new();
    for entry in fs::read_dir("/proc").map_err(|error| format!("Could not read /proc: {error}"))? {
        let entry = entry.map_err(|error| format!("Could not read /proc entry: {error}"))?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|value| value.parse::<i32>().ok())
        else {
            continue;
        };
        if process_has_socket(pid, &inodes)? && is_ours(pid) {
            pids.insert(pid);
        }
    }

    for pid in &pids {
        terminate_pid(*pid, SIGTERM);
    }
    thread::sleep(Duration::from_millis(250));
    for pid in &pids {
        terminate_pid(*pid, SIGKILL);
    }
    Ok(())
}

#[cfg(all(not(target_os = "linux"), not(feature = "mas")))]
fn terminate_sidecar_listeners_on_port(_port: u16) -> Result<(), String> {
    Ok(())
}

#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn listening_tcp_inodes(port: u16) -> Result<HashSet<String>, String> {
    let mut inodes = HashSet::new();
    collect_listening_tcp_inodes("/proc/net/tcp", port, &mut inodes)?;
    collect_listening_tcp_inodes("/proc/net/tcp6", port, &mut inodes)?;
    Ok(inodes)
}

#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn collect_listening_tcp_inodes(
    path: &str,
    port: u16,
    inodes: &mut HashSet<String>,
) -> Result<(), String> {
    let content =
        fs::read_to_string(path).map_err(|error| format!("Could not read {path}: {error}"))?;
    let expected_port = format!("{port:04X}");
    for line in content.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() <= 9 || fields[3] != "0A" {
            continue;
        }
        let Some(local_port) = fields[1].rsplit_once(':').map(|(_, value)| value) else {
            continue;
        };
        if local_port.eq_ignore_ascii_case(&expected_port) {
            inodes.insert(fields[9].to_string());
        }
    }
    Ok(())
}

#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn process_has_socket(pid: i32, inodes: &HashSet<String>) -> Result<bool, String> {
    let fd_dir = format!("/proc/{pid}/fd");
    let Ok(entries) = fs::read_dir(&fd_dir) else {
        return Ok(false);
    };
    for entry in entries {
        let Ok(entry) = entry else {
            continue; // process may have exited between the /proc scan and this read
        };
        let Ok(target) = fs::read_link(entry.path()) else {
            continue;
        };
        let target = target.to_string_lossy();
        if let Some(inode) = target
            .strip_prefix("socket:[")
            .and_then(|value| value.strip_suffix(']'))
        {
            if inodes.contains(inode) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn is_geolibre_sidecar_process(pid: i32) -> bool {
    let path = format!("/proc/{pid}/cmdline");
    let Ok(command_line) = fs::read(path) else {
        return false;
    };
    let command_line = String::from_utf8_lossy(&command_line);
    command_line.contains("geolibre_server.app.main")
        || command_line.contains("geolibre_server/app")
}

// Recognize OUR Jupyter server (started by start_jupyter_server) by the bundled
// config path on its command line — specific enough not to match the user's own
// jupyter/JupyterHub processes.
#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn is_geolibre_jupyter_process(pid: i32) -> bool {
    let path = format!("/proc/{pid}/cmdline");
    let Ok(command_line) = fs::read(path) else {
        return false;
    };
    let command_line = String::from_utf8_lossy(&command_line);
    command_line.contains("jupyter_server_config.py") && command_line.contains("geolibre_server")
}

#[cfg(all(unix, not(feature = "mas")))]
fn terminate_pid(pid: i32, signal: i32) {
    let _ = unsafe { kill(pid, signal) };
}

#[cfg(not(feature = "mas"))]
fn sidecar_project_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = env::var("GEOLIBRE_SIDECAR_PROJECT_DIR") {
        return validate_sidecar_project_dir(PathBuf::from(path));
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        if let Some(path) = resolve_sidecar_in_resource_dir(&resource_dir) {
            return Ok(path);
        }
    }

    validate_sidecar_project_dir(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join("backend")
            .join("geolibre_server"),
    )
}

/// Locate the bundled Python sidecar project under a Tauri resource directory.
///
/// Tauri bundles the `../../../backend/geolibre_server` resource by rewriting
/// every leading `..` in the source path to an `_up_` directory, so in an
/// installed build the project lands at
/// `<resource_dir>/_up_/_up_/_up_/backend/geolibre_server` rather than directly
/// under the resource dir (issue #1223). We probe the plain locations first,
/// then a few `_up_` depths so the lookup keeps working if the number of `..`
/// segments in the resource path ever changes.
#[cfg(not(feature = "mas"))]
fn resolve_sidecar_in_resource_dir(resource_dir: &std::path::Path) -> Option<PathBuf> {
    // Plain resource root plus a few `_up_` levels of margin over the observed
    // 3-level bundle depth, so the lookup survives a change in Tauri's bundling.
    const MAX_UP_DEPTH: usize = 4;
    let mut prefix = resource_dir.to_path_buf();
    for _ in 0..=MAX_UP_DEPTH {
        if let Ok(path) =
            validate_sidecar_project_dir(prefix.join("backend").join("geolibre_server"))
        {
            return Some(path);
        }
        if let Ok(path) = validate_sidecar_project_dir(prefix.join("geolibre_server")) {
            return Some(path);
        }
        prefix = prefix.join("_up_");
    }
    None
}

#[cfg(not(feature = "mas"))]
fn validate_sidecar_project_dir(path: PathBuf) -> Result<PathBuf, String> {
    let path = path
        .canonicalize()
        .map_err(|error| format!("Could not resolve sidecar project path: {error}"))?;
    if path.join("pyproject.toml").exists() {
        Ok(path)
    } else {
        Err(format!(
            "Could not find GeoLibre sidecar project at {}",
            path.display()
        ))
    }
}

#[cfg(not(feature = "mas"))]
fn ensure_managed_uv(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = env::var("GEOLIBRE_UV") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
    }

    if let Some(path) = find_executable_on_path(uv_executable_name()) {
        return Ok(path);
    }

    install_managed_uv(app)
}

#[cfg(not(feature = "mas"))]
fn install_managed_uv(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let uv_dir = app_runtime_dir(app)?.join("uv-bin");
    let uv = uv_dir.join(uv_executable_name());
    if uv.exists() {
        return Ok(uv);
    }

    fs::create_dir_all(&uv_dir)
        .map_err(|error| format!("Could not create uv cache directory: {error}"))?;
    let script = download_uv_installer(app)?;
    let mut command = if cfg!(target_os = "windows") {
        let mut command = Command::new("powershell");
        command
            .arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(&script);
        command
    } else {
        let mut command = Command::new("sh");
        command.arg(&script);
        command
    };
    // First run only, but it is the one that would flash a PowerShell window
    // across the user's desktop while uv installs.
    hide_console_window(&mut command);
    let output = command
        .env("UV_UNMANAGED_INSTALL", &uv_dir)
        .output()
        .map_err(|error| format!("Could not run uv installer: {error}"))?;
    let _ = fs::remove_file(script);
    if !output.status.success() {
        let detail = String::from_utf8_lossy(if output.stderr.is_empty() {
            &output.stdout
        } else {
            &output.stderr
        });
        return Err(format!("uv installer failed: {detail}"));
    }
    if !uv.exists() {
        return Err(format!("uv installer did not create {}", uv.display()));
    }
    Ok(uv)
}

#[cfg(not(feature = "mas"))]
fn download_uv_installer(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let url = if cfg!(target_os = "windows") {
        format!("{UV_INSTALL_BASE_URL}/install.ps1")
    } else {
        format!("{UV_INSTALL_BASE_URL}/install.sh")
    };
    let response = reqwest::blocking::Client::builder()
        .user_agent("GeoLibre Desktop")
        .build()
        .map_err(|error| format!("Could not create HTTP client: {error}"))?
        .get(url)
        .send()
        .map_err(|error| format!("Could not download uv installer: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("uv installer download failed with status {status}"));
    }
    let extension = if cfg!(target_os = "windows") {
        "ps1"
    } else {
        "sh"
    };
    let installer_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not resolve app cache directory: {error}"))?
        .join("installers");
    fs::create_dir_all(&installer_dir)
        .map_err(|error| format!("Could not create installer cache directory: {error}"))?;
    let script = installer_dir.join(format!("uv-install.{extension}"));
    fs::write(
        &script,
        response
            .bytes()
            .map_err(|error| format!("Could not read uv installer: {error}"))?,
    )
    .map_err(|error| format!("Could not write uv installer: {error}"))?;
    Ok(script)
}

#[cfg(not(feature = "mas"))]
fn uv_executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "uv.exe"
    } else {
        "uv"
    }
}

#[cfg(not(feature = "mas"))]
fn find_executable_on_path(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file() && is_executable(candidate))
}

#[cfg(all(unix, not(feature = "mas")))]
fn is_executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(all(not(unix), not(feature = "mas")))]
fn is_executable(_path: &std::path::Path) -> bool {
    true
}

#[cfg(not(feature = "mas"))]
fn ensure_martin_binary_path(app: &tauri::AppHandle) -> Result<MartinBinaryInfo, String> {
    let asset_name = martin_asset_name()?;
    let executable_name = martin_executable_name();
    let martin_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("martin")
        .join(MARTIN_VERSION)
        .join(
            asset_name
                .trim_end_matches(".tar.gz")
                .trim_end_matches(".zip"),
        );
    let binary_path = martin_dir.join(executable_name);
    let temp_binary_path = martin_dir.join(format!("{executable_name}.download"));

    if binary_path.exists() {
        return Ok(MartinBinaryInfo {
            path: binary_path.to_string_lossy().to_string(),
            downloaded: false,
        });
    }

    fs::create_dir_all(&martin_dir)
        .map_err(|error| format!("Could not create Martin cache directory: {error}"))?;
    let _ = fs::remove_file(&temp_binary_path);
    let archive = download_martin_asset(asset_name)?;
    if let Err(error) = extract_martin_binary(&archive, asset_name, &temp_binary_path)
        .and_then(|_| make_executable(&temp_binary_path))
        .and_then(|_| {
            fs::rename(&temp_binary_path, &binary_path)
                .map_err(|error| format!("Could not install Martin binary: {error}"))
        })
    {
        let _ = fs::remove_file(&temp_binary_path);
        return Err(error);
    }

    Ok(MartinBinaryInfo {
        path: binary_path.to_string_lossy().to_string(),
        downloaded: true,
    })
}

#[cfg(not(feature = "mas"))]
fn martin_asset_name() -> Result<&'static str, String> {
    if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
        return Ok("martin-x86_64-unknown-linux-musl.tar.gz");
    }
    if cfg!(target_os = "linux") && cfg!(target_arch = "aarch64") {
        return Ok("martin-aarch64-unknown-linux-musl.tar.gz");
    }
    if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        return Ok("martin-aarch64-apple-darwin.tar.gz");
    }
    if cfg!(target_os = "macos") && cfg!(target_arch = "x86_64") {
        return Ok("martin-x86_64-apple-darwin.tar.gz");
    }
    if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
        return Ok("martin-x86_64-pc-windows-msvc.zip");
    }

    Err("No Martin binary release is available for this platform.".to_string())
}

#[cfg(not(feature = "mas"))]
fn martin_executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "martin.exe"
    } else {
        "martin"
    }
}

#[cfg(not(feature = "mas"))]
fn download_martin_asset(asset_name: &str) -> Result<Vec<u8>, String> {
    let url = format!("{MARTIN_RELEASE_BASE_URL}/{MARTIN_VERSION}/{asset_name}");
    let response = reqwest::blocking::Client::builder()
        .user_agent("GeoLibre Desktop")
        .build()
        .map_err(|error| format!("Could not create HTTP client: {error}"))?
        .get(url)
        .send()
        .map_err(|error| format!("Could not download Martin: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Martin download failed with status {status}"));
    }

    response
        .bytes()
        .map(|bytes| bytes.to_vec())
        .map_err(|error| format!("Could not read Martin download: {error}"))
}

#[cfg(not(feature = "mas"))]
fn extract_martin_binary(
    archive: &[u8],
    asset_name: &str,
    binary_path: &Path,
) -> Result<(), String> {
    if asset_name.ends_with(".zip") {
        extract_martin_binary_from_zip(archive, binary_path)
    } else {
        extract_martin_binary_from_tar_gz(archive, binary_path)
    }
}

#[cfg(not(feature = "mas"))]
fn extract_martin_binary_from_tar_gz(archive: &[u8], binary_path: &Path) -> Result<(), String> {
    let decoder = GzDecoder::new(Cursor::new(archive));
    let mut archive = tar::Archive::new(decoder);
    let executable_name = martin_executable_name();
    let entries = archive
        .entries()
        .map_err(|error| format!("Could not read Martin archive: {error}"))?;

    for entry in entries {
        let mut entry = entry.map_err(|error| format!("Could not read Martin archive: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("Could not read Martin archive path: {error}"))?;
        if path.file_name().and_then(|name| name.to_str()) != Some(executable_name) {
            continue;
        }

        copy_archive_entry_to_path(&mut entry, binary_path)?;
        return Ok(());
    }

    Err("Martin archive did not contain the expected executable.".to_string())
}

#[cfg(not(feature = "mas"))]
fn extract_martin_binary_from_zip(archive: &[u8], binary_path: &Path) -> Result<(), String> {
    let reader = Cursor::new(archive);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|error| format!("Could not read Martin zip: {error}"))?;
    let executable_name = martin_executable_name();

    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|error| format!("Could not read Martin zip entry: {error}"))?;
        let path = PathBuf::from(file.name());
        if path.file_name().and_then(|name| name.to_str()) != Some(executable_name) {
            continue;
        }

        copy_archive_entry_to_path(&mut file, binary_path)?;
        return Ok(());
    }

    Err("Martin zip did not contain the expected executable.".to_string())
}

#[cfg(not(feature = "mas"))]
fn copy_archive_entry_to_path<R: Read>(reader: &mut R, path: &Path) -> Result<(), String> {
    let mut output =
        File::create(path).map_err(|error| format!("Could not create Martin binary: {error}"))?;
    if let Err(error) = std::io::copy(reader, &mut output) {
        let _ = fs::remove_file(path);
        return Err(format!("Could not extract Martin binary: {error}"));
    }
    Ok(())
}

#[cfg(all(unix, not(feature = "mas")))]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path)
        .map_err(|error| format!("Could not read Martin binary permissions: {error}"))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .map_err(|error| format!("Could not mark Martin executable: {error}"))
}

#[cfg(all(not(unix), not(feature = "mas")))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(not(feature = "mas"))]
struct SpawnedMartinServer {
    base_url: String,
    port: u16,
    process: MartinProcess,
}

#[cfg(not(feature = "mas"))]
fn spawn_martin_server(
    binary_path: &str,
    connection_string: &str,
    default_srid: Option<&str>,
) -> Result<SpawnedMartinServer, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Could not reserve a local Martin port: {error}"))?;
    let port = listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("Could not read local Martin port: {error}"))?;
    let listen_address = format!("127.0.0.1:{port}");
    let base_url = format!("http://127.0.0.1:{port}");
    let mut command = Command::new(binary_path);
    command
        .arg("-l")
        .arg(&listen_address)
        .env("DATABASE_URL", connection_string)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(default_srid) = default_srid
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        command.env("DEFAULT_SRID", default_srid);
    }

    // Martin is a console program too, and it runs for as long as the PostGIS
    // connection is open.
    hide_console_window(&mut command);

    drop(listener);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start Martin: {error}"))?;

    if let Err(error) = wait_for_martin_health(&base_url, &mut child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    let _ = child.stdout.take();
    let _ = child.stderr.take();

    Ok(SpawnedMartinServer {
        base_url,
        port,
        process: MartinProcess { child },
    })
}

#[cfg(not(feature = "mas"))]
fn wait_for_martin_health(base_url: &str, child: &mut Child) -> Result<(), String> {
    let health_url = format!("{base_url}/health");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
        .map_err(|error| format!("Could not create HTTP client: {error}"))?;

    for _ in 0..MARTIN_HEALTH_ATTEMPTS {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not inspect Martin process: {error}"))?
        {
            let output = read_child_output(child);
            return Err(if output.trim().is_empty() {
                format!("Martin exited before it was ready: {status}")
            } else {
                format!("Martin exited before it was ready: {output}")
            });
        }

        if client
            .get(&health_url)
            .send()
            .map(|response| response.status().is_success())
            .unwrap_or(false)
        {
            return Ok(());
        }

        thread::sleep(Duration::from_millis(100));
    }

    Err("Martin did not become ready in time.".to_string())
}

#[cfg(not(feature = "mas"))]
fn read_child_output(child: &mut Child) -> String {
    let mut output = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut output);
    }
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_string(&mut output);
    }
    output
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MbtilesMetadata {
    name: String,
    format: String,
    tile_type: String,
    source_layers: Vec<String>,
    min_zoom: Option<i64>,
    max_zoom: Option<i64>,
    bounds: Option<[f64; 4]>,
    center: Option<[f64; 3]>,
    scheme: String,
}

#[tauri::command]
fn read_mbtiles_metadata(path: String) -> Result<MbtilesMetadata, String> {
    let connection = open_mbtiles(&path)?;
    let metadata = read_metadata_rows(&connection)?;
    let fallback_name = Path::new(&path)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("MBTiles Layer")
        .to_string();
    let format = metadata
        .get("format")
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_else(|| "pbf".to_string());
    let tile_type = match format.as_str() {
        "pbf" | "mvt" | "protobuf" => "vector",
        _ => "raster",
    }
    .to_string();

    Ok(MbtilesMetadata {
        name: metadata
            .get("name")
            .filter(|value| !value.trim().is_empty())
            .cloned()
            .unwrap_or(fallback_name),
        format,
        tile_type,
        source_layers: read_vector_source_layers(metadata.get("json")),
        min_zoom: metadata
            .get("minzoom")
            .and_then(|value| value.parse::<i64>().ok()),
        max_zoom: metadata
            .get("maxzoom")
            .and_then(|value| value.parse::<i64>().ok()),
        bounds: metadata.get("bounds").and_then(|value| parse_bounds(value)),
        center: metadata.get("center").and_then(|value| parse_center(value)),
        scheme: metadata
            .get("scheme")
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_else(|| "tms".to_string()),
    })
}

#[tauri::command]
fn read_mbtiles_tile(path: String, z: u32, x: u32, y: u32) -> Result<Vec<u8>, String> {
    let connection = open_mbtiles(&path)?;
    let scheme = read_metadata_value(&connection, "scheme")?
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_else(|| "tms".to_string());
    let tile_row = if scheme == "xyz" {
        i64::from(y)
    } else {
        let row_count = 1_i64
            .checked_shl(z)
            .ok_or_else(|| "Tile zoom level is too large".to_string())?;
        row_count - 1 - i64::from(y)
    };
    if tile_row < 0 {
        return Ok(Vec::new());
    }

    let tile_data = connection
        .query_row(
            "SELECT tile_data FROM tiles WHERE zoom_level = ?1 AND tile_column = ?2 AND tile_row = ?3",
            params![i64::from(z), i64::from(x), tile_row],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .optional()
        .map_err(|error| format!("Could not read MBTiles tile: {error}"))?;

    Ok(tile_data
        .map(decompress_tile_data)
        .transpose()?
        .unwrap_or_default())
}

fn open_mbtiles(path: &str) -> Result<Connection, String> {
    if !Path::new(path).exists() {
        return Err("The selected MBTiles file does not exist".to_string());
    }

    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Could not open MBTiles file: {error}"))
}

fn read_metadata_rows(
    connection: &Connection,
) -> Result<std::collections::HashMap<String, String>, String> {
    let mut statement = connection
        .prepare("SELECT name, value FROM metadata")
        .map_err(|error| format!("Could not read MBTiles metadata: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Could not query MBTiles metadata: {error}"))?;

    let mut metadata = std::collections::HashMap::new();
    for row in rows {
        let (name, value) =
            row.map_err(|error| format!("Could not parse MBTiles metadata: {error}"))?;
        metadata.insert(name.to_ascii_lowercase(), value);
    }
    Ok(metadata)
}

fn read_metadata_value(connection: &Connection, name: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT value FROM metadata WHERE lower(name) = lower(?1)",
            [name],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not read MBTiles metadata: {error}"))
}

fn read_vector_source_layers(json: Option<&String>) -> Vec<String> {
    let Some(json) = json else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    value
        .get("vector_layers")
        .and_then(Value::as_array)
        .map(|layers| {
            layers
                .iter()
                .filter_map(|layer| layer.get("id").and_then(Value::as_str))
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn parse_bounds(value: &str) -> Option<[f64; 4]> {
    let values = parse_number_list(value);
    if values.len() != 4 {
        return None;
    }
    Some([values[0], values[1], values[2], values[3]])
}

fn parse_center(value: &str) -> Option<[f64; 3]> {
    let values = parse_number_list(value);
    if values.len() < 2 {
        return None;
    }
    Some([values[0], values[1], values.get(2).copied().unwrap_or(0.0)])
}

fn parse_number_list(value: &str) -> Vec<f64> {
    value
        .split(',')
        .filter_map(|part| part.trim().parse::<f64>().ok())
        .collect()
}

fn decompress_tile_data(data: Vec<u8>) -> Result<Vec<u8>, String> {
    if data.starts_with(&[0x1f, 0x8b]) {
        let mut decoder = GzDecoder::new(data.as_slice());
        let mut decoded = Vec::new();
        decoder
            .read_to_end(&mut decoded)
            .map_err(|error| format!("Could not decompress gzip tile: {error}"))?;
        return Ok(decoded);
    }

    if data.len() > 2 && data[0] == 0x78 {
        let mut decoder = ZlibDecoder::new(data.as_slice());
        let mut decoded = Vec::new();
        if decoder.read_to_end(&mut decoded).is_ok() {
            return Ok(decoded);
        }
    }

    Ok(data)
}

fn create_main_window(app: &mut tauri::App) -> tauri::Result<()> {
    let window_config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .expect("GeoLibre Desktop requires a main window config");

    let builder = tauri::WebviewWindowBuilder::from_config(app, &window_config)?;

    // Only desktop opens OAuth flows in child windows; on mobile they navigate
    // in-page (or via the system browser), so skip the new-window handler.
    #[cfg(desktop)]
    let builder = {
        let app_handle = app.handle().clone();
        builder.on_new_window(move |url, features| {
            create_oauth_popup_window(app_handle.clone(), url, features)
        })
    };

    builder.build()?;

    Ok(())
}

#[cfg(desktop)]
fn create_oauth_popup_window(
    app_handle: tauri::AppHandle,
    url: tauri::Url,
    features: tauri::webview::NewWindowFeatures,
) -> tauri::webview::NewWindowResponse<tauri::Wry> {
    let popup_id = POPUP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let child_app_handle = app_handle.clone();
    let blank_url: tauri::Url = match "about:blank".parse() {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("OAuth popup: could not parse blank URL: {error}");
            return tauri::webview::NewWindowResponse::Deny;
        }
    };
    let window = match tauri::WebviewWindowBuilder::new(
        &app_handle,
        format!("oauthPopup{popup_id}"),
        tauri::WebviewUrl::External(blank_url),
    )
    .window_features(features)
    .title(url.as_str())
    .on_new_window(move |url, features| {
        create_oauth_popup_window(child_app_handle.clone(), url, features)
    })
    .on_document_title_changed(|window, title| {
        let _ = window.set_title(&title);
    })
    .build()
    {
        Ok(window) => window,
        Err(error) => {
            eprintln!("OAuth popup: failed to create popup window: {error}");
            return tauri::webview::NewWindowResponse::Deny;
        }
    };

    tauri::webview::NewWindowResponse::Create { window }
}

#[cfg(target_os = "linux")]
fn nvidia_is_primary_gpu(drm_root: &Path) -> bool {
    let Ok(entries) = fs::read_dir(drm_root) else {
        return false;
    };
    entries.filter_map(Result::ok).any(|entry| {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("card") || name.contains('-') {
            return false;
        }
        let device = entry.path().join("device");
        fs::read_to_string(device.join("vendor"))
            .is_ok_and(|vendor| vendor.trim().eq_ignore_ascii_case("0x10de"))
            && fs::read_to_string(device.join("boot_vga"))
                .is_ok_and(|boot_vga| boot_vga.trim() == "1")
            && fs::read_link(device.join("driver")).is_ok_and(|driver| {
                driver
                    .file_name()
                    .is_some_and(|name| name.eq_ignore_ascii_case("nvidia"))
            })
    })
}

#[cfg(target_os = "linux")]
fn linux_uses_nvidia_renderer(
    drm_root: &Path,
    prime_offload: Option<&std::ffi::OsStr>,
    glx_vendor: Option<&std::ffi::OsStr>,
) -> bool {
    prime_offload.is_some_and(|value| value != "0")
        || glx_vendor.is_some_and(|value| value.eq_ignore_ascii_case("nvidia"))
        || nvidia_is_primary_gpu(drm_root)
}

/// JavaScriptCore options that keep WebKitGTK's WebAssembly tier-up off its
/// OSR-entry path (see `configure_linux_webkit`). Both are needed: the first
/// covers OSR entry out of the WebAssembly interpreter, the second the loop
/// tier-up checks the baseline (BBQ) JIT emits. Leaving either on still
/// reaches the trampoline.
#[cfg(target_os = "linux")]
const WASM_OSR_ENTRY_JSC_OPTIONS: [&str; 2] = ["JSC_useWasmOSR", "JSC_useBBQTierUpChecks"];

/// Whether this CPU implements AVX. The trampoline behind GeoLibre#2087 is
/// x86-only, so every other architecture answers yes and skips the workaround.
#[cfg(all(target_os = "linux", any(target_arch = "x86", target_arch = "x86_64")))]
fn cpu_supports_avx() -> bool {
    std::arch::is_x86_feature_detected!("avx")
}

#[cfg(all(
    target_os = "linux",
    not(any(target_arch = "x86", target_arch = "x86_64"))
))]
fn cpu_supports_avx() -> bool {
    true
}

/// Whether an explicit value for one of `WASM_OSR_ENTRY_JSC_OPTIONS` leaves it
/// off. JavaScriptCore reads `false`, `no` (either in any case) and `0` as off
/// and `true`, `yes` and `1` as on, and keeps the option's default, which for
/// both of these is on, for anything it cannot parse. Answer the way it does
/// rather than treating "set" as "off".
#[cfg(target_os = "linux")]
fn jsc_option_is_off(value: &std::ffi::OsStr) -> bool {
    value.to_str().is_some_and(|value| {
        value.eq_ignore_ascii_case("false") || value.eq_ignore_ascii_case("no") || value == "0"
    })
}

/// Whether `WASM_OSR_ENTRY_JSC_OPTIONS` has to be pinned off, given whether the
/// CPU supports AVX and whether either option is explicitly *on*. The two are
/// one decision, not two: leaving half the pair applied costs WebAssembly
/// performance without keeping the renderer alive. So an option somebody has
/// already turned off is fine to build on (the other half still gets applied),
/// while an option somebody has turned on is the escape hatch and takes the
/// whole workaround out of GeoLibre's hands, as does pinning `JSC_useBBQJIT`
/// instead.
#[cfg(target_os = "linux")]
fn linux_needs_wasm_osr_workaround(cpu_supports_avx: bool, opted_out: bool) -> bool {
    !cpu_supports_avx && !opted_out
}

#[cfg(target_os = "linux")]
fn configure_linux_webkit() {
    // WebKitGTK's DMABUF renderer could fail to allocate GBM buffers on older
    // graphics stacks, leaving the Tauri window blank, so it used to be
    // disabled here unconditionally. Disabling it also forces a slow readback
    // compositing path that visibly drops MapLibre pan/zoom FPS, and the
    // allocation bugs are fixed on most current graphics stacks, so keep the
    // workaround only for versions older than 2.48 and Nvidia renderers, where
    // GBM allocation failures still occur on current WebKitGTK. An explicit
    // user/distributor value always wins (per WebKit semantics, "0" keeps
    // DMABUF on and any other value disables it). Only set the default when
    // unset.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        let webkit_version = unsafe {
            (
                webkit2gtk_sys::webkit_get_major_version(),
                webkit2gtk_sys::webkit_get_minor_version(),
            )
        };
        let prime_offload = std::env::var_os("__NV_PRIME_RENDER_OFFLOAD");
        let glx_vendor = std::env::var_os("__GLX_VENDOR_LIBRARY_NAME");
        if webkit_version < (2, 48)
            || linux_uses_nvidia_renderer(
                Path::new("/sys/class/drm"),
                prime_offload.as_deref(),
                glx_vendor.as_deref(),
            )
        {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }
    // WebAssembly tier-up kills the renderer on x86-64 CPUs without AVX
    // (GeoLibre#2087). When a loop inside a WebAssembly function gets hot,
    // JavaScriptCore performs OSR entry into a JIT tier, and that path runs
    // `ctiMasmProbeTrampoline`, which spills xmm0-xmm15 with VEX-encoded
    // `vmovaps` and no runtime AVX check. On a CPU without AVX the first of
    // those instructions raises SIGILL, the WebKitWebProcess dies, and the
    // window stays blank forever with nothing shown to the user. It is an
    // upstream WebKit bug that no GeoLibre code can avoid emitting, and it is
    // reached in normal use because the app runs WebAssembly (DuckDB-WASM,
    // Whitebox) in a worker. All we can do is keep JavaScriptCore off the OSR
    // entry path. WebAssembly still gets baseline-compiled when a function is
    // called repeatedly, so the cost is bounded (a few times slower on repeated
    // calls; a single long-running call with a hot loop stays interpreted)
    // instead of the app being unusable. Verified against WebKitGTK 2.52.6 by
    // breakpointing the trampoline in the web process: with both options off it
    // is never entered, with either one on it still is.
    let cpu_supports_avx = cpu_supports_avx();
    let kept_on = WASM_OSR_ENTRY_JSC_OPTIONS
        .into_iter()
        .find(|option| std::env::var_os(option).is_some_and(|value| !jsc_option_is_off(&value)));
    if linux_needs_wasm_osr_workaround(cpu_supports_avx, kept_on.is_some()) {
        for option in WASM_OSR_ENTRY_JSC_OPTIONS {
            if std::env::var_os(option).is_none() {
                std::env::set_var(option, "false");
            }
        }
        eprintln!(
            "GeoLibre: this CPU has no AVX, so WebAssembly tier-up would crash the WebKit \
             renderer (see GeoLibre issue 2087). {} are off to keep the app running; \
             WebAssembly-heavy work will be slower.",
            WASM_OSR_ENTRY_JSC_OPTIONS.join(" and ")
        );
    } else if !cpu_supports_avx {
        if let Some(option) = kept_on {
            eprintln!(
                "GeoLibre: this CPU has no AVX, but {option} is set to keep WebAssembly tier-up \
                 on, so the workaround for GeoLibre issue 2087 was left alone. The renderer can \
                 still die with SIGILL unless {} are both off.",
                WASM_OSR_ENTRY_JSC_OPTIONS.join(" and ")
            );
        }
    }

    // Prefer portal-backed native dialogs on Linux. This avoids GTK/GIO file
    // metadata warnings that can appear around file and folder pickers.
    if std::env::var_os("GTK_USE_PORTAL").is_none() {
        std::env::set_var("GTK_USE_PORTAL", "1");
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_linux_webkit() {}

#[cfg(test)]
mod tests {
    use super::{
        client_cert_is_pkcs12, client_cert_password_without_path, ensure_fetchable_url,
        is_allowed_local_vector_path, is_allowed_project_path, is_disallowed_ip,
        is_safe_absolute_path, is_ssrf_guard_error, path_is_under, resolve_fetch_timeout_secs,
        tcp_table_port, MAX_FETCH_TIMEOUT_SECS, REMOTE_TILE_TIMEOUT_SECS, SSRF_BLOCKED_MESSAGE,
    };
    #[cfg(target_os = "linux")]
    use super::{
        cpu_supports_avx, jsc_option_is_off, linux_needs_wasm_osr_workaround,
        linux_uses_nvidia_renderer, nvidia_is_primary_gpu, WASM_OSR_ENTRY_JSC_OPTIONS,
    };
    // Everything these imports feed is compiled out of the `mas` build, so the
    // tests that exercise it (and their scaffolding) are gated with it.
    #[cfg(not(feature = "mas"))]
    use super::{
        add_main_sidecar_extras, child_failure_message, clear_appimage_python_env,
        find_zip_manifest_path, plugin_archive_file_name, resolve_sidecar_in_resource_dir,
        CapturedOutput, CAPTURED_LOG_MAX_LINES, CAPTURED_LOG_REPORTED_LINES, CAPTURED_LOG_SETTLE,
    };
    #[cfg(not(feature = "mas"))]
    use std::env;
    #[cfg(not(feature = "mas"))]
    use std::ffi::OsStr;
    #[cfg(not(feature = "mas"))]
    use std::io::{Cursor, Write};
    use std::net::IpAddr;
    #[cfg(not(feature = "mas"))]
    use std::path::PathBuf;
    #[cfg(not(feature = "mas"))]
    use std::process::Command;
    #[cfg(not(feature = "mas"))]
    use std::sync::Mutex;
    #[cfg(not(feature = "mas"))]
    use std::time::Duration;

    // `std::env::set_var` is process-global, so the tests that stage an AppImage
    // environment must not run concurrently with each other.
    #[cfg(not(feature = "mas"))]
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[cfg(not(feature = "mas"))]
    #[test]
    fn main_sidecar_installs_postgis_runtime() {
        let mut command = Command::new("uv");
        add_main_sidecar_extras(&mut command);
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(
            args,
            [
                OsStr::new("--extra"),
                OsStr::new("ml"),
                OsStr::new("--extra"),
                OsStr::new("postgis"),
            ]
        );
    }

    // A throwaway directory tree under the system temp dir that removes itself
    // on drop, so scratch dirs are cleaned up even when an assertion panics.
    // Uses the process id (no rand dependency) and clears any leftover from a
    // prior run at construction.
    #[cfg(not(feature = "mas"))]
    struct ScratchDir(PathBuf);

    #[cfg(not(feature = "mas"))]
    impl ScratchDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("geolibre-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    #[cfg(not(feature = "mas"))]
    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(all(target_os = "linux", not(feature = "mas")))]
    #[test]
    fn detects_primary_nvidia_gpu() {
        let root = ScratchDir::new("nvidia-primary");
        let device = root.path().join("card0/device");
        std::fs::create_dir_all(&device).unwrap();
        std::fs::write(device.join("vendor"), "0x10de\n").unwrap();
        std::fs::write(device.join("boot_vga"), "1\n").unwrap();
        std::os::unix::fs::symlink("/sys/bus/pci/drivers/nvidia", device.join("driver")).unwrap();

        assert!(nvidia_is_primary_gpu(root.path()));
    }

    #[cfg(all(target_os = "linux", not(feature = "mas")))]
    #[test]
    fn ignores_secondary_nvidia_gpu() {
        let root = ScratchDir::new("nvidia-secondary");
        let device = root.path().join("card1/device");
        std::fs::create_dir_all(&device).unwrap();
        std::fs::write(device.join("vendor"), "0x10de\n").unwrap();
        std::fs::write(device.join("boot_vga"), "0\n").unwrap();
        std::os::unix::fs::symlink("/sys/bus/pci/drivers/nvidia", device.join("driver")).unwrap();

        assert!(!nvidia_is_primary_gpu(root.path()));
    }

    #[cfg(all(target_os = "linux", not(feature = "mas")))]
    #[test]
    fn ignores_primary_nvidia_gpu_using_nouveau() {
        let root = ScratchDir::new("nouveau-primary");
        let device = root.path().join("card0/device");
        std::fs::create_dir_all(&device).unwrap();
        std::fs::write(device.join("vendor"), "0x10de\n").unwrap();
        std::fs::write(device.join("boot_vga"), "1\n").unwrap();
        std::os::unix::fs::symlink("/sys/bus/pci/drivers/nouveau", device.join("driver")).unwrap();

        assert!(!nvidia_is_primary_gpu(root.path()));
    }

    #[cfg(all(target_os = "linux", not(feature = "mas")))]
    #[test]
    fn detects_explicit_nvidia_renderer_environment() {
        let root = ScratchDir::new("nvidia-renderer-env");

        assert!(linux_uses_nvidia_renderer(
            root.path(),
            Some(OsStr::new("1")),
            None,
        ));
        assert!(linux_uses_nvidia_renderer(
            root.path(),
            None,
            Some(OsStr::new("NVIDIA")),
        ));
        assert!(!linux_uses_nvidia_renderer(
            root.path(),
            Some(OsStr::new("0")),
            Some(OsStr::new("mesa")),
        ));
    }

    // Regression for issue #2087: on an x86-64 CPU without AVX, WebKitGTK's
    // WebAssembly OSR entry runs an unconditionally AVX trampoline and takes
    // the renderer down with SIGILL, so both options have to be pinned off.
    #[cfg(all(target_os = "linux", not(feature = "mas")))]
    #[test]
    fn disables_wasm_osr_entry_only_without_avx() {
        assert!(linux_needs_wasm_osr_workaround(false, false));
        assert!(!linux_needs_wasm_osr_workaround(true, false));
    }

    // Turning either option back on is the escape hatch, and it takes the whole
    // pair out of GeoLibre's hands: half the workaround costs WebAssembly
    // performance without saving the renderer.
    #[cfg(all(target_os = "linux", not(feature = "mas")))]
    #[test]
    fn keeps_an_explicit_wasm_osr_setting() {
        assert!(!linux_needs_wasm_osr_workaround(false, true));
        assert!(!linux_needs_wasm_osr_workaround(true, true));
    }

    // An option someone already turned off is not an opt-out, so the other half
    // of the pair still gets applied. Which values count as off is
    // JavaScriptCore's rule, verified against WebKitGTK 2.52.6: `false` and
    // `no` in any case, and `0`, disable an option; `true`, `yes` and `1` turn
    // it on; and a value it cannot parse leaves the default, which for both of
    // these options is on.
    #[cfg(all(target_os = "linux", not(feature = "mas")))]
    #[test]
    fn reads_wasm_osr_values_the_way_javascriptcore_does() {
        for off in ["false", "FALSE", "False", "no", "NO", "No", "0"] {
            assert!(jsc_option_is_off(OsStr::new(off)), "{off}");
        }
        for on in ["true", "TRUE", "1", "yes", "YES", "garbage", ""] {
            assert!(!jsc_option_is_off(OsStr::new(on)), "{on}");
        }
    }

    // Both options are needed: with either one left on, the web process still
    // enters the trampoline (measured on WebKitGTK 2.52.6). They are read by
    // JavaScriptCore straight out of the environment, so the names carry the
    // `JSC_` prefix.
    #[cfg(all(target_os = "linux", not(feature = "mas")))]
    #[test]
    fn pins_both_javascriptcore_wasm_osr_options() {
        assert_eq!(
            WASM_OSR_ENTRY_JSC_OPTIONS,
            ["JSC_useWasmOSR", "JSC_useBBQTierUpChecks"]
        );
    }

    // Every architecture other than x86 skips the workaround, and the x86
    // answer has to come from the running CPU rather than from build flags.
    #[cfg(all(target_os = "linux", not(feature = "mas")))]
    #[test]
    fn reports_avx_support_for_this_cpu() {
        let supported = cpu_supports_avx();
        if !cfg!(any(target_arch = "x86", target_arch = "x86_64")) {
            assert!(supported);
            return;
        }
        // Cross-check against the kernel where it reports the flags. A
        // hypervisor can mask them, and a restricted /proc need not carry a
        // `flags` line at all, so a missing line means "nothing to compare",
        // not a failure.
        let cpuinfo = std::fs::read_to_string("/proc/cpuinfo").unwrap_or_default();
        let mut flag_lines = cpuinfo.lines().filter(|line| line.starts_with("flags"));
        if let Some(flags) = flag_lines.next() {
            assert_eq!(supported, flags.split_whitespace().any(|flag| flag == "avx"));
        }
    }

    // Regression for issue #1223: installed builds place the bundled sidecar at
    // `<resource_dir>/_up_/_up_/_up_/backend/geolibre_server`, so the resolver
    // must follow the `_up_` chain rather than only checking the resource root.
    #[cfg(not(feature = "mas"))]
    #[test]
    fn resolves_bundled_sidecar_under_up_prefix() {
        let root = ScratchDir::new("sidecar-up");
        let project = root
            .path()
            .join("_up_")
            .join("_up_")
            .join("_up_")
            .join("backend")
            .join("geolibre_server");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("pyproject.toml"), "[project]\n").unwrap();

        let resolved =
            resolve_sidecar_in_resource_dir(root.path()).expect("sidecar should be found");
        assert_eq!(resolved, project.canonicalize().unwrap());

        // The plain (0-level) layout used by portable builds, where the sidecar
        // sits at `backend/geolibre_server` directly under the resource dir.
        let plain_root = ScratchDir::new("sidecar-plain");
        let plain_project = plain_root.path().join("backend").join("geolibre_server");
        std::fs::create_dir_all(&plain_project).unwrap();
        std::fs::write(plain_project.join("pyproject.toml"), "[project]\n").unwrap();
        let plain_resolved = resolve_sidecar_in_resource_dir(plain_root.path())
            .expect("plain sidecar should be found");
        assert_eq!(plain_resolved, plain_project.canonicalize().unwrap());

        // A resource dir without the project (and without a pyproject marker)
        // resolves to nothing rather than a false positive.
        let empty = ScratchDir::new("sidecar-empty");
        assert!(resolve_sidecar_in_resource_dir(empty.path()).is_none());
    }

    // Issue #1220: a client certificate is read as PKCS#12 when its extension is
    // `.p12`/`.pfx` (case-insensitively) or a passphrase is supplied; everything
    // else is treated as PEM.
    #[test]
    fn classifies_client_cert_format() {
        use std::path::Path;
        // Extension selects PKCS#12, case-insensitively.
        assert!(client_cert_is_pkcs12(Path::new("/certs/id.p12"), false));
        assert!(client_cert_is_pkcs12(Path::new("/certs/id.PFX"), false));
        // PEM (and unrecognised) extensions stay PEM without a passphrase.
        assert!(!client_cert_is_pkcs12(Path::new("/certs/id.pem"), false));
        assert!(!client_cert_is_pkcs12(Path::new("/certs/id.crt"), false));
        assert!(!client_cert_is_pkcs12(Path::new("/certs/id"), false));
        // A passphrase forces PKCS#12 even for a PEM-looking or extensionless path.
        assert!(client_cert_is_pkcs12(Path::new("/certs/id.pem"), true));
        assert!(client_cert_is_pkcs12(Path::new("/certs/id"), true));
    }

    // Issue #1220: a passphrase without a certificate path is a misconfiguration
    // (it configures nothing on its own) and must be surfaced, not dropped.
    #[test]
    fn flags_passphrase_without_certificate_path() {
        assert!(client_cert_password_without_path(false, true));
        // A passphrase with a cert path, or no passphrase at all, is fine.
        assert!(!client_cert_password_without_path(true, true));
        assert!(!client_cert_password_without_path(false, false));
        assert!(!client_cert_password_without_path(true, false));
    }

    #[test]
    fn blocks_link_local_and_metadata_ips() {
        for ip in [
            "169.254.169.254",        // cloud metadata (link-local)
            "169.254.0.1",            // link-local
            "0.0.0.0",                // unspecified
            "255.255.255.255",        // broadcast
            "::",                     // unspecified
            "fe80::1",                // link-local
            "::ffff:169.254.169.254", // IPv4-mapped metadata
            "::169.254.169.254",      // IPv4-compatible metadata (deprecated)
        ] {
            assert!(
                is_disallowed_ip(ip.parse::<IpAddr>().unwrap()),
                "expected {ip} to be blocked"
            );
        }
    }

    #[test]
    fn allows_public_loopback_and_lan_ips() {
        // Public plus loopback/LAN, which stay reachable for local tile/COG
        // data (issue #387). Only link-local/metadata is blocked.
        for ip in [
            "8.8.8.8",
            "1.1.1.1",
            "93.184.216.34",
            "2606:4700:4700::1111",
            "127.0.0.1",    // loopback (local dev tile server)
            "192.168.1.10", // LAN
            "10.0.0.5",     // LAN
            "::1",          // loopback
        ] {
            assert!(
                !is_disallowed_ip(ip.parse::<IpAddr>().unwrap()),
                "expected {ip} to be allowed"
            );
        }
    }

    #[test]
    fn ensure_fetchable_url_blocks_metadata_and_bad_schemes() {
        assert!(ensure_fetchable_url("http://169.254.169.254/latest/meta-data").is_err());
        assert!(ensure_fetchable_url("file:///etc/passwd").is_err());
        assert!(ensure_fetchable_url("ftp://example.com/x").is_err());
        // Public and loopback/LAN literals are allowed (local data workflow).
        assert!(ensure_fetchable_url("https://1.1.1.1/").is_ok());
        assert!(ensure_fetchable_url("http://127.0.0.1:8081/tiles/0/0/0.png").is_ok());
        assert!(ensure_fetchable_url("http://[::1]:8081/data.pmtiles").is_ok());
    }

    #[test]
    fn ssrf_guard_error_is_detected_through_the_source_chain() {
        use std::error::Error;
        use std::fmt;

        #[derive(Debug)]
        struct Wrapper(Box<dyn Error + Send + Sync>);
        impl fmt::Display for Wrapper {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                // Deliberately hides the cause, the way reqwest's "error
                // following redirect" / connector errors hide theirs.
                write!(f, "error following redirect for url (https://example.com/)")
            }
        }
        impl Error for Wrapper {
            fn source(&self) -> Option<&(dyn Error + 'static)> {
                Some(self.0.as_ref())
            }
        }

        let blocked = Wrapper(SSRF_BLOCKED_MESSAGE.into());
        assert!(!blocked.to_string().contains(SSRF_BLOCKED_MESSAGE));
        assert!(is_ssrf_guard_error(&blocked));

        // A genuine transport failure must stay fallback-eligible.
        let transport = Wrapper("connection reset by peer".into());
        assert!(!is_ssrf_guard_error(&transport));
    }

    #[test]
    fn project_path_guard_allows_projects_and_blocks_secrets() {
        assert!(is_allowed_project_path("/home/u/map.geolibre.json"));
        assert!(is_allowed_project_path("/home/u/map.geolibre"));
        assert!(is_allowed_project_path("C:\\Users\\u\\map.geolibre.json"));
        // Secrets and traversal are refused.
        assert!(!is_allowed_project_path("/home/u/.ssh/id_rsa"));
        assert!(!is_allowed_project_path("/home/u/.aws/credentials"));
        assert!(!is_allowed_project_path(
            "/home/u/../../etc/hosts.geolibre.json"
        ));
        assert!(!is_allowed_project_path("relative/map.geolibre.json"));
        assert!(!is_allowed_project_path(
            "\\\\server\\share\\map.geolibre.json"
        ));
        // A bare .json file (e.g. a JSON credential store) is NOT a project.
        assert!(!is_allowed_project_path(
            "/home/u/.config/gcloud/application_default_credentials.json"
        ));
        assert!(!is_allowed_project_path("C:\\Users\\u\\map.json"));
    }

    #[test]
    fn allows_absolute_vector_paths() {
        assert!(is_allowed_local_vector_path("/home/u/cities.geojson"));
        assert!(is_allowed_local_vector_path(
            "C:\\Users\\smith\\Mile_Markers.geojson"
        ));
        assert!(is_allowed_local_vector_path("C:/data/roads.gpkg"));
        // Case-insensitive extension; a ".." inside the filename is fine.
        assert!(is_allowed_local_vector_path("/data/v1..2.SHP"));
    }

    #[test]
    fn rejects_non_vector_relative_or_traversal_paths() {
        // Non-vector extension.
        assert!(!is_allowed_local_vector_path("/etc/passwd"));
        // Relative path.
        assert!(!is_allowed_local_vector_path("cities.geojson"));
        // Directory traversal segments.
        assert!(!is_allowed_local_vector_path("/data/../etc/secret.geojson"));
        assert!(!is_allowed_local_vector_path(
            "C:\\data\\..\\secret.geojson"
        ));
        // UNC network paths, both the backslash and forward-slash forms.
        assert!(!is_allowed_local_vector_path(
            "\\\\server\\share\\x.geojson"
        ));
        assert!(!is_allowed_local_vector_path("//server/share/x.geojson"));
        // Empty string is not an absolute path.
        assert!(!is_allowed_local_vector_path(""));
        // No extension, and a trailing dot (empty extension).
        assert!(!is_allowed_local_vector_path("/home/user/noextension"));
        assert!(!is_allowed_local_vector_path("/home/user/file."));
    }

    #[cfg(not(feature = "mas"))]
    fn zip_with_names(names: &[&str]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for name in names {
            writer.start_file(*name, options).unwrap();
            writer.write_all(b"x").unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[cfg(not(feature = "mas"))]
    fn manifest_path(names: &[&str]) -> Option<String> {
        let bytes = zip_with_names(names);
        let archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        find_zip_manifest_path(&archive)
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn finds_root_manifest() {
        assert_eq!(
            manifest_path(&["plugin.json", "dist/plugin.js"]).as_deref(),
            Some("plugin.json")
        );
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn finds_manifest_inside_a_wrapping_folder() {
        assert_eq!(
            manifest_path(&["my-plugin/plugin.json", "my-plugin/dist/plugin.js"]).as_deref(),
            Some("my-plugin/plugin.json")
        );
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn prefers_root_and_ignores_macosx_metadata() {
        // A root manifest wins over a deeper one.
        assert_eq!(
            manifest_path(&["wrap/plugin.json", "plugin.json"]).as_deref(),
            Some("plugin.json")
        );
        // The __MACOSX folder is skipped, so the real wrapped manifest is found.
        assert_eq!(
            manifest_path(&["__MACOSX/wrap/._plugin.json", "wrap/plugin.json"]).as_deref(),
            Some("wrap/plugin.json")
        );
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn returns_none_without_a_manifest() {
        assert_eq!(manifest_path(&["dist/plugin.js"]), None);
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn keeps_safe_plugin_ids() {
        assert_eq!(plugin_archive_file_name("maplibre-foo"), "maplibre-foo.zip");
        assert_eq!(plugin_archive_file_name("foo.bar_2"), "foo.bar_2.zip");
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn sanitizes_unsafe_characters_and_traversal() {
        // Path separators and other characters cannot escape the plugins dir;
        // leading dots are then stripped, so "../evil" collapses to "_evil".
        assert_eq!(plugin_archive_file_name("../evil"), "_evil.zip");
        assert_eq!(plugin_archive_file_name("a/b"), "a_b.zip");
        // Leading dots are stripped so the archive is never hidden.
        assert_eq!(plugin_archive_file_name("..hidden"), "hidden.zip");
        // A name that sanitizes away entirely falls back to a fixed stem.
        assert_eq!(plugin_archive_file_name("..."), "plugin.zip");
    }

    #[test]
    fn is_safe_absolute_path_accepts_absolute_local_dirs() {
        assert!(is_safe_absolute_path("/home/user/data"));
        assert!(is_safe_absolute_path("/data"));
        assert!(is_safe_absolute_path("C:\\Users\\me\\gis"));
        assert!(is_safe_absolute_path("C:/Users/me/gis"));
        // A ".." inside a name (not a traversal segment) is fine.
        assert!(is_safe_absolute_path("/home/user/v1..2"));
    }

    #[test]
    fn is_safe_absolute_path_rejects_unc_traversal_and_relative() {
        // UNC shares (both forms) can auto-authenticate against a remote host.
        assert!(!is_safe_absolute_path("\\\\server\\share"));
        assert!(!is_safe_absolute_path("//server/share"));
        // `..` traversal segments.
        assert!(!is_safe_absolute_path("/home/user/../etc"));
        assert!(!is_safe_absolute_path("C:\\a\\..\\b"));
        // Relative / non-absolute and empty input.
        assert!(!is_safe_absolute_path("home/user"));
        assert!(!is_safe_absolute_path("./data"));
        assert!(!is_safe_absolute_path(""));
        assert!(!is_safe_absolute_path("C:")); // drive letter without a separator
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn captured_output_keeps_only_the_trailing_lines() {
        let captured = CapturedOutput::new();
        for index in 0..(CAPTURED_LOG_MAX_LINES * 3) {
            captured.push(format!("line {index}"));
        }
        let tail = captured.tail();
        let lines: Vec<_> = tail.lines().collect();
        // The buffer is bounded and the report quotes only its end, so a child
        // that writes thousands of lines still yields a short, recent tail.
        assert_eq!(lines.len(), CAPTURED_LOG_REPORTED_LINES);
        let last = CAPTURED_LOG_MAX_LINES * 3 - 1;
        assert_eq!(lines[lines.len() - 1], format!("line {last}"));
        assert_eq!(
            lines[0],
            format!("line {}", last + 1 - CAPTURED_LOG_REPORTED_LINES)
        );
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn captured_output_drops_blank_lines_from_the_tail() {
        let captured = CapturedOutput::new();
        captured.push("error: Failed to spawn: `jupyter`".to_string());
        captured.push("   ".to_string());
        captured.push(String::new());
        captured.push("  Caused by: No such file or directory (os error 2)  ".to_string());
        assert_eq!(
            captured.tail(),
            "error: Failed to spawn: `jupyter`\n  Caused by: No such file or directory (os error 2)"
        );
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn child_failure_message_quotes_the_child_output() {
        let captured = CapturedOutput::new();
        captured.push("error: Extra `notebook` is not defined".to_string());
        let message = child_failure_message("Jupyter server exited.", &captured);
        assert!(message.starts_with("Jupyter server exited."));
        // The cause has to travel with the error: an installed build is
        // GUI-subsystem on Windows and has no terminal to read it from.
        assert!(message.contains("error: Extra `notebook` is not defined"));
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn child_failure_message_says_so_when_there_was_no_output() {
        let message = child_failure_message("Jupyter server exited.", &CapturedOutput::new());
        assert_eq!(message, "Jupyter server exited. It produced no output.");
    }

    // The whole point of the capture is that the child's *last* lines — the
    // error that killed it — reach the report. `try_wait` can observe the exit
    // while those lines are still in the pipe, so the report has to wait for the
    // readers to drain. Uses a real child so the race is real: a spawn that
    // writes and exits immediately, reported the way the health waiters do.
    #[cfg(all(unix, not(feature = "mas")))]
    #[test]
    fn child_failure_message_waits_for_output_still_in_the_pipe() {
        use std::process::{Command, Stdio};

        let mut child = Command::new("sh")
            .arg("-c")
            .arg("echo 'error: the cause'; echo 'to stderr' >&2")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn a child that writes and exits");
        let output = CapturedOutput::attach(&mut child);
        // Mirror the waiters: report as soon as the exit is observed.
        while child.try_wait().expect("inspect child").is_none() {
            std::thread::sleep(Duration::from_millis(5));
        }
        let message = child_failure_message("Child exited.", &output);
        assert!(message.contains("error: the cause"), "got: {message}");
        assert!(message.contains("to stderr"), "got: {message}");
    }

    // The race the report has to win, made deterministic. A reader that is
    // provably still behind at report time stands in for bytes sitting in the
    // OS pipe after `try_wait` has already reported the child gone. Without
    // `settle` the report races past it and quotes nothing — which is the
    // failure mode the capture exists to prevent. (The real-child test above
    // exercises the same path end to end, but its timing is not guaranteed:
    // on a fast machine the reader usually wins on its own.)
    #[cfg(not(feature = "mas"))]
    #[test]
    fn child_failure_message_waits_for_output_still_in_flight() {
        struct SlowThenEof {
            sent: bool,
        }
        impl std::io::Read for SlowThenEof {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.sent {
                    return Ok(0); // EOF
                }
                std::thread::sleep(Duration::from_millis(100));
                let line = b"error: the cause\n";
                buf[..line.len()].copy_from_slice(line);
                self.sent = true;
                Ok(line.len())
            }
        }

        let captured = CapturedOutput::new();
        captured.drain(SlowThenEof { sent: false }, false);
        let message = child_failure_message("Child exited.", &captured);
        assert!(message.contains("error: the cause"), "got: {message}");
    }

    // AppImageKit's AppRun exports PYTHONHOME=$APPDIR/usr/ into every child. A
    // Python that honours it looks for its stdlib inside the AppImage mount and
    // aborts with "Failed to import encodings module" before running any code,
    // which is how the Notebook panel and the sidecar died in AppImage builds.
    // Serialized with the other env-mutating test: these share process env.
    #[cfg(not(feature = "mas"))]
    #[test]
    fn appimage_python_env_is_stripped_from_children() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let appdir = "/tmp/.mount_GeoLibreXXXX";
        // Reproduce what AppRun exports.
        env::set_var("APPDIR", appdir);
        env::set_var("PYTHONHOME", format!("{appdir}/usr/"));
        env::set_var(
            "PYTHONPATH",
            format!("{appdir}/usr/share/pyshared/:/home/me/lib"),
        );
        env::set_var(
            "LD_LIBRARY_PATH",
            format!("{appdir}/usr/lib/:{appdir}/lib/"),
        );

        let mut command = Command::new("true");
        clear_appimage_python_env(&mut command);
        let envs: Vec<_> = command.get_envs().collect();
        let lookup = |name: &str| {
            envs.iter()
                .find(|(key, _)| *key == OsStr::new(name))
                .map(|(_, value)| *value)
        };

        // PYTHONHOME is dropped outright — it is the fatal one.
        assert_eq!(lookup("PYTHONHOME"), Some(None));
        // The user's own PYTHONPATH entry survives; the AppDir one does not.
        assert_eq!(lookup("PYTHONPATH"), Some(Some(OsStr::new("/home/me/lib"))));
        // Every LD_LIBRARY_PATH entry was an AppDir entry, so the variable is
        // unset rather than passed through empty.
        assert_eq!(lookup("LD_LIBRARY_PATH"), Some(None));

        env::remove_var("APPDIR");
        env::remove_var("PYTHONHOME");
        env::remove_var("PYTHONPATH");
        env::remove_var("LD_LIBRARY_PATH");
    }

    // Outside an AppImage nothing is filtered: a user who deliberately set these
    // for their own Python must keep them.
    #[cfg(not(feature = "mas"))]
    #[test]
    fn python_env_is_untouched_outside_an_appimage() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        env::remove_var("APPDIR");
        env::set_var("PYTHONPATH", "/home/me/lib:/opt/other");

        let mut command = Command::new("true");
        clear_appimage_python_env(&mut command);
        let value = command
            .get_envs()
            .find(|(key, _)| *key == OsStr::new("PYTHONPATH"))
            .map(|(_, value)| value);
        assert_eq!(value, Some(Some(OsStr::new("/home/me/lib:/opt/other"))));

        env::remove_var("PYTHONPATH");
    }

    // The Jupyter launch sets PYTHONPATH itself (notebook-lib, so `import
    // geolibre` works) before the sanitizer runs; the sanitizer must not
    // overwrite it.
    #[cfg(not(feature = "mas"))]
    #[test]
    fn a_pythonpath_the_caller_already_set_is_preserved() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        env::set_var("APPDIR", "/tmp/.mount_GeoLibreXXXX");
        env::set_var("PYTHONPATH", "/tmp/.mount_GeoLibreXXXX/usr/share/pyshared/");

        let mut command = Command::new("true");
        command.env("PYTHONPATH", "/app/runtime/notebook-lib");
        clear_appimage_python_env(&mut command);
        let value = command
            .get_envs()
            .find(|(key, _)| *key == OsStr::new("PYTHONPATH"))
            .map(|(_, value)| value);
        assert_eq!(value, Some(Some(OsStr::new("/app/runtime/notebook-lib"))));

        env::remove_var("APPDIR");
        env::remove_var("PYTHONPATH");
    }

    // A reader that never reaches EOF must not hang the report: `uv` spawns
    // `jupyter`, which spawns kernels holding these same pipe handles, so a
    // grandchild outliving the child keeps the write end open forever. `settle`
    // is bounded for exactly this case.
    #[cfg(not(feature = "mas"))]
    #[test]
    fn settle_gives_up_on_a_reader_that_never_reaches_eof() {
        struct NeverEnds;
        impl std::io::Read for NeverEnds {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                std::thread::sleep(Duration::from_millis(50));
                buf[0] = b'\n';
                Ok(1)
            }
        }

        let captured = CapturedOutput::new();
        captured.drain(NeverEnds, false);
        let started = std::time::Instant::now();
        captured.settle();
        // Bounded: returns at the deadline rather than blocking forever. The
        // generous upper bound keeps this from flaking on a loaded CI runner.
        assert!(
            started.elapsed() < CAPTURED_LOG_SETTLE * 10,
            "settle blocked for {:?}",
            started.elapsed()
        );
    }

    // The Windows reaper reads the local port out of a DWORD that holds it in
    // network byte order in its low word. Getting this wrong would match the
    // wrong listener (or none), so pin the decoding here -- these are pure
    // functions, so the check runs on every platform even though their only
    // caller is Windows-only.
    #[test]
    fn decodes_a_network_order_port_from_the_tcp_table() {
        // 8766 = 0x223E; network byte order puts 0x22 first, so the DWORD's low
        // word reads 0x3E22, and the high word is padding the API does not use.
        assert_eq!(tcp_table_port(0x0000_3E22), 8766);
        assert_eq!(tcp_table_port(0xDEAD_3E22), 8766);
        assert_eq!(tcp_table_port(0x0000_223E), 0x3E22);
    }

    // Add Vector Layer downloads a whole dataset through the same command that
    // fetches tiles, so it asks for a longer budget. The clamp is what keeps
    // that override from becoming a way to disable the timeout entirely.
    #[test]
    fn clamps_the_fetch_timeout_into_the_allowed_range() {
        // No override: the tile-sized default.
        assert_eq!(resolve_fetch_timeout_secs(None), REMOTE_TILE_TIMEOUT_SECS);
        // A dataset-sized budget is honored as asked.
        assert_eq!(resolve_fetch_timeout_secs(Some(180)), 180);
        // Zero would mean "no timeout" to reqwest, so it is raised to the floor
        // rather than letting a stalled request hang forever.
        assert_eq!(resolve_fetch_timeout_secs(Some(0)), REMOTE_TILE_TIMEOUT_SECS);
        // Below the floor is raised; above the ceiling is capped.
        assert_eq!(resolve_fetch_timeout_secs(Some(1)), REMOTE_TILE_TIMEOUT_SECS);
        assert_eq!(
            resolve_fetch_timeout_secs(Some(u64::MAX)),
            MAX_FETCH_TIMEOUT_SECS
        );
    }

    // The image-path guard is what keeps the reaper from killing a Jupyter the
    // user installed themselves: only executables under our own runtime
    // directory are ours to terminate.
    #[test]
    fn recognizes_only_paths_inside_the_runtime_directory() {
        let root =
            std::path::Path::new(r"C:\Users\me\AppData\Roaming\org.geolibre.desktop\runtime");
        assert!(path_is_under(
            std::path::Path::new(
                r"C:\Users\me\AppData\Roaming\org.geolibre.desktop\runtime\jupyter-server\Scripts\python.exe"
            ),
            root
        ));
        // Case and separator differences are not a mismatch on Windows.
        assert!(path_is_under(
            std::path::Path::new(
                r"c:\users\me\appdata\roaming\org.geolibre.desktop\RUNTIME/uv-bin/uv.exe"
            ),
            root
        ));
        // A sibling directory sharing the prefix is not inside it.
        assert!(!path_is_under(
            std::path::Path::new(
                r"C:\Users\me\AppData\Roaming\org.geolibre.desktop\runtime-old\jupyter-server\python.exe"
            ),
            root
        ));
        // The user's own Python is left alone.
        assert!(!path_is_under(
            std::path::Path::new(r"C:\Program Files\Python312\python.exe"),
            root
        ));
        // A non-ASCII profile name survives the fold: ASCII case folding leaves
        // it byte-identical on both sides, where Unicode lowercasing could
        // change its length and misalign the prefix.
        let unicode_root = std::path::Path::new(r"C:\Users\İŞIL\AppData\Roaming\runtime");
        assert!(path_is_under(
            std::path::Path::new(
                r"C:\Users\İŞIL\AppData\Roaming\runtime\jupyter-server\python.exe"
            ),
            unicode_root
        ));
        // The directory itself is not "inside" itself, and an empty root never
        // matches (which would otherwise make every listener look like ours).
        assert!(!path_is_under(root, root));
        assert!(!path_is_under(
            std::path::Path::new(r"C:\anything"),
            std::path::Path::new("")
        ));
    }
}
