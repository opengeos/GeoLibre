//! ArcGIS REST transport, separate from the host-scoped HTTP plugin.

use std::time::Duration;

use reqwest::{redirect::Policy, Url};
use serde::Serialize;

use super::{build_guarded_http_client_with_redirects, url_is_fetchable};

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

fn client() -> Result<reqwest::blocking::Client, String> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::blocking::Client, String>> =
        std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            build_guarded_http_client_with_redirects(Policy::custom(|attempt| {
                if attempt.previous().len() >= 10 {
                    return attempt.error("Too many ArcGIS redirects.");
                }
                match validate_redirect(attempt.previous(), attempt.url()) {
                    Ok(()) => attempt.follow(),
                    Err(error) => attempt.error(error),
                }
            }))
        })
        .clone()
}

/// GET-only command with the existing native address/DNS and enterprise TLS guards.
/// Returns HTTP status separately so ArcGIS retry and service-error handling survive IPC.
#[tauri::command]
pub(crate) async fn fetch_arcgis_response(url: String) -> Result<ArcGISResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = Url::parse(&url).map_err(|_| "Invalid ArcGIS URL.".to_string())?;
        validate_url(&url)?;
        let response = client()?
            .get(url)
            .timeout(Duration::from_secs(120))
            .send()
            // reqwest's display includes the URL, which may contain an access token.
            .map_err(|error| format!("ArcGIS request failed: {}", error.without_url()))?;
        let status = response.status().as_u16();
        let body = response
            .text()
            .map_err(|error| format!("Could not read ArcGIS response: {}", error.without_url()))?;
        Ok(ArcGISResponse { status, body })
    })
    .await
    .map_err(|error| format!("ArcGIS request task failed: {error}"))?
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
}
