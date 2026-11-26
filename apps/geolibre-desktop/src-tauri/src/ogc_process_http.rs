//! Bounded desktop transport for OGC API Processes discovery, execution and jobs.

use std::time::Duration;

use base64::Engine;
use serde::Serialize;

use crate::guarded_http::{
    guarded_http_client_without_referer, request_error_message, url_is_fetchable,
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
    tauri::async_runtime::spawn_blocking(move || {
        request_blocking(
            url,
            method,
            body,
            accept,
            prefer_async.unwrap_or(false),
            max_bytes,
            timeout_secs,
        )
    })
    .await
    .map_err(|error| format!("OGC process HTTP task failed: {error}"))?
}

fn request_blocking(
    url: String,
    method: String,
    body: Option<String>,
    accept: Option<String>,
    prefer_async: bool,
    max_bytes: Option<u64>,
    timeout_secs: Option<u64>,
) -> Result<ProcessHttpResponse, String> {
    let method = request_method(&method, body.as_deref())?;
    let target = reqwest::Url::parse(&url).map_err(|_| "Invalid OGC process URL".to_owned())?;
    if !target.username().is_empty() || target.password().is_some() {
        return Err("OGC process URLs must not contain user information".into());
    }
    url_is_fetchable(&target)?;
    let client = guarded_http_client_without_referer()?;
    let mut request = client
        .request(method.clone(), target)
        .timeout(Duration::from_secs(
            timeout_secs.unwrap_or(120).clamp(8, 600),
        ))
        .header(
            reqwest::header::ACCEPT,
            accept.as_deref().unwrap_or("application/json"),
        );
    if let Some(body) = body {
        request = request
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body);
    }
    if prefer_async && method == reqwest::Method::POST {
        request = request.header("Prefer", "respond-async");
    }
    let response = request
        .send()
        .map_err(|error| request_error_message(&error.without_url()))?;
    let status = response.status().as_u16();
    let final_url = response.url().as_str().to_owned();
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let content_type = header("content-type");
    let location = header("location");
    let retry_after = header("retry-after");
    let links: Vec<&str> = response
        .headers()
        .get_all(reqwest::header::LINK)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .collect();
    let link = if links.is_empty() {
        None
    } else {
        Some(links.join(", "))
    };
    let length = response.content_length();
    let max_bytes = max_bytes.unwrap_or(2 * 1024 * 1024).min(MAX_RESPONSE_BYTES);
    // Keep small OGC exception documents, but an oversized/broken error page
    // must not hide the server's HTTP status behind a download-limit error.
    let body = if (200..300).contains(&status) {
        crate::http_body::read_limited_body(response, length, max_bytes)?
    } else {
        crate::http_body::read_limited_body(response, length, max_bytes.min(64 * 1024))
            .unwrap_or_default()
    };
    Ok(ProcessHttpResponse {
        status,
        final_url,
        content_type,
        location,
        retry_after,
        link,
        body_base64: base64::engine::general_purpose::STANDARD.encode(body),
    })
}

#[cfg(test)]
mod tests {
    use super::{request_method, MAX_INPUT_BYTES};

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
}

#[cfg(test)]
mod transport_tests {
    use super::request_blocking;
    use base64::Engine;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::time::{Duration, Instant};

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
                let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
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
