//! Shared HTTP client builders and RFC 3986 percent-encoding helpers.
//!
//! Consolidates repeated `reqwest::blocking::Client::builder()` configurations
//! and hand-rolled percent-encoders/decoders onto the `percent-encoding` crate.

use std::time::Duration;

use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};

use crate::app_error::AppError;

pub(crate) const DEFAULT_USER_AGENT: &str = "GeoLibre Desktop";

/// RFC 3986 unreserved characters (`A-Z`, `a-z`, `0-9`, `-`, `.`, `_`, `~`) left
/// unescaped; every other byte is uppercase percent-encoded (`%XX`).
const RFC3986_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// Percent-encode `value` per RFC 3986 (used by AWS SigV4 and OAuth queries).
pub(crate) fn percent_encode_rfc3986(value: &str) -> String {
    utf8_percent_encode(value, RFC3986_ENCODE_SET).to_string()
}

/// Percent-decode `value` (lossy UTF-8, preserving invalid `%` sequences verbatim).
pub(crate) fn percent_decode_lossy(value: &str) -> String {
    percent_decode_str(value).decode_utf8_lossy().into_owned()
}

/// Decode `application/x-www-form-urlencoded` query values (`+` -> space, then
/// percent-decode lossy UTF-8 without panicking on multibyte bytes after `%`).
pub(crate) fn form_url_decode_lossy(value: &str) -> String {
    let plus_as_space = value.replace('+', " ");
    percent_decode_lossy(&plus_as_space)
}

/// Build a blocking `reqwest` client with GeoLibre's standard User-Agent and timeout.
pub(crate) fn blocking_client(timeout: Duration) -> Result<reqwest::blocking::Client, AppError> {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .user_agent(DEFAULT_USER_AGENT)
        .build()
        .map_err(|error| AppError::Http(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3986_encoding_matches_sigv4_and_oauth() {
        assert_eq!(
            percent_encode_rfc3986("AZaz09-._~ /:+"),
            "AZaz09-._~%20%2F%3A%2B"
        );
    }

    #[test]
    fn decode_handles_multibyte_and_plus() {
        assert_eq!(form_url_decode_lossy("hello+world%21"), "hello world!");
        assert_eq!(percent_decode_lossy("bad%é"), "bad%é");
    }
}
