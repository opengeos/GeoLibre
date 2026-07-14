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
const TOKEN_PATH: &str = "/__geolibre_ee_token";

#[derive(Default)]
pub struct EarthEngineOAuthState {
    counter: AtomicU64,
    server_started: AtomicBool,
    tokens: Arc<Mutex<HashMap<String, EarthEngineOAuthToken>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EarthEngineOAuthStart {
    url: String,
    state: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EarthEngineOAuthToken {
    state: String,
    access_token: Option<String>,
    token_type: Option<String>,
    expires_in: Option<u64>,
    error: Option<String>,
}

#[tauri::command]
pub fn start_earth_engine_oauth(
    client_id: String,
    state: tauri::State<'_, EarthEngineOAuthState>,
) -> Result<EarthEngineOAuthStart, String> {
    let client_id = client_id.trim();
    if client_id.is_empty() {
        return Err("Earth Engine OAuth client ID is required.".to_string());
    }

    ensure_oauth_server(&state)?;

    let counter = state.counter.fetch_add(1, Ordering::Relaxed);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let state_id = format!("geolibre-{now}-{counter}");
    let url = format!(
        "http://localhost:{OAUTH_PORT}{AUTH_PATH}?client_id={}&state={}",
        url_encode(client_id),
        url_encode(&state_id),
    );

    Ok(EarthEngineOAuthStart {
        url,
        state: state_id,
    })
}

#[tauri::command]
pub fn poll_earth_engine_oauth(
    state_id: String,
    state: tauri::State<'_, EarthEngineOAuthState>,
) -> Result<Option<EarthEngineOAuthToken>, String> {
    let mut tokens = state.tokens.lock().map_err(|error| error.to_string())?;
    Ok(tokens.remove(&state_id))
}

fn ensure_oauth_server(state: &EarthEngineOAuthState) -> Result<(), String> {
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
                    "Could not start Earth Engine OAuth helper on http://localhost:{OAUTH_PORT} because the port is already in use. Close any running GeoLibre dev server or other app using port {OAUTH_PORT}, then try again.",
                ));
            }
            return Err(format!(
                "Could not start Earth Engine OAuth helper on http://localhost:{OAUTH_PORT}: {error}",
            ));
        }
    };
    let tokens = Arc::clone(&state.tokens);

    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let tokens = Arc::clone(&tokens);
            thread::spawn(move || handle_connection(stream, tokens));
        }
    });

    Ok(())
}

fn handle_connection(
    mut stream: TcpStream,
    tokens: Arc<Mutex<HashMap<String, EarthEngineOAuthToken>>>,
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
        ("POST", TOKEN_PATH) => {
            if let Ok(token) = serde_json::from_slice::<EarthEngineOAuthToken>(&body) {
                if !token.state.is_empty() {
                    if let Ok(mut token_store) = tokens.lock() {
                        token_store.insert(token.state.clone(), token);
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
  <style>
    body {{
      align-items: center;
      background: #f8fafc;
      color: #111827;
      display: flex;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }}
    main {{
      background: #fff;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      box-shadow: 0 16px 40px rgba(15, 23, 42, 0.14);
      max-width: 420px;
      padding: 24px;
      width: calc(100vw - 40px);
    }}
    h1 {{
      font-size: 18px;
      margin: 0 0 8px;
    }}
    p {{
      color: #4b5563;
      font-size: 14px;
      line-height: 1.5;
      margin: 0 0 18px;
    }}
    button {{
      background: #0f766e;
      border: 0;
      border-radius: 6px;
      color: white;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      padding: 10px 14px;
    }}
    button:disabled {{
      cursor: wait;
      opacity: 0.7;
    }}
    #status {{
      color: #4b5563;
      font-size: 12px;
      margin-top: 14px;
      min-height: 18px;
    }}
  </style>
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
    // packages/plugins/src/plugins/earth-engine-auth.ts.
    const scope = [
      "https://www.googleapis.com/auth/earthengine",
      "https://www.googleapis.com/auth/drive.file"
    ].join(" ");
    const button = document.getElementById("sign-in");
    const status = document.getElementById("status");

    async function sendResult(payload) {{
      await fetch("/__geolibre_ee_token", {{
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
