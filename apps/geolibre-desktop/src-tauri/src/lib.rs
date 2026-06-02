mod earth_engine_oauth;

use earth_engine_oauth::{
    poll_earth_engine_oauth, start_earth_engine_oauth, EarthEngineOAuthState,
};
use flate2::read::{GzDecoder, ZlibDecoder};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
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

static POPUP_COUNTER: AtomicU64 = AtomicU64::new(0);

const MARTIN_VERSION: &str = "martin-v1.10.1";
const MARTIN_RELEASE_BASE_URL: &str = "https://github.com/maplibre/martin/releases/download";
const MARTIN_START_ATTEMPTS: usize = 3;
const MARTIN_HEALTH_ATTEMPTS: usize = 30;
const SIDECAR_HEALTH_ATTEMPTS: usize = 180;
const SIDECAR_PORT: u16 = 8765;
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

struct MartinProcess {
    child: Child,
}

struct SidecarProcess {
    child: Child,
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
        .manage(SidecarServerState {
            process: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            close_oauth_popups,
            ensure_martin_binary,
            fetch_url_bytes,
            resolve_url_redirect,
            read_mbtiles_metadata,
            read_mbtiles_tile,
            start_martin_server,
            stop_martin_server,
            start_geolibre_sidecar,
            stop_geolibre_sidecar,
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
async fn fetch_url_bytes(url: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_url_bytes_blocking(url))
        .await
        .map_err(|error| format!("Tile fetch task failed: {error}"))?
}

fn fetch_url_bytes_blocking(url: String) -> Result<Vec<u8>, String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only HTTP and HTTPS URLs can be fetched".to_string());
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(REMOTE_TILE_TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(REMOTE_TILE_CONNECT_TIMEOUT_SECS))
        .user_agent("GeoLibre Desktop")
        .build()
        .map_err(|error| format!("Could not create HTTP client: {error}"))?;

    let response = client
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

#[tauri::command]
async fn resolve_url_redirect(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_url_redirect_blocking(url))
        .await
        .map_err(|error| format!("URL resolve task failed: {error}"))?
}

fn resolve_url_redirect_blocking(url: String) -> Result<String, String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only HTTP and HTTPS URLs can be resolved".to_string());
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(URL_RESOLVE_TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(REMOTE_TILE_CONNECT_TIMEOUT_SECS))
        .user_agent("GeoLibre Desktop")
        .build()
        .map_err(|error| format!("Could not create HTTP client: {error}"))?;

    if let Ok(head_response) = client.head(&url).send() {
        if has_xyz_placeholders(head_response.url().as_str()) {
            return Ok(head_response.url().to_string());
        }
    }

    let response = client
        .get(&url)
        .header("accept", "application/json, text/plain;q=0.9, */*;q=0.8")
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
                });
            }
            *process = None;
        }
    }

    if sidecar_health_is_ready(&base_url) {
        return Ok(SidecarServerInfo {
            base_url,
            port: SIDECAR_PORT,
        });
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
        .arg("uvicorn")
        .arg("geolibre_server.app.main:app")
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(SIDECAR_PORT.to_string())
        .current_dir(&project_dir)
        .env("GEOLIBRE_UV", &uv)
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
    })
}

#[tauri::command]
fn stop_geolibre_sidecar(state: tauri::State<SidecarServerState>) -> Result<(), String> {
    {
        let mut process = state
            .process
            .lock()
            .map_err(|_| "Could not lock sidecar process state.".to_string())?;
        if let Some(mut sidecar) = process.take() {
            sidecar.terminate();
        }
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
        return Err("GeoLibre sidecar is still running on port 8765.".to_string());
    }
    Ok(())
}

fn sidecar_base_url() -> String {
    format!("http://127.0.0.1:{SIDECAR_PORT}")
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

fn request_sidecar_shutdown(base_url: &str) {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(500))
        .build();
    if let Ok(client) = client {
        let _ = client.post(format!("{base_url}/shutdown")).send();
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
    let process_group = -(child.id() as i32);
    let _ = unsafe { kill(process_group, SIGTERM) };
    thread::sleep(Duration::from_millis(250));
    let _ = unsafe { kill(process_group, SIGKILL) };
}

#[cfg(not(unix))]
fn terminate_sidecar_process_group(_child: &mut Child) {}

#[cfg(target_os = "linux")]
fn terminate_sidecar_listeners_on_port(port: u16) -> Result<(), String> {
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
        if process_has_socket(pid, &inodes)? && is_geolibre_sidecar_process(pid) {
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
        let entry = entry.map_err(|error| format!("Could not read {fd_dir} entry: {error}"))?;
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
        || command_line.contains("geolibre_server")
        || command_line.contains("uvicorn")
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
        if let Ok(path) =
            validate_sidecar_project_dir(resource_dir.join("backend").join("geolibre_server"))
        {
            return Ok(path);
        }
        if let Ok(path) = validate_sidecar_project_dir(resource_dir.join("geolibre_server")) {
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
        .find(|candidate| candidate.exists())
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
    // Prefer portal-backed native dialogs on Linux. This avoids GTK/GIO file
    // metadata warnings that can appear around file and folder pickers.
    if std::env::var_os("GTK_USE_PORTAL").is_none() {
        std::env::set_var("GTK_USE_PORTAL", "1");
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_linux_webkit() {}
