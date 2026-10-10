//! ArcGIS REST transport, separate from the host-scoped HTTP plugin.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{redirect::Policy, Url};
use serde::Serialize;

use super::{guarded_async_client_builder, url_is_fetchable, MAX_HTTP_REDIRECTS};

const MAX_ARCGIS_BODY_BYTES: usize = 64 * 1024 * 1024;
const BODY_TOO_LARGE: &str =
    "ArcGIS response exceeds the 64 MiB limit. Reduce the records per request.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArcGISResponse {
    status: u16,
    body: String,
    /// The body of an attachment download, which is binary and must reach the
    /// webview byte for byte; `body` is then empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    body_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_type: Option<String>,
}

/// The write operation a POST path addresses, if any.
#[derive(Clone, Copy, PartialEq, Debug)]
enum WriteKind {
    /// `applyEdits` and `deleteAttachments`: form-encoded.
    Form,
    /// `addAttachment` and `updateAttachment`: multipart, carrying a file.
    Multipart,
}

fn write_kind(url: &Url) -> Option<WriteKind> {
    let last = url
        .path_segments()?
        .rev()
        .find(|segment| !segment.is_empty())?;
    match last {
        "applyEdits" | "deleteAttachments" => Some(WriteKind::Form),
        "addAttachment" | "updateAttachment" => Some(WriteKind::Multipart),
        _ => None,
    }
}

/// `.../<objectId>/attachments/<attachmentId>`: the file itself, not JSON.
fn is_attachment_download(url: &Url) -> bool {
    let Some(segments) = url.path_segments() else {
        return false;
    };
    let segments: Vec<&str> = segments.filter(|segment| !segment.is_empty()).collect();
    matches!(
        segments.as_slice(),
        [.., object_id, "attachments", attachment_id]
            if !object_id.is_empty()
                && object_id.bytes().all(|b| b.is_ascii_digit())
                && !attachment_id.is_empty()
                && attachment_id.bytes().all(|b| b.is_ascii_digit())
    )
}

/// A multipart body's type must name its boundary and nothing that could
/// smuggle another header.
fn valid_multipart_type(content_type: &str) -> bool {
    content_type.starts_with("multipart/form-data; boundary=")
        && content_type.len() <= 200
        && !content_type.contains(['\r', '\n'])
}

fn has_token(url: &Url) -> bool {
    url.query_pairs()
        .any(|(key, value)| key == "token" && !value.is_empty())
}

fn validate_url(url: &Url) -> Result<(), String> {
    if has_token(url) && url.scheme() != "https" {
        return Err("ArcGIS access tokens require HTTPS.".into());
    }
    url_is_fetchable(url)
}

fn validate_redirect(previous: &[Url], target: &Url) -> Result<(), String> {
    if let Some(authenticated) = previous.iter().find(|url| has_token(url)) {
        if target.scheme() != "https" || target.origin() != authenticated.origin() {
            return Err(
                "Authenticated ArcGIS redirects must stay on the same HTTPS origin.".into(),
            );
        }
    }
    validate_url(target)
}

fn client() -> Result<reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> =
        std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            // The shared builder carries the SSRF guard and the native download
            // client's enterprise CA and mTLS settings.
            guarded_async_client_builder(Policy::custom(|attempt| {
                if attempt
                    .previous()
                    .iter()
                    .any(|url| write_kind(url).is_some())
                {
                    return attempt.error("ArcGIS write redirects are not allowed.");
                }
                if attempt.previous().len() >= MAX_HTTP_REDIRECTS {
                    return attempt.error("Too many ArcGIS redirects.");
                }
                match validate_redirect(attempt.previous(), attempt.url()) {
                    Ok(()) => attempt.follow(),
                    Err(error) => attempt.error(error),
                }
            }))?
            .build()
            .map_err(|error| format!("Could not create ArcGIS HTTP client: {error}"))
        })
        .clone()
}

type CancelRequest = Box<dyn Fn() + Send + Sync>;

#[derive(Default, Clone)]
pub(crate) struct ArcGISRequests(Arc<Mutex<HashMap<String, CancelRequest>>>);

impl ArcGISRequests {
    fn cancel(&self, id: &str) {
        if let Some(cancel) = self.0.lock().unwrap().remove(id) {
            cancel();
        }
    }
}

struct RequestGuard {
    requests: ArcGISRequests,
    id: String,
}
impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.requests.cancel(&self.id);
    }
}

#[tauri::command]
pub(crate) fn cancel_arcgis_request(
    request_id: String,
    requests: tauri::State<'_, ArcGISRequests>,
) {
    requests.cancel(&request_id);
}

async fn read_response(
    mut response: reqwest::Response,
    limit: usize,
    binary: bool,
) -> Result<ArcGISResponse, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(BODY_TOO_LARGE.into());
    }
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Could not read ArcGIS response: {}", error.without_url()))?
    {
        if chunk.len() > limit.saturating_sub(body.len()) {
            return Err(BODY_TOO_LARGE.into());
        }
        body.extend_from_slice(&chunk);
    }
    if binary {
        return Ok(ArcGISResponse {
            status,
            body: String::new(),
            body_base64: Some(STANDARD.encode(&body)),
            content_type,
        });
    }
    // ArcGIS JSON is UTF-8; match reqwest's replacement of malformed sequences.
    Ok(ArcGISResponse {
        status,
        body: String::from_utf8_lossy(&body).into_owned(),
        body_base64: None,
        content_type,
    })
}

/// A request body: form-encoded text, or a multipart payload with its type.
pub(crate) enum ArcGISBody {
    Form(String),
    Multipart {
        bytes: Vec<u8>,
        content_type: String,
    },
}

impl ArcGISBody {
    fn len(&self) -> usize {
        match self {
            ArcGISBody::Form(text) => text.len(),
            ArcGISBody::Multipart { bytes, .. } => bytes.len(),
        }
    }
}

fn check_write(url: &Url, body: &ArcGISBody) -> Result<(), String> {
    let kind = write_kind(url);
    if url.scheme() != "https" || kind.is_none() {
        return Err("ArcGIS writes require an HTTPS edit or attachment endpoint.".into());
    }
    match body {
        ArcGISBody::Form(_) if kind == Some(WriteKind::Form) => {}
        ArcGISBody::Multipart { content_type, .. }
            if kind == Some(WriteKind::Multipart) && valid_multipart_type(content_type) => {}
        _ => return Err("ArcGIS write body does not match its endpoint.".into()),
    }
    if body.len() > MAX_ARCGIS_BODY_BYTES {
        return Err("ArcGIS edit request exceeds the 64 MiB limit.".into());
    }
    Ok(())
}

async fn request(url: String, body: Option<ArcGISBody>) -> Result<ArcGISResponse, String> {
    let url = Url::parse(&url).map_err(|_| "Invalid ArcGIS URL.".to_string())?;
    if let Some(body) = &body {
        check_write(&url, body)?;
    }
    let binary = body.is_none() && is_attachment_download(&url);
    let checked = url.clone();
    tauri::async_runtime::spawn_blocking(move || validate_url(&checked))
        .await
        .map_err(|error| format!("ArcGIS validation failed: {error}"))??;
    let client = client()?;
    let request = match body {
        Some(ArcGISBody::Form(body)) => client
            .post(url)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(body),
        Some(ArcGISBody::Multipart {
            bytes,
            content_type,
        }) => client
            .post(url)
            .header("Content-Type", content_type)
            .body(bytes),
        None => client.get(url),
    };
    let response = request
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|error| format!("ArcGIS request failed: {}", error.without_url()))?;
    read_response(response, MAX_ARCGIS_BODY_BYTES, binary).await
}

/// Register cancellation before notifying the caller, so even an early abort
/// stops the socket/body read. The guard also cleans up if the command is dropped.
#[tauri::command]
pub(crate) async fn fetch_arcgis_response(
    url: String,
    request_id: String,
    body: Option<String>,
    body_base64: Option<String>,
    content_type: Option<String>,
    ready: tauri::ipc::Channel<()>,
    requests: tauri::State<'_, ArcGISRequests>,
) -> Result<ArcGISResponse, String> {
    let body = match (body, body_base64, content_type) {
        (Some(text), None, None) => Some(ArcGISBody::Form(text)),
        (None, Some(encoded), Some(content_type)) => Some(ArcGISBody::Multipart {
            bytes: STANDARD
                .decode(encoded)
                .map_err(|_| "Invalid ArcGIS request body.".to_string())?,
            content_type,
        }),
        (None, None, None) => None,
        _ => return Err("Invalid ArcGIS request body.".into()),
    };
    let task = {
        let mut active = requests.0.lock().unwrap();
        if active.contains_key(&request_id) {
            return Err("Duplicate ArcGIS request ID.".into());
        }
        let task = tauri::async_runtime::spawn(request(url, body));
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
        .map_err(|_| "ArcGIS caller disconnected.".to_string())?;
    task.await
        .map_err(|_| "ArcGIS request cancelled.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_metadata_and_plaintext_tokens() {
        assert!(
            validate_url(&Url::parse("http://169.254.169.254/latest/meta-data").unwrap()).is_err()
        );
        assert!(validate_url(
            &Url::parse("http://127.0.0.1/FeatureServer/0?token=secret").unwrap()
        )
        .is_err());
        assert!(validate_url(&Url::parse("file:///etc/passwd").unwrap()).is_err());
        assert!(validate_url(&Url::parse("http://127.0.0.1/FeatureServer/0").unwrap()).is_ok());
    }

    #[test]
    fn allows_only_same_https_origin_for_authenticated_redirects() {
        let previous = [Url::parse("https://127.0.0.1/old?token=secret").unwrap()];
        assert!(validate_redirect(
            &previous,
            &Url::parse("https://127.0.0.1/new?token=secret").unwrap()
        )
        .is_ok());
        for target in [
            "http://127.0.0.1/new",
            "https://127.0.0.2/new",
            "https://127.0.0.1:444/new",
        ] {
            assert!(validate_redirect(&previous, &Url::parse(target).unwrap()).is_err());
        }
    }

    #[test]
    fn unauthenticated_redirects_still_enforce_address_guard() {
        let previous = [Url::parse("http://127.0.0.1/FeatureServer/0").unwrap()];
        assert!(validate_redirect(
            &previous,
            &Url::parse("http://169.254.169.254/latest/meta-data").unwrap()
        )
        .is_err());
        assert!(validate_redirect(
            &previous,
            &Url::parse("http://127.0.0.2/FeatureServer/0").unwrap()
        )
        .is_ok());
    }

    fn serve(response: &'static [u8]) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/query", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            stream.read(&mut request).unwrap();
            let _ = stream.write_all(response);
        });
        url
    }

    #[test]
    fn bounds_advertised_and_chunked_bodies_before_decoding() {
        tauri::async_runtime::block_on(async {
            for response in [
                b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n".as_slice(),
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n8\r\n12345678\r\n1\r\n9\r\n0\r\n\r\n".as_slice(),
            ] {
                let response = client().unwrap().get(serve(response)).send().await.unwrap();
                assert!(matches!(read_response(response, 8, false).await, Err(error) if error == BODY_TOO_LARGE));
            }
            let response = client()
                .unwrap()
                .get(serve(
                    b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 8\r\n\r\n12345678",
                ))
                .send()
                .await
                .unwrap();
            let result = read_response(response, 8, false).await.unwrap();
            assert_eq!(result.status, 503);
            assert_eq!(result.body, "12345678");
        });
    }

    #[test]
    fn returns_attachment_bytes_unaltered() {
        tauri::async_runtime::block_on(async {
            let response = client()
                .unwrap()
                .get(serve(
                    b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 4\r\n\r\n\x89\xff\x00P",
                ))
                .send()
                .await
                .unwrap();
            let result = read_response(response, 8, true).await.unwrap();
            assert_eq!(result.body, "");
            assert_eq!(result.content_type.as_deref(), Some("image/png"));
            assert_eq!(
                STANDARD.decode(result.body_base64.unwrap()).unwrap(),
                b"\x89\xff\x00P"
            );
        });
    }

    #[test]
    fn recognizes_attachment_downloads_and_write_endpoints() {
        let url = |s: &str| Url::parse(s).unwrap();
        assert!(is_attachment_download(&url(
            "https://a.com/arcgis/rest/services/S/FeatureServer/0/12/attachments/3?token=x"
        )));
        for other in [
            "https://a.com/S/FeatureServer/0/12/attachments",
            "https://a.com/S/FeatureServer/0/12/attachments/x",
            "https://a.com/S/FeatureServer/0/query",
        ] {
            assert!(!is_attachment_download(&url(other)));
        }
        let form = || ArcGISBody::Form("f=json".into());
        let multipart = |content_type: &str| ArcGISBody::Multipart {
            bytes: vec![1],
            content_type: content_type.into(),
        };
        let boundary = "multipart/form-data; boundary=abc";
        assert!(check_write(&url("https://a.com/S/FeatureServer/0/applyEdits"), &form()).is_ok());
        assert!(check_write(
            &url("https://a.com/S/FeatureServer/0/1/deleteAttachments"),
            &form()
        )
        .is_ok());
        assert!(check_write(
            &url("https://a.com/S/FeatureServer/0/1/addAttachment"),
            &multipart(boundary)
        )
        .is_ok());
        assert!(check_write(
            &url("https://a.com/S/FeatureServer/0/1/updateAttachment"),
            &multipart(boundary)
        )
        .is_ok());
        // Wrong body for the endpoint, plaintext, an unrelated path, header smuggling.
        assert!(check_write(
            &url("https://a.com/S/FeatureServer/0/1/addAttachment"),
            &form()
        )
        .is_err());
        assert!(check_write(
            &url("https://a.com/S/FeatureServer/0/applyEdits"),
            &multipart(boundary)
        )
        .is_err());
        assert!(check_write(&url("http://a.com/S/FeatureServer/0/applyEdits"), &form()).is_err());
        assert!(check_write(&url("https://a.com/S/FeatureServer/0/query"), &form()).is_err());
        assert!(check_write(
            &url("https://a.com/S/FeatureServer/0/1/addAttachment"),
            &multipart("multipart/form-data; boundary=a\r\nX-Evil: 1")
        )
        .is_err());
        assert!(check_write(
            &url("https://a.com/S/FeatureServer/0/1/addAttachment"),
            &multipart("text/plain")
        )
        .is_err());
    }

    #[test]
    fn cancellation_closes_a_stalled_native_body_read() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/query", listener.local_addr().unwrap());
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (closed_tx, closed_rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = [0; 4096];
            stream.read(&mut request).unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n")
                .unwrap();
            started_tx.send(()).unwrap();
            let result = stream.read(&mut request);
            closed_tx.send(matches!(result, Ok(0)) || matches!(result, Err(ref error) if error.kind() == std::io::ErrorKind::ConnectionReset)).unwrap();
        });
        let task = tauri::async_runtime::spawn(request(url, None));
        let abort = task.inner().abort_handle();
        let requests = ArcGISRequests::default();
        requests
            .0
            .lock()
            .unwrap()
            .insert("test".into(), Box::new(move || abort.abort()));
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        requests.cancel("test");
        assert!(tauri::async_runtime::block_on(task).is_err());
        assert!(closed_rx.recv_timeout(Duration::from_secs(5)).unwrap());
        assert!(requests.0.lock().unwrap().is_empty());
        server.join().unwrap();
    }
}
