//! ArcGIS REST transport, separate from the host-scoped HTTP plugin.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use reqwest::{redirect::Policy, Url};
use serde::Serialize;

use super::{
    client_identity, extra_ca_certificates, url_is_fetchable, ClientIdentity, GuardedDnsResolver,
    MAX_HTTP_REDIRECTS,
};

const MAX_ARCGIS_BODY_BYTES: usize = 64 * 1024 * 1024;
const BODY_TOO_LARGE: &str =
    "ArcGIS response exceeds the 64 MiB limit. Reduce the records per request.";

#[derive(Serialize)]
pub(crate) struct ArcGISResponse {
    status: u16,
    body: String,
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
            let mut builder = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(super::REMOTE_TILE_CONNECT_TIMEOUT_SECS))
                .dns_resolver(Arc::new(GuardedDnsResolver))
                .user_agent("GeoLibre Desktop")
                .redirect(Policy::custom(|attempt| {
                    if attempt.previous().len() >= MAX_HTTP_REDIRECTS {
                        return attempt.error("Too many ArcGIS redirects.");
                    }
                    match validate_redirect(attempt.previous(), attempt.url()) {
                        Ok(()) => attempt.follow(),
                        Err(error) => attempt.error(error),
                    }
                }));
            // Match the native download client's enterprise CA and mTLS settings.
            for certificate in extra_ca_certificates()? {
                builder = builder.add_root_certificate(certificate);
            }
            builder = match client_identity()? {
                #[cfg(not(target_os = "android"))]
                Some(ClientIdentity::Pkcs12(identity)) => {
                    builder.use_native_tls().identity(identity)
                }
                Some(ClientIdentity::Pem(identity)) => builder.use_rustls_tls().identity(identity),
                None => builder.use_rustls_tls(),
            };
            builder
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
) -> Result<ArcGISResponse, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(BODY_TOO_LARGE.into());
    }
    let status = response.status().as_u16();
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
    // ArcGIS JSON is UTF-8; match reqwest's replacement of malformed sequences.
    Ok(ArcGISResponse {
        status,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

async fn request(url: String) -> Result<ArcGISResponse, String> {
    let url = Url::parse(&url).map_err(|_| "Invalid ArcGIS URL.".to_string())?;
    let checked = url.clone();
    tauri::async_runtime::spawn_blocking(move || validate_url(&checked))
        .await
        .map_err(|error| format!("ArcGIS validation failed: {error}"))??;
    let response = client()?
        .get(url)
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|error| format!("ArcGIS request failed: {}", error.without_url()))?;
    read_response(response, MAX_ARCGIS_BODY_BYTES).await
}

/// Register cancellation before notifying the caller, so even an early abort
/// stops the socket/body read. The guard also cleans up if the command is dropped.
#[tauri::command]
pub(crate) async fn fetch_arcgis_response(
    url: String,
    request_id: String,
    ready: tauri::ipc::Channel<()>,
    requests: tauri::State<'_, ArcGISRequests>,
) -> Result<ArcGISResponse, String> {
    let task = {
        let mut active = requests.0.lock().unwrap();
        if active.contains_key(&request_id) {
            return Err("Duplicate ArcGIS request ID.".into());
        }
        let task = tauri::async_runtime::spawn(request(url));
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
                assert!(matches!(read_response(response, 8).await, Err(error) if error == BODY_TOO_LARGE));
            }
            let response = client()
                .unwrap()
                .get(serve(
                    b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 8\r\n\r\n12345678",
                ))
                .send()
                .await
                .unwrap();
            let result = read_response(response, 8).await.unwrap();
            assert_eq!(result.status, 503);
            assert_eq!(result.body, "12345678");
        });
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
        let task = tauri::async_runtime::spawn(request(url));
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
