//! AWS credential resolution for reading private S3 data.
//!
//! The webview signs S3 requests itself (SigV4 presigning in
//! `@geolibre/core`), so all this module does is turn a credential *source*
//! into a set of keys, the way the AWS CLI would:
//!
//! - `profile`: a named profile from the shared config files
//!   (`~/.aws/credentials`, `~/.aws/config`, or the files named by
//!   `AWS_SHARED_CREDENTIALS_FILE` / `AWS_CONFIG_FILE`). Static keys,
//!   IAM Identity Center (SSO) profiles, and `credential_process` are handled
//!   natively; anything else (role assumption, `login_session`) falls back to
//!   `aws configure export-credentials` when the AWS CLI is on `PATH`.
//! - `environment`: `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
//!   `AWS_SESSION_TOKEN`. Read only when the user picks this source for a
//!   connection, which is why these names are not in `read_env_vars`'
//!   allowlist.
//!
//! SSO profiles read the token `aws sso login` caches under
//! `~/.aws/sso/cache`, refreshing it when it carries a refresh token, and
//! `aws_sso_login_start`/`aws_sso_login_poll` run the same device
//! authorization flow in-app, writing the same cache file, so the CLI and
//! GeoLibre share one sign-in.

use crate::aws_sts::{self, AssumeRoleOptions, RoleCredentials};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_PROFILE_NAME_BYTES: usize = 128;
const HTTP_TIMEOUT_SECS: u64 = 20;
/// Tokens this close to expiry are refreshed rather than used.
const TOKEN_EXPIRY_SKEW_MS: i64 = 60_000;
const MAX_PENDING_LOGINS: usize = 4;
/// Deepest `source_profile` chain followed before assuming a cycle.
const MAX_ROLE_CHAIN: usize = 5;
const DEFAULT_STS_REGION: &str = "us-east-1";

/// Resolved credentials returned to the webview.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AwsResolvedCredentials {
    access_key_id: String,
    secret_access_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_token: Option<String>,
    /// Epoch milliseconds, for temporary credentials.
    #[serde(skip_serializing_if = "Option::is_none")]
    expiration: Option<i64>,
    /// The profile's (or environment's) default region.
    #[serde(skip_serializing_if = "Option::is_none")]
    region: Option<String>,
}

/// One profile from the shared config files, for the connection picker.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AwsProfileSummary {
    name: String,
    /// `static`, `sso`, `process`, `role`, or `other`.
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    region: Option<String>,
}

// ---------------------------------------------------------------------------
// Shared config files
// ---------------------------------------------------------------------------

type IniSections = HashMap<String, HashMap<String, String>>;

/// Where the shared files live. Split out so tests can point at a temp dir.
#[derive(Debug, Clone)]
struct AwsPaths {
    config: PathBuf,
    credentials: PathBuf,
    sso_cache: PathBuf,
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn expand_home(value: &str) -> PathBuf {
    if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(value)
}

fn default_paths() -> Result<AwsPaths, String> {
    let home = home_dir();
    let aws_dir = home.as_ref().map(|home| home.join(".aws"));
    let from_env = |name: &str| {
        env::var(name)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|value| expand_home(value.trim()))
    };
    let config = from_env("AWS_CONFIG_FILE").or_else(|| aws_dir.as_ref().map(|d| d.join("config")));
    let credentials = from_env("AWS_SHARED_CREDENTIALS_FILE")
        .or_else(|| aws_dir.as_ref().map(|d| d.join("credentials")));
    match (config, credentials, aws_dir) {
        (Some(config), Some(credentials), Some(aws_dir)) => Ok(AwsPaths {
            config,
            credentials,
            sso_cache: aws_dir.join("sso").join("cache"),
        }),
        _ => Err("Could not locate the home directory to read AWS profiles.".to_string()),
    }
}

/// Parses an AWS-style INI file. Keys are lower-cased; nested sub-sections
/// (`s3 =` followed by indented lines) are skipped, since nothing here needs
/// them.
fn parse_ini(text: &str) -> IniSections {
    let mut sections: IniSections = HashMap::new();
    let mut current: Option<String> = None;
    let mut in_nested = false;
    for raw in text.lines() {
        let line = raw.trim_end();
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            current = Some(trimmed[1..trimmed.len() - 1].trim().to_string());
            in_nested = false;
            sections
                .entry(current.clone().unwrap_or_default())
                .or_default();
            continue;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if indented && in_nested {
            continue;
        }
        let Some(section) = current.as_ref() else {
            continue;
        };
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim().to_string();
        in_nested = value.is_empty();
        if !in_nested {
            sections
                .entry(section.clone())
                .or_default()
                .insert(key, value);
        }
    }
    sections
}

fn read_ini(path: &Path) -> IniSections {
    std::fs::read_to_string(path)
        .map(|text| parse_ini(&text))
        .unwrap_or_default()
}

/// Profile sections in the config file are `[profile name]`, except `[default]`.
fn config_profile<'a>(config: &'a IniSections, name: &str) -> Option<&'a HashMap<String, String>> {
    config.get(&format!("profile {name}")).or_else(|| {
        if name == "default" {
            config.get("default")
        } else {
            None
        }
    })
}

fn profile_kind(
    config: Option<&HashMap<String, String>>,
    credentials: Option<&HashMap<String, String>>,
) -> &'static str {
    let has = |section: Option<&HashMap<String, String>>, key: &str| {
        section.is_some_and(|values| values.get(key).is_some_and(|v| !v.is_empty()))
    };
    if has(config, "role_arn") || has(credentials, "role_arn") {
        return "role";
    }
    if has(credentials, "aws_access_key_id") || has(config, "aws_access_key_id") {
        return "static";
    }
    if has(config, "sso_session") || has(config, "sso_start_url") {
        "sso"
    } else if has(config, "credential_process") || has(credentials, "credential_process") {
        "process"
    } else {
        "other"
    }
}

fn list_profiles_in(paths: &AwsPaths) -> Vec<AwsProfileSummary> {
    let config = read_ini(&paths.config);
    let credentials = read_ini(&paths.credentials);
    let mut names: Vec<String> = Vec::new();
    for section in config.keys() {
        if section == "default" {
            names.push("default".to_string());
        } else if let Some(name) = section.strip_prefix("profile ") {
            names.push(name.trim().to_string());
        }
    }
    names.extend(credentials.keys().cloned());
    names.sort();
    names.dedup();
    names
        .into_iter()
        .filter(|name| !name.is_empty())
        .map(|name| {
            let config_section = config_profile(&config, &name);
            let credentials_section = credentials.get(&name);
            AwsProfileSummary {
                kind: profile_kind(config_section, credentials_section),
                region: config_section.and_then(|values| values.get("region").cloned()),
                name,
            }
        })
        .collect()
}

fn validate_profile_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > MAX_PROFILE_NAME_BYTES {
        return Err("AWS profile name is empty or too long.".to_string());
    }
    if name.chars().any(|c| c.is_control() || c == '[' || c == ']') {
        return Err("AWS profile name contains unexpected characters.".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Parses the timestamps the AWS CLI writes (`2026-01-01T00:00:00Z`, and the
/// older `2026-01-01T00:00:00UTC`).
fn parse_timestamp_ms(value: &str) -> Option<i64> {
    let normalized = value.trim().replace("UTC", "Z");
    chrono::DateTime::parse_from_rfc3339(&normalized)
        .ok()
        .map(|time| time.timestamp_millis())
}

fn format_timestamp(ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/// JSON request bodies without reqwest's `json` feature.
trait JsonBody {
    fn json_body(self, value: &serde_json::Value) -> Self;
}

impl JsonBody for reqwest::blocking::RequestBuilder {
    fn json_body(self, value: &serde_json::Value) -> Self {
        self.header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(value.to_string())
    }
}

fn read_json<T: serde::de::DeserializeOwned>(
    response: reqwest::blocking::Response,
) -> Result<T, String> {
    let bytes = response.bytes().map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

/// Reads a successful response's JSON body (after `error_for_status`).
trait ReadJson {
    fn read_json_value<T: serde::de::DeserializeOwned>(self) -> Result<T, String>;
}

impl ReadJson for reqwest::blocking::Response {
    fn read_json_value<T: serde::de::DeserializeOwned>(self) -> Result<T, String> {
        read_json(self)
    }
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .user_agent("GeoLibre Desktop")
        .build()
        .map_err(|error| error.to_string())
}

/// AWS regions are lower-case letters, digits, and dashes. Checked before a
/// region from a config file becomes part of an endpoint host name.
fn validate_region(region: &str) -> Result<(), String> {
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

// ---------------------------------------------------------------------------
// IAM Identity Center (SSO)
// ---------------------------------------------------------------------------

/// The pieces of an SSO profile needed to fetch role credentials.
#[derive(Debug, Clone, PartialEq)]
struct SsoProfile {
    /// `sso_session` name, for the newer token-provider format.
    session: Option<String>,
    start_url: String,
    sso_region: String,
    account_id: String,
    role_name: String,
}

fn sso_profile(config: &IniSections, name: &str) -> Result<SsoProfile, String> {
    let profile = config_profile(config, name)
        .ok_or_else(|| format!("AWS profile \"{name}\" is not in the config file."))?;
    let session = profile.get("sso_session").cloned();
    let (start_url, sso_region) = match &session {
        Some(session_name) => {
            let section = config
                .get(&format!("sso-session {session_name}"))
                .ok_or_else(|| format!("sso-session \"{session_name}\" is not defined."))?;
            (
                section.get("sso_start_url").cloned(),
                section.get("sso_region").cloned(),
            )
        }
        None => (
            profile.get("sso_start_url").cloned(),
            profile.get("sso_region").cloned(),
        ),
    };
    let missing = |field: &str| format!("AWS profile \"{name}\" is missing {field}.");
    let sso = SsoProfile {
        session,
        start_url: start_url.ok_or_else(|| missing("sso_start_url"))?,
        sso_region: sso_region.ok_or_else(|| missing("sso_region"))?,
        account_id: profile
            .get("sso_account_id")
            .cloned()
            .ok_or_else(|| missing("sso_account_id"))?,
        role_name: profile
            .get("sso_role_name")
            .cloned()
            .ok_or_else(|| missing("sso_role_name"))?,
    };
    validate_region(&sso.sso_region)?;
    Ok(sso)
}

/// `~/.aws/sso/cache/<sha1>.json`, keyed by session name (token-provider
/// format) or start URL (legacy format), exactly as the AWS CLI names it.
fn sso_cache_file(cache_dir: &Path, sso: &SsoProfile) -> PathBuf {
    let key = sso.session.as_deref().unwrap_or(&sso.start_url);
    let digest = Sha1::digest(key.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    cache_dir.join(format!("{hex}.json"))
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SsoTokenCache {
    #[serde(skip_serializing_if = "Option::is_none")]
    start_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    region: Option<String>,
    access_token: String,
    expires_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_secret: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    registration_expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
}

fn write_sso_cache(path: &Path, token: &SsoTokenCache) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let body = serde_json::to_vec_pretty(token).map_err(|error| error.to_string())?;
    // Written through a temp file so a concurrent CLI read never sees half a token.
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, body).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&temp, path).map_err(|error| error.to_string())
}

fn sso_login_hint(profile: &str) -> String {
    format!(
        "The AWS SSO session for profile \"{profile}\" has expired or was never started. \
         Sign in from Settings → Cloud Storage, or run `aws sso login --profile {profile}`."
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OidcTokenResponse {
    access_token: String,
    expires_in: i64,
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct OidcError {
    error: Option<String>,
}

fn refresh_sso_token(
    client: &reqwest::blocking::Client,
    sso_region: &str,
    cached: &SsoTokenCache,
) -> Result<SsoTokenCache, String> {
    let (Some(client_id), Some(client_secret), Some(refresh_token)) = (
        cached.client_id.as_ref(),
        cached.client_secret.as_ref(),
        cached.refresh_token.as_ref(),
    ) else {
        return Err("no refresh token".to_string());
    };
    if cached
        .registration_expires_at
        .as_deref()
        .and_then(parse_timestamp_ms)
        .is_some_and(|expires| expires <= now_ms())
    {
        return Err("client registration expired".to_string());
    }
    let response = client
        .post(format!("https://oidc.{sso_region}.amazonaws.com/token"))
        .json_body(&serde_json::json!({
            "clientId": client_id,
            "clientSecret": client_secret,
            "grantType": "refresh_token",
            "refreshToken": refresh_token,
        }))
        .send()
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("token refresh failed ({})", response.status()));
    }
    let token: OidcTokenResponse = read_json(response)?;
    Ok(SsoTokenCache {
        access_token: token.access_token,
        expires_at: format_timestamp(now_ms() + token.expires_in * 1000),
        refresh_token: token.refresh_token.or_else(|| cached.refresh_token.clone()),
        ..cached.clone()
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoleCredentialsResponse {
    role_credentials: SsoRoleCredentials,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SsoRoleCredentials {
    access_key_id: String,
    secret_access_key: String,
    session_token: String,
    expiration: i64,
}

fn resolve_sso(
    paths: &AwsPaths,
    config: &IniSections,
    name: &str,
    region: Option<String>,
) -> Result<AwsResolvedCredentials, String> {
    let sso = sso_profile(config, name)?;
    let cache_path = sso_cache_file(&paths.sso_cache, &sso);
    let cached: SsoTokenCache = std::fs::read(&cache_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or_else(|| sso_login_hint(name))?;
    let client = http_client()?;
    let fresh = parse_timestamp_ms(&cached.expires_at)
        .is_some_and(|expires| expires - TOKEN_EXPIRY_SKEW_MS > now_ms());
    let token = if fresh {
        cached
    } else {
        let refreshed = refresh_sso_token(&client, &sso.sso_region, &cached)
            .map_err(|_| sso_login_hint(name))?;
        // Best effort: the refreshed token still works for this call if the
        // cache cannot be rewritten.
        let _ = write_sso_cache(&cache_path, &refreshed);
        refreshed
    };
    let response = client
        .get(format!(
            "https://portal.sso.{}.amazonaws.com/federation/credentials",
            sso.sso_region
        ))
        .query(&[
            ("role_name", &sso.role_name),
            ("account_id", &sso.account_id),
        ])
        .header("x-amz-sso_bearer_token", &token.access_token)
        .send()
        .map_err(|error| format!("Could not reach AWS IAM Identity Center: {error}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(sso_login_hint(name));
    }
    if !status.is_success() {
        return Err(format!(
            "AWS IAM Identity Center refused role \"{}\" in account {} ({status}).",
            sso.role_name, sso.account_id
        ));
    }
    let body: RoleCredentialsResponse = read_json(response)?;
    let role = body.role_credentials;
    Ok(AwsResolvedCredentials {
        access_key_id: role.access_key_id,
        secret_access_key: role.secret_access_key,
        session_token: Some(role.session_token),
        expiration: Some(role.expiration),
        region,
    })
}

// ---------------------------------------------------------------------------
// credential_process and the AWS CLI fallback
// ---------------------------------------------------------------------------

// The App Store build cannot spawn processes, so only tests use these there.
#[cfg_attr(feature = "mas", allow(dead_code))]
#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ProcessCredentials {
    access_key_id: String,
    secret_access_key: String,
    session_token: Option<String>,
    expiration: Option<String>,
}

#[cfg_attr(feature = "mas", allow(dead_code))]
fn credentials_from_process_output(
    stdout: &[u8],
    region: Option<String>,
) -> Result<AwsResolvedCredentials, String> {
    let parsed: ProcessCredentials = serde_json::from_slice(stdout)
        .map_err(|error| format!("The credential process returned invalid JSON: {error}"))?;
    Ok(AwsResolvedCredentials {
        access_key_id: parsed.access_key_id,
        secret_access_key: parsed.secret_access_key,
        session_token: parsed.session_token.filter(|token| !token.is_empty()),
        expiration: parsed.expiration.as_deref().and_then(parse_timestamp_ms),
        region,
    })
}

#[cfg(not(feature = "mas"))]
fn run_process(mut command: std::process::Command) -> Result<Vec<u8>, String> {
    let output = command
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr.trim();
        return Err(if message.is_empty() {
            format!("exited with {}", output.status)
        } else {
            message.chars().take(500).collect()
        });
    }
    Ok(output.stdout)
}

/// Runs a profile's `credential_process` through the platform shell, as the
/// AWS CLI documents the setting (a command line, not an argv array).
#[cfg(not(feature = "mas"))]
fn resolve_credential_process(
    command_line: &str,
    region: Option<String>,
) -> Result<AwsResolvedCredentials, String> {
    #[cfg(windows)]
    let command = {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", command_line]);
        command
    };
    #[cfg(not(windows))]
    let command = {
        let mut command = std::process::Command::new("sh");
        command.args(["-c", command_line]);
        command
    };
    let stdout = run_process(command)
        .map_err(|error| format!("The profile's credential_process failed: {error}"))?;
    credentials_from_process_output(&stdout, region)
}

/// `aws configure export-credentials` resolves every profile type the CLI
/// supports (role chains, `login_session`, …) and prints process-format JSON.
#[cfg(not(feature = "mas"))]
fn resolve_with_aws_cli(
    name: &str,
    region: Option<String>,
) -> Result<AwsResolvedCredentials, String> {
    let mut command = std::process::Command::new("aws");
    command.args([
        "configure",
        "export-credentials",
        "--profile",
        name,
        "--format",
        "process",
    ]);
    let stdout = run_process(command).map_err(|error| {
        format!(
            "AWS profile \"{name}\" needs the AWS CLI (v2) to resolve, and \
             `aws configure export-credentials` failed: {error}"
        )
    })?;
    credentials_from_process_output(&stdout, region)
}

#[cfg(feature = "mas")]
fn resolve_credential_process(
    _command_line: &str,
    _region: Option<String>,
) -> Result<AwsResolvedCredentials, String> {
    Err("credential_process profiles are not supported in the App Store build.".to_string())
}

#[cfg(feature = "mas")]
fn resolve_with_aws_cli(
    name: &str,
    _region: Option<String>,
) -> Result<AwsResolvedCredentials, String> {
    Err(format!(
        "AWS profile \"{name}\" needs the AWS CLI, which the App Store build cannot run. \
         Use access keys instead."
    ))
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

fn static_keys(
    section: Option<&HashMap<String, String>>,
    region: Option<String>,
) -> Option<AwsResolvedCredentials> {
    let section = section?;
    let access_key_id = section.get("aws_access_key_id").filter(|v| !v.is_empty())?;
    let secret_access_key = section
        .get("aws_secret_access_key")
        .filter(|v| !v.is_empty())?;
    Some(AwsResolvedCredentials {
        access_key_id: access_key_id.clone(),
        secret_access_key: secret_access_key.clone(),
        session_token: section
            .get("aws_session_token")
            .filter(|v| !v.is_empty())
            .cloned(),
        expiration: None,
        region,
    })
}

fn resolve_profile_in(paths: &AwsPaths, name: &str) -> Result<AwsResolvedCredentials, String> {
    resolve_profile_depth(paths, name, 0)
}

impl From<RoleCredentials> for AwsResolvedCredentials {
    fn from(role: RoleCredentials) -> Self {
        AwsResolvedCredentials {
            access_key_id: role.access_key_id,
            secret_access_key: role.secret_access_key,
            session_token: role.session_token,
            expiration: role.expiration,
            region: None,
        }
    }
}

impl AwsResolvedCredentials {
    fn as_role_credentials(&self) -> RoleCredentials {
        RoleCredentials {
            access_key_id: self.access_key_id.clone(),
            secret_access_key: self.secret_access_key.clone(),
            session_token: self.session_token.clone(),
            expiration: self.expiration,
        }
    }

    fn with_region(mut self, region: Option<String>) -> Self {
        if self.region.is_none() {
            self.region = region;
        }
        self
    }
}

/// A role profile: `role_arn` assumed from `source_profile`, a
/// `credential_source`, or a `web_identity_token_file`, as the AWS CLI does.
fn resolve_role_profile(
    paths: &AwsPaths,
    section: &HashMap<String, String>,
    credentials_section: Option<&HashMap<String, String>>,
    name: &str,
    depth: usize,
    region: Option<String>,
) -> Result<AwsResolvedCredentials, String> {
    let role_arn = section.get("role_arn").cloned().unwrap_or_default();
    let sts_region = region
        .clone()
        .unwrap_or_else(|| DEFAULT_STS_REGION.to_string());
    let get = |key: &str| {
        section
            .get(key)
            .map(String::as_str)
            .filter(|v| !v.is_empty())
    };
    if get("mfa_serial").is_some() {
        // An MFA code has to be typed in; the AWS CLI can prompt for it.
        return resolve_with_aws_cli(name, region);
    }
    if let Some(token_file) = get("web_identity_token_file") {
        let token = std::fs::read_to_string(expand_home(token_file))
            .map_err(|error| format!("Could not read web_identity_token_file: {error}"))?;
        return aws_sts::assume_role_with_web_identity(
            &role_arn,
            &token,
            get("role_session_name"),
            &sts_region,
        )
        .map(|role| AwsResolvedCredentials::from(role).with_region(region));
    }
    let base: RoleCredentials = if let Some(source) = get("credential_source") {
        aws_sts::credential_source(source)?
    } else if let Some(source_profile) = get("source_profile") {
        if source_profile == name {
            // A profile may name itself to use its own static keys.
            static_keys(credentials_section, None)
                .or_else(|| static_keys(Some(section), None))
                .ok_or_else(|| format!("AWS profile \"{name}\" has no keys of its own."))?
                .as_role_credentials()
        } else {
            resolve_profile_depth(paths, source_profile, depth + 1)?.as_role_credentials()
        }
    } else {
        return Err(format!(
            "AWS profile \"{name}\" sets role_arn without source_profile or credential_source."
        ));
    };
    let duration = get("duration_seconds").and_then(|value| value.parse().ok());
    aws_sts::assume_role(
        &base,
        &AssumeRoleOptions {
            role_arn: &role_arn,
            external_id: get("external_id"),
            session_name: get("role_session_name"),
            duration_seconds: duration,
            region: &sts_region,
        },
    )
    .map(|role| AwsResolvedCredentials::from(role).with_region(region))
}

fn resolve_profile_depth(
    paths: &AwsPaths,
    name: &str,
    depth: usize,
) -> Result<AwsResolvedCredentials, String> {
    validate_profile_name(name)?;
    if depth > MAX_ROLE_CHAIN {
        return Err(format!(
            "AWS profile \"{name}\": the source_profile chain is too deep or loops."
        ));
    }
    let config = read_ini(&paths.config);
    let credentials = read_ini(&paths.credentials);
    let config_section = config_profile(&config, name);
    let credentials_section = credentials.get(name);
    if config_section.is_none() && credentials_section.is_none() {
        return Err(format!(
            "AWS profile \"{name}\" was not found in {} or {}.",
            paths.credentials.display(),
            paths.config.display()
        ));
    }
    let region = config_section.and_then(|values| values.get("region").cloned());
    match profile_kind(config_section, credentials_section) {
        "static" => static_keys(credentials_section, region.clone())
            .or_else(|| static_keys(config_section, region.clone()))
            .ok_or_else(|| format!("AWS profile \"{name}\" has incomplete access keys.")),
        "sso" => resolve_sso(paths, &config, name, region),
        "role" => {
            // Role settings live in the config file; the credentials file can
            // carry them too.
            let mut merged = credentials_section.cloned().unwrap_or_default();
            merged.extend(config_section.cloned().unwrap_or_default());
            resolve_role_profile(paths, &merged, credentials_section, name, depth, region)
        }
        "process" => {
            let command_line = config_section
                .and_then(|values| values.get("credential_process"))
                .or_else(|| credentials_section.and_then(|values| values.get("credential_process")))
                .cloned()
                .unwrap_or_default();
            resolve_credential_process(&command_line, region)
        }
        _ => resolve_with_aws_cli(name, region),
    }
}

fn resolve_environment() -> Result<AwsResolvedCredentials, String> {
    let read = |name: &str| {
        env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let (Some(access_key_id), Some(secret_access_key)) =
        (read("AWS_ACCESS_KEY_ID"), read("AWS_SECRET_ACCESS_KEY"))
    else {
        return Err(
            "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set in GeoLibre's environment."
                .to_string(),
        );
    };
    Ok(AwsResolvedCredentials {
        access_key_id,
        secret_access_key,
        session_token: read("AWS_SESSION_TOKEN"),
        expiration: read("AWS_CREDENTIAL_EXPIRATION")
            .as_deref()
            .and_then(parse_timestamp_ms),
        region: read("AWS_REGION").or_else(|| read("AWS_DEFAULT_REGION")),
    })
}

/// The profile named by `AWS_PROFILE`, else `default`.
fn default_profile_name() -> String {
    env::var("AWS_PROFILE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "default".to_string())
}

/// Lists the profiles in the shared AWS config files.
#[tauri::command]
pub async fn aws_list_profiles() -> Result<Vec<AwsProfileSummary>, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(list_profiles_in(&default_paths()?)))
        .await
        .map_err(|error| error.to_string())?
}

/// Resolves credentials from `source` (`profile` or `environment`). An empty
/// profile name means `AWS_PROFILE`, else `default`.
/// Access keys typed into Settings, for a `keys` connection that assumes a role.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsKeysInput {
    access_key_id: String,
    secret_access_key: String,
    session_token: Option<String>,
}

/// A role to assume on top of the source's credentials.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsRoleInput {
    role_arn: String,
    external_id: Option<String>,
    session_name: Option<String>,
}

fn resolve_source(
    source: &str,
    profile: Option<String>,
    keys: Option<AwsKeysInput>,
) -> Result<AwsResolvedCredentials, String> {
    match source {
        "environment" => resolve_environment(),
        "instance" => {
            let region = env::var("AWS_REGION")
                .or_else(|_| env::var("AWS_DEFAULT_REGION"))
                .ok()
                .filter(|value| !value.trim().is_empty());
            aws_sts::instance_role_credentials(region.as_deref().unwrap_or(DEFAULT_STS_REGION))
                .map(|role| AwsResolvedCredentials::from(role).with_region(region))
        }
        "profile" => {
            let name = profile
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty())
                .unwrap_or_else(default_profile_name);
            resolve_profile_in(&default_paths()?, &name)
        }
        "keys" => {
            let keys = keys.ok_or_else(|| "Access keys are required.".to_string())?;
            Ok(AwsResolvedCredentials {
                access_key_id: keys.access_key_id,
                secret_access_key: keys.secret_access_key,
                session_token: keys.session_token.filter(|token| !token.is_empty()),
                expiration: None,
                region: None,
            })
        }
        other => Err(format!("Unknown AWS credential source \"{other}\".")),
    }
}

/// Resolves credentials from `source` (`profile`, `environment`, `instance`,
/// or `keys` with `keys`), then assumes `role` on top when one is given. An
/// empty profile name means `AWS_PROFILE`, else `default`.
#[tauri::command]
pub async fn aws_resolve_credentials(
    source: String,
    profile: Option<String>,
    keys: Option<AwsKeysInput>,
    role: Option<AwsRoleInput>,
    region: Option<String>,
) -> Result<AwsResolvedCredentials, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = resolve_source(&source, profile, keys)?;
        let Some(role) = role.filter(|role| !role.role_arn.trim().is_empty()) else {
            return Ok(base);
        };
        let sts_region = region
            .filter(|value| validate_region(value).is_ok())
            .or_else(|| {
                base.region
                    .clone()
                    .filter(|value| validate_region(value).is_ok())
            })
            .unwrap_or_else(|| DEFAULT_STS_REGION.to_string());
        aws_sts::assume_role(
            &base.as_role_credentials(),
            &AssumeRoleOptions {
                role_arn: role.role_arn.trim(),
                external_id: role.external_id.as_deref(),
                session_name: role.session_name.as_deref(),
                duration_seconds: None,
                region: &sts_region,
            },
        )
        .map(|assumed| AwsResolvedCredentials::from(assumed).with_region(base.region))
    })
    .await
    .map_err(|error| error.to_string())?
}

// ---------------------------------------------------------------------------
// In-app SSO sign-in (OAuth device authorization)
// ---------------------------------------------------------------------------

struct PendingLogin {
    id: String,
    cache_path: PathBuf,
    start_url: String,
    sso_region: String,
    client_id: String,
    client_secret: String,
    registration_expires_at: Option<i64>,
    device_code: String,
    expires_at: i64,
}

/// Device codes and client secrets stay here; the webview only sees an id.
#[derive(Default)]
pub struct AwsSsoLoginState {
    pending: Mutex<Vec<PendingLogin>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsSsoLoginStart {
    login_id: String,
    verification_uri: String,
    user_code: String,
    /// Seconds between polls.
    interval: u64,
    /// Seconds until the code expires.
    expires_in: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterClientResponse {
    client_id: String,
    client_secret: String,
    client_secret_expires_at: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceAuthorizationResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    expires_in: i64,
    interval: Option<u64>,
}

fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn start_login_blocking(profile: &str) -> Result<(PendingLogin, AwsSsoLoginStart), String> {
    validate_profile_name(profile)?;
    let paths = default_paths()?;
    let config = read_ini(&paths.config);
    let sso = sso_profile(&config, profile)?;
    let client = http_client()?;
    let base = format!("https://oidc.{}.amazonaws.com", sso.sso_region);
    let mut register = serde_json::json!({
        "clientName": "GeoLibre Desktop",
        "clientType": "public",
    });
    // The refreshable token-provider format asks for this scope; legacy
    // profiles get the CLI's legacy, non-refreshable token.
    if sso.session.is_some() {
        register["scopes"] = serde_json::json!(["sso:account:access"]);
    }
    let registration: RegisterClientResponse = client
        .post(format!("{base}/client/register"))
        .json_body(&register)
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("Could not register with AWS IAM Identity Center: {error}"))?
        .read_json_value()?;
    let device: DeviceAuthorizationResponse = client
        .post(format!("{base}/device_authorization"))
        .json_body(&serde_json::json!({
            "clientId": registration.client_id,
            "clientSecret": registration.client_secret,
            "startUrl": sso.start_url,
        }))
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("Could not start the AWS SSO sign-in: {error}"))?
        .read_json_value()?;
    let login_id = random_id()?;
    let interval = device.interval.unwrap_or(5).max(1);
    let start = AwsSsoLoginStart {
        login_id: login_id.clone(),
        verification_uri: device
            .verification_uri_complete
            .clone()
            .unwrap_or_else(|| device.verification_uri.clone()),
        user_code: device.user_code,
        interval,
        expires_in: device.expires_in,
    };
    let pending = PendingLogin {
        id: login_id,
        cache_path: sso_cache_file(&paths.sso_cache, &sso),
        start_url: sso.start_url,
        sso_region: sso.sso_region,
        client_id: registration.client_id,
        client_secret: registration.client_secret,
        registration_expires_at: registration.client_secret_expires_at.map(|s| s * 1000),
        device_code: device.device_code,
        expires_at: now_ms() + device.expires_in * 1000,
    };
    Ok((pending, start))
}

/// Starts an IAM Identity Center sign-in for an SSO profile. The webview opens
/// `verificationUri` in the browser and polls {@link aws_sso_login_poll}.
#[tauri::command]
pub async fn aws_sso_login_start(
    profile: String,
    state: tauri::State<'_, AwsSsoLoginState>,
) -> Result<AwsSsoLoginStart, String> {
    let (pending, start) =
        tauri::async_runtime::spawn_blocking(move || start_login_blocking(profile.trim()))
            .await
            .map_err(|error| error.to_string())??;
    let mut logins = state.pending.lock().map_err(|error| error.to_string())?;
    logins.retain(|login| login.expires_at > now_ms());
    if logins.len() >= MAX_PENDING_LOGINS {
        logins.remove(0);
    }
    logins.push(pending);
    Ok(start)
}

/// Polls a sign-in: `pending`, `slow_down`, or `complete` (the token was
/// cached). Rejects when the user denied it or the code expired.
#[tauri::command]
pub async fn aws_sso_login_poll(
    login_id: String,
    state: tauri::State<'_, AwsSsoLoginState>,
) -> Result<String, String> {
    let request = {
        let logins = state.pending.lock().map_err(|error| error.to_string())?;
        let login = logins
            .iter()
            .find(|login| login.id == login_id)
            .ok_or_else(|| "This AWS sign-in is no longer pending.".to_string())?;
        if login.expires_at <= now_ms() {
            return Err("The AWS sign-in code expired. Start the sign-in again.".to_string());
        }
        (
            login.sso_region.clone(),
            login.client_id.clone(),
            login.client_secret.clone(),
            login.device_code.clone(),
        )
    };
    let (sso_region, client_id, client_secret, device_code) = request;
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let response = http_client()?
            .post(format!("https://oidc.{sso_region}.amazonaws.com/token"))
            .json_body(&serde_json::json!({
                "clientId": client_id,
                "clientSecret": client_secret,
                "grantType": "urn:ietf:params:oauth:grant-type:device_code",
                "deviceCode": device_code,
            }))
            .send()
            .map_err(|error| error.to_string())?;
        if response.status().is_success() {
            let token: OidcTokenResponse = read_json(response)?;
            return Ok(Some(token));
        }
        let error = response
            .bytes()
            .ok()
            .and_then(|bytes| serde_json::from_slice::<OidcError>(&bytes).ok())
            .and_then(|body| body.error)
            .unwrap_or_default();
        match error.as_str() {
            "authorization_pending" => Ok(None),
            "slow_down" => Err("slow_down".to_string()),
            "access_denied" => Err("The AWS sign-in was denied.".to_string()),
            "expired_token" => {
                Err("The AWS sign-in code expired. Start the sign-in again.".to_string())
            }
            other => Err(format!("The AWS sign-in failed ({other}).")),
        }
    })
    .await
    .map_err(|error| error.to_string())?;

    let token = match outcome {
        Ok(None) => return Ok("pending".to_string()),
        Err(error) if error == "slow_down" => return Ok("slow_down".to_string()),
        Err(error) => {
            let mut logins = state.pending.lock().map_err(|error| error.to_string())?;
            logins.retain(|login| login.id != login_id);
            return Err(error);
        }
        Ok(Some(token)) => token,
    };
    let login = {
        let mut logins = state.pending.lock().map_err(|error| error.to_string())?;
        let index = logins
            .iter()
            .position(|login| login.id == login_id)
            .ok_or_else(|| "This AWS sign-in is no longer pending.".to_string())?;
        logins.remove(index)
    };
    let cache = SsoTokenCache {
        start_url: Some(login.start_url),
        region: Some(login.sso_region),
        access_token: token.access_token,
        expires_at: format_timestamp(now_ms() + token.expires_in * 1000),
        client_id: token
            .refresh_token
            .as_ref()
            .map(|_| login.client_id.clone()),
        client_secret: token
            .refresh_token
            .as_ref()
            .map(|_| login.client_secret.clone()),
        registration_expires_at: token
            .refresh_token
            .as_ref()
            .and(login.registration_expires_at)
            .map(format_timestamp),
        refresh_token: token.refresh_token,
    };
    write_sso_cache(&login.cache_path, &cache)?;
    Ok("complete".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_paths(config: &str, credentials: &str) -> (PathBuf, AwsPaths) {
        let dir = env::temp_dir().join(format!("geolibre-aws-test-{}", random_id().unwrap()));
        std::fs::create_dir_all(dir.join("sso/cache")).unwrap();
        std::fs::write(dir.join("config"), config).unwrap();
        std::fs::write(dir.join("credentials"), credentials).unwrap();
        let paths = AwsPaths {
            config: dir.join("config"),
            credentials: dir.join("credentials"),
            sso_cache: dir.join("sso/cache"),
        };
        (dir, paths)
    }

    const CONFIG: &str = "\
[default]
region = us-east-1

[profile dev]
sso_session = corp
sso_account_id = 111122223333
sso_role_name = ReadOnly
region = us-west-2

[profile legacy]
sso_start_url = https://legacy.awsapps.com/start
sso_region = eu-west-1
sso_account_id = 444455556666
sso_role_name = Admin

[profile assumed]
role_arn = arn:aws:iam::123456789012:role/Reader
source_profile = default

[profile chained]
role_arn = arn:aws:iam::123456789012:role/Second
source_profile = assumed

[profile loop]
role_arn = arn:aws:iam::123456789012:role/Loop
source_profile = loop2

[profile loop2]
role_arn = arn:aws:iam::123456789012:role/Loop2
source_profile = loop

[profile tool]
credential_process = /usr/bin/printf '{\"Version\":1}'
# a comment
s3 =
  max_concurrent_requests = 20

[sso-session corp]
sso_start_url = https://corp.awsapps.com/start
sso_region = us-east-1
sso_registration_scopes = sso:account:access
";

    const CREDENTIALS: &str = "\
[default]
aws_access_key_id = AKIDEFAULT
aws_secret_access_key = secret/default
[scratch]
aws_access_key_id=AKIDSCRATCH
aws_secret_access_key=secret-scratch
aws_session_token=token-scratch
";

    #[test]
    fn lists_profiles_with_kinds_and_regions() {
        let (dir, paths) = temp_paths(CONFIG, CREDENTIALS);
        let profiles = list_profiles_in(&paths);
        let summary: Vec<(&str, &str, Option<&str>)> = profiles
            .iter()
            .map(|p| (p.name.as_str(), p.kind, p.region.as_deref()))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("assumed", "role", None),
                ("chained", "role", None),
                ("default", "static", Some("us-east-1")),
                ("dev", "sso", Some("us-west-2")),
                ("legacy", "sso", None),
                ("loop", "role", None),
                ("loop2", "role", None),
                ("scratch", "static", None),
                ("tool", "process", None),
            ]
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn resolves_static_profiles_from_the_credentials_file() {
        let (dir, paths) = temp_paths(CONFIG, CREDENTIALS);
        let resolved = resolve_profile_in(&paths, "default").unwrap();
        assert_eq!(resolved.access_key_id, "AKIDEFAULT");
        assert_eq!(resolved.secret_access_key, "secret/default");
        assert_eq!(resolved.region.as_deref(), Some("us-east-1"));
        let scratch = resolve_profile_in(&paths, "scratch").unwrap();
        assert_eq!(scratch.session_token.as_deref(), Some("token-scratch"));
        assert!(resolve_profile_in(&paths, "missing").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn role_profile_cycles_stop_before_any_network_call() {
        let (dir, paths) = temp_paths(CONFIG, CREDENTIALS);
        let error = resolve_profile_in(&paths, "loop").unwrap_err();
        assert!(error.contains("too deep or loops"), "{error}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn nested_sections_do_not_leak_keys() {
        let sections = parse_ini(CONFIG);
        let tool = sections.get("profile tool").unwrap();
        assert!(tool.get("max_concurrent_requests").is_none());
        assert!(tool.get("s3").is_none());
    }

    #[test]
    fn reads_sso_session_and_legacy_profiles() {
        let config = parse_ini(CONFIG);
        let dev = sso_profile(&config, "dev").unwrap();
        assert_eq!(dev.session.as_deref(), Some("corp"));
        assert_eq!(dev.start_url, "https://corp.awsapps.com/start");
        assert_eq!(dev.sso_region, "us-east-1");
        assert_eq!(dev.account_id, "111122223333");
        let legacy = sso_profile(&config, "legacy").unwrap();
        assert_eq!(legacy.session, None);
        assert_eq!(legacy.sso_region, "eu-west-1");
        assert!(sso_profile(&config, "default").is_err());
    }

    #[test]
    fn cache_file_names_match_the_aws_cli() {
        let cache = Path::new("/c");
        let config = parse_ini(CONFIG);
        // The CLI keys the token-provider format by session name and the
        // legacy format by start URL: sha1("corp") and sha1 of the URL.
        let session = sso_cache_file(cache, &sso_profile(&config, "dev").unwrap());
        assert_eq!(
            session,
            Path::new("/c/ee0bfd2552fbd840c02cc48b6e823320543c450f.json")
        );
        let legacy = sso_cache_file(cache, &sso_profile(&config, "legacy").unwrap());
        assert_ne!(session, legacy);
    }

    #[test]
    fn expired_sso_token_without_refresh_asks_for_login() {
        let (dir, paths) = temp_paths(CONFIG, CREDENTIALS);
        let config = parse_ini(CONFIG);
        let sso = sso_profile(&config, "dev").unwrap();
        write_sso_cache(
            &sso_cache_file(&paths.sso_cache, &sso),
            &SsoTokenCache {
                access_token: "expired".to_string(),
                expires_at: "2020-01-01T00:00:00Z".to_string(),
                ..Default::default()
            },
        )
        .unwrap();
        let error = resolve_profile_in(&paths, "dev").unwrap_err();
        assert!(error.contains("aws sso login --profile dev"), "{error}");
        // No cache at all gives the same hint.
        let error = resolve_profile_in(&paths, "legacy").unwrap_err();
        assert!(error.contains("aws sso login --profile legacy"), "{error}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn parses_cli_timestamps_and_process_output() {
        assert_eq!(
            parse_timestamp_ms("2026-01-01T00:00:00Z"),
            Some(1_767_225_600_000)
        );
        assert_eq!(
            parse_timestamp_ms("2026-01-01T00:00:00UTC"),
            Some(1_767_225_600_000)
        );
        assert_eq!(parse_timestamp_ms("garbage"), None);
        assert_eq!(format_timestamp(1_767_225_600_000), "2026-01-01T00:00:00Z");
        let resolved = credentials_from_process_output(
            br#"{"Version":1,"AccessKeyId":"A","SecretAccessKey":"S","SessionToken":"T","Expiration":"2026-01-01T00:00:00Z"}"#,
            Some("us-east-1".to_string()),
        )
        .unwrap();
        assert_eq!(resolved.session_token.as_deref(), Some("T"));
        assert_eq!(resolved.expiration, Some(1_767_225_600_000));
    }

    #[test]
    fn rejects_regions_that_are_not_host_labels() {
        assert!(validate_region("us-east-1").is_ok());
        assert!(validate_region("evil.com/x").is_err());
        assert!(validate_region("").is_err());
    }
}
