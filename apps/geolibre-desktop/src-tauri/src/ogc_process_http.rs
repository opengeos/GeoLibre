//! Bounded desktop transport for OGC API Processes discovery, execution and jobs.

use std::{future::Future, sync::Arc, time::Duration};
use tokio::time::{timeout_at, Instant};

use base64::Engine;
use serde::Serialize;

use crate::guarded_http::{
    guarded_async_client_builder, request_error_message, url_is_fetchable, MAX_HTTP_REDIRECTS,
};

const MAX_INPUT_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Serialize)]
pub(crate) struct ProcessHttpResponse {
    status: u16,
    final_url: String,
    content_type: Option<String>,
    location: Option<String>,
    retry_after: Option<String>,
    link: Option<String>,
    body_base64: String,
    body_read_failed: bool,
}

fn request_method(method: &str, body: Option<&str>) -> Result<reqwest::Method, String> {
    let parsed = match method {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err("OGC Processes supports GET, POST and DELETE requests only".into()),
    };
    if let Some(value) = body {
        if parsed != reqwest::Method::POST {
            return Err("Only an OGC process execution POST may have a request body".into());
        }
        if value.len() > MAX_INPUT_BYTES {
            return Err("OGC process inputs exceed the 1 MiB limit".into());
        }
        let document: serde_json::Value = serde_json::from_str(value)
            .map_err(|_| "OGC process inputs must be valid JSON".to_owned())?;
        if !document.is_object() {
            return Err("OGC process execution requires a JSON object".into());
        }
    } else if parsed == reqwest::Method::POST {
        return Err("OGC process execution requires a request body".into());
    }
    Ok(parsed)
}

/// Execute one bounded protocol request through the shared desktop HTTP guard.
/// A distinct command ensures an older host fails explicitly rather than
/// silently treating an execution POST as a legacy GET.
#[tauri::command]
pub(crate) async fn ogc_process_http_request(
    url: String,
    method: String,
    body: Option<String>,
    accept: Option<String>,
    prefer_async: Option<bool>,
    max_bytes: Option<u64>,
    timeout_secs: Option<u64>,
) -> Result<ProcessHttpResponse, String> {
    execute_request(
        ProcessRequest {
            url,
            method,
            body,
            accept,
            prefer_async: prefer_async.unwrap_or(false),
            max_bytes,
            deadline: Instant::now()
                + Duration::from_secs(timeout_secs.unwrap_or(120).clamp(8, 600)),
        },
        Arc::new(url_is_fetchable),
    )
    .await
}

struct ProcessRequest {
    url: String,
    method: String,
    body: Option<String>,
    accept: Option<String>,
    prefer_async: bool,
    max_bytes: Option<u64>,
    deadline: Instant,
}

fn request_timeout() -> String {
    "OGC process request timed out".into()
}

/// Check the absolute deadline before each poll that could dispatch a request.
async fn send_before_deadline<F>(future: F, deadline: Instant) -> Result<F::Output, String>
where
    F: Future,
{
    let mut future = std::pin::pin!(future);
    timeout_at(
        deadline,
        std::future::poll_fn(|context| {
            if Instant::now() >= deadline {
                return std::task::Poll::Ready(Err(request_timeout()));
            }
            future.as_mut().poll(context).map(Ok)
        }),
    )
    .await
    .map_err(|_| request_timeout())?
}

fn client() -> Result<reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> =
        std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            // The shared builder preserves TLS, mTLS and direct-connection DNS guards.
            // A configured proxy must enforce destination policy for writes as well
            // as reads. Redirects are handled below so validation shares the deadline.
            guarded_async_client_builder(reqwest::redirect::Policy::none())?
                .referer(false)
                .build()
                .map_err(|error| format!("Could not create OGC process client: {error}"))
        })
        .clone()
}

/// Preparation can outlive its timeout, but it can never dispatch a request.
async fn prepare_request<F>(
    target: reqwest::Url,
    deadline: Instant,
    validate: Arc<F>,
) -> Result<reqwest::Client, String>
where
    F: Fn(&reqwest::Url) -> Result<(), String> + Send + Sync + 'static,
{
    timeout_at(
        deadline,
        tauri::async_runtime::spawn_blocking(move || {
            if !target.username().is_empty() || target.password().is_some() {
                return Err("OGC process URLs must not contain user information".into());
            }
            validate(&target)?;
            client()
        }),
    )
    .await
    .map_err(|_| request_timeout())?
    .map_err(|error| format!("OGC process preparation failed: {error}"))?
}

async fn execute_request<F>(
    options: ProcessRequest,
    validate: Arc<F>,
) -> Result<ProcessHttpResponse, String>
where
    F: Fn(&reqwest::Url) -> Result<(), String> + Send + Sync + 'static,
{
    let method = request_method(&options.method, options.body.as_deref())?;
    let mut target =
        reqwest::Url::parse(&options.url).map_err(|_| "Invalid OGC process URL".to_owned())?;
    for hop in 0..=MAX_HTTP_REDIRECTS {
        let client = prepare_request(target.clone(), options.deadline, validate.clone()).await?;
        let remaining = options
            .deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or_else(request_timeout)?;
        let mut request = client
            .request(method.clone(), target.clone())
            .timeout(remaining)
            .header(
                reqwest::header::ACCEPT,
                options.accept.as_deref().unwrap_or("application/json"),
            );
        if let Some(body) = &options.body {
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body.clone());
        }
        if options.prefer_async && method == reqwest::Method::POST {
            request = request.header("Prefer", "respond-async");
        }
        let response = send_before_deadline(request.send(), options.deadline)
            .await?
            .map_err(|error| request_error_message(&error.without_url()))?;
        if method == reqwest::Method::GET
            && matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308)
        {
            if let Some(location) = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
            {
                if hop == MAX_HTTP_REDIRECTS {
                    return Err("Too many OGC process redirects".into());
                }
                target = target
                    .join(location)
                    .map_err(|_| "Invalid OGC process redirect".to_owned())?;
                continue;
            }
        }
        return read_response(
            response,
            options.deadline,
            options.max_bytes,
            method != reqwest::Method::GET,
        )
        .await;
    }
    Err("Too many OGC process redirects".into())
}

async fn read_body(mut response: reqwest::Response, limit: u64) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err(format!("Response exceeds the {limit}-byte download limit"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| request_error_message(&error.without_url()))?
    {
        if chunk.len() as u64 > limit.saturating_sub(bytes.len() as u64) {
            return Err(format!("Response exceeds the {limit}-byte download limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn read_response(
    response: reqwest::Response,
    deadline: Instant,
    max_bytes: Option<u64>,
    write: bool,
) -> Result<ProcessHttpResponse, String> {
    let status = response.status().as_u16();
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    let links: Vec<_> = response
        .headers()
        .get_all(reqwest::header::LINK)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .collect();
    let mut result = ProcessHttpResponse {
        status,
        final_url: response.url().as_str().to_owned(),
        content_type: header("content-type"),
        location: header("location"),
        retry_after: header("retry-after"),
        link: if links.is_empty() {
            None
        } else {
            Some(links.join(", "))
        },
        body_base64: String::new(),
        body_read_failed: false,
    };
    let limit = max_bytes.unwrap_or(2 * 1024 * 1024).min(MAX_RESPONSE_BYTES);
    let limit = if (200..300).contains(&status) {
        limit
    } else {
        limit.min(64 * 1024)
    };
    let body = timeout_at(deadline, read_body(response, limit))
        .await
        .map_err(|_| request_timeout())
        .and_then(|result| result);
    match body {
        Ok(bytes) => result.body_base64 = base64::engine::general_purpose::STANDARD.encode(bytes),
        Err(_) if write && (200..300).contains(&status) => result.body_read_failed = true,
        Err(_) if !(200..300).contains(&status) => result.body_read_failed = true,
        Err(error) => return Err(error),
    }
    Ok(result)
}

#[cfg(test)]
fn request_blocking(
    url: String,
    method: String,
    body: Option<String>,
    accept: Option<String>,
    prefer_async: bool,
    max_bytes: Option<u64>,
    timeout_secs: Option<u64>,
) -> Result<ProcessHttpResponse, String> {
    tauri::async_runtime::block_on(ogc_process_http_request(
        url,
        method,
        body,
        accept,
        Some(prefer_async),
        max_bytes,
        timeout_secs,
    ))
}

#[cfg(test)]
mod tests {
    use super::{request_method, MAX_INPUT_BYTES};

    #[test]
    fn input_depth_matches_the_shared_client_preflight_limit() {
        for (arrays, allowed) in [(125, true), (126, false)] {
            let body = format!(
                "{{\"inputs\":{{\"payload\":{}0{}}}}}",
                "[".repeat(arrays),
                "]".repeat(arrays)
            );
            assert_eq!(request_method("POST", Some(&body)).is_ok(), allowed);
        }
    }

    #[test]
    fn expired_send_is_never_polled() {
        tauri::async_runtime::block_on(async {
            let dispatched = std::cell::Cell::new(false);
            let send = std::future::poll_fn(|_| {
                dispatched.set(true);
                std::task::Poll::Ready(())
            });
            let result = super::send_before_deadline(send, super::Instant::now()).await;
            assert!(result.unwrap_err().contains("timed out"));
            assert!(!dispatched.get());
        });
    }

    #[test]
    fn execution_inputs_and_methods_are_bounded_before_network_access() {
        assert!(request_method("POST", Some(r#"{"inputs":{"name":"GeoLibre"}}"#)).is_ok());
        assert!(request_method("GET", None).is_ok());
        assert!(request_method("DELETE", None).is_ok());
        for method in ["PUT", "PATCH", "TRACE", "post"] {
            assert!(request_method(method, Some("{}")).is_err());
        }
        assert!(request_method("GET", Some("{}")).is_err());
        assert!(request_method("POST", None).is_err());
        assert!(request_method("POST", Some("[]")).is_err());
        assert!(request_method("POST", Some("broken")).is_err());
        assert!(request_method("POST", Some(&" ".repeat(MAX_INPUT_BYTES + 1))).is_err());
    }

    #[test]
    fn expired_validation_never_dispatches_a_late_write() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Mutex,
        };
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let (release, wait) = mpsc::channel();
        let wait = Mutex::new(wait);
        let finished = super::Arc::new(AtomicBool::new(false));
        let completed = finished.clone();
        let validator = super::Arc::new(move |target: &reqwest::Url| {
            wait.lock()
                .unwrap()
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap();
            let result = super::url_is_fetchable(target);
            completed.store(true, Ordering::SeqCst);
            result
        });
        let result = tauri::async_runtime::block_on(super::execute_request(
            super::ProcessRequest {
                url: format!("http://{}/execution", listener.local_addr().unwrap()),
                method: "POST".into(),
                body: Some("{}".into()),
                accept: None,
                prefer_async: false,
                max_bytes: None,
                deadline: super::Instant::now() + std::time::Duration::from_millis(150),
            },
            validator,
        ));
        assert!(result.err().unwrap().contains("timed out"));
        release.send(()).unwrap();
        for _ in 0..100 {
            if finished.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(finished.load(Ordering::SeqCst));
        let observe_until = std::time::Instant::now() + std::time::Duration::from_millis(100);
        while std::time::Instant::now() < observe_until {
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    #[test]
    fn body_deadline_preserves_write_acknowledgements_but_fails_reads() {
        use std::{
            io::{BufRead, BufReader, Write},
            net::TcpListener,
            time::Duration,
        };
        for method in ["POST", "GET"] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let (release, hold) = std::sync::mpsc::channel();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    assert!(
                        reader.read_line(&mut line).unwrap() > 0,
                        "unexpected EOF before headers completed"
                    );
                    if line == "\r\n" {
                        break;
                    }
                }
                socket.write_all(b"HTTP/1.1 202 Accepted\r\nLocation: /jobs/retained\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n").unwrap();
                hold.recv_timeout(Duration::from_secs(5)).unwrap();
            });
            let result = tauri::async_runtime::block_on(async {
                let target = reqwest::Url::parse(&format!("http://{address}/execution")).unwrap();
                let client = super::prepare_request(
                    target.clone(),
                    super::Instant::now() + Duration::from_secs(5),
                    super::Arc::new(super::url_is_fetchable),
                )
                .await
                .unwrap();
                let response = client
                    .request(
                        reqwest::Method::from_bytes(method.as_bytes()).unwrap(),
                        target,
                    )
                    .timeout(Duration::from_secs(5))
                    .send()
                    .await
                    .unwrap();
                // The body is held until this read returns. Start this test's
                // deadline only after headers exist, independent of setup load.
                super::read_response(
                    response,
                    super::Instant::now() + Duration::from_millis(50),
                    None,
                    method == "POST",
                )
                .await
            });
            release.send(()).unwrap();
            if method == "POST" {
                let response = result.unwrap();
                assert_eq!(response.status, 202);
                assert_eq!(response.location.as_deref(), Some("/jobs/retained"));
                assert!(response.body_read_failed);
            } else {
                assert!(result.is_err());
            }
            server.join().unwrap();
        }
    }
}

#[cfg(test)]
mod transport_tests {
    use super::request_blocking;
    use base64::Engine;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::time::{Duration, Instant};

    #[test]
    fn mutating_redirects_never_send_a_second_request() {
        let origin = TcpListener::bind("127.0.0.1:0").unwrap();
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/execution", origin.local_addr().unwrap());
        let redirected = format!("http://{}/unexpected", destination.local_addr().unwrap());
        origin.set_nonblocking(true).unwrap();
        destination.set_nonblocking(true).unwrap();
        let server = std::thread::spawn(move || {
            for (method, status) in [("POST", 303), ("POST", 307), ("DELETE", 308)] {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut socket = loop {
                    match origin.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline, "write request did not arrive");
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        Err(error) => panic!("accept failed: {error}"),
                    }
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut line = String::new();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                reader.read_line(&mut line).unwrap();
                assert!(line.starts_with(&format!("{method} /execution ")));
                let mut length = 0;
                loop {
                    let mut header = String::new();
                    assert!(reader.read_line(&mut header).unwrap() > 0);
                    if header == "\r\n" {
                        break;
                    }
                    if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:")
                    {
                        length = value.trim().parse::<usize>().unwrap();
                    }
                }
                reader.read_exact(&mut vec![0; length]).unwrap();
                write!(socket, "HTTP/1.1 {status} Redirect\r\nLocation: {redirected}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            }
        });
        for (method, status) in [("POST", 303), ("POST", 307), ("DELETE", 308)] {
            let result = request_blocking(
                url.clone(),
                method.into(),
                (method == "POST").then(|| "{}".to_owned()),
                None,
                false,
                None,
                Some(8),
            )
            .unwrap();
            assert_eq!(result.status, status);
        }
        server.join().unwrap();
        assert!(
            matches!(destination.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
        );
    }

    #[test]
    fn redirects_do_not_disclose_query_credentials_through_referer() {
        let origin = TcpListener::bind("127.0.0.1:0").unwrap();
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        let initial_url = format!(
            "http://{}/execution?token=private-value",
            origin.local_addr().unwrap()
        );
        let final_url = format!("http://{}/results", destination.local_addr().unwrap());
        let destination_url = final_url.clone();
        let server = std::thread::spawn(move || {
            for (listener, redirect) in [(origin, true), (destination, false)] {
                listener.set_nonblocking(true).unwrap();
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline, "redirect request did not arrive");
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        Err(error) => panic!("accept failed: {error}"),
                    }
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut request = String::new();
                loop {
                    let mut line = String::new();
                    assert!(reader.read_line(&mut line).unwrap() > 0);
                    if line == "\r\n" {
                        break;
                    }
                    request.push_str(&line);
                }
                if redirect {
                    assert!(request.contains("?token=private-value"));
                    write!(socket, "HTTP/1.1 302 Found\r\nLocation: {destination_url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                } else {
                    assert!(!request.to_ascii_lowercase().contains("referer:"));
                    assert!(!request.contains("private-value"));
                    socket
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                        )
                        .unwrap();
                }
            }
        });
        let response =
            request_blocking(initial_url, "GET".into(), None, None, false, None, Some(8)).unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.final_url, final_url);
        server.join().unwrap();
    }

    #[test]
    fn execution_job_headers_dismissal_errors_and_body_limits_survive_transport() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let server = std::thread::spawn(move || {
            for (method, path, status, headers, body) in [
                (
                    "POST",
                    "/execution",
                    "202 Accepted",
                    "Location: /jobs/one\r\nRetry-After: 1\r\nLink: </execution>; rel=\"self\"\r\nLink: </jobs/one>; rel=\"monitor\"\r\n",
                    r#"{"status":"accepted"}"#,
                ),
                (
                    "GET",
                    "/jobs/one",
                    "200 OK",
                    "",
                    r#"{"status":"successful"}"#,
                ),
                (
                    "DELETE",
                    "/jobs/one",
                    "200 OK",
                    "",
                    r#"{"status":"dismissed"}"#,
                ),
                (
                    "GET",
                    "/missing",
                    "404 Not Found",
                    "",
                    r#"{"code":"NoSuchProcess"}"#,
                ),
                ("GET", "/large", "200 OK", "", "12345678"),
                (
                    "GET",
                    "/unavailable",
                    "503 Service Unavailable",
                    "",
                    "12345678",
                ),
                ("POST", "/accepted-broken", "202 Accepted", "Location: /jobs/accepted\r\n", "{}"),
                ("POST", "/accepted-large", "201 Created", "Location: /jobs/accepted\r\n", "12345678"),
                ("POST", "/sync-broken", "200 OK", "Link: </jobs/sync>; rel=monitor\r\n", "{}"),
                ("POST", "/sync-large", "200 OK", "Link: </jobs/sync>; rel=monitor\r\n", "12345678"),
                ("DELETE", "/delete-broken", "200 OK", "", "{}"),
            ] {
                let deadline = Instant::now() + Duration::from_secs(10);
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline, "request did not arrive");
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        Err(error) => panic!("accept failed: {error}"),
                    }
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut request = String::new();
                loop {
                    let mut line = String::new();
                    assert!(reader.read_line(&mut line).unwrap() > 0);
                    if line == "\r\n" {
                        break;
                    }
                    request.push_str(&line);
                }
                assert!(request.starts_with(&format!("{method} {path} HTTP/1.1")));
                let lower = request.to_ascii_lowercase();
                assert!(lower.contains("accept: application/json\r\n"));
                if method == "POST" {
                    assert!(lower.contains("prefer: respond-async\r\n"));
                    assert!(lower.contains("content-type: application/json\r\n"));
                    let length: usize = lower
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .unwrap()
                        .parse()
                        .unwrap();
                    let mut data = vec![0; length];
                    reader.read_exact(&mut data).unwrap();
                    assert_eq!(
                        serde_json::from_slice::<serde_json::Value>(&data).unwrap()["inputs"]
                            ["name"],
                        "GeoLibre"
                    );
                } else {
                    assert!(!lower.contains("prefer:"));
                }
                let length = if path.ends_with("-broken") { body.len() + 100 } else { body.len() };
                let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{headers}Content-Length: {length}\r\nConnection: close\r\n\r\n{body}");
                socket.write_all(response.as_bytes()).unwrap();
            }
        });
        let url = |path: &str| format!("http://{address}{path}");
        let accepted = request_blocking(
            url("/execution"),
            "POST".into(),
            Some(r#"{"inputs":{"name":"GeoLibre"}}"#.into()),
            None,
            true,
            Some(1024),
            Some(10),
        )
        .unwrap();
        assert_eq!(accepted.status, 202);
        assert_eq!(accepted.location.as_deref(), Some("/jobs/one"));
        assert_eq!(accepted.retry_after.as_deref(), Some("1"));
        assert_eq!(
            accepted.link.as_deref(),
            Some("</execution>; rel=\"self\", </jobs/one>; rel=\"monitor\"")
        );
        assert_eq!(accepted.content_type.as_deref(), Some("application/json"));
        assert_eq!(accepted.final_url, url("/execution"));
        for (method, path, status, field, value) in [
            ("GET", "/jobs/one", 200, "status", "successful"),
            ("DELETE", "/jobs/one", 200, "status", "dismissed"),
            ("GET", "/missing", 404, "code", "NoSuchProcess"),
        ] {
            let response = request_blocking(
                url(path),
                method.into(),
                None,
                None,
                false,
                Some(1024),
                Some(10),
            )
            .unwrap();
            assert_eq!(response.status, status);
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(
                    &base64::engine::general_purpose::STANDARD
                        .decode(&response.body_base64)
                        .unwrap()
                )
                .unwrap()[field],
                value
            );
        }
        let error = request_blocking(
            url("/large"),
            "GET".into(),
            None,
            None,
            false,
            Some(4),
            Some(10),
        )
        .err()
        .unwrap();
        assert!(error.contains("download limit"));
        let unavailable = request_blocking(
            url("/unavailable"),
            "GET".into(),
            None,
            None,
            false,
            Some(4),
            Some(10),
        )
        .unwrap();
        assert_eq!(unavailable.status, 503);
        assert!(unavailable.body_base64.is_empty());
        for (path, max, status) in [("/accepted-broken", 1024, 202), ("/accepted-large", 4, 201)] {
            let accepted = request_blocking(
                url(path),
                "POST".into(),
                Some(r#"{"inputs":{"name":"GeoLibre"}}"#.into()),
                None,
                true,
                Some(max),
                Some(10),
            )
            .unwrap();
            assert_eq!(accepted.status, status);
            assert_eq!(accepted.location.as_deref(), Some("/jobs/accepted"));
            assert!(accepted.body_base64.is_empty());
            assert!(accepted.body_read_failed);
        }
        for (path, max) in [("/sync-broken", 1024), ("/sync-large", 4)] {
            let recovered = request_blocking(
                url(path),
                "POST".into(),
                Some(r#"{"inputs":{"name":"GeoLibre"}}"#.into()),
                None,
                true,
                Some(max),
                Some(10),
            )
            .unwrap();
            assert_eq!(recovered.status, 200);
            assert_eq!(recovered.link.as_deref(), Some("</jobs/sync>; rel=monitor"));
            assert!(recovered.body_base64.is_empty());
            assert!(recovered.body_read_failed);
        }
        let dismissed = request_blocking(
            url("/delete-broken"),
            "DELETE".into(),
            None,
            None,
            false,
            Some(1024),
            Some(10),
        )
        .unwrap();
        assert_eq!(dismissed.status, 200);
        assert!(dismissed.body_base64.is_empty());
        server.join().unwrap();
        let failure = request_blocking(
            url("/closed?token=private-value"),
            "GET".into(),
            None,
            None,
            false,
            None,
            Some(8),
        )
        .err()
        .unwrap();
        assert!(!failure.contains("private-value"));
        assert!(!failure.contains("token="));
    }

    #[test]
    fn rejects_metadata_targets_and_embedded_credentials_before_sending() {
        for url in [
            "http://169.254.169.254/latest/meta-data/",
            "https://user:password@example.org/processes",
        ] {
            assert!(
                request_blocking(url.into(), "GET".into(), None, None, false, None, None).is_err()
            );
        }
    }
}
