//! The Martin vector tile server behind PostGIS layers on desktop: downloading
//! and unpacking the pinned release binary, spawning it against a connection
//! string, waiting for it to become healthy, and stopping it. The Mac App Store
//! build keeps stub commands with the same names and signatures.

#[cfg(not(feature = "mas"))]
use crate::child_process::{child_failure_message, hide_console_window, CapturedOutput};
#[cfg(not(feature = "mas"))]
use crate::process_lifetime;
#[cfg(not(feature = "mas"))]
use crate::sidecar::loopback_http_client;
#[cfg(not(feature = "mas"))]
use flate2::read::GzDecoder;
use serde::Serialize;
#[cfg(not(feature = "mas"))]
use std::fs;
#[cfg(not(feature = "mas"))]
use std::fs::File;
#[cfg(not(feature = "mas"))]
use std::io::{Cursor, Read};
#[cfg(not(feature = "mas"))]
use std::net::TcpListener;
#[cfg(not(feature = "mas"))]
use std::path::{Path, PathBuf};
#[cfg(not(feature = "mas"))]
use std::process::{Child, Command, Stdio};
#[cfg(not(feature = "mas"))]
use std::sync::Mutex;
#[cfg(not(feature = "mas"))]
use std::thread;
#[cfg(not(feature = "mas"))]
use std::time::Duration;
#[cfg(not(feature = "mas"))]
use tauri::Manager;

#[cfg(not(feature = "mas"))]
const MARTIN_VERSION: &str = "martin-v1.10.1";
#[cfg(not(feature = "mas"))]
const MARTIN_RELEASE_BASE_URL: &str = "https://github.com/maplibre/martin/releases/download";
#[cfg(not(feature = "mas"))]
const MARTIN_START_ATTEMPTS: usize = 3;
#[cfg(not(feature = "mas"))]
const MARTIN_HEALTH_ATTEMPTS: usize = 30;
#[cfg(not(feature = "mas"))]
pub(crate) struct MartinServerState {
    pub(crate) process: Mutex<Option<MartinProcess>>,
    // Serialize concurrent starts so two callers do not race to bind ports.
    pub(crate) lifecycle: Mutex<()>,
    // Bumped immediately on stop/exit so an in-progress startup drops its child
    // instead of installing it, without making Stop wait for startup to finish.
    pub(crate) generation: std::sync::atomic::AtomicU64,
}

#[cfg(not(feature = "mas"))]
pub(crate) struct MartinProcess {
    child: Child,
}

#[cfg(not(feature = "mas"))]
impl MartinProcess {
    /// Whether the Martin child is still alive. A server that crashed or was
    /// killed from outside must not keep blocking new starts with "already
    /// running", so the start path clears the slot when this reports false.
    /// Only a confirmed exit counts: a failed `try_wait` keeps the process, so
    /// a transient inspection error can never kill a healthy server.
    fn is_running(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(Some(_)))
    }
}

/// Clear a recorded Martin process that has already exited, then report
/// whether a live one is still holding the slot.
#[cfg(not(feature = "mas"))]
fn martin_slot_is_busy(process: &mut Option<MartinProcess>) -> bool {
    if process.as_mut().is_some_and(|martin| !martin.is_running()) {
        *process = None;
    }
    process.is_some()
}

#[cfg(not(feature = "mas"))]
impl Drop for MartinProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MartinBinaryInfo {
    path: String,
    downloaded: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MartinServerInfo {
    base_url: String,
    binary_path: String,
    port: u16,
}

// Mac App Store stubs: see the note above the sidecar stubs in sidecar.rs.
#[cfg(feature = "mas")]
#[tauri::command]
pub(crate) async fn ensure_martin_binary(
    _app: tauri::AppHandle,
) -> Result<MartinBinaryInfo, String> {
    Err("The Martin tile server is not available in the Mac App Store build.".to_string())
}

#[cfg(feature = "mas")]
#[tauri::command]
pub(crate) async fn start_martin_server(
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
pub(crate) async fn stop_martin_server() -> Result<(), String> {
    Err("The Martin tile server is not available in the Mac App Store build.".to_string())
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
pub(crate) async fn ensure_martin_binary(
    app: tauri::AppHandle,
) -> Result<MartinBinaryInfo, String> {
    tauri::async_runtime::spawn_blocking(move || ensure_martin_binary_path(&app))
        .await
        .map_err(|error| format!("Could not join Martin binary check task: {error}"))?
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
pub(crate) async fn start_martin_server(
    app: tauri::AppHandle,
    connection_string: String,
    default_srid: Option<String>,
) -> Result<MartinServerInfo, String> {
    let start_gen = app
        .state::<MartinServerState>()
        .generation
        .load(std::sync::atomic::Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        start_martin_server_blocking(app, connection_string, default_srid, start_gen)
    })
    .await
    .map_err(|error| format!("Could not join Martin startup task: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn start_martin_server_blocking(
    app: tauri::AppHandle,
    connection_string: String,
    default_srid: Option<String>,
    start_gen: u64,
) -> Result<MartinServerInfo, String> {
    if connection_string.trim().is_empty() {
        return Err("Enter a PostgreSQL connection string.".to_string());
    }

    let state = app.state::<MartinServerState>();
    if state.generation.load(std::sync::atomic::Ordering::SeqCst) != start_gen {
        return Err("Martin server startup was cancelled.".to_string());
    }
    let binary = ensure_martin_binary_path(&app)?;
    let _lifecycle = state
        .lifecycle
        .lock()
        .map_err(|_| "Could not lock Martin lifecycle.".to_string())?;
    if state.generation.load(std::sync::atomic::Ordering::SeqCst) != start_gen {
        return Err("Martin server startup was cancelled.".to_string());
    }
    {
        let mut process = state
            .process
            .lock()
            .map_err(|_| "Could not lock Martin process state.".to_string())?;
        if martin_slot_is_busy(&mut process) {
            return Err(
                "A Martin server is already running. Stop it before starting a new one."
                    .to_string(),
            );
        }
    }

    let mut last_error = "Could not start Martin.".to_string();
    for _ in 0..MARTIN_START_ATTEMPTS {
        if state.generation.load(std::sync::atomic::Ordering::SeqCst) != start_gen {
            return Err("Martin server startup was cancelled.".to_string());
        }
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
                if state.generation.load(std::sync::atomic::Ordering::SeqCst) != start_gen {
                    drop(process);
                    drop(info.process);
                    return Err("Martin server startup was cancelled.".to_string());
                }
                if martin_slot_is_busy(&mut process) {
                    drop(process);
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
pub(crate) async fn stop_martin_server(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_martin_server_blocking(app))
        .await
        .map_err(|error| format!("Could not join Martin stop task: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn stop_martin_server_blocking(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<MartinServerState>();
    // Bump generation without blocking on `lifecycle` so Stop is immediate even
    // while a startup attempt is in flight; the startup checks `generation`
    // under `process.lock()` before storing any child.
    state
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let mut process = state
        .process
        .lock()
        .map_err(|_| "Could not lock Martin process state.".to_string())?;
    let taken = process.take();
    drop(process);
    drop(taken);
    Ok(())
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
        let name = file
            .name()
            .map_err(|error| format!("Could not read Martin zip entry name: {error}"))?;
        let path = PathBuf::from(name.as_ref());
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
    let mut child = process_lifetime::spawn_managed_child(command)
        .map_err(|error| format!("Could not start Martin: {error}"))?;
    // Drain both pipes from the moment we spawn, and for as long as Martin
    // runs. Martin logs at least one line per auto-published table before it
    // binds its port, so a database with a few hundred tables overflows the
    // pipe buffer during discovery: reading only after exit (the old shape)
    // left Martin blocked on a log write and every health poll timing out.
    let output = CapturedOutput::attach(&mut child);

    if let Err(error) = wait_for_martin_health(&base_url, &mut child, &output) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    Ok(SpawnedMartinServer {
        base_url,
        port,
        process: MartinProcess { child },
    })
}

#[cfg(not(feature = "mas"))]
fn wait_for_martin_health(
    base_url: &str,
    child: &mut Child,
    output: &CapturedOutput,
) -> Result<(), String> {
    let health_url = format!("{base_url}/health");
    let client =
        loopback_http_client().map_err(|error| format!("Could not create HTTP client: {error}"))?;

    for _ in 0..MARTIN_HEALTH_ATTEMPTS {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not inspect Martin process: {error}"))?
        {
            return Err(child_failure_message(
                &format!("Martin exited before it was ready (exit status: {status})."),
                output,
            ));
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

    Err(child_failure_message(
        "Martin did not become ready in time.",
        output,
    ))
}

#[cfg(all(test, unix, not(feature = "mas")))]
mod tests {
    use super::{martin_slot_is_busy, wait_for_martin_health, MartinProcess};
    use crate::child_process::CapturedOutput;

    // Regression for #2677. Martin writes one or more log lines per discovered
    // table before it binds its port, so a large schema overflows the pipe
    // buffer during startup. With the pipes left unread the child blocked on
    // that write and never exited, and the waiter reported a bare timeout. A
    // child that writes well past the buffer and then exits must be seen to
    // exit, with its last line quoted.
    #[cfg(all(unix, not(feature = "mas")))]
    #[test]
    fn martin_waiter_drains_a_log_larger_than_the_pipe_buffer() {
        use std::process::{Command, Stdio};

        // The last line goes to stdout too: stdout and stderr are separate
        // pipes drained by separate threads, so a stderr line written after
        // the stdout flood can land in the buffer before the stdout reader
        // catches up, and the flood then evicts it from the reported tail.
        // Only one stream has a defined order to assert on.
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(
                "i=0; while [ $i -lt 2000 ]; do \
                 echo \"INFO martin: source public.table_$i added, no spatial index\"; \
                 i=$((i+1)); done; echo 'error: last line'; exit 3",
            )
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn a chatty child");
        let output = CapturedOutput::attach(&mut child);
        // Port 9 (discard) is never serving HTTP, so health never succeeds and
        // the only way out before the timeout is the child exiting.
        let error = wait_for_martin_health("http://127.0.0.1:9", &mut child, &output)
            .expect_err("the child exits without becoming healthy");
        let _ = child.kill();
        let _ = child.wait();
        assert!(error.contains("exited before it was ready"), "got: {error}");
        assert!(error.contains("error: last line"), "got: {error}");
    }

    // The stderr half of the test above: a child that reports its failure on
    // stderr (with stdout quiet, so there is no cross-pipe ordering to race)
    // must have that line quoted in the waiter's error.
    #[cfg(all(unix, not(feature = "mas")))]
    #[test]
    fn martin_waiter_quotes_the_stderr_tail() {
        use std::process::{Command, Stdio};

        let mut child = Command::new("sh")
            .arg("-c")
            .arg("echo 'error: bind failed' >&2; exit 3")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn a failing child");
        let output = CapturedOutput::attach(&mut child);
        let error = wait_for_martin_health("http://127.0.0.1:9", &mut child, &output)
            .expect_err("the child exits without becoming healthy");
        let _ = child.kill();
        let _ = child.wait();
        assert!(error.contains("exited before it was ready"), "got: {error}");
        assert!(error.contains("error: bind failed"), "got: {error}");
    }

    // A Martin that died or was killed from outside must not keep blocking new
    // starts with "already running"; a live one still must.
    #[cfg(all(unix, not(feature = "mas")))]
    #[test]
    fn martin_slot_clears_an_exited_process_but_keeps_a_live_one() {
        use std::process::{Command, Stdio};

        let spawn = |script: &str| {
            Command::new("sh")
                .arg("-c")
                .arg(script)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn a child")
        };

        let mut exited = spawn("exit 0");
        exited.wait().expect("wait for the child to exit");
        let mut slot = Some(MartinProcess { child: exited });
        assert!(!martin_slot_is_busy(&mut slot));
        assert!(slot.is_none());

        let mut slot = Some(MartinProcess {
            child: spawn("sleep 30"),
        });
        assert!(martin_slot_is_busy(&mut slot));
        assert!(slot.is_some());
        // Dropping the MartinProcess kills and reaps the sleeper.
        drop(slot);

        let mut empty: Option<MartinProcess> = None;
        assert!(!martin_slot_is_busy(&mut empty));
    }
}
