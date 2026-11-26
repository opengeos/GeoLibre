//! Live MCP command relay hosted by the desktop shell itself.
//!
//! The `live_*` tools of the GeoLibre MCP server (`python/src/geolibre/mcp/live.py`)
//! drive the map open in GeoLibre Desktop by posting scripting commands to a
//! loopback relay. The relay used to live only in the Python processing sidecar
//! or the desktop JupyterLab server, so Live MCP needed a Python runtime, and
//! the Mac App Store build, which cannot ship either, had no relay at all. This
//! module serves the same HTTP contract from the Tauri process:
//!
//! - `POST /relay/command`: one `geolibre:command` envelope. With a `requestId`
//!   it waits for the correlated result, for the per-method budget in
//!   [`METHOD_RESULT_TIMEOUT_SECONDS`] or the caller's `timeoutSeconds`.
//! - `GET /relay/status`: `{"listeners": n}`.
//!
//! Commands reach the webview as a Tauri event instead of a WebSocket, and the
//! webview answers through the `live_relay_result` command, so the app side
//! needs no credential at all: Tauri IPC is already confined to the app.
//!
//! The client side authenticates with a token generated each time access is
//! enabled and written, with the address and pid, to an owner-only discovery
//! file (`~/.geolibre/runtime/live-relay.json`, the file the sidecar relay used).
//! Access is off until the webview applies the user's explicit "Allow AI agents
//! to drive the map" setting; turning it off closes the listener, fails pending
//! commands, drops subscribers and removes the discovery file.
//!
//! Transport: loopback TCP on an ephemeral port, except in the Mac App Store
//! build. The App Sandbox refuses to bind even a loopback TCP port without the
//! `com.apple.security.network.server` entitlement, which App Review rejected
//! (docs/mac-app-store.md), but it allows a Unix domain socket inside the app's
//! container. So the `mas` build listens on `live-relay.sock` next to the
//! discovery file in the container's home, and the MCP client connects to that
//! socket (`live.py` looks in the container for the discovery file).

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Map, Value};

/// Envelope the scripting bridge speaks (`relay_protocol.COMMAND_TYPE`).
pub(crate) const COMMAND_TYPE: &str = "geolibre:command";
/// Envelope of the app's correlated reply (`relay_protocol.RESULT_TYPE`).
pub(crate) const RESULT_TYPE: &str = "geolibre:result";
/// Tauri event a subscribed webview receives each relayed command on.
pub(crate) const COMMAND_EVENT: &str = "live-relay:command";

/// Result wait when neither the caller nor the method table says otherwise.
pub(crate) const DEFAULT_RESULT_TIMEOUT_SECONDS: f64 = 5.0;
/// Bounds a caller-requested `timeoutSeconds` is clamped to.
pub(crate) const MIN_RESULT_TIMEOUT_SECONDS: f64 = 0.5;
pub(crate) const MAX_RESULT_TIMEOUT_SECONDS: f64 = 4.0 * 60.0 * 60.0;

/// Default result waits for commands that do real work in the app. Mirrors
/// `METHOD_RESULT_TIMEOUT_SECONDS` in `relay_protocol.py` and
/// `METHOD_TIMEOUT_SECONDS` in `live.py`; `python/tests/test_mcp_live.py`
/// parses this table and fails when the three disagree.
pub(crate) const METHOD_RESULT_TIMEOUT_SECONDS: &[(&str, f64)] = &[
    ("runAlgorithm", 30.0 * 60.0),
    ("runWhiteboxTool", 30.0 * 60.0),
    ("runModelBuilder", 60.0 * 60.0),
    ("addRasterBytes", 120.0),
    ("addGeoJsonLayer", 60.0),
    ("getLayerFeatures", 60.0),
    ("toImage", 60.0),
];

/// Serialized command cap, as the sidecar relay and `live.py` enforce.
const MAX_COMMAND_BYTES: usize = 8 * 1024 * 1024;
/// Request line plus headers.
const MAX_HEADER_BYTES: usize = 16 * 1024;
/// Simultaneous client connections; more are answered 503 at once.
const MAX_CONNECTIONS: usize = 16;
/// How long one read of a client's request may stall.
const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a client may take to send its whole request, so a slow drip
/// cannot hold a connection slot indefinitely.
const REQUEST_DEADLINE: Duration = Duration::from_secs(30);
/// Accept-loop poll interval, which bounds how long a disabled listener lingers.
const ACCEPT_POLL: Duration = Duration::from_millis(50);
/// Discovery file name, shared with the sidecar relay and `live.py`.
const DISCOVERY_FILE_NAME: &str = "live-relay.json";
/// Unix socket name in the Mac App Store build, next to the discovery file.
const SOCKET_FILE_NAME: &str = "live-relay.sock";
/// Shorter name used when the full one would overflow `sun_path`: the
/// container home holds the user name, so a long one pushes the path past it.
#[cfg(unix)]
const SHORT_SOCKET_FILE_NAME: &str = "r.sock";
/// `sizeof(sockaddr_un.sun_path)`, including the terminating NUL.
#[cfg(unix)]
const SUN_PATH_LEN: usize = if cfg!(any(target_os = "macos", target_os = "ios")) {
    104
} else {
    108
};
/// Overrides the discovery file location (tests, unusual home directories).
pub(crate) const DISCOVERY_FILE_ENV: &str = "GEOLIBRE_LIVE_RELAY_FILE";

/// How a client reaches the relay.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Transport {
    /// `127.0.0.1` on an ephemeral port.
    #[cfg_attr(all(feature = "mas", unix), allow(dead_code))]
    Tcp,
    /// A Unix domain socket beside the discovery file.
    #[cfg(unix)]
    #[cfg_attr(not(feature = "mas"), allow(dead_code))]
    Unix,
}

impl Transport {
    /// The transport this build listens on: a Unix socket in the sandboxed
    /// Mac App Store build, loopback TCP everywhere else.
    pub(crate) fn for_build() -> Self {
        #[cfg(all(feature = "mas", unix))]
        {
            Transport::Unix
        }
        #[cfg(not(all(feature = "mas", unix)))]
        {
            Transport::Tcp
        }
    }
}

/// Delivers a command to one subscribed webview.
pub(crate) trait Dispatcher: Send + Sync + 'static {
    /// Send `envelope` to the webview labelled `label`.
    ///
    /// Returns whether the event was handed to that webview.
    fn dispatch(&self, label: &str, envelope: &Value) -> bool;
}

/// Result wait for `method`, honoring a valid caller-chosen `requested` value.
///
/// Mirrors `relay_protocol.result_timeout_seconds`: a finite positive number
/// is clamped to [`MIN_RESULT_TIMEOUT_SECONDS`, `MAX_RESULT_TIMEOUT_SECONDS`];
/// anything else falls back to the per-method default.
pub(crate) fn result_timeout_seconds(method: &str, requested: Option<&Value>) -> f64 {
    if let Some(value) = requested.filter(|value| !value.is_boolean()) {
        if let Some(number) = value.as_f64() {
            if number.is_finite() && number > 0.0 {
                return number.clamp(MIN_RESULT_TIMEOUT_SECONDS, MAX_RESULT_TIMEOUT_SECONDS);
            }
        }
    }
    METHOD_RESULT_TIMEOUT_SECONDS
        .iter()
        .find(|(name, _)| *name == method)
        .map(|(_, seconds)| *seconds)
        .unwrap_or(DEFAULT_RESULT_TIMEOUT_SECONDS)
}

/// Validate a posted command and build the envelope sent to the app.
///
/// Mirrors `relay_protocol.normalize_command`.
pub(crate) fn normalize_command(payload: &Value) -> Result<Value, String> {
    let object = payload
        .as_object()
        .ok_or_else(|| "Expected a JSON object.".to_string())?;
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .filter(|method| !method.is_empty())
        .ok_or_else(|| "Missing a non-empty 'method'.".to_string())?;
    let params = match object.get("params") {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(Value::Object(params)) if params.is_empty() => Value::Object(Map::new()),
        Some(Value::Object(params)) => Value::Object(params.clone()),
        // Python treats any falsy params as {}; an empty list or "" does too.
        Some(Value::Array(items)) if items.is_empty() => Value::Object(Map::new()),
        Some(Value::String(text)) if text.is_empty() => Value::Object(Map::new()),
        Some(Value::Bool(false)) => Value::Object(Map::new()),
        Some(Value::Number(number)) if number.as_f64() == Some(0.0) => Value::Object(Map::new()),
        Some(_) => return Err("'params' must be an object.".to_string()),
    };
    let request_id = object
        .get("requestId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    Ok(json!({
        "type": COMMAND_TYPE,
        "requestId": request_id,
        "method": method,
        "params": params,
    }))
}

/// Validate an app result frame, returning `(requestId, result)`.
///
/// Mirrors `relay_protocol.normalize_result`.
pub(crate) fn normalize_result(payload: &Value) -> Result<(String, Value), String> {
    let object = payload
        .as_object()
        .filter(|object| object.get("type").and_then(Value::as_str) == Some(RESULT_TYPE))
        .ok_or_else(|| "Expected a GeoLibre result object.".to_string())?;
    let request_id = object
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "Missing a non-empty 'requestId'.".to_string())?;
    let ok = object
        .get("ok")
        .and_then(Value::as_bool)
        .ok_or_else(|| "Missing boolean 'ok'.".to_string())?;
    let result = if ok {
        json!({"ok": true, "value": object.get("value").cloned().unwrap_or(Value::Null)})
    } else {
        let error = match object.get("error") {
            Some(Value::String(text)) if !text.is_empty() => text.clone(),
            Some(Value::Null) | None => "GeoLibre command failed.".to_string(),
            Some(Value::String(_)) => "GeoLibre command failed.".to_string(),
            Some(other) => other.to_string(),
        };
        json!({"ok": false, "error": error})
    };
    Ok((request_id.to_string(), result))
}

/// Compare two secrets in time independent of where they first differ.
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// 32 random bytes as hex, or an error when the OS has no randomness.
fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).map_err(|error| format!("No secure randomness: {error}"))?;
    Ok(buffer.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Where the relay advertises itself: the env override, else
/// `~/.geolibre/runtime/live-relay.json` (inside the container when sandboxed).
pub(crate) fn default_discovery_file() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(DISCOVERY_FILE_ENV).filter(|value| !value.is_empty()) {
        // Absolute, so the socket published beside it is absolute too: the
        // client refuses a relative socket path.
        let path = PathBuf::from(path);
        return Some(std::path::absolute(&path).unwrap_or(path));
    }
    // Python's Path.home(), which the MCP client uses, reads USERPROFILE on
    // Windows and ignores HOME (which Git Bash may set to a POSIX path).
    let home = if cfg!(windows) {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
    } else {
        std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
    };
    home.filter(|value| !value.is_empty()).map(|home| {
        PathBuf::from(home)
            .join(".geolibre")
            .join("runtime")
            .join(DISCOVERY_FILE_NAME)
    })
}

/// One request waiting on the app.
struct Pending {
    sender: SyncSender<Value>,
    recipients: HashSet<String>,
}

/// A running listener; dropping the stop flag's owner does not stop it, so it
/// is stopped explicitly.
struct Server {
    stop: Arc<AtomicBool>,
    socket_path: Option<PathBuf>,
}

#[derive(Default)]
struct State {
    enabled: bool,
    token: String,
    listeners: HashSet<String>,
    pending: HashMap<String, Pending>,
    /// Client request id -> the dispatch id that reserved it.
    client_request_ids: HashMap<String, String>,
    server: Option<Server>,
    /// What the discovery file says, so a later write can be skipped or a
    /// removal checked against this process.
    published: Option<Value>,
}

/// The relay's state machine, independent of Tauri so it can be tested.
pub(crate) struct RelayCore {
    state: Mutex<State>,
    dispatcher: Box<dyn Dispatcher>,
    transport: Transport,
    discovery_file: Option<PathBuf>,
    connections: AtomicUsize,
    /// Serializes access changes so overlapping enables never bind twice.
    lifecycle: Mutex<()>,
}

/// Snapshot returned to the webview after an access change.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccessStatus {
    pub(crate) enabled: bool,
    pub(crate) listeners: usize,
}

impl RelayCore {
    /// Build a disabled relay.
    pub(crate) fn new(
        dispatcher: Box<dyn Dispatcher>,
        transport: Transport,
        discovery_file: Option<PathBuf>,
    ) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::default()),
            dispatcher,
            transport,
            discovery_file,
            connections: AtomicUsize::new(0),
            lifecycle: Mutex::new(()),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Apply the user's preference: start or stop serving clients.
    pub(crate) fn set_access(self: &Arc<Self>, enabled: bool) -> Result<AccessStatus, String> {
        let _change = self
            .lifecycle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if enabled {
            self.enable()
        } else {
            // Access is off even when discovery cleanup fails; the error lets
            // the webview retry, and a retry finishes only the cleanup.
            self.disable()?;
            Ok(self.status())
        }
    }

    /// Current access state and subscriber count.
    pub(crate) fn status(&self) -> AccessStatus {
        let state = self.lock();
        AccessStatus {
            enabled: state.enabled,
            listeners: state.listeners.len(),
        }
    }

    fn enable(self: &Arc<Self>) -> Result<AccessStatus, String> {
        {
            let state = self.lock();
            if state.enabled && state.server.is_some() {
                drop(state);
                // Republish in case another process overwrote the file.
                self.publish()?;
                return Ok(self.status());
            }
        }
        let discovery = self
            .discovery_file
            .clone()
            .ok_or_else(|| "No home directory to publish Live MCP discovery in.".to_string())?;
        let token = random_hex(32)?;
        let stop = Arc::new(AtomicBool::new(false));
        let (address, socket_path) = self.bind(&discovery, stop.clone())?;
        let payload = match &socket_path {
            Some(path) => json!({
                "kind": "desktop",
                "transport": "unix",
                "socket": path.to_string_lossy(),
                "url": "http://localhost/relay",
                "token": token,
                "pid": std::process::id(),
            }),
            None => json!({
                "kind": "desktop",
                "url": format!("http://{address}/relay"),
                "token": token,
                "pid": std::process::id(),
            }),
        };
        {
            let mut state = self.lock();
            state.enabled = true;
            state.token = token;
            state.server = Some(Server { stop, socket_path });
            state.published = Some(payload);
        }
        if let Err(error) = self.publish() {
            let _ = self.disable();
            return Err(error);
        }
        Ok(self.status())
    }

    fn disable(&self) -> Result<(), String> {
        let (server, pending) = {
            let mut state = self.lock();
            state.enabled = false;
            state.token.clear();
            state.listeners.clear();
            state.client_request_ids.clear();
            let pending: Vec<Pending> = state.pending.drain().map(|(_, pending)| pending).collect();
            (state.server.take(), pending)
        };
        for waiting in pending {
            let _ = waiting
                .sender
                .try_send(json!({"ok": false, "error": "Live MCP access was disabled."}));
        }
        if let Some(server) = server {
            server.stop.store(true, Ordering::SeqCst);
            if let Some(path) = server.socket_path {
                let _ = std::fs::remove_file(path);
            }
        }
        self.unpublish()
    }

    /// Bind the listener and start its accept loop.
    fn bind(
        self: &Arc<Self>,
        discovery: &Path,
        stop: Arc<AtomicBool>,
    ) -> Result<(String, Option<PathBuf>), String> {
        match self.transport {
            Transport::Tcp => {
                let listener = TcpListener::bind(("127.0.0.1", 0))
                    .map_err(|error| format!("Could not open the Live MCP relay: {error}"))?;
                let address = listener
                    .local_addr()
                    .map_err(|error| format!("Could not open the Live MCP relay: {error}"))?
                    .to_string();
                listener
                    .set_nonblocking(true)
                    .map_err(|error| format!("Could not open the Live MCP relay: {error}"))?;
                let core = Arc::clone(self);
                let expected_host = address.clone();
                thread::Builder::new()
                    .name("live-relay".into())
                    .spawn(move || {
                        core.accept_loop(
                            stop,
                            || {
                                listener.accept().map(|(stream, _)| {
                                    Box::new(TcpConnection(stream)) as Box<dyn Connection>
                                })
                            },
                            Some(expected_host),
                        )
                    })
                    .map_err(|error| format!("Could not start the Live MCP relay: {error}"))?;
                Ok((address, None))
            }
            #[cfg(unix)]
            Transport::Unix => {
                use std::os::unix::fs::PermissionsExt;
                use std::os::unix::net::UnixListener;

                let directory = discovery
                    .parent()
                    .ok_or_else(|| "Live MCP discovery has no directory.".to_string())?;
                create_private_dir(directory)?;
                let path = socket_path_in(directory)?;
                if path == discovery {
                    return Err(format!(
                        "The Live MCP discovery file cannot be named like its socket: {}",
                        discovery.display()
                    ));
                }
                let _ = std::fs::remove_file(&path);
                let listener = UnixListener::bind(&path)
                    .map_err(|error| format!("Could not open the Live MCP relay: {error}"))?;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
                listener
                    .set_nonblocking(true)
                    .map_err(|error| format!("Could not open the Live MCP relay: {error}"))?;
                let core = Arc::clone(self);
                thread::Builder::new()
                    .name("live-relay".into())
                    .spawn(move || {
                        core.accept_loop(
                            stop,
                            || {
                                listener.accept().map(|(stream, _)| {
                                    Box::new(UnixConnection(stream)) as Box<dyn Connection>
                                })
                            },
                            None,
                        )
                    })
                    .map_err(|error| format!("Could not start the Live MCP relay: {error}"))?;
                Ok((path.to_string_lossy().into_owned(), Some(path)))
            }
        }
    }

    fn accept_loop(
        self: Arc<Self>,
        stop: Arc<AtomicBool>,
        mut accept: impl FnMut() -> std::io::Result<Box<dyn Connection>>,
        expected_host: Option<String>,
    ) {
        while !stop.load(Ordering::SeqCst) {
            match accept() {
                Ok(connection) => {
                    if self.connections.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                        self.connections.fetch_sub(1, Ordering::SeqCst);
                        let mut connection = connection;
                        let _ = connection.prepare();
                        let _ = write_response(
                            connection.as_mut(),
                            503,
                            &json!({"detail": "Too many Live MCP connections."}),
                        );
                        continue;
                    }
                    let core = Arc::clone(&self);
                    let host = expected_host.clone();
                    let spawned = thread::Builder::new()
                        .name("live-relay-client".into())
                        .spawn(move || {
                            let mut connection = connection;
                            core.serve(connection.as_mut(), host.as_deref());
                            connection.close();
                            core.connections.fetch_sub(1, Ordering::SeqCst);
                        });
                    if spawned.is_err() {
                        self.connections.fetch_sub(1, Ordering::SeqCst);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(ACCEPT_POLL);
                }
                Err(_) => thread::sleep(ACCEPT_POLL),
            }
        }
    }

    /// Answer one HTTP request on `connection`.
    fn serve(&self, connection: &mut dyn Connection, expected_host: Option<&str>) {
        if connection.prepare().is_err() {
            return;
        }
        // Authenticate on the headers alone, so an unauthenticated client
        // never makes the relay read (or allocate) a command body.
        let (status, body) =
            match read_request(connection, |request| self.admit(request, expected_host)) {
                Ok(request) => self.handle(&request),
                Err(response) => response,
            };
        let _ = write_response(connection, status, &body);
    }

    /// Decide from the request line and headers whether to serve a request.
    fn admit(&self, request: &Request, expected_host: Option<&str>) -> Result<(), (u16, Value)> {
        // A browser always names its page's origin on a cross-site request. A
        // Live MCP client never does, so refusing any Origin keeps web pages out
        // even before the token check.
        if request.header("origin").is_some() {
            return Err((403, json!({"detail": "Browser requests are not accepted."})));
        }
        if let Some(expected) = expected_host {
            // DNS-rebinding guard: only the loopback address we bound.
            let port = expected.rsplit(':').next().unwrap_or_default();
            let allowed = [expected.to_string(), format!("localhost:{port}")];
            if !request
                .header("host")
                .is_some_and(|host| allowed.iter().any(|item| item.eq_ignore_ascii_case(host)))
            {
                return Err((403, json!({"detail": "Unexpected Host header."})));
            }
        }
        let route = (request.method.as_str(), request.path.as_str());
        if !matches!(route, ("POST", "/relay/command") | ("GET", "/relay/status")) {
            return Err((404, json!({"detail": "Not found"})));
        }
        self.check_token(request)
    }

    /// Answer an admitted request.
    fn handle(&self, request: &Request) -> (u16, Value) {
        if request.method == "GET" {
            return (200, json!({"listeners": self.lock().listeners.len()}));
        }
        self.command(&request.body)
    }

    fn check_token(&self, request: &Request) -> Result<(), (u16, Value)> {
        let state = self.lock();
        if !state.enabled || state.token.is_empty() {
            return Err((404, json!({"detail": "Live relay is not enabled"})));
        }
        let provided = request
            .header("x-geolibre-relay-token")
            .map(str::to_string)
            .or_else(|| {
                let value = request.header("authorization")?;
                let (scheme, token) = value.split_once(' ')?;
                matches!(scheme.to_ascii_lowercase().as_str(), "token" | "bearer")
                    .then(|| token.trim().to_string())
            })
            .unwrap_or_default();
        if !constant_time_eq(provided.as_bytes(), state.token.as_bytes()) {
            return Err((401, json!({"detail": "Missing or invalid relay token"})));
        }
        Ok(())
    }

    fn command(&self, body: &[u8]) -> (u16, Value) {
        let payload: Value = if body.is_empty() {
            json!({})
        } else {
            match serde_json::from_slice(body) {
                Ok(payload) => payload,
                Err(error) => return (400, json!({"detail": error.to_string()})),
            }
        };
        let mut envelope = match normalize_command(&payload) {
            Ok(envelope) => envelope,
            Err(message) => return (400, json!({"detail": message})),
        };
        let request_id = envelope["requestId"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let method = envelope["method"].as_str().unwrap_or_default().to_string();
        if request_id.is_empty() {
            let labels: Vec<String> = self.lock().listeners.iter().cloned().collect();
            let delivered = labels
                .iter()
                .filter(|label| self.dispatcher.dispatch(label, &envelope))
                .count();
            return (200, json!({"delivered": delivered}));
        }
        let timeout = result_timeout_seconds(&method, payload.get("timeoutSeconds"));
        let dispatch_id = match random_hex(16) {
            Ok(id) => id,
            Err(message) => return (500, json!({"detail": message})),
        };
        envelope["requestId"] = Value::String(dispatch_id.clone());
        let (sender, receiver) = mpsc::sync_channel::<Value>(1);
        let labels: Vec<String> = {
            let mut state = self.lock();
            if !state.enabled {
                return (404, json!({"detail": "Live relay is not enabled"}));
            }
            if state.client_request_ids.contains_key(&request_id) {
                return (409, json!({"detail": "Duplicate requestId."}));
            }
            state
                .client_request_ids
                .insert(request_id.clone(), dispatch_id.clone());
            let labels: Vec<String> = state.listeners.iter().cloned().collect();
            state.pending.insert(
                dispatch_id.clone(),
                Pending {
                    sender,
                    recipients: labels.iter().cloned().collect(),
                },
            );
            labels
        };
        let mut delivered = 0usize;
        for label in &labels {
            if self.dispatcher.dispatch(label, &envelope) {
                delivered += 1;
            } else {
                self.forget_recipient(&dispatch_id, label);
            }
        }
        let outcome = if delivered == 0 {
            None
        } else {
            Some(receiver.recv_timeout(Duration::from_secs_f64(timeout)))
        };
        {
            let mut state = self.lock();
            state.pending.remove(&dispatch_id);
            // A revocation and re-grant may have handed this id to a newer
            // request meanwhile; release only our own reservation.
            if state.client_request_ids.get(&request_id) == Some(&dispatch_id) {
                state.client_request_ids.remove(&request_id);
            }
        }
        match outcome {
            None => (200, json!({"delivered": 0})),
            Some(Ok(mut result)) => {
                result["requestId"] = Value::String(request_id);
                result["delivered"] = json!(delivered);
                (200, result)
            }
            Some(Err(RecvTimeoutError::Timeout)) => (
                504,
                json!({"detail": "GeoLibre did not return a result in time."}),
            ),
            Some(Err(RecvTimeoutError::Disconnected)) => (
                200,
                json!({
                    "delivered": delivered,
                    "requestId": request_id,
                    "ok": false,
                    "error": "GeoLibre disconnected before returning a result.",
                }),
            ),
        }
    }

    /// Drop `label` from a request's recipients, failing it when none remain.
    fn forget_recipient(&self, dispatch_id: &str, label: &str) {
        let mut state = self.lock();
        if let Some(pending) = state.pending.get_mut(dispatch_id) {
            pending.recipients.remove(label);
            if pending.recipients.is_empty() {
                let _ = pending.sender.try_send(json!({
                    "ok": false,
                    "error": "GeoLibre disconnected before returning a result.",
                }));
            }
        }
    }

    /// Register a webview to receive commands. Requires access to be enabled.
    pub(crate) fn subscribe(&self, label: &str) -> Result<AccessStatus, String> {
        let mut state = self.lock();
        if !state.enabled {
            return Err("Live MCP access is not enabled.".to_string());
        }
        state.listeners.insert(label.to_string());
        Ok(AccessStatus {
            enabled: true,
            listeners: state.listeners.len(),
        })
    }

    /// Stop sending commands to a webview (closed, reloaded or unsubscribed).
    pub(crate) fn unsubscribe(&self, label: &str) {
        let mut state = self.lock();
        if !state.listeners.remove(label) {
            return;
        }
        for pending in state.pending.values_mut() {
            if pending.recipients.remove(label) && pending.recipients.is_empty() {
                let _ = pending.sender.try_send(json!({
                    "ok": false,
                    "error": "GeoLibre disconnected before returning a result.",
                }));
            }
        }
    }

    /// Hand an app result frame to the request waiting for it.
    pub(crate) fn resolve(&self, frame: &str) -> Result<(), String> {
        let payload: Value = serde_json::from_str(frame).map_err(|error| error.to_string())?;
        let (dispatch_id, result) = normalize_result(&payload)?;
        let state = self.lock();
        if let Some(pending) = state.pending.get(&dispatch_id) {
            let _ = pending.sender.try_send(result);
        }
        Ok(())
    }

    /// Write the discovery file for the current listener.
    fn publish(&self) -> Result<(), String> {
        let (payload, path) = {
            let state = self.lock();
            match (&state.published, &self.discovery_file) {
                (Some(payload), Some(path)) => (payload.clone(), path.clone()),
                _ => return Ok(()),
            }
        };
        if let Some(directory) = path.parent() {
            create_private_dir(directory)?;
        }
        let contents = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
        crate::fs_util::write_file_atomic(
            &path,
            &contents,
            crate::fs_util::AtomicWriteOptions {
                create_parents: true,
                owner_only_unix: true,
                ..Default::default()
            },
        )
        .map_err(|error| {
            format!(
                "Live MCP discovery could not be published ({error}). Retry after checking \
                 runtime directory permissions."
            )
        })
    }

    /// Remove the discovery file if it still describes this process.
    ///
    /// The ownership record is kept until the file is gone (or another process
    /// replaced it), so a failed removal can be retried by a later disable.
    pub(crate) fn unpublish(&self) -> Result<(), String> {
        let published = self.lock().published.clone();
        let (Some(published), Some(path)) = (published, self.discovery_file.as_ref()) else {
            return Ok(());
        };
        let ours = match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str::<Value>(&text).is_ok_and(|current| {
                // Another GeoLibre window may have replaced the file.
                current.get("token") == published.get("token")
                    && current.get("pid") == published.get("pid")
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => {
                return Err(format!(
                    "Live MCP discovery could not be read for removal: {error}"
                ))
            }
        };
        if ours {
            if let Err(error) = std::fs::remove_file(path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Err(format!("Live MCP discovery could not be removed: {error}"));
                }
            }
        }
        let mut state = self.lock();
        if state.published.as_ref() == Some(&published) {
            state.published = None;
        }
        Ok(())
    }

    /// Stop serving and remove discovery at app exit.
    pub(crate) fn shutdown(&self) {
        let _change = self
            .lifecycle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = self.disable();
    }
}

/// The relay socket beside the discovery file, shortened when the directory is
/// so deep that the full name would not fit in `sun_path`.
#[cfg(unix)]
fn socket_path_in(directory: &Path) -> Result<PathBuf, String> {
    [SOCKET_FILE_NAME, SHORT_SOCKET_FILE_NAME]
        .iter()
        .map(|name| directory.join(name))
        .find(|path| path.as_os_str().len() < SUN_PATH_LEN)
        .ok_or_else(|| {
            format!(
                "The Live MCP socket path is too long for this system: {}",
                directory.join(SHORT_SOCKET_FILE_NAME).display()
            )
        })
}

fn create_private_dir(directory: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(directory)
            .map_err(|error| format!("Could not create {}: {error}", directory.display()))
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(directory)
            .map_err(|error| format!("Could not create {}: {error}", directory.display()))
    }
}

/// A client connection, TCP or Unix.
trait Connection: Read + Write + Send {
    /// Switch to blocking reads with the request deadline.
    fn prepare(&mut self) -> std::io::Result<()>;
    /// Bound the next reads, so none outlives the whole-request deadline.
    fn limit_reads(&mut self, timeout: Duration) -> std::io::Result<()>;
    /// Close both directions.
    fn close(&mut self);
}

struct TcpConnection(TcpStream);

impl Read for TcpConnection {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(buffer)
    }
}

impl Write for TcpConnection {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0.write(buffer)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}

impl Connection for TcpConnection {
    fn limit_reads(&mut self, timeout: Duration) -> std::io::Result<()> {
        self.0.set_read_timeout(Some(timeout))
    }
    fn prepare(&mut self) -> std::io::Result<()> {
        self.0.set_nonblocking(false)?;
        self.0.set_read_timeout(Some(REQUEST_READ_TIMEOUT))?;
        self.0.set_write_timeout(Some(REQUEST_READ_TIMEOUT))
    }
    fn close(&mut self) {
        let _ = self.0.shutdown(Shutdown::Both);
    }
}

#[cfg(unix)]
struct UnixConnection(std::os::unix::net::UnixStream);

#[cfg(unix)]
impl Read for UnixConnection {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(buffer)
    }
}

#[cfg(unix)]
impl Write for UnixConnection {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0.write(buffer)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}

#[cfg(unix)]
impl Connection for UnixConnection {
    fn limit_reads(&mut self, timeout: Duration) -> std::io::Result<()> {
        self.0.set_read_timeout(Some(timeout))
    }
    fn prepare(&mut self) -> std::io::Result<()> {
        self.0.set_nonblocking(false)?;
        self.0.set_read_timeout(Some(REQUEST_READ_TIMEOUT))?;
        self.0.set_write_timeout(Some(REQUEST_READ_TIMEOUT))
    }
    fn close(&mut self) {
        let _ = self.0.shutdown(Shutdown::Both);
    }
}

/// A parsed HTTP/1.1 request.
struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

/// Read one request: headers up to [`MAX_HEADER_BYTES`], a `Content-Length`
/// body up to [`MAX_COMMAND_BYTES`]. Chunked bodies are refused.
fn read_request(
    connection: &mut dyn Connection,
    admit: impl FnOnce(&Request) -> Result<(), (u16, Value)>,
) -> Result<Request, (u16, Value)> {
    let fail = |status: u16, message: &str| (status, json!({"detail": message}));
    let deadline = std::time::Instant::now() + REQUEST_DEADLINE;
    let late = || std::time::Instant::now() > deadline;
    // Each read may stall for at most what is left of the deadline.
    let budget = || {
        deadline
            .saturating_duration_since(std::time::Instant::now())
            .clamp(Duration::from_millis(1), REQUEST_READ_TIMEOUT)
    };
    let mut reader = BufReader::new(connection);
    let mut head = Vec::new();
    loop {
        let before = head.len();
        reader
            .get_mut()
            .limit_reads(budget())
            .map_err(|_| fail(400, "Could not read the request."))?;
        let read = reader
            .by_ref()
            .take((MAX_HEADER_BYTES + 1 - head.len()) as u64)
            .read_until(b'\n', &mut head)
            .map_err(|_| fail(400, "Could not read the request."))?;
        if read == 0 {
            return Err(fail(400, "Incomplete request."));
        }
        if head.len() > MAX_HEADER_BYTES {
            return Err(fail(431, "Request headers are too large."));
        }
        if late() {
            return Err(fail(408, "The request took too long."));
        }
        let line = &head[before..];
        if line == b"\r\n" || line == b"\n" {
            break;
        }
    }
    let text = String::from_utf8(head).map_err(|_| fail(400, "Malformed request."))?;
    let mut lines = text.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let (Some(method), Some(target), Some(version)) = (parts.next(), parts.next(), parts.next())
    else {
        return Err(fail(400, "Malformed request line."));
    };
    if !version.starts_with("HTTP/1.") {
        return Err(fail(505, "Only HTTP/1.x is supported."));
    }
    let path = target
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .to_string();
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(fail(400, "Malformed header."));
        };
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
    }
    let request_headers = Request {
        method: method.to_string(),
        path,
        headers,
        body: Vec::new(),
    };
    if request_headers.header("transfer-encoding").is_some() {
        return Err(fail(411, "A Content-Length body is required."));
    }
    let length = match request_headers.header("content-length") {
        None => 0,
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| fail(400, "Invalid Content-Length."))?,
    };
    if length > MAX_COMMAND_BYTES {
        return Err(fail(413, "Live command exceeds the 8 MB limit."));
    }
    admit(&request_headers)?;
    let mut body = Vec::with_capacity(length.min(64 * 1024));
    let mut chunk = [0u8; 64 * 1024];
    while body.len() < length {
        if late() {
            return Err(fail(408, "The request took too long."));
        }
        reader
            .get_mut()
            .limit_reads(budget())
            .map_err(|_| fail(400, "Could not read the request."))?;
        let want = chunk.len().min(length - body.len());
        match reader.read(&mut chunk[..want]) {
            Ok(0) | Err(_) => return Err(fail(400, "Incomplete request body.")),
            Ok(read) => body.extend_from_slice(&chunk[..read]),
        }
    }
    if late() {
        return Err(fail(408, "The request took too long."));
    }
    Ok(Request {
        body,
        ..request_headers
    })
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        408 => "Request Timeout",
        409 => "Conflict",
        411 => "Length Required",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        505 => "HTTP Version Not Supported",
        _ => "Internal Server Error",
    }
}

fn write_response(
    connection: &mut dyn Connection,
    status: u16,
    body: &Value,
) -> std::io::Result<()> {
    let body = serde_json::to_vec(body).unwrap_or_else(|_| b"{}".to_vec());
    let head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n\r\n",
        reason(status),
        body.len()
    );
    connection.write_all(head.as_bytes())?;
    connection.write_all(&body)?;
    connection.flush()
}

#[cfg(desktop)]
pub(crate) mod commands {
    //! Tauri bindings for [`super::RelayCore`].

    use std::sync::Arc;

    use serde_json::Value;
    use tauri::{AppHandle, Emitter, Runtime};

    use super::{AccessStatus, Dispatcher, RelayCore, Transport, COMMAND_EVENT};

    /// Managed state holding the relay.
    pub(crate) struct LiveRelayState(pub(crate) Arc<RelayCore>);

    struct TauriDispatcher<R: Runtime>(AppHandle<R>);

    impl<R: Runtime> Dispatcher for TauriDispatcher<R> {
        fn dispatch(&self, label: &str, envelope: &Value) -> bool {
            self.0.emit_to(label, COMMAND_EVENT, envelope).is_ok()
        }
    }

    /// Build the managed relay state for `app`.
    pub(crate) fn state<R: Runtime>(app: &AppHandle<R>) -> LiveRelayState {
        LiveRelayState(RelayCore::new(
            Box::new(TauriDispatcher(app.clone())),
            Transport::for_build(),
            super::default_discovery_file(),
        ))
    }

    /// Apply the "Allow AI agents to drive the map" setting.
    #[tauri::command]
    pub(crate) fn live_relay_set_access(
        state: tauri::State<'_, LiveRelayState>,
        enabled: bool,
    ) -> Result<AccessStatus, String> {
        state.0.set_access(enabled)
    }

    /// Subscribe the calling webview to relayed commands.
    #[tauri::command]
    pub(crate) fn live_relay_subscribe<R: Runtime>(
        state: tauri::State<'_, LiveRelayState>,
        webview: tauri::Webview<R>,
    ) -> Result<AccessStatus, String> {
        state.0.subscribe(webview.label())
    }

    /// Unsubscribe the calling webview.
    #[tauri::command]
    pub(crate) fn live_relay_unsubscribe<R: Runtime>(
        state: tauri::State<'_, LiveRelayState>,
        webview: tauri::Webview<R>,
    ) {
        state.0.unsubscribe(webview.label());
    }

    /// Return a `geolibre:result` frame for a relayed command.
    #[tauri::command]
    pub(crate) fn live_relay_result(
        state: tauri::State<'_, LiveRelayState>,
        frame: String,
    ) -> Result<(), String> {
        state.0.resolve(&frame)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Weak;

    /// Answers every command from a background thread, like the webview would.
    struct EchoDispatcher {
        core: Mutex<Weak<RelayCore>>,
        mode: Mutex<&'static str>,
        seen: Mutex<Vec<Value>>,
    }

    impl Dispatcher for Arc<EchoDispatcher> {
        fn dispatch(&self, label: &str, envelope: &Value) -> bool {
            self.seen
                .lock()
                .unwrap()
                .push(json!({"label": label, "envelope": envelope}));
            let mode = *self.mode.lock().unwrap();
            if mode == "refuse" {
                return false;
            }
            let Some(core) = self.core.lock().unwrap().upgrade() else {
                return false;
            };
            let envelope = envelope.clone();
            let label = label.to_string();
            thread::spawn(move || {
                let id = envelope["requestId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
                match mode {
                    "silent" => {}
                    "leave" => core.unsubscribe(&label),
                    "fail" => {
                        let frame = json!({"type": RESULT_TYPE, "requestId": id, "ok": false, "error": "boom"});
                        let _ = core.resolve(&frame.to_string());
                    }
                    _ => {
                        let frame = json!({
                            "type": RESULT_TYPE,
                            "requestId": id,
                            "ok": true,
                            "value": {"method": envelope["method"], "params": envelope["params"]},
                        });
                        let _ = core.resolve(&frame.to_string());
                    }
                }
            });
            true
        }
    }

    struct Fixture {
        core: Arc<RelayCore>,
        dispatcher: Arc<EchoDispatcher>,
        discovery: PathBuf,
        _dir: tempdir::Dir,
    }

    mod tempdir {
        use std::path::PathBuf;

        /// A unique directory removed on drop.
        pub struct Dir(pub PathBuf);

        impl Dir {
            pub fn new() -> Self {
                let path = std::env::temp_dir().join(format!(
                    "lr-{}-{}",
                    std::process::id(),
                    super::random_hex(6).unwrap()
                ));
                std::fs::create_dir_all(&path).unwrap();
                Dir(path)
            }
        }

        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    fn fixture(transport: Transport) -> Fixture {
        let dir = tempdir::Dir::new();
        let discovery = dir.0.join("runtime").join(DISCOVERY_FILE_NAME);
        let dispatcher = Arc::new(EchoDispatcher {
            core: Mutex::new(Weak::new()),
            mode: Mutex::new("echo"),
            seen: Mutex::new(Vec::new()),
        });
        let core = RelayCore::new(
            Box::new(dispatcher.clone()),
            transport,
            Some(discovery.clone()),
        );
        *dispatcher.core.lock().unwrap() = Arc::downgrade(&core);
        Fixture {
            core,
            dispatcher,
            discovery,
            _dir: dir,
        }
    }

    fn discovery(fixture: &Fixture) -> Value {
        serde_json::from_str(&std::fs::read_to_string(&fixture.discovery).unwrap()).unwrap()
    }

    /// Send one raw HTTP request to the published relay and parse the reply.
    fn send(fixture: &Fixture, raw: &str) -> (u16, Value) {
        let info = discovery(fixture);
        let mut response = Vec::new();
        if let Some(socket) = info.get("socket").and_then(Value::as_str) {
            #[cfg(unix)]
            {
                let mut stream = std::os::unix::net::UnixStream::connect(socket).unwrap();
                stream.write_all(raw.as_bytes()).unwrap();
                stream.read_to_end(&mut response).unwrap();
            }
            #[cfg(not(unix))]
            let _ = socket;
        } else {
            let url = info["url"].as_str().unwrap();
            let address = url.trim_start_matches("http://").trim_end_matches("/relay");
            let mut stream = TcpStream::connect(address).unwrap();
            stream.write_all(raw.as_bytes()).unwrap();
            stream.read_to_end(&mut response).unwrap();
        }
        let text = String::from_utf8(response).unwrap();
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, serde_json::from_str(body).unwrap_or(Value::Null))
    }

    fn host(fixture: &Fixture) -> String {
        let info = discovery(fixture);
        if info.get("socket").is_some() {
            return "localhost".into();
        }
        info["url"]
            .as_str()
            .unwrap()
            .trim_start_matches("http://")
            .trim_end_matches("/relay")
            .to_string()
    }

    fn post(fixture: &Fixture, body: &Value, token: Option<&str>) -> (u16, Value) {
        let token = token
            .map(str::to_string)
            .unwrap_or_else(|| discovery(fixture)["token"].as_str().unwrap().to_string());
        let body = body.to_string();
        send(
            fixture,
            &format!(
                "POST /relay/command HTTP/1.1\r\nHost: {}\r\nAuthorization: token {token}\r\n\
                 Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                host(fixture),
                body.len()
            ),
        )
    }

    fn status(fixture: &Fixture) -> (u16, Value) {
        let token = discovery(fixture)["token"].as_str().unwrap().to_string();
        send(
            fixture,
            &format!(
                "GET /relay/status HTTP/1.1\r\nHost: {}\r\nX-GeoLibre-Relay-Token: {token}\r\n\r\n",
                host(fixture)
            ),
        )
    }

    #[test]
    fn budgets_match_the_python_table_and_clamp_requests() {
        assert_eq!(result_timeout_seconds("setView", None), 5.0);
        assert_eq!(result_timeout_seconds("runAlgorithm", None), 1800.0);
        assert_eq!(result_timeout_seconds("runModelBuilder", None), 3600.0);
        assert_eq!(result_timeout_seconds("toImage", Some(&json!(0.1))), 0.5);
        assert_eq!(
            result_timeout_seconds("toImage", Some(&json!(1e9))),
            14400.0
        );
        assert_eq!(result_timeout_seconds("toImage", Some(&json!(true))), 60.0);
        assert_eq!(result_timeout_seconds("toImage", Some(&json!(-1))), 60.0);
        assert_eq!(result_timeout_seconds("toImage", Some(&json!("9"))), 60.0);
    }

    #[test]
    fn commands_and_results_are_validated_like_the_python_relays() {
        assert!(normalize_command(&json!([])).is_err());
        assert!(normalize_command(&json!({"method": ""})).is_err());
        assert!(normalize_command(&json!({"method": "x", "params": [1]})).is_err());
        let envelope = normalize_command(&json!({"method": "x", "requestId": 3})).unwrap();
        assert_eq!(envelope["requestId"], "");
        assert_eq!(envelope["params"], json!({}));
        assert!(normalize_result(&json!({"type": "other"})).is_err());
        assert!(normalize_result(&json!({"type": RESULT_TYPE, "requestId": "a"})).is_err());
        let (id, failed) =
            normalize_result(&json!({"type": RESULT_TYPE, "requestId": "a", "ok": false})).unwrap();
        assert_eq!(id, "a");
        assert_eq!(failed["error"], "GeoLibre command failed.");
    }

    fn round_trip(transport: Transport) {
        let fixture = fixture(transport);
        assert!(
            fixture.core.subscribe("main").is_err(),
            "subscribing needs access"
        );
        fixture.core.set_access(true).unwrap();
        let info = discovery(&fixture);
        assert_eq!(info["kind"], "desktop");
        assert_eq!(info["pid"], std::process::id());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&fixture.discovery)
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o077, 0, "discovery must be owner-only");
        }
        assert_eq!(status(&fixture), (200, json!({"listeners": 0})));
        let (code, body) = post(
            &fixture,
            &json!({"method": "getView", "requestId": "r1"}),
            None,
        );
        assert_eq!((code, body), (200, json!({"delivered": 0})));

        fixture.core.subscribe("main").unwrap();
        assert_eq!(status(&fixture), (200, json!({"listeners": 1})));
        let (code, body) = post(
            &fixture,
            &json!({"method": "setView", "params": {"zoom": 3}, "requestId": "r2"}),
            None,
        );
        assert_eq!(code, 200);
        assert_eq!(body["delivered"], 1);
        assert_eq!(body["ok"], true);
        assert_eq!(body["requestId"], "r2");
        assert_eq!(
            body["value"],
            json!({"method": "setView", "params": {"zoom": 3}})
        );
        // The app sees a relay-chosen id, never the client's.
        let seen = fixture
            .dispatcher
            .seen
            .lock()
            .unwrap()
            .last()
            .cloned()
            .unwrap();
        assert_ne!(seen["envelope"]["requestId"], "r2");
        assert_eq!(seen["label"], "main");

        *fixture.dispatcher.mode.lock().unwrap() = "fail";
        let (_, body) = post(&fixture, &json!({"method": "x", "requestId": "r3"}), None);
        assert_eq!(
            (body["ok"].clone(), body["error"].clone()),
            (json!(false), json!("boom"))
        );

        // Fire-and-forget commands report deliveries only.
        let (_, body) = post(&fixture, &json!({"method": "x"}), None);
        assert_eq!(body, json!({"delivered": 1}));
    }

    #[test]
    fn tcp_relay_round_trips_commands() {
        round_trip(Transport::Tcp);
    }

    #[cfg(unix)]
    #[test]
    fn unix_socket_relay_round_trips_commands() {
        round_trip(Transport::Unix);
    }

    #[cfg(unix)]
    #[test]
    fn deep_directories_get_a_shorter_socket_name() {
        let base = PathBuf::from("/");
        assert_eq!(
            socket_path_in(&base.join("a")).unwrap(),
            base.join("a").join(SOCKET_FILE_NAME)
        );
        let deep = base.join("d".repeat(SUN_PATH_LEN - 12));
        assert_eq!(
            socket_path_in(&deep).unwrap(),
            deep.join(SHORT_SOCKET_FILE_NAME)
        );
        assert!(socket_path_in(&base.join("d".repeat(SUN_PATH_LEN))).is_err());
    }

    #[test]
    fn requests_are_authenticated_and_browsers_refused() {
        let fixture = fixture(Transport::Tcp);
        fixture.core.set_access(true).unwrap();
        let (code, _) = post(&fixture, &json!({"method": "x"}), Some("wrong"));
        assert_eq!(code, 401);
        let token = discovery(&fixture)["token"].as_str().unwrap().to_string();
        let host = host(&fixture);
        let origin = format!(
            "GET /relay/status HTTP/1.1\r\nHost: {host}\r\nOrigin: https://evil.example\r\n\
             Authorization: Bearer {token}\r\n\r\n"
        );
        assert_eq!(send(&fixture, &origin).0, 403);
        let rebinding = format!(
            "GET /relay/status HTTP/1.1\r\nHost: evil.example\r\nAuthorization: Bearer {token}\r\n\r\n"
        );
        assert_eq!(send(&fixture, &rebinding).0, 403);
        let chunked = format!(
            "POST /relay/command HTTP/1.1\r\nHost: {host}\r\nAuthorization: token {token}\r\n\
             Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n"
        );
        assert_eq!(send(&fixture, &chunked).0, 411);
        let huge = format!(
            "POST /relay/command HTTP/1.1\r\nHost: {host}\r\nAuthorization: token {token}\r\n\
             Content-Length: {}\r\n\r\n",
            MAX_COMMAND_BYTES + 1
        );
        assert_eq!(send(&fixture, &huge).0, 413);
        // A wrong token is refused from the headers alone: the client never
        // sends the body it announced, and still gets its answer.
        let unread = format!(
            "POST /relay/command HTTP/1.1\r\nHost: {host}\r\nAuthorization: token wrong\r\n\
             Content-Length: 4096\r\n\r\n"
        );
        assert_eq!(send(&fixture, &unread).0, 401);
        let missing = format!("GET /other HTTP/1.1\r\nHost: {host}\r\n\r\n");
        assert_eq!(send(&fixture, &missing).0, 404);
        assert_eq!(post(&fixture, &json!({"params": {}}), None).0, 400);
    }

    #[test]
    fn slow_results_time_out_with_504_and_disconnects_fail_fast() {
        let fixture = fixture(Transport::Tcp);
        fixture.core.set_access(true).unwrap();
        fixture.core.subscribe("main").unwrap();
        *fixture.dispatcher.mode.lock().unwrap() = "silent";
        let (code, body) = post(
            &fixture,
            &json!({"method": "x", "requestId": "slow", "timeoutSeconds": 0.5}),
            None,
        );
        assert_eq!(code, 504);
        assert_eq!(body["detail"], "GeoLibre did not return a result in time.");

        *fixture.dispatcher.mode.lock().unwrap() = "leave";
        let (code, body) = post(&fixture, &json!({"method": "x", "requestId": "gone"}), None);
        assert_eq!(code, 200);
        assert_eq!(
            body["error"],
            "GeoLibre disconnected before returning a result."
        );
    }

    #[test]
    fn disabling_revokes_pending_requests_listeners_and_discovery() {
        let fixture = fixture(Transport::Tcp);
        fixture.core.set_access(true).unwrap();
        fixture.core.subscribe("main").unwrap();
        *fixture.dispatcher.mode.lock().unwrap() = "silent";
        let info = discovery(&fixture);
        let url = info["url"].as_str().unwrap().to_string();
        let token = info["token"].as_str().unwrap().to_string();
        let address = url
            .trim_start_matches("http://")
            .trim_end_matches("/relay")
            .to_string();
        let waiter = {
            let address = address.clone();
            let token = token.clone();
            thread::spawn(move || {
                let body =
                    json!({"method": "x", "requestId": "w", "timeoutSeconds": 30}).to_string();
                let mut stream = TcpStream::connect(&address).unwrap();
                write!(
                    stream,
                    "POST /relay/command HTTP/1.1\r\nHost: {address}\r\nAuthorization: token {token}\r\n\
                     Content-Length: {}\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
                let mut response = String::new();
                stream.read_to_string(&mut response).unwrap();
                response
            })
        };
        // Let the command reach the dispatcher before revoking.
        for _ in 0..100 {
            if !fixture.dispatcher.seen.lock().unwrap().is_empty() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        fixture.core.set_access(false).unwrap();
        let response = waiter.join().unwrap();
        assert!(
            response.contains("Live MCP access was disabled."),
            "{response}"
        );
        assert!(!fixture.discovery.exists(), "discovery must be removed");
        assert_eq!(
            fixture.core.status(),
            AccessStatus {
                enabled: false,
                listeners: 0
            }
        );
        assert!(fixture.core.subscribe("main").is_err());
        // The listener closes within one accept poll.
        thread::sleep(ACCEPT_POLL * 4);
        assert!(TcpStream::connect(&address).is_err());

        // A new grant uses a fresh token; the revoked one stays refused.
        fixture.core.set_access(true).unwrap();
        assert_ne!(discovery(&fixture)["token"], json!(token));
    }

    #[cfg(unix)]
    #[test]
    fn a_discovery_file_named_like_the_socket_is_refused() {
        let dir = tempdir::Dir::new();
        let discovery = dir.0.join(SOCKET_FILE_NAME);
        let dispatcher = Arc::new(EchoDispatcher {
            core: Mutex::new(Weak::new()),
            mode: Mutex::new("echo"),
            seen: Mutex::new(Vec::new()),
        });
        let core = RelayCore::new(Box::new(dispatcher), Transport::Unix, Some(discovery));
        let error = core.set_access(true).unwrap_err();
        assert!(error.contains("named like its socket"), "{error}");
        assert!(!core.status().enabled);
    }

    #[test]
    fn unpublish_leaves_a_file_another_process_wrote() {
        let fixture = fixture(Transport::Tcp);
        fixture.core.set_access(true).unwrap();
        std::fs::write(&fixture.discovery, r#"{"pid": 1, "token": "other"}"#).unwrap();
        fixture.core.set_access(false).unwrap();
        assert!(fixture.discovery.exists());
    }

    #[test]
    fn duplicate_client_request_ids_conflict() {
        let fixture = fixture(Transport::Tcp);
        fixture.core.set_access(true).unwrap();
        fixture.core.subscribe("main").unwrap();
        *fixture.dispatcher.mode.lock().unwrap() = "silent";
        let first = {
            let info = discovery(&fixture);
            let url = info["url"].as_str().unwrap().to_string();
            let token = info["token"].as_str().unwrap().to_string();
            thread::spawn(move || {
                let address = url
                    .trim_start_matches("http://")
                    .trim_end_matches("/relay")
                    .to_string();
                let body =
                    json!({"method": "x", "requestId": "dup", "timeoutSeconds": 60}).to_string();
                let mut stream = TcpStream::connect(&address).unwrap();
                write!(
                    stream,
                    "POST /relay/command HTTP/1.1\r\nHost: {address}\r\nAuthorization: token {token}\r\n\
                     Content-Length: {}\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
                let mut response = String::new();
                stream.read_to_string(&mut response).unwrap();
            })
        };
        for _ in 0..100 {
            if !fixture.dispatcher.seen.lock().unwrap().is_empty() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        // The first request is still pending (its wait is a minute), so the
        // duplicate conflicts; revoking access then releases the first.
        let (code, _) = post(&fixture, &json!({"method": "x", "requestId": "dup"}), None);
        assert_eq!(code, 409);
        fixture.core.set_access(false).unwrap();
        first.join().unwrap();
    }
}
