//! The desktop JupyterLab server behind the Notebook panel: its own uv project
//! environment, the notebook root and bundled examples, a per-launch token,
//! spawn and health checks, and shutdown. The Mac App Store build keeps stub
//! commands with the same names and signatures.

#[cfg(not(feature = "mas"))]
use crate::child_process::{
    child_failure_message, configure_sidecar_process, terminate_sidecar_child, CapturedOutput,
};
#[cfg(not(feature = "mas"))]
use crate::port_reclaim::terminate_jupyter_listeners_on_port;
#[cfg(not(feature = "mas"))]
use crate::process_lifetime;
#[cfg(not(feature = "mas"))]
use crate::sidecar::{
    add_sidecar_python_pin, app_runtime_dir, ensure_managed_uv, loopback_http_client,
    prepend_pythonpath, sidecar_project_dir, wait_for_port_free,
};
use serde::Serialize;
#[cfg(not(feature = "mas"))]
use std::fs;
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
pub(crate) struct JupyterServerState {
    pub(crate) process: Mutex<Option<JupyterProcess>>,
    // Token of the currently running server, so a reuse path can hand the same
    // URL back without restarting.
    pub(crate) token: Mutex<Option<String>>,
    // Held for the whole of start_jupyter_server_blocking so two concurrent
    // start calls can't both spawn on the same port (the loser would exit 1).
    pub(crate) startup: Mutex<()>,
    // Bumped immediately on stop/exit so Stop returns immediately while any
    // in-progress startup discards its child instead of installing it.
    pub(crate) generation: std::sync::atomic::AtomicU64,
}

#[cfg(not(feature = "mas"))]
pub(crate) struct JupyterProcess {
    child: Child,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JupyterServerInfo {
    url: String,
    port: u16,
    token: String,
}

// Mac App Store stubs: see the note above the sidecar stubs in sidecar.rs.
#[cfg(feature = "mas")]
#[tauri::command]
pub(crate) async fn start_jupyter_server(
    _app: tauri::AppHandle,
) -> Result<JupyterServerInfo, String> {
    Err("The Jupyter notebook server is not available in the Mac App Store build.".to_string())
}

#[cfg(feature = "mas")]
#[tauri::command]
pub(crate) async fn stop_jupyter_server(_app: tauri::AppHandle) -> Result<(), String> {
    Err("The Jupyter notebook server is not available in the Mac App Store build.".to_string())
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
pub(crate) async fn start_jupyter_server(
    app: tauri::AppHandle,
) -> Result<JupyterServerInfo, String> {
    let start_gen = app
        .state::<JupyterServerState>()
        .generation
        .load(std::sync::atomic::Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || start_jupyter_server_blocking(app, start_gen))
        .await
        .map_err(|error| format!("Could not join Jupyter startup task: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn start_jupyter_server_blocking(
    app: tauri::AppHandle,
    start_gen: u64,
) -> Result<JupyterServerInfo, String> {
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
    if state.generation.load(std::sync::atomic::Ordering::SeqCst) != start_gen {
        return Err("Jupyter server startup was cancelled.".to_string());
    }
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
    // Seed the example notebooks (the same ones bundled into JupyterLite on web)
    // only when missing, so we never clobber a user's edits.
    for notebook in ["Welcome.ipynb", "Explore_GeoLibre.ipynb"] {
        let dest = notebooks_dir.join(notebook);
        if !dest.exists() {
            let _ = fs::copy(project_dir.join("notebook_examples").join(notebook), &dest);
        }
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
        .arg(&project_dir);
    add_sidecar_python_pin(&mut command);
    command
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

    let mut child = process_lifetime::spawn_managed_child(command)
        .map_err(|error| format!("Could not start Jupyter server: {error}"))?;
    let output = CapturedOutput::attach(&mut child);

    let base_url = jupyter_base_url();
    if let Err(error) = wait_for_jupyter_health(&base_url, &token, &mut child, &output) {
        terminate_sidecar_child(&mut child);
        return Err(error);
    }

    // Record our server unless a concurrent stop or app exit bumped
    // `generation` while startup was running.
    {
        let mut process = state
            .process
            .lock()
            .map_err(|_| "Could not lock Jupyter process state.".to_string())?;
        if state.generation.load(std::sync::atomic::Ordering::SeqCst) != start_gen {
            drop(process);
            terminate_sidecar_child(&mut child);
            return Err("Jupyter server startup was cancelled.".to_string());
        }
        *process = Some(JupyterProcess { child });
        *state
            .token
            .lock()
            .map_err(|_| "Could not lock Jupyter token.".to_string())? = Some(token.clone());
    }

    Ok(JupyterServerInfo {
        url: base_url,
        port: JUPYTER_PORT,
        token,
    })
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
pub(crate) async fn stop_jupyter_server(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_jupyter_server_blocking(app))
        .await
        .map_err(|error| format!("Could not join Jupyter stop task: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn stop_jupyter_server_blocking(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<JupyterServerState>();
    // Bump generation immediately without blocking on `startup` so Stop stays
    // responsive even during a slow `uv sync` or health wait; any in-progress
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
            .map_err(|_| "Could not lock Jupyter process state.".to_string())?;
        // Clear the token in the same `process` critical section as taking the
        // process so a concurrent start cannot publish a fresh token that gets
        // wiped by a late clear.
        let taken = process.take();
        if let Ok(mut token) = state.token.lock() {
            *token = None;
        }
        drop(process);
        // JupyterProcess::Drop terminates the child's process group outside the lock.
        drop(taken);
    }
    // Backstop: reap anything still bound to the port only when no startup is
    // in flight and no newer start has installed a live server in the meantime.
    if let Ok(_startup) = state.startup.try_lock() {
        if state.generation.load(std::sync::atomic::Ordering::SeqCst) == stop_gen
            && state.process.lock().is_ok_and(|process| process.is_none())
        {
            match app_runtime_dir(&app) {
                Ok(runtime_dir) => {
                    let _ = terminate_jupyter_listeners_on_port(JUPYTER_PORT, &runtime_dir);
                }
                Err(error) => {
                    eprintln!("Jupyter: skipping the port {JUPYTER_PORT} backstop ({error}).")
                }
            }
        }
    }
    Ok(())
}

#[cfg(not(feature = "mas"))]
fn jupyter_base_url() -> String {
    format!("http://127.0.0.1:{JUPYTER_PORT}")
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
    let client =
        loopback_http_client().map_err(|error| format!("Could not build HTTP client: {error}"))?;
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

// A loopback-bound, per-launch token for the desktop Jupyter server. It is the
// only barrier once the XSRF check is disabled for the embedded iframe (see
// jupyter_server_config.py), so use the OS CSPRNG (128 random bits) rather than
// anything derived from the clock/pid.
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
