//! Outbound HTTP from the desktop process: the SSRF guard (blocked address
//! ranges, guarded DNS and redirects), the shared guarded clients with the
//! optional extra CA and mTLS identity, and the `fetch_url_bytes`,
//! `fetch_url_response` and `resolve_url_redirect` commands.

use serde::Serialize;
use serde_json::Value;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

const REMOTE_TILE_TIMEOUT_SECS: u64 = 8;
pub(crate) const MAX_HTTP_REDIRECTS: usize = 10;
const REMOTE_TILE_CONNECT_TIMEOUT_SECS: u64 = 4;
const URL_RESOLVE_TIMEOUT_SECS: u64 = 15;
/// Ceiling for a caller-supplied `fetch_url_bytes` budget. The default suits a
/// tile; callers that download a whole dataset (Add Vector Layer) ask for more,
/// but not without bound, so a bad value cannot wedge a request indefinitely.
const MAX_FETCH_TIMEOUT_SECS: u64 = 600;
/// Error surfaced when a fetch would reach a blocked address.
pub(crate) const SSRF_BLOCKED_MESSAGE: &str =
    "Refusing to fetch a link-local, unspecified, or multicast address";

/// Path to a PEM bundle of extra CA certificate(s) to trust for server
/// verification, on top of the OS trust store (issue #1220).
const HTTP_CA_CERT_ENV: &str = "GEOLIBRE_HTTP_CA_CERT";
/// Path to the client certificate to present for mutual TLS. A `.pem` file
/// (certificate chain plus an unencrypted PKCS#8 private key) or a PKCS#12
/// bundle (`.p12`/`.pfx`, optionally passphrase-protected).
const HTTP_CLIENT_CERT_ENV: &str = "GEOLIBRE_HTTP_CLIENT_CERT";
/// Passphrase for a PKCS#12 client certificate. Its presence also forces the
/// PKCS#12 code path for a client cert that lacks a recognised extension.
const HTTP_CLIENT_CERT_PASSWORD_ENV: &str = "GEOLIBRE_HTTP_CLIENT_CERT_PASSWORD";

/// Whether an IP sits in a range a webview- or plugin-triggered fetch must not
/// reach. This is the SSRF guard for [`fetch_url_bytes`] and
/// [`resolve_url_redirect`]: those commands issue requests from the desktop
/// process's network position and hand the body/redirect back to the webview, so
/// without this a rogue plugin could read cloud metadata (169.254.169.254) — the
/// classic SSRF target — that browser `fetch` cannot reach because of CORS.
///
/// Loopback and private/LAN ranges are deliberately NOT blocked: the app is
/// built to load XYZ tiles, COGs, and PMTiles from a user's own
/// `http://localhost:<port>` or LAN dev server (issue #387), and these commands
/// are the desktop fetch path for that data. Blocking them would break a
/// documented workflow. Sensitive loopback services (the Python sidecar, the
/// Jupyter server) are individually token-gated, so the residual reachability of
/// loopback/LAN is acceptable; link-local/metadata, which has no such guard, is
/// blocked.
pub(crate) fn is_disallowed_ip(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            v4.is_link_local() // 169.254.0.0/16 (incl. cloud metadata)
                || v4.is_unspecified() // 0.0.0.0
                || v4.is_broadcast()
                || v4.is_multicast()
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_disallowed_ip(IpAddr::V4(mapped));
            }
            let segments = v6.segments();
            // Deprecated IPv4-compatible form `::a.b.c.d` (all-zero 96-bit
            // prefix, no `ffff` marker, and not `::`/`::1`). `to_ipv4_mapped`
            // only covers `::ffff:a.b.c.d`, so classify the embedded IPv4 here
            // too — otherwise `::169.254.169.254` would slip past the guard.
            if segments[..6].iter().all(|&s| s == 0) && !(segments[6] == 0 && segments[7] <= 1) {
                let embedded = std::net::Ipv4Addr::new(
                    (segments[6] >> 8) as u8,
                    (segments[6] & 0xff) as u8,
                    (segments[7] >> 8) as u8,
                    (segments[7] & 0xff) as u8,
                );
                return is_disallowed_ip(IpAddr::V4(embedded));
            }
            // Not handled: 6to4 (2002::/16) and Teredo (2001::/32) also embed an
            // IPv4 address, so e.g. 2002:a9fe:a9fe:: could reach 169.254.169.254.
            // These transition mechanisms are effectively defunct and unrouted on
            // modern hosts, so the practical risk is negligible; noted so this
            // isn't mistaken for full coverage of every IPv4-embedding form.
            v6.is_unspecified()
                || v6.is_multicast()
                // fe80::/10 link-local
                || (segments[0] & 0xffc0) == 0xfe80
                // fd00:ec2::/32 AWS IPv6 IMDS (fd00:ec2::254) and EKS Pod Identity (fd00:ec2::23)
                || (segments[0] == 0xfd00 && segments[1] == 0x0ec2)
        }
    }
}

/// Reject a parsed URL that is non-HTTP(S) or whose host resolves to an address
/// [`is_disallowed_ip`] blocks (link-local, cloud metadata, unspecified or
/// multicast; loopback and LAN hosts stay allowed for local data servers).
/// Hostname hosts are resolved and rejected if *any* resolved address is
/// disallowed, so a name that points at a blocked IP cannot slip through.
pub(crate) fn url_is_fetchable(url: &reqwest::Url) -> Result<(), String> {
    use std::net::ToSocketAddrs;
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("Unsupported URL scheme: {other}")),
    }
    let host = url
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?;
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        return if is_disallowed_ip(ip) {
            Err(SSRF_BLOCKED_MESSAGE.to_string())
        } else {
            Ok(())
        };
    }
    let port = url.port_or_known_default().unwrap_or(0);
    let mut resolved_any = false;
    for addr in (bare, port)
        .to_socket_addrs()
        .map_err(|error| format!("Could not resolve host {bare}: {error}"))?
    {
        resolved_any = true;
        if is_disallowed_ip(addr.ip()) {
            return Err(SSRF_BLOCKED_MESSAGE.to_string());
        }
    }
    if resolved_any {
        Ok(())
    } else {
        Err(format!("Could not resolve host {bare}"))
    }
}

/// Parse and SSRF-validate a URL string before a request is issued.
fn ensure_fetchable_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|error| format!("Invalid URL: {error}"))?;
    url_is_fetchable(&parsed)
}

/// A redirect policy that re-applies [`url_is_fetchable`] to every hop, so a
/// public URL that 3xx-redirects to an internal address is not followed.
///
/// A blocked hop fails the request via `attempt.error` rather than
/// `attempt.stop`: stopping makes reqwest hand the 30x response back as `Ok`,
/// which reaches the frontend as a bland "Request failed with status 302" that
/// [`is_ssrf_guard_error`] cannot recognise — and an unrecognised failure is
/// retried by the webview's unguarded `fetch`, which would follow the very
/// redirect this policy refused. Failing with [`SSRF_BLOCKED_MESSAGE`] in the
/// error's source chain keeps that fallback closed. The hop cap still uses
/// `stop`: an over-long but otherwise allowed chain is not an SSRF rejection
/// and must not be reported as one.
fn guarded_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= MAX_HTTP_REDIRECTS {
            return attempt.stop();
        }
        match url_is_fetchable(attempt.url()) {
            Ok(()) => attempt.follow(),
            Err(_) => attempt.error(SSRF_BLOCKED_MESSAGE),
        }
    })
}

/// True when a reqwest failure was caused by the SSRF guard rather than by the
/// network.
///
/// Neither guard's rejection is visible in the top-level `Display`: the redirect
/// policy's error is wrapped in reqwest's "error following redirect", and
/// [`GuardedDnsResolver`]'s is wrapped by the connector. Both keep
/// [`SSRF_BLOCKED_MESSAGE`] in the source chain, so walk it.
fn is_ssrf_guard_error(error: &dyn std::error::Error) -> bool {
    let mut current = Some(error);
    while let Some(error) = current {
        if error.to_string().contains(SSRF_BLOCKED_MESSAGE) {
            return true;
        }
        current = error.source();
    }
    false
}

/// Renders a request failure for the frontend, preserving
/// [`SSRF_BLOCKED_MESSAGE`] verbatim when the guard was what refused it.
///
/// `isBlockedUrlError` in `src/lib/vector-url-fetch.ts` matches on that wording
/// to decide whether retrying in the webview is safe, so a guard rejection that
/// reaches it as a generic transport error fails *open* into an unguarded fetch.
pub(crate) fn request_error_message(error: &reqwest::Error) -> String {
    if is_ssrf_guard_error(error) {
        return SSRF_BLOCKED_MESSAGE.to_string();
    }
    format!("Request failed: {error}")
}

/// A DNS resolver that drops any address in a blocked range, so reqwest connects
/// only to IPs that passed [`is_disallowed_ip`].
///
/// [`url_is_fetchable`] validates the host *before* the request, but reqwest
/// re-resolves the name when it opens the connection, so a check-then-connect
/// gap remains: an attacker controlling DNS (short TTL) could answer the
/// pre-check with a public IP and the actual connection with `169.254.169.254`.
/// Enforcing the filter inside the resolver reqwest actually uses — for the
/// initial request and every redirect hop — closes that rebinding window.
struct GuardedDnsResolver;

impl reqwest::dns::Resolve for GuardedDnsResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        use std::net::ToSocketAddrs;
        Box::pin(async move {
            let host = name.as_str().to_string();
            // Offload blocking std getaddrinfo onto Tokio's blocking pool so
            // slow or unreachable DNS never stalls async workers.
            let resolved = tauri::async_runtime::spawn_blocking(move || {
                (host.as_str(), 0u16)
                    .to_socket_addrs()
                    .map(|iter| iter.collect::<Vec<_>>())
            })
            .await
            .map_err(|error| Box::new(error) as Box<dyn std::error::Error + Send + Sync>)?;
            let addrs: Vec<std::net::SocketAddr> = match resolved {
                Ok(list) => list
                    .into_iter()
                    .filter(|addr| !is_disallowed_ip(addr.ip()))
                    .collect(),
                Err(error) => {
                    return Err(Box::new(error) as Box<dyn std::error::Error + Send + Sync>);
                }
            };
            if addrs.is_empty() {
                return Err(SSRF_BLOCKED_MESSAGE.into());
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// A client certificate for mutual TLS, tagged by the backend it needs.
///
/// The rustls backend (our default) reads a PEM identity directly. PKCS#12
/// bundles, which is what Windows exports and what carries a passphrase, are
/// only parseable by the native-tls backend, so those requests switch backends
/// for that one client (issue #1220).
enum ClientIdentity {
    /// PEM identity (certificate chain plus an unencrypted PKCS#8 key), rustls.
    Pem(reqwest::Identity),
    /// PKCS#12 identity, native-tls. Not available on Android, which does not
    /// ship the native-tls backend (openssl-sys has no NDK cross build).
    #[cfg(not(target_os = "android"))]
    Pkcs12(reqwest::Identity),
}

/// Whether a client certificate should be read as PKCS#12 rather than PEM.
///
/// A `.p12`/`.pfx` extension or a supplied passphrase selects PKCS#12; anything
/// else is treated as PEM.
fn client_cert_is_pkcs12(path: &std::path::Path, has_password: bool) -> bool {
    if has_password {
        return true;
    }
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("p12") | Some("pfx")
    )
}

/// A passphrase without a certificate path is a misconfiguration: the passphrase
/// alone configures nothing, so it is surfaced as an error rather than silently
/// dropped (issue #1220).
fn client_cert_password_without_path(has_cert_path: bool, has_password: bool) -> bool {
    has_password && !has_cert_path
}

/// Load extra CA certificate(s) named by [`HTTP_CA_CERT_ENV`], if any. A
/// set-but-empty value (common from `CA_CERT=${SECRET:-}` env interpolation) is
/// treated as unset rather than read as the path `""`.
fn extra_ca_certificates() -> Result<Vec<reqwest::Certificate>, String> {
    let Some(path) = env::var_os(HTTP_CA_CERT_ENV).filter(|value| !value.is_empty()) else {
        return Ok(Vec::new());
    };
    let path = PathBuf::from(path);
    let pem = fs::read(&path)
        .map_err(|error| format!("Could not read CA certificate {}: {error}", path.display()))?;
    reqwest::Certificate::from_pem_bundle(&pem)
        .map_err(|error| format!("Could not parse CA certificate {}: {error}", path.display()))
}

/// Load the mutual-TLS client identity named by [`HTTP_CLIENT_CERT_ENV`], if any.
fn client_identity() -> Result<Option<ClientIdentity>, String> {
    // Treat missing or empty as unset: env interpolation in Docker/K8s/.env
    // tooling (e.g. `PASSWORD=${SECRET:-}`) commonly yields "" rather than
    // leaving the variable unset, which must not force the PKCS#12 path or trip
    // the stray-passphrase error below. A non-UTF-8 value is surfaced as an error
    // rather than dropped, since the PKCS#12 loader takes a `&str` passphrase.
    let password = match env::var(HTTP_CLIENT_CERT_PASSWORD_ENV) {
        Ok(value) if value.is_empty() => None,
        Ok(value) => Some(value),
        Err(env::VarError::NotPresent) => None,
        Err(env::VarError::NotUnicode(_)) => {
            return Err(format!(
                "{HTTP_CLIENT_CERT_PASSWORD_ENV} is not valid UTF-8"
            ));
        }
    };
    // A set-but-empty cert path is likewise treated as unset, so it does not
    // bypass the stray-passphrase guard below or fail later on `fs::read("")`.
    let Some(path) = env::var_os(HTTP_CLIENT_CERT_ENV).filter(|value| !value.is_empty()) else {
        if client_cert_password_without_path(false, password.is_some()) {
            return Err(format!(
                "{HTTP_CLIENT_CERT_PASSWORD_ENV} is set but {HTTP_CLIENT_CERT_ENV} is not; \
                 set the client certificate path or unset the passphrase"
            ));
        }
        return Ok(None);
    };
    let path = PathBuf::from(path);
    let bytes = fs::read(&path).map_err(|error| {
        format!(
            "Could not read client certificate {}: {error}",
            path.display()
        )
    })?;
    if client_cert_is_pkcs12(&path, password.is_some()) {
        #[cfg(not(target_os = "android"))]
        {
            let identity =
                reqwest::Identity::from_pkcs12_der(&bytes, password.as_deref().unwrap_or(""))
                    .map_err(|error| {
                        format!(
                            "Could not load PKCS#12 client certificate {}: {error}",
                            path.display()
                        )
                    })?;
            Ok(Some(ClientIdentity::Pkcs12(identity)))
        }
        // Android lacks the native-tls backend that parses PKCS#12, so surface a
        // clear error rather than silently misreading the bundle as PEM.
        #[cfg(target_os = "android")]
        {
            Err(format!(
                "PKCS#12 client certificates are not supported on this platform: {}",
                path.display()
            ))
        }
    } else {
        let identity = reqwest::Identity::from_pem(&bytes).map_err(|error| {
            format!(
                "Could not load PEM client certificate {}: {error}",
                path.display()
            )
        })?;
        Ok(Some(ClientIdentity::Pem(identity)))
    }
}

/// A blocking HTTP client that guards direct connections with
/// [`GuardedDnsResolver`] and re-validates redirect URLs. A configured system
/// proxy is a trusted network boundary and must enforce the destination-address
/// policy when it resolves names. See docs/network-endpoints.md.
///
/// The client trusts the OS certificate store (via the `rustls-tls-native-roots`
/// feature) so enterprise CAs work, and presents a client certificate for
/// mutual TLS when one is configured (issue #1220).
///
/// It is built once and cached: the client carries a connection pool and, when
/// mutual TLS is configured, certificate material read and parsed from disk,
/// none of which changes during a run. Callers set their own per-request
/// deadline with [`reqwest::blocking::RequestBuilder::timeout`]. reqwest's
/// blocking `Client` is `Arc`-backed, so cloning the cached instance is cheap. A
/// load error is cached too: the config is static, so re-reading a bad
/// certificate would fail identically.
pub(crate) fn guarded_http_client() -> Result<reqwest::blocking::Client, String> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::blocking::Client, String>> =
        std::sync::OnceLock::new();
    CLIENT.get_or_init(build_guarded_http_client).clone()
}

/// An async `reqwest` client builder with the same SSRF guard, enterprise CAs
/// and mTLS identity as [`build_guarded_http_client_with_redirects`]. The async
/// transports (ArcGIS, plugin requests) add their own redirect policy and any
/// extra settings, then build and cache the client themselves.
pub(crate) fn guarded_async_client_builder(
    redirects: reqwest::redirect::Policy,
) -> Result<reqwest::ClientBuilder, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(REMOTE_TILE_CONNECT_TIMEOUT_SECS))
        .dns_resolver(std::sync::Arc::new(GuardedDnsResolver))
        .user_agent("GeoLibre Desktop")
        .redirect(redirects);
    for certificate in extra_ca_certificates()? {
        builder = builder.add_root_certificate(certificate);
    }
    Ok(match client_identity()? {
        #[cfg(not(target_os = "android"))]
        Some(ClientIdentity::Pkcs12(identity)) => builder.use_native_tls().identity(identity),
        Some(ClientIdentity::Pem(identity)) => builder.use_rustls_tls().identity(identity),
        None => builder.use_rustls_tls(),
    })
}

fn build_guarded_http_client() -> Result<reqwest::blocking::Client, String> {
    build_guarded_http_client_with_redirects(guarded_redirect_policy())
}

fn build_guarded_http_client_with_redirects(
    redirects: reqwest::redirect::Policy,
) -> Result<reqwest::blocking::Client, String> {
    // The SSRF guard (GuardedDnsResolver + redirect re-validation) is applied
    // here, independent of the TLS backend chosen below, for direct connections
    // on both rustls and native-tls. A configured proxy resolves destinations
    // itself and must enforce the same address policy at that network boundary.
    let mut builder = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(REMOTE_TILE_CONNECT_TIMEOUT_SECS))
        .redirect(redirects)
        .dns_resolver(std::sync::Arc::new(GuardedDnsResolver))
        .user_agent("GeoLibre Desktop");

    for certificate in extra_ca_certificates()? {
        builder = builder.add_root_certificate(certificate);
    }

    builder = match client_identity()? {
        // PKCS#12 identities are only understood by native-tls, which also reads
        // the OS trust store on every platform; switch this one client over.
        // (Not reachable on Android — client_identity errors out there.)
        #[cfg(not(target_os = "android"))]
        Some(ClientIdentity::Pkcs12(identity)) => builder.use_native_tls().identity(identity),
        Some(ClientIdentity::Pem(identity)) => builder.use_rustls_tls().identity(identity),
        None => builder.use_rustls_tls(),
    };

    builder
        .build()
        .map_err(|error| format!("Could not create HTTP client: {error}"))
}

/// Fetches a URL's bytes, bypassing browser CORS.
///
/// `timeout_secs` overrides the tile-sized default for callers that download a
/// whole dataset rather than a tile; it is clamped to
/// `[REMOTE_TILE_TIMEOUT_SECS, MAX_FETCH_TIMEOUT_SECS]`, so the budget can only
/// ever be raised and never removed.
/// `max_bytes`, when supplied, limits the body while it is read rather than
/// buffering an oversized response before rejecting it.
#[tauri::command]
pub(crate) async fn fetch_url_bytes(
    url: String,
    timeout_secs: Option<u64>,
    max_bytes: Option<u64>,
) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fetch_url_bytes_blocking(url, timeout_secs, max_bytes)
    })
    .await
    .map_err(|error| format!("Tile fetch task failed: {error}"))?
}

/// A native response that keeps the status and body even when the status is
/// not a success, for protocols whose error answers carry a machine-readable
/// body (an OGC `ExceptionReport` on a 400, say).
#[derive(Serialize)]
pub(crate) struct NativeHttpResponse {
    status: u16,
    final_url: String,
    content_type: Option<String>,
    body: Vec<u8>,
}

/// Fetches a URL, bypassing browser CORS, and returns the status, content type
/// and body whatever the status. Same guards, timeout clamp and optional body
/// limit as [`fetch_url_bytes`], which instead rejects any non-success status.
#[tauri::command]
pub(crate) async fn fetch_url_response(
    url: String,
    timeout_secs: Option<u64>,
    max_bytes: Option<u64>,
    accept: Option<String>,
    discard_error_body: Option<bool>,
) -> Result<NativeHttpResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fetch_url_response_blocking(
            url,
            timeout_secs,
            max_bytes,
            accept,
            discard_error_body.unwrap_or(false),
        )
    })
    .await
    .map_err(|error| format!("Fetch task failed: {error}"))?
}

fn fetch_url_response_blocking(
    url: String,
    timeout_secs: Option<u64>,
    max_bytes: Option<u64>,
    accept: Option<String>,
    discard_error_body: bool,
) -> Result<NativeHttpResponse, String> {
    ensure_fetchable_url(&url)?;

    let client = guarded_http_client()?;
    let timeout = resolve_fetch_timeout_secs(timeout_secs);

    let mut request = client.get(&url).timeout(Duration::from_secs(timeout));
    if let Some(value) = accept {
        request = request.header(reqwest::header::ACCEPT, value);
    }
    let response = request
        .send()
        .map_err(|error| request_error_message(&error))?;
    let status = response.status().as_u16();
    let final_url = response.url().as_str().to_owned();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body = if discard_error_body && !(200..300).contains(&status) {
        Vec::new()
    } else if let Some(limit) = max_bytes {
        let content_length = response.content_length();
        crate::http_body::read_limited_body(response, content_length, limit)?
    } else {
        response
            .bytes()
            .map(|bytes| bytes.to_vec())
            .map_err(|error| format!("Could not read response body: {error}"))?
    };
    Ok(NativeHttpResponse {
        status,
        final_url,
        content_type,
        body,
    })
}

/// Resolves the request budget for a fetch, defaulting to the tile timeout and
/// clamping a caller-supplied value into `[REMOTE_TILE_TIMEOUT_SECS,
/// MAX_FETCH_TIMEOUT_SECS]`. A caller can therefore only ever raise the budget,
/// and never past the ceiling or down to zero (which reqwest reads as "no
/// timeout" and would let a stalled request hang forever).
fn resolve_fetch_timeout_secs(timeout_secs: Option<u64>) -> u64 {
    timeout_secs
        .unwrap_or(REMOTE_TILE_TIMEOUT_SECS)
        .clamp(REMOTE_TILE_TIMEOUT_SECS, MAX_FETCH_TIMEOUT_SECS)
}

fn fetch_url_bytes_blocking(
    url: String,
    timeout_secs: Option<u64>,
    max_bytes: Option<u64>,
) -> Result<Vec<u8>, String> {
    ensure_fetchable_url(&url)?;

    let client = guarded_http_client()?;
    let timeout = resolve_fetch_timeout_secs(timeout_secs);

    let response = client
        .get(&url)
        .timeout(Duration::from_secs(timeout))
        .send()
        .map_err(|error| request_error_message(&error))?;
    let status = response.status();
    if !status.is_success() {
        // Keep this wording: `tileErrorStatus` in `src/lib/tile-retry.ts` reads
        // the status from it to decide whether a tile is retried.
        return Err(format!("Request failed with status {status}"));
    }

    if let Some(limit) = max_bytes {
        let content_length = response.content_length();
        crate::http_body::read_limited_body(response, content_length, limit)
    } else {
        response
            .bytes()
            .map(|bytes| bytes.to_vec())
            .map_err(|error| format!("Could not read response body: {error}"))
    }
}

#[tauri::command]
pub(crate) async fn resolve_url_redirect(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_url_redirect_blocking(url))
        .await
        .map_err(|error| format!("URL resolve task failed: {error}"))?
}

fn resolve_url_redirect_blocking(url: String) -> Result<String, String> {
    ensure_fetchable_url(&url)?;

    let client = guarded_http_client()?;
    let timeout = Duration::from_secs(URL_RESOLVE_TIMEOUT_SECS);

    if let Ok(head_response) = client.head(&url).timeout(timeout).send() {
        if has_xyz_placeholders(head_response.url().as_str()) {
            return Ok(head_response.url().to_string());
        }
    }

    let response = client
        .get(&url)
        .header("accept", "application/json, text/plain;q=0.9, */*;q=0.8")
        .timeout(timeout)
        .send()
        .map_err(|error| request_error_message(&error))?;
    if has_xyz_placeholders(response.url().as_str()) {
        return Ok(response.url().to_string());
    }

    let body = response
        .text()
        .map_err(|error| format!("Could not read response body: {error}"))?;

    resolved_url_from_body(&body).ok_or_else(|| "Could not resolve URL".to_string())
}

fn has_xyz_placeholders(url: &str) -> bool {
    let normalized = url.to_ascii_lowercase();
    (normalized.contains("{z}") || normalized.contains("%7bz%7d"))
        && (normalized.contains("{x}") || normalized.contains("%7bx%7d"))
        && (normalized.contains("{y}") || normalized.contains("%7by%7d"))
}

fn resolved_url_from_body(body: &str) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.starts_with("https://") || trimmed.starts_with("http://") {
        return Some(trimmed.to_string());
    }

    let value: Value = serde_json::from_str(trimmed).ok()?;
    resolved_url_from_json(&value)
}

fn resolved_url_from_json(value: &Value) -> Option<String> {
    if let Some(url) = value.as_str() {
        return http_url(url);
    }

    let object = value.as_object()?;
    for key in ["url", "tileUrl", "tile_url"] {
        if let Some(url) = object.get(key).and_then(Value::as_str).and_then(http_url) {
            return Some(url);
        }
    }

    object
        .get("tiles")
        .and_then(Value::as_array)
        .and_then(|tiles| tiles.first())
        .and_then(Value::as_str)
        .and_then(http_url)
}

fn http_url(url: &str) -> Option<String> {
    if url.starts_with("https://") || url.starts_with("http://") {
        Some(url.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{
        client_cert_is_pkcs12, client_cert_password_without_path, ensure_fetchable_url,
        is_disallowed_ip, is_ssrf_guard_error, resolve_fetch_timeout_secs, MAX_FETCH_TIMEOUT_SECS,
        REMOTE_TILE_TIMEOUT_SECS, SSRF_BLOCKED_MESSAGE,
    };
    use std::net::IpAddr;

    #[test]
    fn response_negotiates_content_and_preserves_redirect_url() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;
        use std::time::{Duration, Instant};

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let server = std::thread::spawn(move || {
            for path in ["/start", "/resolved/coverage.json", "/error", "/error"] {
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
                assert!(request.starts_with(&format!("GET {path} HTTP/1.1")));
                assert!(request
                    .to_ascii_lowercase()
                    .contains("accept: application/prs.coverage+json\r\n"));
                if path == "/start" {
                    socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: /resolved/coverage.json\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                } else if path == "/error" {
                    let body = "x".repeat(64);
                    write!(socket, "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 64\r\nConnection: close\r\n\r\n{body}").unwrap();
                } else {
                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/prs.coverage+json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").unwrap();
                }
            }
        });
        let response = super::fetch_url_response_blocking(
            format!("http://{address}/start"),
            Some(10),
            Some(1024),
            Some("application/prs.coverage+json".to_owned()),
            false,
        )
        .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(
            response.final_url,
            format!("http://{address}/resolved/coverage.json")
        );
        assert_eq!(
            response.content_type.as_deref(),
            Some("application/prs.coverage+json")
        );
        assert_eq!(response.body, b"{}");
        let error_response = super::fetch_url_response_blocking(
            format!("http://{address}/error"),
            Some(10),
            Some(16),
            Some("application/prs.coverage+json".to_owned()),
            true,
        )
        .unwrap();
        assert_eq!(error_response.status, 503);
        assert!(error_response.body.is_empty());
        let limited = super::fetch_url_response_blocking(
            format!("http://{address}/error"),
            Some(10),
            Some(16),
            Some("application/prs.coverage+json".to_owned()),
            false,
        );
        assert!(limited.err().unwrap().contains("download limit"));
        server.join().unwrap();
    }

    // Issue #1220: a client certificate is read as PKCS#12 when its extension is
    // `.p12`/`.pfx` (case-insensitively) or a passphrase is supplied; everything
    // else is treated as PEM.
    #[test]
    fn classifies_client_cert_format() {
        use std::path::Path;
        // Extension selects PKCS#12, case-insensitively.
        assert!(client_cert_is_pkcs12(Path::new("/certs/id.p12"), false));
        assert!(client_cert_is_pkcs12(Path::new("/certs/id.PFX"), false));
        // PEM (and unrecognised) extensions stay PEM without a passphrase.
        assert!(!client_cert_is_pkcs12(Path::new("/certs/id.pem"), false));
        assert!(!client_cert_is_pkcs12(Path::new("/certs/id.crt"), false));
        assert!(!client_cert_is_pkcs12(Path::new("/certs/id"), false));
        // A passphrase forces PKCS#12 even for a PEM-looking or extensionless path.
        assert!(client_cert_is_pkcs12(Path::new("/certs/id.pem"), true));
        assert!(client_cert_is_pkcs12(Path::new("/certs/id"), true));
    }

    // Issue #1220: a passphrase without a certificate path is a misconfiguration
    // (it configures nothing on its own) and must be surfaced, not dropped.
    #[test]
    fn flags_passphrase_without_certificate_path() {
        assert!(client_cert_password_without_path(false, true));
        // A passphrase with a cert path, or no passphrase at all, is fine.
        assert!(!client_cert_password_without_path(true, true));
        assert!(!client_cert_password_without_path(false, false));
        assert!(!client_cert_password_without_path(true, false));
    }

    #[test]
    fn blocks_link_local_and_metadata_ips() {
        for ip in [
            "169.254.169.254",        // cloud metadata (link-local)
            "169.254.0.1",            // link-local
            "0.0.0.0",                // unspecified
            "255.255.255.255",        // broadcast
            "::",                     // unspecified
            "fe80::1",                // link-local
            "fd00:ec2::254",          // AWS IPv6 IMDS
            "fd00:ec2::23",           // AWS EKS Pod Identity
            "::ffff:169.254.169.254", // IPv4-mapped metadata
            "::169.254.169.254",      // IPv4-compatible metadata (deprecated)
        ] {
            assert!(
                is_disallowed_ip(ip.parse::<IpAddr>().unwrap()),
                "expected {ip} to be blocked"
            );
        }
    }

    #[test]
    fn allows_public_loopback_and_lan_ips() {
        // Public plus loopback/LAN, which stay reachable for local tile/COG
        // data (issue #387). Only link-local/metadata is blocked.
        for ip in [
            "8.8.8.8",
            "1.1.1.1",
            "93.184.216.34",
            "2606:4700:4700::1111",
            "127.0.0.1",    // loopback (local dev tile server)
            "192.168.1.10", // LAN
            "10.0.0.5",     // LAN
            "::1",          // loopback
        ] {
            assert!(
                !is_disallowed_ip(ip.parse::<IpAddr>().unwrap()),
                "expected {ip} to be allowed"
            );
        }
    }

    #[test]
    fn ensure_fetchable_url_blocks_metadata_and_bad_schemes() {
        assert!(ensure_fetchable_url("http://169.254.169.254/latest/meta-data").is_err());
        assert!(ensure_fetchable_url("file:///etc/passwd").is_err());
        assert!(ensure_fetchable_url("ftp://example.com/x").is_err());
        // Public and loopback/LAN literals are allowed (local data workflow).
        assert!(ensure_fetchable_url("https://1.1.1.1/").is_ok());
        assert!(ensure_fetchable_url("http://127.0.0.1:8081/tiles/0/0/0.png").is_ok());
        assert!(ensure_fetchable_url("http://[::1]:8081/data.pmtiles").is_ok());
    }

    #[test]
    fn ssrf_guard_error_is_detected_through_the_source_chain() {
        use std::error::Error;
        use std::fmt;

        #[derive(Debug)]
        struct Wrapper(Box<dyn Error + Send + Sync>);
        impl fmt::Display for Wrapper {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                // Deliberately hides the cause, the way reqwest's "error
                // following redirect" / connector errors hide theirs.
                write!(f, "error following redirect for url (https://example.com/)")
            }
        }
        impl Error for Wrapper {
            fn source(&self) -> Option<&(dyn Error + 'static)> {
                Some(self.0.as_ref())
            }
        }

        let blocked = Wrapper(SSRF_BLOCKED_MESSAGE.into());
        assert!(!blocked.to_string().contains(SSRF_BLOCKED_MESSAGE));
        assert!(is_ssrf_guard_error(&blocked));

        // A genuine transport failure must stay fallback-eligible.
        let transport = Wrapper("connection reset by peer".into());
        assert!(!is_ssrf_guard_error(&transport));
    }

    // Add Vector Layer downloads a whole dataset through the same command that
    // fetches tiles, so it asks for a longer budget. The clamp is what keeps
    // that override from becoming a way to disable the timeout entirely.
    #[test]
    fn clamps_the_fetch_timeout_into_the_allowed_range() {
        // No override: the tile-sized default.
        assert_eq!(resolve_fetch_timeout_secs(None), REMOTE_TILE_TIMEOUT_SECS);
        // A dataset-sized budget is honored as asked.
        assert_eq!(resolve_fetch_timeout_secs(Some(180)), 180);
        // Zero would mean "no timeout" to reqwest, so it is raised to the floor
        // rather than letting a stalled request hang forever.
        assert_eq!(
            resolve_fetch_timeout_secs(Some(0)),
            REMOTE_TILE_TIMEOUT_SECS
        );
        // Below the floor is raised; above the ceiling is capped.
        assert_eq!(
            resolve_fetch_timeout_secs(Some(1)),
            REMOTE_TILE_TIMEOUT_SECS
        );
        assert_eq!(
            resolve_fetch_timeout_secs(Some(u64::MAX)),
            MAX_FETCH_TIMEOUT_SECS
        );
    }
}
