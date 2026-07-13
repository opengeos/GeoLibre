mod earth_engine_oauth;
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

use earth_engine_oauth::{
    poll_earth_engine_oauth, start_earth_engine_oauth, EarthEngineOAuthState,
};
use flate2::read::{GzDecoder, ZlibDecoder};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::env;
use std::fs::{self, File};
use std::io::{Cursor, Read};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::Manager;

// OAuth popups are a desktop-only, multi-window concept; Android/iOS have no
// equivalent, and `WebviewWindowBuilder::{on_new_window, window_features}` do
// not exist on the mobile runtime.
#[cfg(desktop)]
static POPUP_COUNTER: AtomicU64 = AtomicU64::new(0);

const MARTIN_VERSION: &str = "martin-v1.10.1";
const MARTIN_RELEASE_BASE_URL: &str = "https://github.com/maplibre/martin/releases/download";
const MARTIN_START_ATTEMPTS: usize = 3;
const MARTIN_HEALTH_ATTEMPTS: usize = 30;
const SIDECAR_HEALTH_ATTEMPTS: usize = 180;
const SIDECAR_PORT: u16 = 8765;
// The desktop JupyterLab server for the Notebook panel. Loopback-bound and
// token-gated; uses its own uv project environment so it never disturbs the
// FastAPI sidecar's env. First start can be slow while uv syncs JupyterLab.
const JUPYTER_PORT: u16 = 8766;
// Polled once per second, so up to ~4 minutes — generous headroom for the
// first-run `uv sync` of JupyterLab on a cold cache.
const JUPYTER_HEALTH_ATTEMPTS: usize = 240;
const UV_INSTALL_BASE_URL: &str = "https://astral.sh/uv";
const REMOTE_TILE_TIMEOUT_SECS: u64 = 8;
const REMOTE_TILE_CONNECT_TIMEOUT_SECS: u64 = 4;
const URL_RESOLVE_TIMEOUT_SECS: u64 = 15;

#[cfg(unix)]
const SIGTERM: i32 = 15;
#[cfg(unix)]
const SIGKILL: i32 = 9;

#[cfg(unix)]
unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

struct MartinServerState {
    process: Mutex<Option<MartinProcess>>,
}

struct SidecarServerState {
    process: Mutex<Option<SidecarProcess>>,
}

struct JupyterServerState {
    process: Mutex<Option<JupyterProcess>>,
    // Token of the currently running server, so a reuse path can hand the same
    // URL back without restarting.
    token: Mutex<Option<String>>,
    // Held for the whole of start_jupyter_server_blocking so two concurrent
    // start calls can't both spawn on the same port (the loser would exit 1).
    startup: Mutex<()>,
}

struct MartinProcess {
    child: Child,
}

struct SidecarProcess {
    child: Child,
}

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

impl SidecarProcess {
    fn terminate(&mut self) {
        terminate_sidecar_child(&mut self.child);
    }
}

impl Drop for MartinProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for SidecarProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}

impl JupyterProcess {
    fn terminate(&mut self) {
        // Same process-group teardown as the sidecar (the child is spawned with
        // its own group, so this reaps `uv`/`jupyter`/kernel descendants).
        terminate_sidecar_child(&mut self.child);
    }
}

impl Drop for JupyterProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_linux_webkit();

    tauri::Builder::default()
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
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .manage(EarthEngineOAuthState::default())
        .manage(MartinServerState {
            process: Mutex::new(None),
        })
        .manage(SidecarServerState {
            process: Mutex::new(None),
        })
        .manage(JupyterServerState {
            process: Mutex::new(None),
            token: Mutex::new(None),
            startup: Mutex::new(()),
        })
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
fn guarded_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 10 {
            return attempt.stop();
        }
        match url_is_fetchable(attempt.url()) {
            Ok(()) => attempt.follow(),
            Err(_) => attempt.stop(),
        }
    })
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
    /// PKCS#12 identity, native-tls.
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
            return Err(format!("{HTTP_CLIENT_CERT_PASSWORD_ENV} is not valid UTF-8"));
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
        let identity = reqwest::Identity::from_pkcs12_der(&bytes, password.as_deref().unwrap_or(""))
            .map_err(|error| {
                format!(
                    "Could not load PKCS#12 client certificate {}: {error}",
                    path.display()
                )
            })?;
        Ok(Some(ClientIdentity::Pkcs12(identity)))
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
        Some(ClientIdentity::Pkcs12(identity)) => builder.use_native_tls().identity(identity),
        Some(ClientIdentity::Pem(identity)) => builder.use_rustls_tls().identity(identity),
        None => builder.use_rustls_tls(),
    };

    builder
        .build()
        .map_err(|error| format!("Could not create HTTP client: {error}"))
}

#[tauri::command]
async fn fetch_url_bytes(url: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_url_bytes_blocking(url))
        .await
        .map_err(|error| format!("Tile fetch task failed: {error}"))?
}

fn fetch_url_bytes_blocking(url: String) -> Result<Vec<u8>, String> {
    ensure_fetchable_url(&url)?;

    let client = guarded_http_client()?;

    let response = client
        .get(&url)
        .timeout(Duration::from_secs(REMOTE_TILE_TIMEOUT_SECS))
        .send()
        .map_err(|error| format!("Request failed: {error}"))?;
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

fn normalize_path_key(path: &Path) -> String {
    // Canonicalize so symlinks and case differences on case-insensitive file
    // systems (Windows, macOS) dedupe to one key; fall back to the raw path
    // when it does not exist yet.
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    canonical.to_string_lossy().replace('\\', "/")
}

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

fn is_zip_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
}

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
fn find_zip_manifest_path<R: Read + std::io::Seek>(archive: &zip::ZipArchive<R>) -> Option<String> {
    let names: Vec<&str> = archive.file_names().collect();
    if names.iter().any(|name| *name == "plugin.json") {
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

const MAX_PLUGIN_ENTRY_BYTES: u64 = 50 * 1024 * 1024;

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

fn validate_optional_manifest_string(field: &str, value: &str) -> Result<(), String> {
    if value.trim() != value {
        return Err(format!(
            "{field} must not have leading or trailing whitespace"
        ));
    }
    Ok(())
}

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
        .map_err(|error| format!("Request failed: {error}"))?;
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

#[tauri::command]
fn ensure_martin_binary(app: tauri::AppHandle) -> Result<MartinBinaryInfo, String> {
    ensure_martin_binary_path(&app)
}

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

#[tauri::command]
fn stop_martin_server(state: tauri::State<MartinServerState>) -> Result<(), String> {
    let mut process = state
        .process
        .lock()
        .map_err(|_| "Could not lock Martin process state.".to_string())?;
    *process = None;
    Ok(())
}

#[tauri::command]
async fn start_geolibre_sidecar(app: tauri::AppHandle) -> Result<SidecarServerInfo, String> {
    tauri::async_runtime::spawn_blocking(move || start_geolibre_sidecar_blocking(app))
        .await
        .map_err(|error| format!("Could not join sidecar startup task: {error}"))?
}

fn start_geolibre_sidecar_blocking(app: tauri::AppHandle) -> Result<SidecarServerInfo, String> {
    let base_url = sidecar_base_url();
    let state = app.state::<SidecarServerState>();
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
        // A sidecar is listening but rejects this session's token — an orphan
        // from a previous launch still holding the port. We can't reclaim it
        // (no child handle here, and /shutdown is token-protected), so fail with
        // a clear message rather than handing back a token that 401s every call.
        return Err(
            "A GeoLibre processing server from a previous session is still \
             running on port 8765 but does not accept this session's token. \
             Quit any stray GeoLibre processes and try again."
                .to_string(),
        );
    }

    let uv = ensure_managed_uv(&app)?;
    let project_dir = sidecar_project_dir(&app)?;
    let runtime_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("runtime");

    let mut command = Command::new(&uv);
    command
        .arg("run")
        .arg("--project")
        .arg(&project_dir)
        // The AI segmentation `/ml` endpoints proxy to samgeo-api from inside
        // this main sidecar process and need `httpx`, which lives in the `ml`
        // extra. Unlike whitebox/conversion (separate managed venvs), ml has no
        // lazy bootstrap, so the extra must be synced into the sidecar env here.
        .arg("--extra")
        .arg("ml")
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

    if let Err(error) = wait_for_sidecar_health(&base_url, &mut child) {
        terminate_sidecar_child(&mut child);
        return Err(error);
    }

    let _ = child.stdout.take();
    let _ = child.stderr.take();

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

#[tauri::command]
async fn stop_geolibre_sidecar(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_geolibre_sidecar_blocking(app))
        .await
        .map_err(|error| format!("Could not join sidecar stop task: {error}"))?
}

fn stop_geolibre_sidecar_blocking(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<SidecarServerState>();
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

#[tauri::command]
async fn start_jupyter_server(app: tauri::AppHandle) -> Result<JupyterServerInfo, String> {
    tauri::async_runtime::spawn_blocking(move || start_jupyter_server_blocking(app))
        .await
        .map_err(|error| format!("Could not join Jupyter startup task: {error}"))?
}

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

    // A Jupyter server from a previous app session may still hold the port. We
    // can't reuse it (its per-launch token is unknown to us), and because we
    // spawn with `--ServerApp.port_retries=0`, a new server would fail to bind
    // and exit 1 ("exited before it was ready") while the orphan lingers. Clear
    // any stale listener and wait for the port to free before spawning.
    let _ = terminate_jupyter_listeners_on_port(JUPYTER_PORT);
    wait_for_port_free(JUPYTER_PORT);

    let uv = ensure_managed_uv(&app)?;
    let project_dir = sidecar_project_dir(&app)?;
    let config_path = project_dir.join("jupyter_server_config.py");
    let runtime_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("runtime");
    // Notebooks are saved here (the JupyterLab file browser root).
    let notebooks_dir = runtime_dir.join("notebooks");
    let _ = fs::create_dir_all(&notebooks_dir);
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
    let lib_dir = runtime_dir.join("notebook-lib");
    let _ = fs::create_dir_all(&lib_dir);
    let _ = fs::copy(
        project_dir.join("notebook_client.py"),
        lib_dir.join("geolibre.py"),
    );
    let token = generate_jupyter_token();

    let mut command = Command::new(&uv);
    command
        .arg("run")
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
        // Inherit (don't capture) stdout/stderr. Unlike the sidecar's quiet
        // uvicorn, `uv sync` of JupyterLab + JupyterLab's own startup write a lot;
        // a captured 64 KB pipe we don't drain during the health wait would fill
        // and block the child, so it would never become ready. Inheriting also
        // surfaces the logs in the dev terminal for debugging.
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    configure_sidecar_process(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start Jupyter server: {error}"))?;

    let base_url = jupyter_base_url();
    if let Err(error) = wait_for_jupyter_health(&base_url, &token, &mut child) {
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

#[tauri::command]
async fn stop_jupyter_server(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_jupyter_server_blocking(app))
        .await
        .map_err(|error| format!("Could not join Jupyter stop task: {error}"))?
}

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
    // Backstop: reap anything still bound to the port (no-op on non-unix and
    // when nothing is listening).
    terminate_jupyter_listeners_on_port(JUPYTER_PORT)?;
    Ok(())
}

fn jupyter_base_url() -> String {
    format!("http://127.0.0.1:{JUPYTER_PORT}")
}

// Wait (briefly) until `port` can be bound, i.e. a just-terminated listener has
// fully released it. Binding then dropping leaves a small race window, but it is
// enough to avoid a `--port-retries=0` bind failure right after killing an orphan.
fn wait_for_port_free(port: u16) {
    for _ in 0..20 {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

// Prepend `dir` to any inherited PYTHONPATH (platform separator), so a user's
// existing value is preserved rather than clobbered.
fn prepend_pythonpath(dir: &Path) -> String {
    let dir = dir.display().to_string();
    match env::var("PYTHONPATH") {
        Ok(existing) if !existing.is_empty() => {
            let sep = if cfg!(windows) { ";" } else { ":" };
            format!("{dir}{sep}{existing}")
        }
        _ => dir,
    }
}

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

fn wait_for_jupyter_health(base_url: &str, token: &str, child: &mut Child) -> Result<(), String> {
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
            // Output is inherited (visible in the terminal), not captured, so we
            // surface only the exit status here.
            return Err(format!(
                "Jupyter server exited before it was ready (exit status: {status}). \
                 Check the terminal for the Jupyter/uv startup output."
            ));
        }

        if jupyter_health_is_ready(&client, base_url, token) {
            return Ok(());
        }

        thread::sleep(Duration::from_secs(1));
    }

    Err("Jupyter server did not become ready in time.".to_string())
}

// A loopback-bound, per-launch token for the desktop Jupyter server. It is the
// only barrier once the XSRF check is disabled for the embedded iframe (see
// jupyter_server_config.py), so use the OS CSPRNG (128 random bits) rather than
// anything derived from the clock/pid.
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
fn sidecar_token() -> &'static str {
    static TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TOKEN.get_or_init(generate_jupyter_token)
}

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

fn wait_for_sidecar_stop(base_url: &str) {
    for _ in 0..20 {
        if !sidecar_health_is_ready(base_url) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn wait_for_sidecar_health(base_url: &str, child: &mut Child) -> Result<(), String> {
    for _ in 0..SIDECAR_HEALTH_ATTEMPTS {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not inspect sidecar process: {error}"))?
        {
            let output = read_child_output(child);
            return Err(if output.trim().is_empty() {
                format!("GeoLibre sidecar exited before it was ready: {status}")
            } else {
                format!("GeoLibre sidecar exited before it was ready: {output}")
            });
        }

        if sidecar_health_is_ready(base_url) {
            return Ok(());
        }

        thread::sleep(Duration::from_secs(1));
    }

    Err("GeoLibre sidecar did not become ready in time.".to_string())
}

fn configure_sidecar_process(command: &mut Command) {
    configure_sidecar_process_impl(command);
}

#[cfg(unix)]
fn configure_sidecar_process_impl(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_sidecar_process_impl(_command: &mut Command) {}

fn terminate_sidecar_child(child: &mut Child) {
    terminate_sidecar_process_group(child);
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
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

#[cfg(not(unix))]
fn terminate_sidecar_process_group(_child: &mut Child) {}

#[cfg(target_os = "linux")]
fn terminate_sidecar_listeners_on_port(port: u16) -> Result<(), String> {
    terminate_listeners_on_port(port, is_geolibre_sidecar_process)
}

// Reap a stale Jupyter server that still holds the port (e.g. orphaned by a
// non-graceful exit of a previous app session). Recognized by its cmdline so we
// never touch an unrelated jupyter (the user's own JupyterHub, etc.).
#[cfg(target_os = "linux")]
fn terminate_jupyter_listeners_on_port(port: u16) -> Result<(), String> {
    terminate_listeners_on_port(port, is_geolibre_jupyter_process)
}

// Known gap: this is a no-op on macOS/Windows (the /proc-based listener lookup is
// Linux-only). The current session's child is still reaped on exit via
// JupyterProcess::Drop, but an orphan left by a *previous* crashed session can
// keep holding the port there, in which case the next launch fails to bind and
// surfaces "exited before it was ready". A cross-platform port-owner lookup
// (e.g. lsof on macOS) would be needed to close this.
#[cfg(not(target_os = "linux"))]
fn terminate_jupyter_listeners_on_port(_port: u16) -> Result<(), String> {
    Ok(())
}

// Kill the processes listening on `port` that `is_ours` recognizes (SIGTERM then
// SIGKILL). The `is_ours` guard prevents killing an unrelated process that
// happens to hold the port.
#[cfg(target_os = "linux")]
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

#[cfg(not(target_os = "linux"))]
fn terminate_sidecar_listeners_on_port(_port: u16) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn listening_tcp_inodes(port: u16) -> Result<HashSet<String>, String> {
    let mut inodes = HashSet::new();
    collect_listening_tcp_inodes("/proc/net/tcp", port, &mut inodes)?;
    collect_listening_tcp_inodes("/proc/net/tcp6", port, &mut inodes)?;
    Ok(inodes)
}

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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
#[cfg(target_os = "linux")]
fn is_geolibre_jupyter_process(pid: i32) -> bool {
    let path = format!("/proc/{pid}/cmdline");
    let Ok(command_line) = fs::read(path) else {
        return false;
    };
    let command_line = String::from_utf8_lossy(&command_line);
    command_line.contains("jupyter_server_config.py") && command_line.contains("geolibre_server")
}

#[cfg(unix)]
fn terminate_pid(pid: i32, signal: i32) {
    let _ = unsafe { kill(pid, signal) };
}

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

fn install_managed_uv(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let uv_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("runtime")
        .join("uv-bin");
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

fn uv_executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "uv.exe"
    } else {
        "uv"
    }
}

fn find_executable_on_path(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file() && is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(_path: &std::path::Path) -> bool {
    true
}

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

fn martin_executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "martin.exe"
    } else {
        "martin"
    }
}

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

fn copy_archive_entry_to_path<R: Read>(reader: &mut R, path: &Path) -> Result<(), String> {
    let mut output =
        File::create(path).map_err(|error| format!("Could not create Martin binary: {error}"))?;
    if let Err(error) = std::io::copy(reader, &mut output) {
        let _ = fs::remove_file(path);
        return Err(format!("Could not extract Martin binary: {error}"));
    }
    Ok(())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path)
        .map_err(|error| format!("Could not read Martin binary permissions: {error}"))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .map_err(|error| format!("Could not mark Martin executable: {error}"))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

struct SpawnedMartinServer {
    base_url: String,
    port: u16,
    process: MartinProcess,
}

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
fn configure_linux_webkit() {
    // WebKitGTK's DMABUF renderer could fail to allocate GBM buffers on older
    // graphics stacks, leaving the Tauri window blank, so it used to be
    // disabled here unconditionally. Disabling it also forces a slow readback
    // compositing path that visibly drops MapLibre pan/zoom FPS, and the
    // allocation bugs are fixed in current WebKitGTK, so keep the workaround
    // only for versions older than 2.48. An explicit user/distributor value
    // always wins (per WebKit semantics, "0" keeps DMABUF on and any other
    // value disables it). Only set the default when unset.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        let webkit_version = unsafe {
            (
                webkit2gtk_sys::webkit_get_major_version(),
                webkit2gtk_sys::webkit_get_minor_version(),
            )
        };
        if webkit_version < (2, 48) {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
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
        find_zip_manifest_path, is_allowed_local_vector_path, is_allowed_project_path,
        is_disallowed_ip, is_safe_absolute_path, plugin_archive_file_name,
        resolve_sidecar_in_resource_dir,
    };
    use std::io::{Cursor, Write};
    use std::net::IpAddr;
    use std::path::PathBuf;

    // A throwaway directory tree under the system temp dir that removes itself
    // on drop, so scratch dirs are cleaned up even when an assertion panics.
    // Uses the process id (no rand dependency) and clears any leftover from a
    // prior run at construction.
    struct ScratchDir(PathBuf);

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

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // Regression for issue #1223: installed builds place the bundled sidecar at
    // `<resource_dir>/_up_/_up_/_up_/backend/geolibre_server`, so the resolver
    // must follow the `_up_` chain rather than only checking the resource root.
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

    fn manifest_path(names: &[&str]) -> Option<String> {
        let bytes = zip_with_names(names);
        let archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        find_zip_manifest_path(&archive)
    }

    #[test]
    fn finds_root_manifest() {
        assert_eq!(
            manifest_path(&["plugin.json", "dist/plugin.js"]).as_deref(),
            Some("plugin.json")
        );
    }

    #[test]
    fn finds_manifest_inside_a_wrapping_folder() {
        assert_eq!(
            manifest_path(&["my-plugin/plugin.json", "my-plugin/dist/plugin.js"]).as_deref(),
            Some("my-plugin/plugin.json")
        );
    }

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

    #[test]
    fn returns_none_without_a_manifest() {
        assert_eq!(manifest_path(&["dist/plugin.js"]), None);
    }

    #[test]
    fn keeps_safe_plugin_ids() {
        assert_eq!(plugin_archive_file_name("maplibre-foo"), "maplibre-foo.zip");
        assert_eq!(plugin_archive_file_name("foo.bar_2"), "foo.bar_2.zip");
    }

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
}
