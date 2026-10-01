//! IAM role credentials: STS `AssumeRole` / `AssumeRoleWithWebIdentity`, and
//! the instance and container role providers (EC2 IMDSv2, ECS/EKS container
//! credentials, web identity / IRSA).
//!
//! STS calls are signed here with SigV4 (header form), so role profiles and
//! "role to assume" connections work without the AWS CLI.

use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::env;
use std::time::Duration;

type HmacSha256 = Hmac<Sha256>;

const STS_VERSION: &str = "2011-06-15";
/// How long an assumed role session lasts; the webview re-resolves before it ends.
const ROLE_SESSION_SECONDS: u32 = 3600;
const METADATA_TIMEOUT_MS: u64 = 1500;
const STS_TIMEOUT_SECS: u64 = 20;

/// Credentials as the STS and metadata endpoints return them.
#[derive(Debug, Clone, PartialEq)]
pub struct RoleCredentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
    /// Epoch milliseconds.
    pub expiration: Option<i64>,
}

// ---------------------------------------------------------------------------
// SigV4 header signing
// ---------------------------------------------------------------------------

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// RFC 3986 encoding, as SigV4 canonicalizes query strings and form bodies.
pub fn uri_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// One request to sign. Header names must be lower-case.
struct SignRequest<'a> {
    method: &'a str,
    host: &'a str,
    path: &'a str,
    /// Already-canonical (sorted, encoded) query string.
    query: &'a str,
    /// Extra headers to sign besides `host` and `x-amz-date`.
    headers: Vec<(&'a str, String)>,
    payload: &'a [u8],
    region: &'a str,
    service: &'a str,
    /// `YYYYMMDDTHHMMSSZ`.
    amz_date: &'a str,
}

/// Returns the `Authorization` header value for `request`.
fn authorization(request: &SignRequest, access_key_id: &str, secret_access_key: &str) -> String {
    let mut headers: Vec<(String, String)> = request
        .headers
        .iter()
        .map(|(name, value)| (name.to_string(), value.trim().to_string()))
        .collect();
    headers.push(("host".to_string(), request.host.to_string()));
    headers.push(("x-amz-date".to_string(), request.amz_date.to_string()));
    headers.sort();
    let canonical_headers: String = headers
        .iter()
        .map(|(name, value)| format!("{name}:{value}\n"))
        .collect();
    let signed_headers = headers
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        request.method,
        request.path,
        request.query,
        canonical_headers,
        signed_headers,
        sha256_hex(request.payload)
    );
    let day = &request.amz_date[..8];
    let scope = format!("{day}/{}/{}/aws4_request", request.region, request.service);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{scope}\n{}",
        request.amz_date,
        sha256_hex(canonical_request.as_bytes())
    );
    let date_key = hmac(format!("AWS4{secret_access_key}").as_bytes(), day);
    let region_key = hmac(&date_key, request.region);
    let service_key = hmac(&region_key, request.service);
    let signing_key = hmac(&service_key, "aws4_request");
    let signature = hex(&hmac(&signing_key, &string_to_sign));
    format!(
        "AWS4-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    )
}

fn amz_now() -> String {
    chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
        .format("%Y%m%dT%H%M%SZ")
        .to_string()
}

// ---------------------------------------------------------------------------
// STS
// ---------------------------------------------------------------------------

fn xml_tag(body: &str, tag: &str) -> Option<String> {
    let start = body.find(&format!("<{tag}>"))? + tag.len() + 2;
    let end = body[start..].find(&format!("</{tag}>"))? + start;
    Some(
        body[start..end]
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&amp;", "&"),
    )
}

fn parse_expiration(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value.trim())
        .ok()
        .map(|time| time.timestamp_millis())
}

/// Reads the `<Credentials>` block of an AssumeRole* response, or its error.
fn parse_sts_response(status: u16, body: &str) -> Result<RoleCredentials, String> {
    if !(200..300).contains(&status) {
        let code = xml_tag(body, "Code").unwrap_or_else(|| format!("HTTP {status}"));
        let message = xml_tag(body, "Message").unwrap_or_default();
        return Err(format!("AWS STS refused the role: {code} {message}")
            .trim()
            .to_string());
    }
    let credentials = xml_tag(body, "Credentials")
        .ok_or_else(|| "AWS STS returned no credentials.".to_string())?;
    let field = |name: &str| {
        xml_tag(&credentials, name).ok_or_else(|| format!("AWS STS response is missing {name}."))
    };
    Ok(RoleCredentials {
        access_key_id: field("AccessKeyId")?,
        secret_access_key: field("SecretAccessKey")?,
        session_token: Some(field("SessionToken")?),
        expiration: xml_tag(&credentials, "Expiration")
            .as_deref()
            .and_then(parse_expiration),
    })
}

fn http_client(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .user_agent("GeoLibre Desktop")
        .build()
        .map_err(|error| error.to_string())
}

/// AWS regions are lower-case letters, digits, and dashes. Checked before a
/// region from a config file or the environment becomes part of a host name,
/// so a malformed one cannot send credentials to another host.
pub fn validate_region(region: &str) -> Result<(), String> {
    if region.is_empty()
        || region.len() > 32
        || !region
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(format!("\"{region}\" is not a valid AWS region."));
    }
    Ok(())
}

fn sts_host(region: &str) -> String {
    if region.starts_with("cn-") {
        format!("sts.{region}.amazonaws.com.cn")
    } else {
        format!("sts.{region}.amazonaws.com")
    }
}

fn form_body(params: &[(&str, &str)]) -> String {
    params
        .iter()
        .map(|(name, value)| format!("{}={}", uri_encode(name), uri_encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// A role session name: the caller's, else `geolibre-<epoch>`.
fn session_name(requested: Option<&str>) -> String {
    requested
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| {
            name.chars()
                .filter(|c| c.is_ascii_alphanumeric() || "=,.@_-".contains(*c))
                .take(64)
                .collect()
        })
        .unwrap_or_else(|| {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            format!("geolibre-{secs}")
        })
}

/// Options for [`assume_role`].
pub struct AssumeRoleOptions<'a> {
    pub role_arn: &'a str,
    pub external_id: Option<&'a str>,
    pub session_name: Option<&'a str>,
    pub duration_seconds: Option<u32>,
    pub region: &'a str,
}

fn validate_role_arn(role_arn: &str) -> Result<(), String> {
    if !role_arn.starts_with("arn:aws") || !role_arn.contains(":role/") || role_arn.len() > 2048 {
        return Err(format!("\"{role_arn}\" is not an IAM role ARN."));
    }
    Ok(())
}

/// Calls STS `AssumeRole` with `base` credentials.
pub fn assume_role(
    base: &RoleCredentials,
    options: &AssumeRoleOptions,
) -> Result<RoleCredentials, String> {
    validate_role_arn(options.role_arn)?;
    validate_region(options.region)?;
    let session = session_name(options.session_name);
    let duration = options
        .duration_seconds
        .unwrap_or(ROLE_SESSION_SECONDS)
        .to_string();
    let mut params = vec![
        ("Action", "AssumeRole"),
        ("Version", STS_VERSION),
        ("RoleArn", options.role_arn),
        ("RoleSessionName", session.as_str()),
        ("DurationSeconds", duration.as_str()),
    ];
    if let Some(external_id) = options.external_id.filter(|id| !id.trim().is_empty()) {
        params.push(("ExternalId", external_id.trim()));
    }
    let body = form_body(&params);
    let host = sts_host(options.region);
    let amz_date = amz_now();
    let content_type = "application/x-www-form-urlencoded; charset=utf-8".to_string();
    let mut headers = vec![("content-type", content_type.clone())];
    if let Some(token) = &base.session_token {
        headers.push(("x-amz-security-token", token.clone()));
    }
    let auth = authorization(
        &SignRequest {
            method: "POST",
            host: &host,
            path: "/",
            query: "",
            headers,
            payload: body.as_bytes(),
            region: options.region,
            service: "sts",
            amz_date: &amz_date,
        },
        &base.access_key_id,
        &base.secret_access_key,
    );
    let mut request = http_client(Duration::from_secs(STS_TIMEOUT_SECS))?
        .post(format!("https://{host}/"))
        .header("content-type", content_type)
        .header("x-amz-date", &amz_date)
        .header("authorization", auth)
        .body(body);
    if let Some(token) = &base.session_token {
        request = request.header("x-amz-security-token", token);
    }
    let response = request
        .send()
        .map_err(|error| format!("Could not reach AWS STS: {error}"))?;
    let status = response.status().as_u16();
    let text = response.text().map_err(|error| error.to_string())?;
    parse_sts_response(status, &text)
}

/// Calls STS `AssumeRoleWithWebIdentity` (unsigned: the token is the proof).
pub fn assume_role_with_web_identity(
    role_arn: &str,
    token: &str,
    session_name_hint: Option<&str>,
    region: &str,
) -> Result<RoleCredentials, String> {
    validate_role_arn(role_arn)?;
    validate_region(region)?;
    let session = session_name(session_name_hint);
    let duration = ROLE_SESSION_SECONDS.to_string();
    let body = form_body(&[
        ("Action", "AssumeRoleWithWebIdentity"),
        ("Version", STS_VERSION),
        ("RoleArn", role_arn),
        ("RoleSessionName", session.as_str()),
        ("WebIdentityToken", token.trim()),
        ("DurationSeconds", duration.as_str()),
    ]);
    let response = http_client(Duration::from_secs(STS_TIMEOUT_SECS))?
        .post(format!("https://{}/", sts_host(region)))
        .header(
            "content-type",
            "application/x-www-form-urlencoded; charset=utf-8",
        )
        .body(body)
        .send()
        .map_err(|error| format!("Could not reach AWS STS: {error}"))?;
    let status = response.status().as_u16();
    let text = response.text().map_err(|error| error.to_string())?;
    parse_sts_response(status, &text)
}

// ---------------------------------------------------------------------------
// Instance and container roles
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct MetadataCredentials {
    access_key_id: String,
    secret_access_key: String,
    token: Option<String>,
    expiration: Option<String>,
}

fn from_metadata_json(body: &str) -> Result<RoleCredentials, String> {
    let parsed: MetadataCredentials = serde_json::from_str(body)
        .map_err(|error| format!("The credential endpoint returned invalid JSON: {error}"))?;
    Ok(RoleCredentials {
        access_key_id: parsed.access_key_id,
        secret_access_key: parsed.secret_access_key,
        session_token: parsed.token.filter(|token| !token.is_empty()),
        expiration: parsed.expiration.as_deref().and_then(parse_expiration),
    })
}

fn env_value(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// ECS task roles and EKS Pod Identity: the container credentials endpoint.
/// The container credentials URL, validated the way the AWS SDKs do: a
/// relative URI must be a plain path on the ECS endpoint, and a full URI must
/// be HTTPS or plain HTTP to a loopback or ECS/EKS link-local address, so a
/// tampered variable cannot send the authorization token to another host.
fn container_credentials_url(
    relative: Option<String>,
    full: Option<String>,
) -> Option<Result<String, String>> {
    if let Some(relative) = relative {
        if !relative.starts_with('/')
            || relative.contains('@')
            || relative.chars().any(char::is_control)
        {
            return Some(Err(
                "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI must be a path.".to_string(),
            ));
        }
        return Some(Ok(format!("http://169.254.170.2{relative}")));
    }
    let full = full?;
    let Ok(parsed) = reqwest::Url::parse(&full) else {
        return Some(Err(
            "AWS_CONTAINER_CREDENTIALS_FULL_URI is not a URL.".to_string()
        ));
    };
    let host = parsed.host_str().unwrap_or_default();
    let allowed = match parsed.scheme() {
        "https" => true,
        "http" => matches!(
            host,
            "127.0.0.1"
                | "localhost"
                | "[::1]"
                | "169.254.170.2"
                | "169.254.170.23"
                | "[fd00:ec2::23]"
        ),
        _ => false,
    };
    if !allowed || !parsed.username().is_empty() || parsed.password().is_some() {
        return Some(Err(
            "AWS_CONTAINER_CREDENTIALS_FULL_URI must be HTTPS, or HTTP to a loopback or ECS/EKS \
             metadata address."
                .to_string(),
        ));
    }
    Some(Ok(full))
}

fn container_credentials() -> Option<Result<RoleCredentials, String>> {
    let url = match container_credentials_url(
        env_value("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"),
        env_value("AWS_CONTAINER_CREDENTIALS_FULL_URI"),
    )? {
        Ok(url) => url,
        Err(error) => return Some(Err(error)),
    };
    let token = env_value("AWS_CONTAINER_AUTHORIZATION_TOKEN").or_else(|| {
        env_value("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE")
            .and_then(|path| std::fs::read_to_string(path).ok())
            .map(|value| value.trim().to_string())
    });
    Some((|| {
        let mut request = http_client(Duration::from_secs(5))?.get(&url);
        if let Some(token) = token {
            request = request.header("authorization", token);
        }
        let response = request.send().map_err(|error| {
            format!("Could not reach the container credentials endpoint: {error}")
        })?;
        if !response.status().is_success() {
            return Err(format!(
                "The container credentials endpoint answered {}.",
                response.status()
            ));
        }
        from_metadata_json(&response.text().map_err(|error| error.to_string())?)
    })())
}

/// EC2 instance profile through IMDSv2.
fn instance_metadata_credentials() -> Result<RoleCredentials, String> {
    if env_value("AWS_EC2_METADATA_DISABLED")
        .is_some_and(|value| value.eq_ignore_ascii_case("true"))
    {
        return Err("AWS_EC2_METADATA_DISABLED is set.".to_string());
    }
    let base = env_value("AWS_EC2_METADATA_SERVICE_ENDPOINT")
        .unwrap_or_else(|| "http://169.254.169.254".to_string());
    let base = base.trim_end_matches('/');
    let client = http_client(Duration::from_millis(METADATA_TIMEOUT_MS))?;
    let not_on_ec2 = |_| {
        "No EC2 instance metadata service answered; GeoLibre is not running on EC2.".to_string()
    };
    let token = client
        .put(format!("{base}/latest/api/token"))
        .header("x-aws-ec2-metadata-token-ttl-seconds", "21600")
        .send()
        .map_err(not_on_ec2)?
        .text()
        .map_err(|error| error.to_string())?;
    let get = |path: &str| -> Result<String, String> {
        let response = client
            .get(format!("{base}{path}"))
            .header("x-aws-ec2-metadata-token", &token)
            .send()
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!(
                "The instance metadata service answered {} (is an instance profile attached?).",
                response.status()
            ));
        }
        response.text().map_err(|error| error.to_string())
    };
    let roles = get("/latest/meta-data/iam/security-credentials/")?;
    let role = roles
        .lines()
        .next()
        .map(str::trim)
        .filter(|role| !role.is_empty())
        .ok_or_else(|| "This EC2 instance has no IAM instance profile.".to_string())?;
    from_metadata_json(&get(&format!(
        "/latest/meta-data/iam/security-credentials/{role}"
    ))?)
}

/// Web identity (EKS IRSA and other OIDC federations) from the environment.
fn web_identity_credentials(region: &str) -> Option<Result<RoleCredentials, String>> {
    let token_file = env_value("AWS_WEB_IDENTITY_TOKEN_FILE")?;
    let role_arn = env_value("AWS_ROLE_ARN")?;
    Some(
        std::fs::read_to_string(&token_file)
            .map_err(|error| format!("Could not read AWS_WEB_IDENTITY_TOKEN_FILE: {error}"))
            .and_then(|token| {
                assume_role_with_web_identity(
                    &role_arn,
                    &token,
                    env_value("AWS_ROLE_SESSION_NAME").as_deref(),
                    region,
                )
            }),
    )
}

/// The role GeoLibre's host grants it, in the SDKs' order: web identity, then
/// ECS/EKS container credentials, then the EC2 instance profile.
pub fn instance_role_credentials(region: &str) -> Result<RoleCredentials, String> {
    if let Some(result) = web_identity_credentials(region) {
        return result;
    }
    if let Some(result) = container_credentials() {
        return result;
    }
    instance_metadata_credentials()
}

/// Resolves a profile's `credential_source` (`Environment`, `Ec2InstanceMetadata`, `EcsContainer`).
pub fn credential_source(source: &str) -> Result<RoleCredentials, String> {
    match source {
        "Environment" => {
            let access_key_id = env_value("AWS_ACCESS_KEY_ID");
            let secret_access_key = env_value("AWS_SECRET_ACCESS_KEY");
            match (access_key_id, secret_access_key) {
                (Some(access_key_id), Some(secret_access_key)) => Ok(RoleCredentials {
                    access_key_id,
                    secret_access_key,
                    session_token: env_value("AWS_SESSION_TOKEN"),
                    expiration: None,
                }),
                _ => Err(
                    "credential_source = Environment, but AWS_ACCESS_KEY_ID is not set."
                        .to_string(),
                ),
            }
        }
        "Ec2InstanceMetadata" => instance_metadata_credentials(),
        "EcsContainer" => container_credentials().unwrap_or_else(|| {
            Err(
                "credential_source = EcsContainer, but no container credentials endpoint is set."
                    .to_string(),
            )
        }),
        _ => Err(format!("Unsupported credential_source \"{source}\".")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signs_the_aws_documentation_example() {
        // https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
        // (the IAM ListUsers example from the SigV4 documentation).
        let auth = authorization(
            &SignRequest {
                method: "GET",
                host: "iam.amazonaws.com",
                path: "/",
                query: "Action=ListUsers&Version=2010-05-08",
                headers: vec![(
                    "content-type",
                    "application/x-www-form-urlencoded; charset=utf-8".to_string(),
                )],
                payload: b"",
                region: "us-east-1",
                service: "iam",
                amz_date: "20150830T123600Z",
            },
            "AKIDEXAMPLE",
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        );
        assert_eq!(
            auth,
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, \
             SignedHeaders=content-type;host;x-amz-date, \
             Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
        );
    }

    #[test]
    fn parses_assume_role_responses_and_errors() {
        let ok = r#"<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleResult><Credentials>
    <AccessKeyId>ASIAEXAMPLE</AccessKeyId>
    <SecretAccessKey>secret&amp;key</SecretAccessKey>
    <SessionToken>token</SessionToken>
    <Expiration>2026-01-01T00:00:00Z</Expiration>
  </Credentials></AssumeRoleResult></AssumeRoleResponse>"#;
        let parsed = parse_sts_response(200, ok).unwrap();
        assert_eq!(parsed.access_key_id, "ASIAEXAMPLE");
        assert_eq!(parsed.secret_access_key, "secret&key");
        assert_eq!(parsed.session_token.as_deref(), Some("token"));
        assert_eq!(parsed.expiration, Some(1_767_225_600_000));
        let error = parse_sts_response(
            403,
            "<ErrorResponse><Error><Code>AccessDenied</Code><Message>not authorized</Message></Error></ErrorResponse>",
        )
        .unwrap_err();
        assert!(error.contains("AccessDenied not authorized"), "{error}");
    }

    #[test]
    fn parses_metadata_credentials() {
        let parsed = from_metadata_json(
            r#"{"Code":"Success","AccessKeyId":"ASIA","SecretAccessKey":"S","Token":"T","Expiration":"2026-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        assert_eq!(parsed.session_token.as_deref(), Some("T"));
        assert_eq!(parsed.expiration, Some(1_767_225_600_000));
    }

    #[test]
    fn validates_container_credential_urls() {
        let url = |relative: Option<&str>, full: Option<&str>| {
            container_credentials_url(relative.map(String::from), full.map(String::from))
        };
        assert_eq!(
            url(Some("/v2/credentials/abc"), None).unwrap().unwrap(),
            "http://169.254.170.2/v2/credentials/abc"
        );
        assert!(url(Some("@evil.example.com/x"), None).unwrap().is_err());
        assert!(url(Some("v2/x"), None).unwrap().is_err());
        assert!(url(None, Some("http://169.254.170.23/v1/credentials"))
            .unwrap()
            .is_ok());
        assert!(url(None, Some("https://creds.example.com/x"))
            .unwrap()
            .is_ok());
        assert!(url(None, Some("http://evil.example.com/x"))
            .unwrap()
            .is_err());
        assert!(url(None, Some("http://user@127.0.0.1/x")).unwrap().is_err());
        assert!(url(None, Some("http://:token@127.0.0.1/x"))
            .unwrap()
            .is_err());
        assert!(url(None, None).is_none());
    }

    #[test]
    fn validates_role_arns_and_session_names() {
        assert!(validate_role_arn("arn:aws:iam::123456789012:role/Reader").is_ok());
        assert!(validate_role_arn("arn:aws-cn:iam::123456789012:role/path/Reader").is_ok());
        assert!(validate_role_arn("arn:aws:iam::123456789012:user/Bob").is_err());
        assert_eq!(session_name(Some("me@corp; drop")), "me@corpdrop");
        assert!(session_name(None).starts_with("geolibre-"));
        assert_eq!(uri_encode("a b/+="), "a%20b%2F%2B%3D");
        assert!(validate_region("evil.com/x#").is_err());
    }
}
