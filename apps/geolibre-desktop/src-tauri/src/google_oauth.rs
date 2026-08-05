//! The loopback helper behind every Google sign-in the desktop app performs.
//!
//! Google will not accept the Tauri WebView's origin (`tauri://localhost` /
//! `http://tauri.localhost`) as an OAuth JavaScript origin, so none of Google's
//! browser SDKs can run inside the app window. The way around it is to serve a
//! tiny page from `http://localhost:5173` — an origin that *can* be registered
//! — open it in the system browser, run Google's SDK there, and have the page
//! POST the result back to this same listener for the app to collect by
//! polling.
//!
//! Two flows share that machinery:
//!
//!  - **Earth Engine sign-in** (`/__geolibre_ee_auth`), which returns an access
//!    token for the Earth Engine control.
//!  - **The Google Drive picker** (`/__geolibre_drive_picker`), which returns a
//!    token *and* the files the user chose. The picker is what makes private
//!    Drive files reachable at all: it grants the app per-file access under the
//!    non-sensitive `drive.file` scope, so GeoLibre never has to request the
//!    restricted `drive.readonly` scope that would put it through Google's CASA
//!    security assessment.
//!
//! Both post to the same result endpoint and are collected from the same map,
//! keyed by a per-request state id.

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::ErrorKind,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

const OAUTH_HOST: &str = "127.0.0.1";
const OAUTH_PORT: u16 = 5173;
const AUTH_PATH: &str = "/__geolibre_ee_auth";
const PICKER_PATH: &str = "/__geolibre_drive_picker";
const TOKEN_PATH: &str = "/__geolibre_ee_token";

#[derive(Default)]
pub struct GoogleOAuthState {
    counter: AtomicU64,
    server_started: AtomicBool,
    results: Arc<Mutex<HashMap<String, GoogleOAuthResult>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleOAuthStart {
    url: String,
    state: String,
}

/// A file the user chose in the Drive picker. The picker reports its own field
/// names (`sizeBytes`); the page maps them to the Drive REST API's names before
/// posting, so the frontend handles picked and listed files identically.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrivePickedFile {
    id: String,
    name: String,
    mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleOAuthResult {
    state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    access_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_in: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// Present only for the picker flow. An empty list means the user closed
    /// the picker without choosing anything, which is a normal outcome rather
    /// than an error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    files: Option<Vec<DrivePickedFile>>,
}

#[tauri::command]
pub fn start_earth_engine_oauth(
    client_id: String,
    state: tauri::State<'_, GoogleOAuthState>,
) -> Result<GoogleOAuthStart, String> {
    let client_id = client_id.trim();
    if client_id.is_empty() {
        return Err("Earth Engine OAuth client ID is required.".to_string());
    }

    ensure_oauth_server(&state)?;
    let state_id = next_state_id(&state)?;
    let url = format!(
        "http://localhost:{OAUTH_PORT}{AUTH_PATH}?client_id={}&state={}",
        url_encode(client_id),
        url_encode(&state_id),
    );

    Ok(GoogleOAuthStart {
        url,
        state: state_id,
    })
}

/// Starts a Drive picker session and returns the page URL to open in the system
/// browser. The API key is Google's "developer key", which the picker widget
/// requires in addition to the OAuth token.
#[tauri::command]
pub fn start_google_drive_picker(
    client_id: String,
    api_key: String,
    state: tauri::State<'_, GoogleOAuthState>,
) -> Result<GoogleOAuthStart, String> {
    let client_id = client_id.trim();
    if client_id.is_empty() {
        return Err("A Google OAuth client ID is required to open the Drive picker.".to_string());
    }
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("A Google API key is required to open the Drive picker.".to_string());
    }

    ensure_oauth_server(&state)?;
    let state_id = next_state_id(&state)?;
    let url = format!(
        "http://localhost:{OAUTH_PORT}{PICKER_PATH}?client_id={}&api_key={}&state={}",
        url_encode(client_id),
        url_encode(api_key),
        url_encode(&state_id),
    );

    Ok(GoogleOAuthStart {
        url,
        state: state_id,
    })
}

#[tauri::command]
pub fn poll_earth_engine_oauth(
    state_id: String,
    state: tauri::State<'_, GoogleOAuthState>,
) -> Result<Option<GoogleOAuthResult>, String> {
    take_result(&state, &state_id)
}

#[tauri::command]
pub fn poll_google_drive_picker(
    state_id: String,
    state: tauri::State<'_, GoogleOAuthState>,
) -> Result<Option<GoogleOAuthResult>, String> {
    take_result(&state, &state_id)
}

/// Removes and returns a completed result. Removing (rather than reading) is
/// what makes polling self-terminating: the frontend stops as soon as it sees a
/// value, and a stale entry can never be handed to a later session.
fn take_result(
    state: &tauri::State<'_, GoogleOAuthState>,
    state_id: &str,
) -> Result<Option<GoogleOAuthResult>, String> {
    let mut results = state.results.lock().map_err(|error| error.to_string())?;
    Ok(results.remove(state_id))
}

fn next_state_id(state: &tauri::State<'_, GoogleOAuthState>) -> Result<String, String> {
    let counter = state.counter.fetch_add(1, Ordering::Relaxed);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    Ok(format!("geolibre-{now}-{counter}"))
}

fn ensure_oauth_server(state: &GoogleOAuthState) -> Result<(), String> {
    if state.server_started.load(Ordering::Acquire) {
        return Ok(());
    }
    if state
        .server_started
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(());
    }

    let listener = match TcpListener::bind((OAUTH_HOST, OAUTH_PORT)) {
        Ok(listener) => listener,
        Err(error) => {
            state.server_started.store(false, Ordering::Release);
            if error.kind() == ErrorKind::AddrInUse {
                return Err(format!(
                    "Could not start the Google sign-in helper on http://localhost:{OAUTH_PORT} because the port is already in use. Close any running GeoLibre dev server or other app using port {OAUTH_PORT}, then try again.",
                ));
            }
            return Err(format!(
                "Could not start the Google sign-in helper on http://localhost:{OAUTH_PORT}: {error}",
            ));
        }
    };
    let results = Arc::clone(&state.results);

    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let results = Arc::clone(&results);
            thread::spawn(move || handle_connection(stream, results));
        }
    });

    Ok(())
}

fn handle_connection(
    mut stream: TcpStream,
    results: Arc<Mutex<HashMap<String, GoogleOAuthResult>>>,
) {
    let Ok((method, target, body)) = read_request(&stream) else {
        let _ = write_response(&mut stream, 400, "text/plain", "Bad request");
        return;
    };
    let (path, query) = split_target(&target);

    match (method.as_str(), path) {
        ("GET", AUTH_PATH) => {
            let params = query_params(query);
            let client_id = params.get("client_id").cloned().unwrap_or_default();
            let state = params.get("state").cloned().unwrap_or_default();
            let _ = write_response(
                &mut stream,
                200,
                "text/html",
                &auth_page(&client_id, &state),
            );
        }
        ("GET", PICKER_PATH) => {
            let params = query_params(query);
            let client_id = params.get("client_id").cloned().unwrap_or_default();
            let api_key = params.get("api_key").cloned().unwrap_or_default();
            let state = params.get("state").cloned().unwrap_or_default();
            let _ = write_response(
                &mut stream,
                200,
                "text/html",
                &picker_page(&client_id, &api_key, &state),
            );
        }
        ("POST", TOKEN_PATH) => {
            if let Ok(result) = serde_json::from_slice::<GoogleOAuthResult>(&body) {
                if !result.state.is_empty() {
                    if let Ok(mut store) = results.lock() {
                        store.insert(result.state.clone(), result);
                    }
                }
            }
            let _ = write_response(&mut stream, 204, "text/plain", "");
        }
        ("OPTIONS", TOKEN_PATH) => {
            let _ = write_response(&mut stream, 204, "text/plain", "");
        }
        _ => {
            let _ = write_response(&mut stream, 404, "text/plain", "Not found");
        }
    }
}

fn read_request(stream: &TcpStream) -> Result<(String, String, Vec<u8>), String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|error| error.to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_string();
    let target = request_parts.next().unwrap_or_default().to_string();

    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if line == "\r\n" || line.is_empty() {
            break;
        }
        if let Some(value) = line.strip_prefix("Content-Length:") {
            content_length = value.trim().parse().unwrap_or(0);
        } else if let Some(value) = line.strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or(0);
        }
    }

    let mut body = vec![0; content_length];
    if content_length > 0 {
        reader
            .read_exact(&mut body)
            .map_err(|error| error.to_string())?;
    }

    Ok((method, target, body))
}

fn split_target(target: &str) -> (&str, &str) {
    target.split_once('?').unwrap_or((target, ""))
}

fn query_params(query: &str) -> HashMap<String, String> {
    let mut params = HashMap::new();
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        params.insert(url_decode(key), url_decode(value));
    }
    params
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "OK",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: http://localhost:{OAUTH_PORT}\r\n\
         Access-Control-Allow-Headers: content-type\r\n\
         Access-Control-Allow-Methods: POST, OPTIONS\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        body.len()
    )
}

/// Shared CSS for both helper pages, so the sign-in and picker windows read as
/// the same app rather than two unrelated browser tabs.
const HELPER_PAGE_STYLE: &str = r#"
    body {
      align-items: center;
      background: #f8fafc;
      color: #111827;
      display: flex;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }
    main {
      background: #fff;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      box-shadow: 0 16px 40px rgba(15, 23, 42, 0.14);
      max-width: 420px;
      padding: 24px;
      width: calc(100vw - 40px);
    }
    h1 {
      font-size: 18px;
      margin: 0 0 8px;
    }
    p {
      color: #4b5563;
      font-size: 14px;
      line-height: 1.5;
      margin: 0 0 18px;
    }
    button {
      background: #0f766e;
      border: 0;
      border-radius: 6px;
      color: white;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      padding: 10px 14px;
    }
    button:disabled {
      cursor: wait;
      opacity: 0.7;
    }
    #status {
      color: #4b5563;
      font-size: 12px;
      margin-top: 14px;
      min-height: 18px;
    }
"#;

fn auth_page(client_id: &str, state: &str) -> String {
    let client_id_json = serde_json::to_string(client_id).unwrap_or_else(|_| "\"\"".to_string());
    let state_json = serde_json::to_string(state).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Earth Engine sign-in</title>
  <style>{HELPER_PAGE_STYLE}</style>
</head>
<body>
  <main>
    <h1>Sign in to Earth Engine</h1>
    <p>Continue with Google to authorize GeoLibre Desktop to request Earth Engine map tiles.</p>
    <button id="sign-in" type="button">Continue with Google</button>
    <div id="status"></div>
  </main>
  <script src="https://accounts.google.com/gsi/client" async defer></script>
  <script>
    const clientId = {client_id_json};
    const state = {state_json};
    // Minimal Earth Engine scopes: tiles/thumbnails need `earthengine`, and the
    // EE control's "Export" writes to Drive via the non-sensitive `drive.file`
    // scope. `cloud-platform` is intentionally omitted (GeoLibre never uses it),
    // keeping the app clear of Google's broad/restricted-scope verification. Keep
    // in sync with EARTH_ENGINE_OAUTH_SCOPES in
    // packages/plugins/src/plugins/earth-engine-auth.ts. (Add Data -> Google
    // Drive requests `drive.file` on its own; see picker_page below.)
    const scope = [
      "https://www.googleapis.com/auth/earthengine",
      "https://www.googleapis.com/auth/drive.file"
    ].join(" ");
    const button = document.getElementById("sign-in");
    const status = document.getElementById("status");

    async function sendResult(payload) {{
      await fetch("{TOKEN_PATH}", {{
        method: "POST",
        headers: {{ "content-type": "application/json" }},
        body: JSON.stringify({{ state, ...payload }})
      }});
    }}

    button.addEventListener("click", () => {{
      if (!globalThis.google?.accounts?.oauth2) {{
        status.textContent = "Google sign-in is still loading. Try again in a moment.";
        return;
      }}
      button.disabled = true;
      status.textContent = "Opening Google sign-in...";
      const tokenClient = google.accounts.oauth2.initTokenClient({{
        client_id: clientId,
        scope,
        callback: async (result) => {{
          try {{
            if (result.error) {{
              await sendResult({{ error: result.error_description || result.error }});
              status.textContent = result.error_description || result.error;
              button.disabled = false;
              return;
            }}
            await sendResult({{
              accessToken: result.access_token,
              tokenType: result.token_type || "Bearer",
              expiresIn: result.expires_in || 3600
            }});
            status.textContent = "Sign-in complete. You can close this window.";
            window.close();
          }} catch (error) {{
            status.textContent = error instanceof Error ? error.message : "Could not return the access token.";
            button.disabled = false;
          }}
        }}
      }});
      tokenClient.requestAccessToken();
    }});
  </script>
</body>
</html>"#
    )
}

/// The Drive picker page: sign in for a `drive.file` token, then hand that token
/// to Google's Picker widget and post the chosen files back.
///
/// The two steps are chained rather than offered as separate buttons because the
/// picker is what *creates* the file grants — under `drive.file` a token on its
/// own reaches nothing pre-existing, so there is no useful state between them.
fn picker_page(client_id: &str, api_key: &str, state: &str) -> String {
    let client_id_json = serde_json::to_string(client_id).unwrap_or_else(|_| "\"\"".to_string());
    let api_key_json = serde_json::to_string(api_key).unwrap_or_else(|_| "\"\"".to_string());
    let state_json = serde_json::to_string(state).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Choose files from Google Drive</title>
  <style>{HELPER_PAGE_STYLE}</style>
</head>
<body>
  <main>
    <h1>Choose files from Google Drive</h1>
    <p>Continue with Google, then pick the data files to open in GeoLibre. For an unzipped shapefile, select the .shp together with its .dbf, .shx and .prj.</p>
    <button id="sign-in" type="button">Continue with Google</button>
    <div id="status"></div>
  </main>
  <script src="https://accounts.google.com/gsi/client" async defer></script>
  <script src="https://apis.google.com/js/api.js" async defer></script>
  <script>
    const clientId = {client_id_json};
    const apiKey = {api_key_json};
    const state = {state_json};
    // `drive.file` grants access only to the files picked here, which is exactly
    // the point: it is non-sensitive, so GeoLibre avoids the restricted
    // `drive.readonly` scope and its CASA security assessment.
    const scope = "https://www.googleapis.com/auth/drive.file";
    // The Picker wants the Cloud project number, which is the client ID's
    // leading numeric segment.
    const appId = clientId.split("-")[0];
    const button = document.getElementById("sign-in");
    const status = document.getElementById("status");

    async function sendResult(payload) {{
      await fetch("{TOKEN_PATH}", {{
        method: "POST",
        headers: {{ "content-type": "application/json" }},
        body: JSON.stringify({{ state, ...payload }})
      }});
    }}

    function loadPicker() {{
      return new Promise((resolve, reject) => {{
        if (!globalThis.gapi) {{
          reject(new Error("The Google Picker library is still loading. Try again in a moment."));
          return;
        }}
        gapi.load("picker", {{
          callback: resolve,
          onerror: () => reject(new Error("Could not load the Google Picker library."))
        }});
      }});
    }}

    async function showPicker(accessToken) {{
      await loadPicker();
      const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false);
      const picker = new google.picker.PickerBuilder()
        .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
        .setDeveloperKey(apiKey)
        .setAppId(appId)
        .setOAuthToken(accessToken)
        .addView(view)
        .setCallback(async (data) => {{
          if (data.action === google.picker.Action.PICKED) {{
            const files = (data.docs || []).map((doc) => ({{
              id: doc.id,
              name: doc.name,
              mimeType: doc.mimeType,
              size: doc.sizeBytes === undefined ? undefined : Number(doc.sizeBytes)
            }}));
            await sendResult({{ accessToken, tokenType: "Bearer", files }});
            status.textContent = "Selection sent to GeoLibre. You can close this window.";
            window.close();
          }} else if (data.action === google.picker.Action.CANCEL) {{
            // An empty list rather than an error, so a closed picker reads as
            // "nothing chosen" and the app simply stops waiting.
            await sendResult({{ accessToken, tokenType: "Bearer", files: [] }});
            status.textContent = "No files chosen. You can close this window.";
            window.close();
          }}
        }})
        .build();
      picker.setVisible(true);
    }}

    button.addEventListener("click", () => {{
      if (!globalThis.google?.accounts?.oauth2) {{
        status.textContent = "Google sign-in is still loading. Try again in a moment.";
        return;
      }}
      button.disabled = true;
      status.textContent = "Opening Google sign-in...";
      const tokenClient = google.accounts.oauth2.initTokenClient({{
        client_id: clientId,
        scope,
        callback: async (result) => {{
          try {{
            if (result.error) {{
              await sendResult({{ error: result.error_description || result.error }});
              status.textContent = result.error_description || result.error;
              button.disabled = false;
              return;
            }}
            status.textContent = "Opening the Drive picker...";
            await showPicker(result.access_token);
          }} catch (error) {{
            const message = error instanceof Error ? error.message : "Could not open the Drive picker.";
            await sendResult({{ error: message }});
            status.textContent = message;
            button.disabled = false;
          }}
        }}
      }});
      tokenClient.requestAccessToken();
    }});
  </script>
</body>
</html>"#
    )
}

fn url_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn url_decode(value: &str) -> String {
    let mut decoded = Vec::new();
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                decoded.push(hex);
                index += 3;
                continue;
            }
        }
        decoded.push(if bytes[index] == b'+' {
            b' '
        } else {
            bytes[index]
        });
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}
