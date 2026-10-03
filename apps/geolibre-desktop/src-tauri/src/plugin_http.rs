//! Native HTTP for plugins: any method, no CORS, and a session cookie jar.
//!
//! A plugin that signs in to a service with a cookie (Data to Science, issue
//! #2837) cannot do it from the webview: the page runs at `tauri://localhost`,
//! so the service's session cookie is third-party and WebKit drops it. Requests
//! made here keep their cookies in one in-memory jar for the app session, the
//! way a browser tab on the service's own site would. Set-Cookie headers are
//! never handed back to JavaScript, matching a browser's HttpOnly handling.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    redirect::Policy,
    Method, Url,
};
use serde::{Deserialize, Serialize};

use super::{
    guarded_async_client_builder, is_disallowed_ip, url_is_fetchable, MAX_HTTP_REDIRECTS,
    SSRF_BLOCKED_MESSAGE,
};

const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
const BODY_TOO_LARGE: &str = "Response exceeds the 64 MiB limit.";
const REQUEST_TIMEOUT_SECS: u64 = 120;

/// Request headers the transport sets itself. A plugin-supplied value would
/// either be ignored or contradict the body reqwest actually sends. `cookie`
/// belongs to the jar: reqwest skips the jar when a request already carries a
/// Cookie header, and `fetch` forbids setting one too.
const MANAGED_REQUEST_HEADERS: &[&str] = &[
    "cookie",
    "host",
    "content-length",
    "connection",
    "transfer-encoding",
    "keep-alive",
    "upgrade",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginHttpRequest {
    url: String,
    method: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    /// Request body, base64-encoded so binary payloads survive the IPC hop.
    body: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginHttpResponse {
    status: u16,
    status_text: String,
    /// The final URL after redirects.
    url: String,
    headers: Vec<(String, String)>,
    /// Response body, base64-encoded.
    body: String,
}

/// Any method token `fetch` accepts, except the ones it forbids. `CONNECT`
/// would tunnel and `TRACE` echoes request headers back to the caller.
fn method(name: &str) -> Result<Method, String> {
    let method = Method::from_bytes(name.to_ascii_uppercase().as_bytes())
        .map_err(|_| format!("Invalid HTTP method: {name}"))?;
    if method == Method::CONNECT || method == Method::TRACE {
        return Err(format!("Unsupported HTTP method: {method}"));
    }
    Ok(method)
}

/// Check a redirect hop. A hostname is re-checked by the guarded DNS resolver
/// when reqwest connects, but a literal IP never reaches a resolver, so check
/// it here; otherwise a redirect to `169.254.169.254` would be followed.
fn redirect_target_allowed(url: &Url) -> Result<(), String> {
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("Unsupported redirect scheme: {other}")),
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Redirect target has no host.".to_string())?;
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if bare.parse::<std::net::IpAddr>().is_ok_and(is_disallowed_ip) {
        return Err(SSRF_BLOCKED_MESSAGE.into());
    }
    Ok(())
}

fn request_headers(headers: Vec<(String, String)>) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("Invalid request header name: {name}"))?;
        if MANAGED_REQUEST_HEADERS.contains(&name.as_str()) {
            continue;
        }
        let value = HeaderValue::from_str(&value)
            .map_err(|_| format!("Invalid value for request header {name}."))?;
        map.append(name, value);
    }
    Ok(map)
}

fn response_headers(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .filter(|(name, _)| *name != reqwest::header::SET_COOKIE)
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect()
}

fn client() -> Result<reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> =
        std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            guarded_async_client_builder(Policy::custom(|attempt| {
                if attempt.previous().len() >= MAX_HTTP_REDIRECTS {
                    return attempt.error("Too many redirects.");
                }
                match redirect_target_allowed(attempt.url()) {
                    Ok(()) => attempt.follow(),
                    Err(error) => attempt.error(error),
                }
            }))?
            .cookie_store(true)
            .build()
            .map_err(|error| format!("Could not create the plugin HTTP client: {error}"))
        })
        .clone()
}

async fn read_response(mut response: reqwest::Response) -> Result<PluginHttpResponse, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BODY_BYTES as u64)
    {
        return Err(BODY_TOO_LARGE.into());
    }
    let status = response.status();
    let url = response.url().to_string();
    let headers = response_headers(response.headers());
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Could not read the response: {}", error.without_url()))?
    {
        if chunk.len() > MAX_BODY_BYTES.saturating_sub(body.len()) {
            return Err(BODY_TOO_LARGE.into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(PluginHttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        url,
        headers,
        body: STANDARD.encode(body),
    })
}

async fn send(request: PluginHttpRequest) -> Result<PluginHttpResponse, String> {
    let url = Url::parse(&request.url).map_err(|_| "Invalid request URL.".to_string())?;
    let method = method(&request.method)?;
    let headers = request_headers(request.headers)?;
    let body = request
        .body
        .map(|body| STANDARD.decode(body))
        .transpose()
        .map_err(|_| "Invalid request body encoding.".to_string())?;
    if body
        .as_ref()
        .is_some_and(|body| body.len() > MAX_BODY_BYTES)
    {
        return Err("Request body exceeds the 64 MiB limit.".into());
    }
    let checked = url.clone();
    tauri::async_runtime::spawn_blocking(move || url_is_fetchable(&checked))
        .await
        .map_err(|error| format!("URL validation failed: {error}"))??;
    let mut builder = client()?
        .request(method, url)
        .headers(headers)
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS));
    if let Some(body) = body {
        builder = builder.body(body);
    }
    let response = builder
        .send()
        .await
        .map_err(|error| format!("Request failed: {}", error.without_url()))?;
    read_response(response).await
}

type CancelRequest = Box<dyn Fn() + Send + Sync>;

#[derive(Default, Clone)]
pub(crate) struct PluginHttpRequests(Arc<Mutex<HashMap<String, CancelRequest>>>);

impl PluginHttpRequests {
    fn cancel(&self, id: &str) {
        if let Some(cancel) = self.0.lock().unwrap().remove(id) {
            cancel();
        }
    }
}

struct RequestGuard {
    requests: PluginHttpRequests,
    id: String,
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.requests.cancel(&self.id);
    }
}

/// Abort an in-flight [`plugin_http_request`] (a plugin's `AbortSignal`).
#[tauri::command]
pub(crate) fn cancel_plugin_http_request(
    request_id: String,
    requests: tauri::State<'_, PluginHttpRequests>,
) {
    requests.cancel(&request_id);
}

/// Send a plugin's HTTP request natively. Cancellation is registered before
/// `ready` fires, so an abort the caller sends after that always lands.
#[tauri::command]
pub(crate) async fn plugin_http_request(
    request: PluginHttpRequest,
    request_id: String,
    ready: tauri::ipc::Channel<()>,
    requests: tauri::State<'_, PluginHttpRequests>,
) -> Result<PluginHttpResponse, String> {
    let task = {
        let mut active = requests.0.lock().unwrap();
        if active.contains_key(&request_id) {
            return Err("Duplicate request ID.".into());
        }
        let task = tauri::async_runtime::spawn(send(request));
        let abort = task.inner().abort_handle();
        active.insert(request_id.clone(), Box::new(move || abort.abort()));
        task
    };
    let _guard = RequestGuard {
        requests: requests.inner().clone(),
        id: request_id,
    };
    ready
        .send(())
        .map_err(|_| "Request caller disconnected.".to_string())?;
    task.await.map_err(|_| "Request cancelled.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_fetch_methods_case_insensitively() {
        assert_eq!(method("post").unwrap(), Method::POST);
        assert_eq!(method("DELETE").unwrap(), Method::DELETE);
        assert_eq!(method("propfind").unwrap().as_str(), "PROPFIND");
        assert!(method("CONNECT").is_err());
        assert!(method("trace").is_err());
        assert!(method("BAD METHOD").is_err());
    }

    #[test]
    fn refuses_redirects_to_blocked_ip_literals() {
        let check = |url: &str| redirect_target_allowed(&Url::parse(url).unwrap());
        assert!(check("http://169.254.169.254/latest/meta-data/").is_err());
        assert!(check("http://[::ffff:169.254.169.254]/").is_err());
        assert!(check("http://[fe80::1]/").is_err());
        assert!(check("ftp://example.com/").is_err());
        // Hostnames are left to the guarded resolver; LAN servers stay reachable.
        assert!(check("https://d2s.example/api").is_ok());
        assert!(check("http://192.168.1.20:8000/api").is_ok());
    }

    #[test]
    fn drops_transport_managed_request_headers() {
        let headers = request_headers(vec![
            ("Content-Type".into(), "application/json".into()),
            ("Host".into(), "evil.example".into()),
            ("Content-Length".into(), "1".into()),
            ("Cookie".into(), "access_token=stale".into()),
        ])
        .unwrap();
        assert_eq!(headers.len(), 1);
        assert_eq!(headers["content-type"], "application/json");
    }

    #[test]
    fn rejects_malformed_request_headers() {
        assert!(request_headers(vec![("bad header".into(), "x".into())]).is_err());
        assert!(request_headers(vec![("X-Test".into(), "line\nbreak".into())]).is_err());
    }

    #[test]
    fn keeps_set_cookie_out_of_the_response_headers() {
        let mut headers = HeaderMap::new();
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        headers.append(
            reqwest::header::SET_COOKIE,
            HeaderValue::from_static("access_token=secret; HttpOnly"),
        );
        assert_eq!(
            response_headers(&headers),
            vec![("content-type".to_string(), "application/json".to_string())]
        );
    }
}
