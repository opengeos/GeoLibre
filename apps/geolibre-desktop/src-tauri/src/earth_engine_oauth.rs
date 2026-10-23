use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    io::ErrorKind,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

const OAUTH_HOST: &str = "127.0.0.1";
const OAUTH_PORT: u16 = 5173;
const OAUTH_ORIGIN: &str = "http://localhost:5173";
const AUTH_PATH: &str = "/__geolibre_ee_auth";
const TOKEN_PATH: &str = "/__geolibre_ee_token";
const STATE_PREFIX: &str = "geolibre-";
// 128 random bits, hex-encoded.
const STATE_HEX_LEN: usize = 32;
// The helper only ever receives a short request line, a handful of headers and
// a token JSON of a few KB. Cap everything so a hostile page on the same machine
// cannot make the helper allocate unbounded memory (an oversized
// `vec![0; content_length]` would abort the whole app) or park threads forever.
const MAX_REQUEST_BYTES: u64 = 64 * 1024;
const MAX_BODY_BYTES: usize = 16 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(10);
// Sign-ins the user started but has not finished. Each start is a user action,
// so a small bound only ever drops long-abandoned attempts.
const MAX_PENDING_STATES: usize = 16;

#[derive(Default)]
pub struct EarthEngineOAuthState {
    server_started: AtomicBool,
    shared: Arc<SharedState>,
}

/// State shared between the Tauri commands and the loopback helper threads.
#[derive(Default)]
struct SharedState {
    /// `state` values issued by `start_earth_engine_oauth` and not yet answered.
    /// The helper only renders the sign-in page for, and only accepts a token
    /// for, a state in this list, so another page cannot plant a token.
    pending: Mutex<VecDeque<String>>,
    tokens: Mutex<HashMap<String, EarthEngineOAuthToken>>,
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
    if !is_valid_client_id(client_id) {
        return Err("Earth Engine OAuth client ID contains unexpected characters.".to_string());
    }

    ensure_oauth_server(&state)?;

    let state_id = format!("{STATE_PREFIX}{}", random_hex(STATE_HEX_LEN / 2)?);
    {
        let mut pending = state
            .shared
            .pending
            .lock()
            .map_err(|error| error.to_string())?;
        if pending.len() >= MAX_PENDING_STATES {
            pending.pop_front();
        }
        pending.push_back(state_id.clone());
    }
    let url = format!(
        "{OAUTH_ORIGIN}{AUTH_PATH}?client_id={}&state={}",
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
    let mut tokens = state
        .shared
        .tokens
        .lock()
        .map_err(|error| error.to_string())?;
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
    let shared = Arc::clone(&state.shared);

    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let shared = Arc::clone(&shared);
            thread::spawn(move || handle_connection(stream, &shared));
        }
    });

    Ok(())
}

/// A parsed HTTP request; header names are lower-cased.
struct Request {
    method: String,
    target: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

fn handle_connection(mut stream: TcpStream, shared: &SharedState) {
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let Ok(request) = read_request(&stream) else {
        let _ = write_response(&mut stream, 400, "text/plain", "Bad request", &[]);
        return;
    };
    let (path, query) = split_target(&request.target);

    match (request.method.as_str(), path) {
        ("GET", AUTH_PATH) => {
            let params = query_params(query);
            let client_id = params.get("client_id").map(String::as_str).unwrap_or("");
            let state = params.get("state").map(String::as_str).unwrap_or("");
            // Only render the page for a sign-in this app started. The page
            // reflects both values, so anything else is refused outright rather
            // than relying on escaping alone.
            if !is_valid_client_id(client_id) || !is_pending_state(shared, state) {
                let _ = write_response(
                    &mut stream,
                    400,
                    "text/plain",
                    "Invalid or expired Earth Engine sign-in request.",
                    &[],
                );
                return;
            }
            let Ok(nonce) = random_hex(16) else {
                let _ = write_response(&mut stream, 500, "text/plain", "Internal error", &[]);
                return;
            };
            let csp = auth_page_csp(&nonce);
            let _ = write_response(
                &mut stream,
                200,
                "text/html",
                &auth_page(client_id, state, &nonce),
                &[
                    ("Content-Security-Policy", csp.as_str()),
                    ("X-Frame-Options", "DENY"),
                    ("X-Content-Type-Options", "nosniff"),
                    ("Referrer-Policy", "no-referrer"),
                    ("Cache-Control", "no-store"),
                ],
            );
        }
        ("POST", TOKEN_PATH) => {
            // The helper page posts JSON from its own origin. Requiring both the
            // exact Origin and a JSON content type rejects cross-site "simple"
            // requests (text/plain, form posts) that skip the CORS preflight.
            let same_origin = request.header("origin") == Some(OAUTH_ORIGIN);
            let is_json = request
                .header("content-type")
                .and_then(|value| value.split(';').next())
                .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"));
            if !same_origin || !is_json {
                let _ = write_response(&mut stream, 403, "text/plain", "Forbidden", &[]);
                return;
            }
            match serde_json::from_slice::<EarthEngineOAuthToken>(&request.body) {
                // A result is either an error or a token, and either one ends
                // the sign-in: the app stops polling at the first result.
                Ok(token)
                    if (non_empty(token.error.as_deref())
                        || non_empty(token.access_token.as_deref()))
                        && take_pending_state(shared, &token.state) =>
                {
                    if let Ok(mut token_store) = shared.tokens.lock() {
                        token_store.insert(token.state.clone(), token);
                    }
                    let _ = write_response(&mut stream, 204, "text/plain", "", &[]);
                }
                _ => {
                    let _ = write_response(&mut stream, 400, "text/plain", "Bad request", &[]);
                }
            }
        }
        _ => {
            let _ = write_response(&mut stream, 404, "text/plain", "Not found", &[]);
        }
    }
}

fn read_request(stream: &TcpStream) -> Result<Request, String> {
    let stream = stream.try_clone().map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(stream.take(MAX_REQUEST_BYTES));
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|error| error.to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_string();
    let target = request_parts.next().unwrap_or_default().to_string();

    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if line.is_empty() {
            // EOF (or the size cap) before the blank line ending the headers.
            return Err("Truncated request".to_string());
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    let content_length = match headers.get("content-length") {
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| "Invalid Content-Length".to_string())?,
        None => 0,
    };
    if content_length > MAX_BODY_BYTES {
        return Err("Request body too large".to_string());
    }
    let mut body = vec![0; content_length];
    if content_length > 0 {
        reader
            .read_exact(&mut body)
            .map_err(|error| error.to_string())?;
    }

    Ok(Request {
        method,
        target,
        headers,
        body,
    })
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

fn is_pending_state(shared: &SharedState, state: &str) -> bool {
    is_valid_state(state)
        && shared
            .pending
            .lock()
            .is_ok_and(|pending| pending.iter().any(|issued| issued == state))
}

/// Consumes `state` from the pending list, so each sign-in accepts one result.
fn take_pending_state(shared: &SharedState, state: &str) -> bool {
    if !is_valid_state(state) {
        return false;
    }
    let Ok(mut pending) = shared.pending.lock() else {
        return false;
    };
    match pending.iter().position(|issued| issued == state) {
        Some(index) => {
            pending.remove(index);
            true
        }
        None => false,
    }
}

/// Google OAuth client IDs look like `1234-abc.apps.googleusercontent.com`.
fn is_valid_client_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_'))
}

fn non_empty(value: Option<&str>) -> bool {
    value.is_some_and(|value| !value.is_empty())
}

fn is_valid_state(value: &str) -> bool {
    value.strip_prefix(STATE_PREFIX).is_some_and(|hex| {
        hex.len() == STATE_HEX_LEN
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

/// Returns `byte_len` bytes from the OS CSPRNG as lower-case hex.
fn random_hex(byte_len: usize) -> Result<String, String> {
    let mut bytes = vec![0u8; byte_len];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    let mut hex = String::with_capacity(byte_len * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(hex, "{byte:02x}");
    }
    Ok(hex)
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
    extra_headers: &[(&str, &str)],
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let mut extra = String::new();
    for (name, value) in extra_headers {
        extra.push_str(&format!("{name}: {value}\r\n"));
    }
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         {extra}\
         Connection: close\r\n\
         \r\n\
         {body}",
        body.len()
    )
}

/// Serializes `value` as a JSON string literal that is safe to embed in an
/// inline `<script>`: JSON escaping alone leaves `<`, `>` and `/` intact, so a
/// value containing `</script>` would end the element early. U+2028/U+2029 are
/// escaped too for older JS parsers that treat them as line terminators.
fn script_json_string(value: &str) -> String {
    serde_json::to_string(value)
        .unwrap_or_else(|_| "\"\"".to_string())
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/// Content-Security-Policy for the sign-in page: only the nonce-tagged inline
/// blocks and Google Identity Services may run, the page cannot be framed, and
/// it may only talk to itself and GIS.
fn auth_page_csp(nonce: &str) -> String {
    format!(
        "default-src 'none'; \
         script-src 'nonce-{nonce}' https://accounts.google.com/gsi/client; \
         style-src 'nonce-{nonce}' https://accounts.google.com/gsi/style; \
         connect-src 'self' https://accounts.google.com/gsi/; \
         frame-src https://accounts.google.com/gsi/; \
         img-src 'self' data:; \
         base-uri 'none'; \
         form-action 'none'; \
         frame-ancestors 'none'"
    )
}

fn auth_page(client_id: &str, state: &str, nonce: &str) -> String {
    let client_id_json = script_json_string(client_id);
    let state_json = script_json_string(state);
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Earth Engine sign-in</title>
  <style nonce="{nonce}">
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
  <script nonce="{nonce}" src="https://accounts.google.com/gsi/client" async defer></script>
  <script nonce="{nonce}">
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
      const response = await fetch("/__geolibre_ee_token", {{
        method: "POST",
        headers: {{ "content-type": "application/json" }},
        body: JSON.stringify({{ state, ...payload }})
      }});
      if (!response.ok) throw new Error("Could not return the access token.");
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
              // GeoLibre stops waiting at the first result, so a retry here
              // would have no taker; it must start again from the app.
              status.textContent = `${{result.error_description || result.error}}. Start sign-in again from GeoLibre.`;
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
            // Parse the hex digits from bytes: slicing the &str here would
            // panic when a multi-byte UTF-8 character follows the `%`.
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                .ok()
                .and_then(|digits| u8::from_str_radix(digits, 16).ok());
            if let Some(hex) = hex {
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

#[cfg(test)]
mod tests {
    use super::*;

    const CLIENT_ID: &str = "1234-abc.apps.googleusercontent.com";

    fn issued_state(shared: &SharedState) -> String {
        let state = format!("{STATE_PREFIX}{}", random_hex(STATE_HEX_LEN / 2).unwrap());
        shared.pending.lock().unwrap().push_back(state.clone());
        state
    }

    /// Sends a raw HTTP request through `handle_connection` over a real
    /// loopback socket and returns the raw response.
    fn roundtrip(shared: &SharedState, request: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let request = request.to_string();
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            stream.write_all(request.as_bytes()).unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        });
        let (stream, _) = listener.accept().unwrap();
        handle_connection(stream, shared);
        client.join().unwrap()
    }

    fn post_token(shared: &SharedState, origin: &str, content_type: &str, body: &str) -> String {
        roundtrip(
            shared,
            &format!(
                "POST {TOKEN_PATH} HTTP/1.1\r\nOrigin: {origin}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            ),
        )
    }

    #[test]
    fn script_json_string_cannot_close_the_script_element() {
        let page = auth_page("</script><script>alert(1)</script>", "</SCRIPT x", "n");
        let script = page.split("<script nonce=\"n\">").nth(1).unwrap();
        let data = script.split("// Minimal").next().unwrap();
        assert!(!data.to_ascii_lowercase().contains("</script"));
        assert!(data.contains("\\u003c/script\\u003e\\u003cscript\\u003ealert(1)"));
        assert_eq!(script_json_string("a\u{2028}b"), "\"a\\u2028b\"");
    }

    #[test]
    fn validators_accept_real_values_only() {
        assert!(is_valid_client_id(CLIENT_ID));
        assert!(!is_valid_client_id(""));
        assert!(!is_valid_client_id("abc</script>"));
        assert!(!is_valid_client_id(&"a".repeat(257)));
        assert!(is_valid_state(&format!(
            "{STATE_PREFIX}{}",
            "0f".repeat(16)
        )));
        assert!(!is_valid_state("geolibre-1700000000000-0"));
        assert!(!is_valid_state(&format!(
            "{STATE_PREFIX}{}",
            "0F".repeat(16)
        )));
    }

    #[test]
    fn auth_page_is_served_only_for_an_issued_state() {
        let shared = SharedState::default();
        let state = issued_state(&shared);

        let ok = roundtrip(
            &shared,
            &format!("GET {AUTH_PATH}?client_id={CLIENT_ID}&state={state} HTTP/1.1\r\n\r\n"),
        );
        assert!(ok.starts_with("HTTP/1.1 200 OK"));
        assert!(ok.contains("X-Frame-Options: DENY"));
        assert!(ok.contains("frame-ancestors 'none'"));
        let nonce = ok
            .split("script-src 'nonce-")
            .nth(1)
            .and_then(|rest| rest.split('\'').next())
            .unwrap();
        assert_eq!(nonce.len(), 32);
        assert_eq!(ok.matches(&format!("nonce=\"{nonce}\"")).count(), 3);

        let xss = roundtrip(
            &shared,
            &format!(
                "GET {AUTH_PATH}?client_id=%3C%2Fscript%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E&state={state} HTTP/1.1\r\n\r\n"
            ),
        );
        assert!(xss.starts_with("HTTP/1.1 400"));
        assert!(!xss.contains("<script"));

        let unknown_state = roundtrip(
            &shared,
            &format!(
                "GET {AUTH_PATH}?client_id={CLIENT_ID}&state={STATE_PREFIX}{} HTTP/1.1\r\n\r\n",
                "ab".repeat(16)
            ),
        );
        assert!(unknown_state.starts_with("HTTP/1.1 400"));
    }

    #[test]
    fn token_post_requires_origin_json_and_an_issued_state() {
        let shared = SharedState::default();
        let state = issued_state(&shared);
        let body = format!(r#"{{"state":"{state}","accessToken":"tok"}}"#);

        let cross_site = post_token(&shared, "https://evil.example", "application/json", &body);
        assert!(cross_site.starts_with("HTTP/1.1 403"));
        let simple_request = post_token(&shared, OAUTH_ORIGIN, "text/plain", &body);
        assert!(simple_request.starts_with("HTTP/1.1 403"));
        let forged_state = format!(
            r#"{{"state":"{STATE_PREFIX}{}","accessToken":"x"}}"#,
            "cd".repeat(16)
        );
        let forged = post_token(&shared, OAUTH_ORIGIN, "application/json", &forged_state);
        assert!(forged.starts_with("HTTP/1.1 400"));
        assert!(shared.tokens.lock().unwrap().is_empty());

        let empty_token = format!(r#"{{"state":"{state}","accessToken":""}}"#);
        let empty = post_token(&shared, OAUTH_ORIGIN, "application/json", &empty_token);
        assert!(empty.starts_with("HTTP/1.1 400"));
        assert!(is_pending_state(&shared, &state));

        let accepted = post_token(
            &shared,
            OAUTH_ORIGIN,
            "application/json; charset=utf-8",
            &body,
        );
        assert!(accepted.starts_with("HTTP/1.1 204"));
        assert_eq!(
            shared.tokens.lock().unwrap()[&state]
                .access_token
                .as_deref(),
            Some("tok")
        );

        // Each issued state accepts exactly one result.
        let replay = post_token(&shared, OAUTH_ORIGIN, "application/json", &body);
        assert!(replay.starts_with("HTTP/1.1 400"));
    }

    #[test]
    fn an_error_result_ends_the_sign_in() {
        let shared = SharedState::default();
        let state = issued_state(&shared);
        let error_body = format!(r#"{{"state":"{state}","error":"access_denied"}}"#);
        let error_result = post_token(&shared, OAUTH_ORIGIN, "application/json", &error_body);
        assert!(error_result.starts_with("HTTP/1.1 204"));
        assert!(!is_pending_state(&shared, &state));
        let stored_error = shared
            .tokens
            .lock()
            .ok()
            .and_then(|tokens| tokens.get(&state).and_then(|token| token.error.clone()));
        assert_eq!(stored_error.as_deref(), Some("access_denied"));

        // The app stops polling at the error, so a later token has no taker.
        let late_token = format!(r#"{{"state":"{state}","accessToken":"tok"}}"#);
        let late = post_token(&shared, OAUTH_ORIGIN, "application/json", &late_token);
        assert!(late.starts_with("HTTP/1.1 400"));
    }

    #[test]
    fn oversized_body_is_rejected_without_allocating_it() {
        let shared = SharedState::default();
        let response = roundtrip(
            &shared,
            &format!(
                "POST {TOKEN_PATH} HTTP/1.1\r\nOrigin: {OAUTH_ORIGIN}\r\nContent-Type: application/json\r\nContent-Length: 999999999999\r\n\r\n"
            ),
        );
        assert!(response.starts_with("HTTP/1.1 400"));
    }

    #[test]
    fn url_decode_tolerates_multibyte_after_percent() {
        assert_eq!(url_decode("%é1"), "%é1");
        assert_eq!(url_decode("a%2Fb+c"), "a/b c");
    }
}
