//! The GeoLibre Python processing sidecar (FastAPI on 127.0.0.1:8765): its uv
//! project environment and managed uv install, spawn and health checks, the
//! per-launch token, and shutdown. Also holds the loopback and runtime-directory
//! helpers the Jupyter and Martin managers share. The Mac App Store build keeps
//! stub commands with the same names and signatures.

#[cfg(not(feature = "mas"))]
use crate::child_process::{
    appdir_free_path_var, child_failure_message, configure_sidecar_process,
    terminate_sidecar_child, CapturedOutput,
};
#[cfg(not(feature = "mas"))]
use crate::port_reclaim::terminate_sidecar_listeners_on_port;
#[cfg(not(feature = "mas"))]
use crate::{process_lifetime, uv_bootstrap};
use serde::Serialize;
#[cfg(not(feature = "mas"))]
use std::env;
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
const SIDECAR_HEALTH_ATTEMPTS: usize = 180;
#[cfg(not(feature = "mas"))]
const SIDECAR_PORT: u16 = 8765;
// Returned when a sidecar from an earlier launch holds SIDECAR_PORT and could not
// be reclaimed. The frontend (src/lib/sidecar.ts) recognizes it by the phrase
// "does not accept this session's token" and shows it instead of the bare 401
// the stale sidecar would answer later requests with (GeoLibre#2959).
#[cfg(not(feature = "mas"))]
const STALE_SIDECAR_ERROR: &str = "A GeoLibre processing server from a previous session is \
     still running on port 8765 but does not accept this session's token. Quit any stray \
     GeoLibre processes and try again.";
// The sidecar's PostGIS endpoints refuse every destination until this variable
// names the allowed hosts — the check that stops a *shared* deployment (the
// Docker image, where the sidecar is reachable same-origin through the nginx
// proxy) from being pointed at arbitrary internal databases. See
// `_validate_postgis_target` in
// backend/geolibre_server/geolibre_server/app/postgis.py.
#[cfg(not(feature = "mas"))]
const POSTGIS_HOSTS_ENV: &str = "GEOLIBRE_POSTGIS_HOSTS";
// SQL Server endpoints use the same destination restriction for shared deployments.
#[cfg(not(feature = "mas"))]
const MSSQL_HOSTS_ENV: &str = "GEOLIBRE_MSSQL_HOSTS";
#[cfg(not(feature = "mas"))]
const MSSQL_HOSTS_DESKTOP_DEFAULT: &str = "*";
// Desktop starts its loopback sidecar for one user, so the default is unrestricted.
#[cfg(not(feature = "mas"))]
const POSTGIS_HOSTS_DESKTOP_DEFAULT: &str = "*";
#[cfg(not(feature = "mas"))]
pub(crate) struct SidecarServerState {
    pub(crate) process: Mutex<Option<SidecarProcess>>,
    // Serialize start/stop across every UI surface that can request the shared
    // sidecar. Without this, two callers can both pass the reuse check and race
    // to bind the fixed port, or a restart can overlap the previous teardown.
    pub(crate) lifecycle: Mutex<()>,
    // Bumped on exit so an in-progress startup drops its child instead of
    // storing it after teardown.
    pub(crate) generation: std::sync::atomic::AtomicU64,
}

#[cfg(not(feature = "mas"))]
pub(crate) struct SidecarProcess {
    child: Child,
}

#[cfg(not(feature = "mas"))]
impl SidecarProcess {
    fn terminate(&mut self) {
        terminate_sidecar_child(&mut self.child);
    }
}

#[cfg(not(feature = "mas"))]
impl Drop for SidecarProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidecarServerInfo {
    base_url: String,
    port: u16,
    /// Per-launch bearer token the frontend must send on every sidecar request
    /// (see [`sidecar_token`]).
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
pub(crate) async fn start_geolibre_sidecar(
    _app: tauri::AppHandle,
) -> Result<SidecarServerInfo, String> {
    Err("The GeoLibre processing server is not available in the Mac App Store build.".to_string())
}

#[cfg(feature = "mas")]
#[tauri::command]
pub(crate) async fn stop_geolibre_sidecar(_app: tauri::AppHandle) -> Result<(), String> {
    Err("The GeoLibre processing server is not available in the Mac App Store build.".to_string())
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
pub(crate) async fn start_geolibre_sidecar(
    app: tauri::AppHandle,
) -> Result<SidecarServerInfo, String> {
    let start_gen = app
        .state::<SidecarServerState>()
        .generation
        .load(std::sync::atomic::Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || start_geolibre_sidecar_blocking(app, start_gen))
        .await
        .map_err(|error| format!("Could not join sidecar startup task: {error}"))?
}

// Interpreter for the uv project environments behind the sidecar and Jupyter.
// Left unpinned, uv takes the newest Python it can find or download, which can
// be a release that locked wheels (psycopg-binary, for one) don't support yet,
// and then `uv run` fails before the server starts. 3.12 matches the Whitebox and
// conversion runtime defaults and the version CI tests.
#[cfg(not(feature = "mas"))]
const SIDECAR_PYTHON_VERSION: &str = "3.12";

// uv replaces an existing project environment built on another Python, so this
// also repairs installs whose environment was created before the pin.
#[cfg(not(feature = "mas"))]
pub(crate) fn add_sidecar_python_pin(command: &mut Command) {
    command.arg("--python").arg(SIDECAR_PYTHON_VERSION);
}

#[cfg(not(feature = "mas"))]
fn add_main_sidecar_extras(command: &mut Command) {
    command
        .arg("--extra")
        .arg("ml")
        .arg("--extra")
        .arg("postgis")
        .arg("--extra")
        .arg("mssql");
}

#[cfg(not(feature = "mas"))]
fn start_geolibre_sidecar_blocking(
    app: tauri::AppHandle,
    start_gen: u64,
) -> Result<SidecarServerInfo, String> {
    let base_url = sidecar_base_url();
    let state = app.state::<SidecarServerState>();
    let _lifecycle = state
        .lifecycle
        .lock()
        .map_err(|_| "Could not lock sidecar lifecycle.".to_string())?;
    if state.generation.load(std::sync::atomic::Ordering::SeqCst) != start_gen {
        return Err("GeoLibre sidecar startup was cancelled.".to_string());
    }
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
            return Err(STALE_SIDECAR_ERROR.to_string());
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
    let mssql_hosts = env::var(MSSQL_HOSTS_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| MSSQL_HOSTS_DESKTOP_DEFAULT.to_string());

    let mut command = Command::new(&uv);
    command
        .arg("run")
        // Read the bundled uv.lock as-is: never re-lock, never write to the
        // project directory. See the same flag in start_jupyter_server_blocking.
        .arg("--frozen")
        .arg("--project")
        .arg(&project_dir);
    add_sidecar_python_pin(&mut command);
    // The main sidecar serves AI segmentation, editable PostGIS and SQL Server
    // layers. Unlike whitebox/conversion (separate managed venvs), their extras
    // must be synced into this environment here.
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
        // Makes the Live MCP relay available on this desktop port. Access is
        // disabled until the authenticated /relay/access request applies the
        // user's setting, including when processing starts the sidecar first.
        .env("GEOLIBRE_LIVE_RELAY_PORT", SIDECAR_PORT.to_string())
        .env("GEOLIBRE_RUNTIME_DIR", &runtime_dir)
        .env(POSTGIS_HOSTS_ENV, &postgis_hosts)
        .env(MSSQL_HOSTS_ENV, &mssql_hosts)
        .env("GEOLIBRE_MSSQL_DESKTOP_AUTH", "1")
        .env("UV_CACHE_DIR", runtime_dir.join("uv-cache"))
        .env("UV_PYTHON_INSTALL_DIR", runtime_dir.join("uv-python"))
        .env("UV_PROJECT_ENVIRONMENT", runtime_dir.join("sidecar-server"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_sidecar_process(&mut command);

    let mut child = process_lifetime::spawn_managed_child(command)
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
    if state.generation.load(std::sync::atomic::Ordering::SeqCst) != start_gen {
        drop(process);
        // Drop triggers `SidecarProcess::drop` -> `terminate()` exactly once.
        drop(SidecarProcess { child });
        return Err("GeoLibre sidecar startup was cancelled.".to_string());
    }
    if process.is_some() {
        drop(process);
        drop(SidecarProcess { child });
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
pub(crate) async fn stop_geolibre_sidecar(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_geolibre_sidecar_blocking(app))
        .await
        .map_err(|error| format!("Could not join sidecar stop task: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn stop_geolibre_sidecar_blocking(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<SidecarServerState>();
    // Bump generation immediately without blocking on `lifecycle` so Stop stays
    // responsive during a slow `uv` install or health wait; any in-progress
    // startup checks `generation` under `process.lock()` and tears down its
    // child instead of installing it.
    let stop_gen = state
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
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

    if let Ok(_lifecycle) = state.lifecycle.try_lock() {
        let should_reap_port = || {
            state.generation.load(std::sync::atomic::Ordering::SeqCst) == stop_gen
                && state.process.lock().is_ok_and(|process| process.is_none())
        };
        let base_url = sidecar_base_url();
        if should_reap_port() && sidecar_health_is_ready(&base_url) {
            request_sidecar_shutdown(&base_url);
            wait_for_sidecar_stop(&base_url);
        }
        if should_reap_port() && sidecar_health_is_ready(&base_url) {
            terminate_sidecar_listeners_on_port(SIDECAR_PORT)?;
            wait_for_sidecar_stop(&base_url);
        }
        if should_reap_port() && sidecar_health_is_ready(&base_url) {
            return Err(format!(
                "GeoLibre sidecar is still running on port {SIDECAR_PORT}."
            ));
        }
    }
    Ok(())
}

/// Directory holding everything the app installs at runtime (the managed uv, its
/// caches and project environments, and the notebook root). Lives under the
/// per-user app data directory, so nothing outside it belongs to us.
#[cfg(not(feature = "mas"))]
pub(crate) fn app_runtime_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("runtime"))
}

// Wait (briefly) until `port` can be bound, i.e. a just-terminated listener has
// fully released it. Binding then dropping leaves a small race window, but it is
// enough to avoid a `--port-retries=0` bind failure right after killing an orphan.
// Returns whether the port actually came free within the timeout, so a caller
// that can report a better error than the failed spawn is able to bail out.
#[cfg(not(feature = "mas"))]
pub(crate) fn wait_for_port_free(port: u16) -> bool {
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
pub(crate) fn prepend_pythonpath(dir: &Path) -> String {
    let dir = dir.display().to_string();
    match appdir_free_path_var("PYTHONPATH") {
        Some(existing) if !existing.is_empty() => {
            let sep = if cfg!(windows) { ";" } else { ":" };
            format!("{dir}{sep}{existing}")
        }
        _ => dir,
    }
}

// A loopback-bound, per-launch token for the desktop servers: the Jupyter server
// (its only barrier once the XSRF check is disabled for the embedded iframe, see
// jupyter_server_config.py) and the GeoLibre sidecar's bearer token. Use the OS
// CSPRNG (128 random bits), not anything derived from the clock or pid.
#[cfg(not(feature = "mas"))]
pub(crate) fn generate_jupyter_token() -> String {
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

/// A short-timeout HTTP client for the app's own loopback servers (the
/// sidecar, Jupyter and Martin health, token and shutdown probes).
///
/// The proxy is disabled: reqwest otherwise follows `HTTP_PROXY`-style env vars
/// and, on Windows, the system proxy, whose `ProxyOverride` list it copies
/// verbatim without expanding `<local>`. A corporate proxy then answers these
/// `127.0.0.1` requests itself (often with a 403), so a healthy sidecar never
/// reads as ready and startup waits out every attempt (issue #3003). The
/// webview's own sidecar requests already bypass the proxy in
/// `src/lib/sidecar-fetch.ts`.
#[cfg(not(feature = "mas"))]
pub(crate) fn loopback_http_client() -> reqwest::Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(500))
        .no_proxy()
        .build()
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
    let client = loopback_http_client();
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
/// `/token-check` (a no-op authenticated endpoint) *with* the token so an orphan
/// sidecar from a previous launch — started with a different per-launch token,
/// and not killed because `Drop` doesn't run on `SIGKILL` — is detected rather
/// than silently 401ing every later request. A tokenless dev sidecar
/// (`GEOLIBRE_SIDECAR_TOKEN` unset) accepts any header and returns 200, so it is
/// still reused.
#[cfg(not(feature = "mas"))]
fn sidecar_accepts_token(base_url: &str, token: &str) -> bool {
    let Ok(client) = loopback_http_client() else {
        return false;
    };
    client
        .get(format!("{base_url}/token-check"))
        .header("x-geolibre-token", token)
        .send()
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

#[cfg(not(feature = "mas"))]
fn request_sidecar_shutdown(base_url: &str) {
    let client = loopback_http_client();
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

#[cfg(not(feature = "mas"))]
pub(crate) fn sidecar_project_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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
pub(crate) fn ensure_managed_uv(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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
    // A pinned release archive, SHA-256 verified before extraction; no remote
    // install script is ever run. The shared lock covers sidecar and Jupyter.
    uv_bootstrap::ensure_pinned_uv(&uv_dir)
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

#[cfg(test)]
mod tests {
    #[cfg(not(feature = "mas"))]
    use crate::test_support::{ScratchDir, ENV_LOCK};
    // Everything these imports feed is compiled out of the `mas` build, so the
    // tests that exercise it (and their scaffolding) are gated with it.
    #[cfg(not(feature = "mas"))]
    use super::{
        add_main_sidecar_extras, add_sidecar_python_pin, resolve_sidecar_in_resource_dir,
        sidecar_accepts_token, sidecar_health_is_ready,
    };
    #[cfg(not(feature = "mas"))]
    use std::env;
    #[cfg(not(feature = "mas"))]
    use std::ffi::{OsStr, OsString};
    #[cfg(not(feature = "mas"))]
    use std::io::Write;
    #[cfg(not(feature = "mas"))]
    use std::process::Command;

    #[cfg(not(feature = "mas"))]
    #[test]
    fn main_sidecar_installs_database_runtimes() {
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
                OsStr::new("--extra"),
                OsStr::new("mssql"),
            ]
        );
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn sidecar_environments_pass_the_python_pin() {
        let mut command = Command::new("uv");
        add_sidecar_python_pin(&mut command);
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, [OsStr::new("--python"), OsStr::new("3.12")]);
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

    // The sidecar probes must reach 127.0.0.1 directly. A corporate proxy picked
    // up from the environment or the Windows system settings would otherwise
    // answer them itself, so a healthy sidecar never reads as ready (#3003).
    // reqwest reads the proxy env vars each time a client is built, so pointing
    // them at a proxy that refuses everything shows whether the probes bypass it.
    #[cfg(not(feature = "mas"))]
    #[test]
    fn sidecar_probes_bypass_a_configured_proxy() {
        use std::io::Read;
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use std::thread;

        /// Serves every connection with `response` and returns the server's
        /// address plus a count of the requests it answered.
        fn serve(response: &'static [u8]) -> (String, Arc<AtomicUsize>) {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
            let address = listener.local_addr().unwrap().to_string();
            let hits = Arc::new(AtomicUsize::new(0));
            let counter = Arc::clone(&hits);
            thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let mut buffer = [0_u8; 1024];
                    let _ = stream.read(&mut buffer);
                    counter.fetch_add(1, Ordering::SeqCst);
                    let _ = stream.write_all(response);
                }
            });
            (address, hits)
        }

        /// Restores the proxy env vars even when an assertion fails.
        struct ProxyEnv(Vec<(&'static str, Option<OsString>)>);
        impl Drop for ProxyEnv {
            fn drop(&mut self) {
                for (name, value) in &self.0 {
                    match value {
                        Some(value) => env::set_var(name, value),
                        None => env::remove_var(name),
                    }
                }
            }
        }

        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (sidecar, _) =
            serve(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
        let (proxy, proxy_hits) =
            serve(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");

        let names = [
            "HTTP_PROXY",
            "http_proxy",
            "ALL_PROXY",
            "all_proxy",
            "NO_PROXY",
            "no_proxy",
        ];
        let saved = names.iter().map(|name| (*name, env::var_os(name)));
        let _restore = ProxyEnv(saved.collect());
        for name in names {
            env::remove_var(name);
        }
        env::set_var("HTTP_PROXY", format!("http://{proxy}"));
        env::set_var("http_proxy", format!("http://{proxy}"));

        let base_url = format!("http://{sidecar}");
        assert!(sidecar_health_is_ready(&base_url));
        assert!(sidecar_accepts_token(&base_url, "token"));
        let proxy_requests = proxy_hits.load(Ordering::SeqCst);
        assert_eq!(proxy_requests, 0, "a probe went through the proxy");
    }

    // src/lib/sidecar.ts classifies the start failure by this phrase; if it
    // drifts, a stale sidecar is ignored again and users get a bare 401.
    #[cfg(not(feature = "mas"))]
    #[test]
    fn stale_sidecar_error_keeps_the_phrase_the_frontend_matches() {
        assert!(super::STALE_SIDECAR_ERROR.contains("does not accept this session's token"));
    }
}
