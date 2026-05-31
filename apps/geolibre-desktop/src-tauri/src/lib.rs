mod earth_engine_oauth;

use earth_engine_oauth::{
    poll_earth_engine_oauth, start_earth_engine_oauth, EarthEngineOAuthState,
};
use flate2::read::{GzDecoder, ZlibDecoder};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
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

static POPUP_COUNTER: AtomicU64 = AtomicU64::new(0);

const MARTIN_VERSION: &str = "martin-v1.10.1";
const MARTIN_RELEASE_BASE_URL: &str = "https://github.com/maplibre/martin/releases/download";
const MARTIN_START_ATTEMPTS: usize = 3;
const MARTIN_HEALTH_ATTEMPTS: usize = 30;

struct MartinServerState {
    process: Mutex<Option<MartinProcess>>,
}

struct MartinProcess {
    child: Child,
}

impl Drop for MartinProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_linux_webkit();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(EarthEngineOAuthState::default())
        .manage(MartinServerState {
            process: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            close_oauth_popups,
            ensure_martin_binary,
            fetch_url_bytes,
            read_mbtiles_metadata,
            read_mbtiles_tile,
            start_martin_server,
            stop_martin_server,
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

#[tauri::command]
fn close_oauth_popups(app: tauri::AppHandle) {
    for window in app.webview_windows().values() {
        if window.label().starts_with("oauthPopup") {
            let _ = window.close();
        }
    }
}

#[tauri::command]
fn fetch_url_bytes(url: String) -> Result<Vec<u8>, String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only HTTP and HTTPS URLs can be fetched".to_string());
    }

    let response = reqwest::blocking::Client::new()
        .get(&url)
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
    let app_handle = app.handle().clone();

    tauri::WebviewWindowBuilder::from_config(app, &window_config)?
        .on_new_window(move |url, features| {
            create_oauth_popup_window(app_handle.clone(), url, features)
        })
        .build()?;

    Ok(())
}

fn create_oauth_popup_window(
    app_handle: tauri::AppHandle,
    url: tauri::Url,
    features: tauri::webview::NewWindowFeatures,
) -> tauri::webview::NewWindowResponse<tauri::Wry> {
    let popup_id = POPUP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let child_app_handle = app_handle.clone();
    let window = tauri::WebviewWindowBuilder::new(
        &app_handle,
        format!("oauthPopup{popup_id}"),
        tauri::WebviewUrl::External("about:blank".parse().expect("valid blank URL")),
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
    .expect("failed to create OAuth popup window");

    tauri::webview::NewWindowResponse::Create { window }
}

#[cfg(target_os = "linux")]
fn configure_linux_webkit() {
    // WebKitGTK's DMABUF renderer can fail to allocate GBM buffers on some
    // Linux graphics stacks, leaving the Tauri window blank. Only set the
    // default when unset so an explicit user/distributor value wins.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_linux_webkit() {}
