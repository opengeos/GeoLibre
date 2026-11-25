//! Sign in with ChatGPT, so the AI Assistant can use the user's ChatGPT plan
//! instead of an API key: OpenAI's Sign in with ChatGPT for open-source apps
//! (<https://developers.openai.com/siwc/token-sharing-open-source>). A port of
//! RustGIS's `crates/assistant/src/chatgpt.rs`.
//!
//! The first sign-in registers GeoLibre as the user's own agent
//! (`client_id=dynamic_agent_client`, with this computer's host id); the
//! browser comes back with the client id OpenAI issued, which later sign-ins
//! and renewals use. It is OAuth 2.0 authorization code with PKCE in the system
//! browser, returning to a short-lived listener on `127.0.0.1`. The id token is
//! verified against OpenAI's published keys, and the grant must include
//! `chatgpt.tokens.use.direct`, the permission to use the plan.
//!
//! **No token ever reaches the webview.** External plugins run in the same
//! webview as the app and can call any command it can, so the access token is
//! never handed to JavaScript: [`chatgpt_request`] makes the request itself and
//! streams the reply back, and it only reaches the Responses API and the model
//! list. The refresh token lives in the OS keychain (an entry the webview's
//! `secure_store_*` commands refuse), the registration (client id, account,
//! scopes; never a token) in `chatgpt-auth.json` in the app config folder, and
//! the access and id tokens only in this process's memory.

use std::{
    io::{ErrorKind, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use reqwest::{redirect::Policy, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::Manager;

use super::{guarded_http::guarded_async_client_builder, secure_store};

/// The OpenAI sign-in service (the id token's issuer).
const ISSUER: &str = "https://auth.openai.com";
/// Where the browser signs in.
const AUTHORIZE_URL: &str = "https://auth.openai.com/api/accounts/authorize";
/// Where codes and refresh tokens are exchanged.
const TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
/// OpenAI's OpenID configuration: its signing keys and revocation endpoint.
const DISCOVERY_URL: &str = "https://auth.openai.com/.well-known/openid-configuration";
/// The API the plan's tokens are for (the `resource` of every grant).
const API: &str = "https://api.openai.com/v1";
/// The client id of a first sign-in, which registers GeoLibre for the account.
const REGISTER: &str = "dynamic_agent_client";
/// The name the registration suggests (the user may edit it).
const AGENT_NAME: &str = "GeoLibre";
/// Identity, a refresh token, and the permission to use the plan.
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/// The permission to use the user's ChatGPT plan.
const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
/// The callback port tried first (another free one otherwise).
const PORT: u16 = 1455;
/// Access tokens are renewed this long before they expire.
const REFRESH_MARGIN: i64 = 5 * 60;
/// The clock skew allowed when checking an id token's expiry.
const CLOCK_SKEW: i64 = 5 * 60;
/// How long the browser has to come back.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Requests to the sign-in service (not the streamed replies).
const AUTH_TIMEOUT: Duration = Duration::from_secs(30);
/// Silence allowed between two chunks of a streamed reply.
const READ_TIMEOUT: Duration = Duration::from_secs(180);
/// The callback request line and headers are small.
const MAX_CALLBACK_BYTES: usize = 16 * 1024;
/// The keychain entry holding the refresh and id tokens.
const KEYCHAIN_ACCOUNT: &str = "chatgpt.signIn";
/// The registration, in the app config folder.
const AUTH_FILE: &str = "chatgpt-auth.json";
/// This computer's stable host id, in the app config folder.
const HOST_FILE: &str = "chatgpt-host-id";

// ---------------------------------------------------------------------------
// Data

/// GeoLibre's registration for a ChatGPT account. Saved to [`AUTH_FILE`]:
/// never a token.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Registration {
    /// The client id OpenAI issued for this account (kept after signing out).
    client_id: String,
    /// The verified id token's subject: who signed in.
    subject: String,
    /// The verified email, for display.
    email: String,
    /// The scopes granted.
    scopes: Vec<String>,
    /// The user declined the plan's use: the next sign-in asks for it again.
    plan_declined: bool,
    /// Whether a refresh token is kept for it.
    signed_in: bool,
}

impl Registration {
    fn plan_allowed(&self) -> bool {
        self.scopes.iter().any(|scope| scope == PLAN_SCOPE)
    }
}

/// A sign-in's tokens. `Debug` hides them.
#[derive(Clone, Default, PartialEq, Eq)]
struct Tokens {
    access_token: String,
    refresh_token: String,
    id_token: String,
    /// When the access token expires (Unix seconds; 0 when unknown or none).
    expires_at: i64,
}

impl std::fmt::Debug for Tokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tokens")
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

impl Tokens {
    /// Whether the access token is missing or expires within [`REFRESH_MARGIN`].
    fn expires_soon(&self, now: i64) -> bool {
        self.access_token.is_empty()
            || self.expires_at <= 0
            || self.expires_at.saturating_sub(REFRESH_MARGIN) <= now
    }
}

/// What the keychain entry holds, tied to the registration it belongs to.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct KeychainSecret {
    client_id: String,
    subject: String,
    refresh_token: String,
    id_token: String,
}

/// What a token endpoint gave. `Debug` hides the tokens.
#[derive(Clone, Default, PartialEq, Eq)]
struct Grant {
    access_token: String,
    refresh_token: String,
    id_token: String,
    expires_in: i64,
    scopes: Option<Vec<String>>,
}

impl std::fmt::Debug for Grant {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Grant")
            .field("expires_in", &self.expires_in)
            .field("scopes", &self.scopes)
            .finish_non_exhaustive()
    }
}

/// Why a token endpoint refused.
#[derive(Clone, Debug, PartialEq, Eq)]
enum GrantError {
    /// The refresh token or code can't be used again: sign in again.
    Unusable,
    /// Anything else (a message without credentials).
    Other(String),
}

impl GrantError {
    fn message(&self, what: &str) -> String {
        match self {
            GrantError::Unusable => {
                format!("{what}: the ChatGPT sign-in has expired or was revoked; sign in again.")
            }
            GrantError::Other(why) => format!("{what}: {why}"),
        }
    }
}

/// The signed-in account, for the settings.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptStatus {
    signed_in: bool,
    email: String,
    plan_allowed: bool,
    /// A registration is saved (so the next sign-in reuses its client id).
    registered: bool,
    /// The sign-in is kept in the OS keychain (false: this session only).
    remembered: bool,
    signing_in: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptSignInStart {
    /// The authorization page to open in the browser.
    url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptSignInPoll {
    /// `idle`, `pending`, `done` or `failed`.
    state: &'static str,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptSignOut {
    /// OpenAI confirmed the refresh token's revocation (or there was none).
    revoked: bool,
}

/// One message of a streamed reply.
#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum ChatGptEvent {
    /// The status and content type, before any chunk.
    #[serde(rename_all = "camelCase")]
    Head { status: u16, content_type: String },
    /// Body bytes, base64.
    Chunk { data: String },
    /// The reply is complete. Sent last, so the webview never closes the body
    /// before a chunk still in flight on the channel.
    End,
}

// ---------------------------------------------------------------------------
// Pure helpers

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The PKCE challenge (S256) of a verifier.
fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("No random numbers: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// A version 4 UUID from 16 random bytes, as a host id (`urn:uuid:…`).
fn host_id_from(b: [u8; 16]) -> String {
    let mut id = String::from("urn:uuid:");
    for (i, x) in b.iter().enumerate() {
        let x = match i {
            6 => (x & 0x0f) | 0x40,
            8 => (x & 0x3f) | 0x80,
            _ => *x,
        };
        if matches!(i, 4 | 6 | 8 | 10) {
            id.push('-');
        }
        id.push_str(&format!("{x:02x}"));
    }
    id
}

/// Whether a saved host id has the shape this app writes.
fn valid_host_id(id: &str) -> bool {
    id.strip_prefix("urn:uuid:").is_some_and(|u| {
        u.len() == 36
            && u.char_indices().all(|(i, c)| {
                if matches!(i, 8 | 13 | 18 | 23) {
                    c == '-'
                } else {
                    c.is_ascii_hexdigit()
                }
            })
    })
}

/// One attempt at signing in.
struct Authorization<'a> {
    /// [`REGISTER`] for a first sign-in, else the account's issued client id.
    client_id: &'a str,
    host_id: &'a str,
    redirect_uri: &'a str,
    challenge: &'a str,
    state: &'a str,
    nonce: &'a str,
    /// The account's email, to preselect it.
    login_hint: &'a str,
    /// Ask again for the permissions (after the plan's use was declined).
    consent: bool,
}

/// The page to open in the browser.
fn authorize_url(a: &Authorization) -> String {
    let mut params = vec![
        ("response_type", "code"),
        ("client_id", a.client_id),
        ("redirect_uri", a.redirect_uri),
        ("scope", SCOPES),
        ("resource", API),
        ("state", a.state),
        ("nonce", a.nonce),
        ("code_challenge", a.challenge),
        ("code_challenge_method", "S256"),
        ("ext_agent_host_id", a.host_id),
    ];
    if a.client_id == REGISTER {
        params.push(("agent_name_hint", AGENT_NAME));
    } else if !a.login_hint.is_empty() {
        params.push(("login_hint", a.login_hint));
    }
    if a.consent {
        params.push(("prompt", "consent"));
    }
    Url::parse_with_params(AUTHORIZE_URL, &params)
        .map(String::from)
        .unwrap_or_default()
}

/// The client id a callback gives for a sign-in started with `requested`: the
/// issued one for a first sign-in (which must say it), the saved one otherwise
/// (which it may repeat, never change).
fn callback_client_id(params: &[(String, String)], requested: &str) -> Result<String, String> {
    let mut ids = params
        .iter()
        .filter(|(k, _)| k == "client_id")
        .map(|(_, v)| v.trim());
    let (given, extra) = (ids.next().filter(|v| !v.is_empty()), ids.next());
    if extra.is_some() {
        return Err("the sign-in returned more than one client id".into());
    }
    match (requested == REGISTER, given) {
        (true, Some(id)) if id != REGISTER => Ok(id.to_string()),
        (true, _) => Err("the registration didn't complete; try again".into()),
        (false, Some(id)) if id != requested => {
            Err("the sign-in returned another registration; try again".into())
        }
        (false, _) => Ok(requested.to_string()),
    }
}

/// Whether the callback carries exactly one `state`, equal to the expected one.
fn callback_state_matches(params: &[(String, String)], expected: &str) -> bool {
    let mut states = params.iter().filter(|(key, _)| key == "state");
    !expected.is_empty()
        && states.next().is_some_and(|(_, value)| value == expected)
        && states.next().is_none()
}

/// A token endpoint's reply, or why it refused.
fn parse_grant(status: u16, body: &[u8]) -> Result<Grant, GrantError> {
    let v: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        let code = v
            .get("error")
            .and_then(|e| e.as_str().or_else(|| e.get("code").and_then(Value::as_str)))
            .unwrap_or("");
        // OAuth replies may echo submitted credentials: report only recognized
        // protocol codes, never raw descriptions or bodies.
        return Err(match code {
            "invalid_grant"
            | "invalid_refresh_token"
            | "token_expired"
            | "refresh_token_expired"
            | "refresh_token_invalidated"
            | "refresh_token_reused" => GrantError::Unusable,
            "invalid_request"
            | "invalid_client"
            | "unauthorized_client"
            | "unsupported_grant_type"
            | "invalid_scope" => GrantError::Other(code.to_string()),
            _ => GrantError::Other(format!("HTTP {status}")),
        });
    }
    let field = |k: &str| {
        v.get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let grant = Grant {
        access_token: field("access_token"),
        refresh_token: field("refresh_token"),
        id_token: field("id_token"),
        expires_in: v.get("expires_in").and_then(Value::as_i64).unwrap_or(0),
        scopes: v
            .get("scope")
            .and_then(Value::as_str)
            .map(|s| s.split_whitespace().map(str::to_string).collect()),
    };
    if grant.access_token.is_empty() {
        return Err(GrantError::Other("the reply has no access token".into()));
    }
    Ok(grant)
}

/// The payload of a JWT, unverified.
fn jwt_payload(jwt: &str) -> Option<Value> {
    let mut parts = jwt.split('.');
    let (h, p, s) = (parts.next()?, parts.next()?, parts.next()?);
    if h.is_empty() || p.is_empty() || s.is_empty() || parts.next().is_some() {
        return None;
    }
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(p).ok()?).ok()
}

/// When a grant's access token expires: from `expires_in`, else the token's own `exp`.
fn expiry(grant: &Grant, now: i64) -> i64 {
    if grant.expires_in > 0 {
        return now.saturating_add(grant.expires_in);
    }
    jwt_payload(&grant.access_token)
        .and_then(|v| v.get("exp").and_then(Value::as_i64))
        .unwrap_or(0)
}

/// The tokens after a renewal: the access token, expiry and rotated refresh
/// token replaced together.
fn renewed(old: &Tokens, grant: &Grant, now: i64) -> Tokens {
    Tokens {
        access_token: grant.access_token.clone(),
        refresh_token: if grant.refresh_token.is_empty() {
            old.refresh_token.clone()
        } else {
            grant.refresh_token.clone()
        },
        id_token: if grant.id_token.is_empty() {
            old.id_token.clone()
        } else {
            grant.id_token.clone()
        },
        expires_at: expiry(grant, now),
    }
}

/// Checks an id token's claims (its signature is checked separately): the
/// issuer, the audience (the issued client id), the expiry and the nonce of
/// this sign-in. Gives the subject and email.
fn check_id_claims(
    claims: &Value,
    client_id: &str,
    nonce: &str,
    now: i64,
) -> Result<(String, String), String> {
    let s = |k: &str| claims.get(k).and_then(Value::as_str).unwrap_or("");
    if s("iss") != ISSUER {
        return Err("the id token isn't from OpenAI".into());
    }
    let aud_ok = match claims.get("aud") {
        Some(Value::String(a)) => a == client_id,
        Some(Value::Array(a)) => a.iter().any(|x| x.as_str() == Some(client_id)),
        _ => false,
    };
    if client_id.is_empty() || !aud_ok {
        return Err("the id token is for another app".into());
    }
    if claims
        .get("exp")
        .and_then(Value::as_i64)
        .is_none_or(|exp| exp.saturating_add(CLOCK_SKEW) < now)
    {
        return Err("the id token has expired".into());
    }
    if nonce.is_empty() || s("nonce") != nonce {
        return Err("the id token isn't from this sign-in".into());
    }
    if s("sub").is_empty() {
        return Err("the id token names no account".into());
    }
    Ok((s("sub").to_string(), s("email").to_string()))
}

/// Verifies a JWT's RS256 signature against a JSON Web Key Set. Gives the claims.
fn verify_jwt(jwt: &str, jwks: &Value) -> Result<Value, String> {
    let parts: Vec<&str> = jwt.split('.').collect();
    let [header, _, signature] = parts.as_slice() else {
        return Err("the id token is malformed".into());
    };
    let header: Value = URL_SAFE_NO_PAD
        .decode(header)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or("the id token is malformed")?;
    if header.get("alg").and_then(Value::as_str) != Some("RS256") {
        return Err("the id token isn't signed with RS256".into());
    }
    let kid = header.get("kid").and_then(Value::as_str);
    let key = jwks
        .get("keys")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|k| {
            k.get("kty").and_then(Value::as_str) == Some("RSA")
                && (kid.is_none() || k.get("kid").and_then(Value::as_str) == kid)
        })
        .ok_or("OpenAI's signing key for the id token wasn't found")?;
    let component = |name: &str| {
        key.get(name)
            .and_then(Value::as_str)
            .and_then(|v| URL_SAFE_NO_PAD.decode(v).ok())
            .ok_or_else(|| "OpenAI's signing key is malformed".to_string())
    };
    let public_key = ring::signature::RsaPublicKeyComponents {
        n: component("n")?,
        e: component("e")?,
    };
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| "the id token is malformed")?;
    public_key
        .verify(
            &ring::signature::RSA_PKCS1_2048_8192_SHA256,
            format!("{}.{}", parts[0], parts[1]).as_bytes(),
            &signature,
        )
        .map_err(|_| "the id token's signature is invalid".to_string())?;
    jwt_payload(jwt).ok_or_else(|| "the id token is malformed".to_string())
}

/// An endpoint of OpenAI's OpenID configuration, if it is on the sign-in service.
fn discovered(config: &Value, key: &str) -> Option<String> {
    config
        .get(key)
        .and_then(Value::as_str)
        .filter(|u| u.strip_prefix(ISSUER).is_some_and(|r| r.starts_with('/')))
        .map(str::to_string)
}

/// The API path a webview request may reach, and its method.
fn api_route(path: &str) -> Option<(&'static str, reqwest::Method)> {
    match path {
        "responses" => Some(("responses", reqwest::Method::POST)),
        "models" => Some(("models", reqwest::Method::GET)),
        _ => None,
    }
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The page the browser shows at the end.
fn result_page(title: &str, text: &str) -> String {
    format!(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>GeoLibre: {t}</title></head>\
<body style=\"font-family: system-ui, sans-serif; margin: 3em auto; max-width: 32em; text-align: center\">\
<h1>{t}</h1><p>{b}</p></body></html>",
        t = escape_html(title),
        b = escape_html(text)
    )
}

// ---------------------------------------------------------------------------
// Storage

fn read_registration(dir: &Path) -> Option<Registration> {
    let text = std::fs::read_to_string(dir.join(AUTH_FILE)).ok()?;
    let reg: Registration = serde_json::from_str(&text).ok()?;
    (!reg.client_id.is_empty() && reg.client_id != REGISTER).then_some(reg)
}

/// Writes a file atomically, owner-only on Unix.
fn write_private(path: &Path, text: &str) -> Result<(), String> {
    crate::fs_util::write_file_atomic(
        path,
        text.as_bytes(),
        crate::fs_util::AtomicWriteOptions {
            create_parents: true,
            owner_only_unix: true,
            sync: true,
            preserve_permissions: None,
        },
    )
    .map_err(|e| format!("Can't save the sign-in: {e}"))
}

fn write_registration(dir: &Path, reg: Option<&Registration>) -> Result<(), String> {
    let path = dir.join(AUTH_FILE);
    match reg {
        Some(reg) => write_private(
            &path,
            &serde_json::to_string_pretty(reg).map_err(|e| e.to_string())?,
        ),
        None => match std::fs::remove_file(&path) {
            Err(e) if e.kind() != ErrorKind::NotFound => {
                Err(format!("Can't forget the sign-in: {e}"))
            }
            _ => Ok(()),
        },
    }
}

/// This computer's stable host id, created on first use.
fn host_id(dir: &Path) -> Result<String, String> {
    let path = dir.join(HOST_FILE);
    if let Ok(id) = std::fs::read_to_string(&path) {
        let id = id.trim();
        if valid_host_id(id) {
            return Ok(id.to_string());
        }
    }
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| format!("No random numbers: {e}"))?;
    let id = host_id_from(bytes);
    write_private(&path, &id)?;
    Ok(id)
}

fn keychain_save(reg: &Registration, tokens: &Tokens) -> Result<(), String> {
    let secret = KeychainSecret {
        client_id: reg.client_id.clone(),
        subject: reg.subject.clone(),
        refresh_token: tokens.refresh_token.clone(),
        id_token: tokens.id_token.clone(),
    };
    let text = serde_json::to_string(&secret).map_err(|e| e.to_string())?;
    secure_store::set_blocking(KEYCHAIN_ACCOUNT.to_string(), text)
}

fn keychain_load(reg: &Registration) -> Result<Option<Tokens>, String> {
    let Some(text) = secure_store::get_blocking(KEYCHAIN_ACCOUNT)? else {
        return Ok(None);
    };
    let secret: KeychainSecret = serde_json::from_str(&text).unwrap_or_default();
    // An entry for another registration is out of date.
    if secret.client_id != reg.client_id
        || secret.subject != reg.subject
        || secret.refresh_token.is_empty()
    {
        return Ok(None);
    }
    Ok(Some(Tokens {
        refresh_token: secret.refresh_token,
        id_token: secret.id_token,
        ..Tokens::default()
    }))
}

fn keychain_delete() -> Result<(), String> {
    secure_store::delete_blocking(KEYCHAIN_ACCOUNT.to_string())
}

// ---------------------------------------------------------------------------
// HTTP

fn client() -> Result<reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let client = guarded_async_client_builder(Policy::none())?
        .read_timeout(READ_TIMEOUT)
        .build()
        .map_err(|e| format!("Can't create the HTTP client: {e}"))?;
    Ok(CLIENT.get_or_init(|| client).clone())
}

async fn form_post(url: &str, params: &[(&str, &str)]) -> Result<(u16, Vec<u8>), String> {
    let response = client()?
        .post(url)
        .timeout(AUTH_TIMEOUT)
        .form(params)
        .send()
        .await
        .map_err(|e| format!("Can't reach OpenAI: {}", e.without_url()))?;
    let status = response.status().as_u16();
    let body = response
        .bytes()
        .await
        .map_err(|e| format!("Can't read OpenAI's reply: {}", e.without_url()))?;
    Ok((status, body.to_vec()))
}

async fn get_json(url: &str) -> Result<Value, String> {
    let response = client()?
        .get(url)
        .timeout(AUTH_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("Can't reach OpenAI: {}", e.without_url()))?;
    if !response.status().is_success() {
        return Err(format!(
            "OpenAI answered HTTP {}",
            response.status().as_u16()
        ));
    }
    let body = response
        .bytes()
        .await
        .map_err(|e| format!("Can't read OpenAI's reply: {}", e.without_url()))?;
    serde_json::from_slice(&body).map_err(|_| "OpenAI's reply isn't JSON".to_string())
}

async fn exchange(
    client_id: &str,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<Grant, String> {
    let (status, body) = form_post(
        TOKEN_URL,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", client_id),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect_uri),
            ("resource", API),
        ],
    )
    .await?;
    parse_grant(status, &body).map_err(|e| e.message("Signing in"))
}

/// Verifies an id token's signature and claims; gives its subject and email.
async fn verify_id_token(
    id_token: &str,
    client_id: &str,
    nonce: &str,
) -> Result<(String, String), String> {
    let config = get_json(DISCOVERY_URL).await?;
    let jwks_uri =
        discovered(&config, "jwks_uri").ok_or("OpenAI's sign-in configuration has no keys")?;
    let jwks = get_json(&jwks_uri).await?;
    let claims = verify_jwt(id_token, &jwks)?;
    check_id_claims(&claims, client_id, nonce, now())
}

/// Revokes a refresh token. True once OpenAI confirms it.
async fn revoke(client_id: &str, refresh_token: &str) -> bool {
    if refresh_token.is_empty() {
        return true;
    }
    let Ok(config) = get_json(DISCOVERY_URL).await else {
        return false;
    };
    let Some(endpoint) = discovered(&config, "revocation_endpoint") else {
        return false;
    };
    for attempt in 0..3 {
        match form_post(
            &endpoint,
            &[
                ("token", refresh_token),
                ("token_type_hint", "refresh_token"),
                ("client_id", client_id),
            ],
        )
        .await
        {
            Ok((status, _)) if (200..300).contains(&status) => return true,
            // Retry server errors only.
            Ok((status, _)) if status < 500 => return false,
            _ if attempt < 2 => tokio_sleep(Duration::from_millis(500 << attempt)).await,
            _ => {}
        }
    }
    false
}

async fn tokio_sleep(duration: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration)).await;
}

// ---------------------------------------------------------------------------
// State

#[derive(Default)]
struct Session {
    loaded: bool,
    dir: Option<PathBuf>,
    reg: Option<Registration>,
    tokens: Option<Tokens>,
    /// The refresh token is in the keychain (false: this session only).
    in_keychain: bool,
    /// Changes with every sign-in and sign-out (not renewal): a request begun
    /// for one account is never retried with another's token.
    generation: u64,
}

impl Session {
    fn signed_in(&self) -> bool {
        self.reg.as_ref().is_some_and(|r| r.signed_in)
            && self
                .tokens
                .as_ref()
                .is_some_and(|t| !t.refresh_token.is_empty())
    }

    fn status(&self, signing_in: bool) -> ChatGptStatus {
        let signed_in = self.signed_in();
        ChatGptStatus {
            signed_in,
            email: self
                .reg
                .as_ref()
                .map(|r| r.email.clone())
                .unwrap_or_default(),
            plan_allowed: signed_in && self.reg.as_ref().is_some_and(Registration::plan_allowed),
            registered: self.reg.is_some(),
            remembered: signed_in && self.in_keychain,
            signing_in,
        }
    }

    /// Clears in-memory token state and returns the registration snapshot to
    /// persist (plus keychain deletion) on a blocking worker via
    /// `spawn_blocking`. Callers hold the async session mutex across that
    /// persistence so concurrent sign-ins and sign-outs stay strictly ordered
    /// on the keychain while blocking disk/keychain I/O stays off the Tokio
    /// executor.
    fn clear_signed_in_state(
        &mut self,
    ) -> (Option<Tokens>, Option<(PathBuf, Option<Registration>)>) {
        let tokens = self.tokens.take();
        if let Some(reg) = self.reg.as_mut() {
            reg.signed_in = false;
        }
        let reg_write = self.dir.clone().map(|dir| (dir, self.reg.clone()));
        self.in_keychain = false;
        self.generation += 1;
        (tokens, reg_write)
    }
}

async fn persist_sign_out(reg_write: Option<(PathBuf, Option<Registration>)>) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        if let Some((dir, reg)) = reg_write {
            let _ = write_registration(&dir, reg.as_ref());
        }
        let _ = keychain_delete();
    })
    .await;
}

/// A request's cancellation: a flag, and a wake-up for the wait it interrupts.
#[derive(Default)]
struct Cancel {
    flag: AtomicBool,
    notify: tokio::sync::Notify,
}

impl Cancel {
    fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Runs `work` until it finishes or the request is cancelled (`None`),
    /// dropping the pending network wait in that case.
    async fn or_cancelled<T>(&self, work: impl std::future::Future<Output = T>) -> Option<T> {
        use std::future::Future;
        use std::task::Poll;
        let mut work = std::pin::pin!(work);
        let mut notified = std::pin::pin!(self.notify.notified());
        // Registered before the flag is read, so a cancel in between still wakes it.
        notified.as_mut().enable();
        if self.is_cancelled() {
            return None;
        }
        std::future::poll_fn(|cx| {
            if let Poll::Ready(value) = work.as_mut().poll(cx) {
                return Poll::Ready(Some(value));
            }
            if notified.as_mut().poll(cx).is_ready() {
                return Poll::Ready(None);
            }
            Poll::Pending
        })
        .await
    }
}

struct LoginAttempt {
    cancel: Arc<AtomicBool>,
    outcome: Arc<Mutex<Option<Result<(), String>>>>,
}

#[derive(Default)]
pub struct ChatGptAuthState {
    session: Arc<tokio::sync::Mutex<Session>>,
    login: Mutex<Option<LoginAttempt>>,
    /// Advanced (under `login`) by every cancel and sign-out, so a start that
    /// was overtaken before it stored its attempt cancels that attempt itself.
    login_generation: std::sync::atomic::AtomicU64,
    /// Held for a whole `chatgpt_sign_in_start`, so overlapping starts run in
    /// turn and each one cancels the attempt the previous one installed.
    starting: tokio::sync::Mutex<()>,
    requests: crate::in_flight::InFlightRegistry<Arc<Cancel>>,
}

impl ChatGptAuthState {
    fn signing_in(&self) -> bool {
        self.login
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .is_some_and(|attempt| {
                attempt
                    .outcome
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .is_none()
            })
    }

    fn cancel_login(&self) {
        let mut login = self.login.lock().unwrap_or_else(|p| p.into_inner());
        self.login_generation.fetch_add(1, Ordering::SeqCst);
        if let Some(attempt) = login.take() {
            attempt.cancel.store(true, Ordering::SeqCst);
        }
    }
}

fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("Could not resolve the config directory: {e}"))
}

/// Reads the registration and the keychain once per app run.
async fn ensure_loaded(session: &mut Session, app: &tauri::AppHandle) -> Result<(), String> {
    if session.loaded {
        return Ok(());
    }
    let dir = config_dir(app)?;
    let reg = read_registration(&dir);
    let mut tokens = None;
    if let Some(reg) = reg.as_ref().filter(|r| r.signed_in) {
        let reg = reg.clone();
        // A locked or missing keychain reads as signed out here; the
        // registration stays for the next sign-in.
        tokens = tauri::async_runtime::spawn_blocking(move || keychain_load(&reg))
            .await
            .ok()
            .and_then(Result::ok)
            .flatten();
    }
    session.in_keychain = tokens.is_some();
    session.reg = reg.map(|mut r| {
        r.signed_in = tokens.is_some();
        r
    });
    session.tokens = tokens;
    session.dir = Some(dir);
    session.loaded = true;
    Ok(())
}

/// A current access token, renewed first when it expires soon (or `force`).
/// Runs under the session lock, so concurrent requests renew only once: a
/// rotated refresh token must never be used twice.
async fn fresh_access_token(session: &mut Session, force: bool) -> Result<String, String> {
    if !session.signed_in() {
        return Err("Not signed in with ChatGPT. Sign in in Settings → AI Providers.".into());
    }
    let reg = session.reg.clone().unwrap_or_default();
    if !reg.plan_allowed() {
        return Err(
            "GeoLibre isn't allowed to use your ChatGPT plan. Sign in again and allow it.".into(),
        );
    }
    let tokens = session.tokens.clone().unwrap_or_default();
    if !force && !tokens.expires_soon(now()) {
        return Ok(tokens.access_token);
    }
    let (status, body) = form_post(
        TOKEN_URL,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", &reg.client_id),
            ("refresh_token", &tokens.refresh_token),
            ("resource", API),
        ],
    )
    .await?;
    let grant = match parse_grant(status, &body) {
        Ok(grant) => grant,
        Err(GrantError::Unusable) => {
            let (_, reg_write) = session.clear_signed_in_state();
            persist_sign_out(reg_write).await;
            return Err(GrantError::Unusable.message("Renewing the ChatGPT sign-in"));
        }
        Err(e) => return Err(e.message("Renewing the ChatGPT sign-in")),
    };
    let next = renewed(&tokens, &grant, now());
    let mut reg = reg;
    if let Some(scopes) = &grant.scopes {
        reg.scopes = scopes.clone();
        reg.plan_declined = !reg.plan_allowed();
    }
    if next.refresh_token != tokens.refresh_token || next.id_token != tokens.id_token {
        let (r, t) = (reg.clone(), next.clone());
        session.in_keychain = tauri::async_runtime::spawn_blocking(move || keychain_save(&r, &t))
            .await
            .map(|r| r.is_ok())
            .unwrap_or(false);
        if !session.in_keychain {
            // The keychain still holds the rotated-out refresh token, which a
            // later launch would load: drop it. This sign-in lasts the session.
            let _ = tauri::async_runtime::spawn_blocking(keychain_delete).await;
        }
    }
    if let Some(dir) = &session.dir {
        let _ = write_registration(dir, Some(&reg));
    }
    let access = next.access_token.clone();
    session.reg = Some(reg);
    session.tokens = Some(next);
    if !session.reg.as_ref().is_some_and(Registration::plan_allowed) {
        return Err(
            "GeoLibre isn't allowed to use your ChatGPT plan. Sign in again and allow it.".into(),
        );
    }
    Ok(access)
}

// ---------------------------------------------------------------------------
// The callback listener

/// What the callback listener needs to finish a sign-in.
struct Pending {
    redirect_uri: String,
    verifier: String,
    state: String,
    nonce: String,
    /// [`REGISTER`] or the saved client id.
    client_id: String,
    /// The account a sign-in with a saved registration must come back as.
    subject: String,
}

fn check_attempt(cancel: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("The sign-in was cancelled.".into());
    }
    if Instant::now() >= deadline {
        return Err("The sign-in timed out. Start it again and finish it in the browser.".into());
    }
    Ok(())
}

/// The request target (`/auth/callback?code=…`) of an HTTP GET, read up to its headers' end.
fn request_target(
    stream: &mut impl Read,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Option<String> {
    let deadline = deadline.min(Instant::now() + Duration::from_secs(2));
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < MAX_CALLBACK_BYTES {
        check_attempt(cancel, deadline).ok()?;
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e)
                if matches!(
                    e.kind(),
                    ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                ) => {}
            Err(_) => return None,
        }
    }
    if !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        return None;
    }
    let line = buf.split(|b| *b == b'\n').next()?;
    let mut parts = std::str::from_utf8(line).ok()?.trim().split(' ');
    let (method, target, version) = (parts.next()?, parts.next()?, parts.next()?);
    (method == "GET" && version.starts_with("HTTP/1.") && parts.next().is_none())
        .then(|| target.to_string())
}

fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Error",
    };
    let kind = if body.starts_with("<!DOCTYPE") {
        "text/html; charset=utf-8"
    } else {
        "text/plain; charset=utf-8"
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {kind}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream
        .write_all(head.as_bytes())
        .and_then(|_| stream.write_all(body.as_bytes()))
        .and_then(|_| stream.flush());
}

/// Answers requests until the callback arrives (or the sign-in is cancelled
/// or times out), then exchanges the code, verifies the account and saves it.
fn serve(
    listener: &TcpListener,
    cancel: &AtomicBool,
    pending: &Pending,
    session: &tokio::sync::Mutex<Session>,
) -> Result<(), String> {
    let deadline = Instant::now() + LOGIN_TIMEOUT;
    loop {
        check_attempt(cancel, deadline)?;
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e)
                if matches!(
                    e.kind(),
                    ErrorKind::WouldBlock | ErrorKind::Interrupted | ErrorKind::ConnectionAborted
                ) =>
            {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
            Err(e) => return Err(format!("The sign-in listener failed: {e}")),
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        let Some(target) = request_target(&mut stream, cancel, deadline) else {
            respond(&mut stream, 400, "Bad request");
            continue;
        };
        let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
            respond(&mut stream, 400, "Bad request");
            continue;
        };
        if url.path() != "/auth/callback" {
            respond(&mut stream, 404, "Not found");
            continue;
        }
        let params: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        let get = |k: &str| {
            params
                .iter()
                .find(|(n, _)| n == k)
                .map(|(_, v)| v.as_str())
                .unwrap_or("")
        };
        if !callback_state_matches(&params, &pending.state) {
            respond(&mut stream, 400, "State mismatch");
            continue;
        }
        if !get("error").is_empty() {
            let why = if get("error") == "access_denied" {
                "Access was denied."
            } else {
                "The authorization failed."
            };
            respond(&mut stream, 200, &result_page("Sign-in failed", why));
            return Err(format!("Signing in with ChatGPT: {why}"));
        }
        let code = get("code").to_string();
        if code.is_empty() {
            respond(&mut stream, 400, "Missing authorization code");
            continue;
        }
        let result = callback_client_id(&params, &pending.client_id)
            .map_err(|e| format!("Signing in with ChatGPT: {e}"))
            .and_then(|client_id| {
                tauri::async_runtime::block_on(finish(pending, &client_id, &code, cancel, session))
            });
        return match result {
            Ok(false) => {
                respond(
                    &mut stream,
                    200,
                    &result_page(
                        "Sign-in incomplete",
                        "GeoLibre wasn't allowed to use your ChatGPT plan. Sign in again and allow it to use the AI Assistant.",
                    ),
                );
                Ok(())
            }
            Ok(true) => {
                respond(
                    &mut stream,
                    200,
                    &result_page(
                        "Signed in",
                        "GeoLibre can now use your ChatGPT plan. You can close this tab.",
                    ),
                );
                Ok(())
            }
            Err(e) => {
                respond(&mut stream, 200, &result_page("Sign-in failed", &e));
                Err(e)
            }
        };
    }
}

/// Puts back the keychain entry a sign-in that isn't kept replaced: the
/// previous sign-in's, or none.
async fn restore_keychain(previous: Option<(Registration, Tokens)>) {
    let _ = tauri::async_runtime::spawn_blocking(move || match previous {
        Some((reg, tokens)) => keychain_save(&reg, &tokens),
        None => keychain_delete(),
    })
    .await;
}

/// Exchanges the code, verifies the id token and keeps the sign-in. True when
/// the plan may be used.
async fn finish(
    pending: &Pending,
    client_id: &str,
    code: &str,
    cancel: &AtomicBool,
    session: &tokio::sync::Mutex<Session>,
) -> Result<bool, String> {
    let grant = exchange(client_id, code, &pending.redirect_uri, &pending.verifier).await?;
    let kept = async {
        let (subject, email) = verify_id_token(&grant.id_token, client_id, &pending.nonce)
            .await
            .map_err(|e| format!("Signing in with ChatGPT: {e}"))?;
        if !pending.subject.is_empty() && client_id == pending.client_id && subject != pending.subject {
            return Err("Signing in with ChatGPT: a different ChatGPT account came back than the one registered. Choose \"Use another account\" to switch.".to_string());
        }
        if grant.refresh_token.is_empty() {
            return Err("Signing in with ChatGPT: OpenAI returned no refresh token.".to_string());
        }
        let scopes = grant.scopes.clone().unwrap_or_default();
        let reg = Registration {
            client_id: client_id.to_string(),
            subject,
            email,
            plan_declined: !scopes.iter().any(|s| s == PLAN_SCOPE),
            scopes,
            signed_in: true,
        };
        let tokens = renewed(&Tokens::default(), &grant, now());
        let mut session = session.lock().await;
        // Checked under the lock: a cancel (or a newer sign-in) wins.
        if cancel.load(Ordering::SeqCst) {
            return Err("The sign-in was cancelled.".to_string());
        }
        let dir = session.dir.clone().ok_or("No config folder")?;
        // What the keychain held before, to put back if this sign-in isn't kept.
        let previous = session
            .reg
            .clone()
            .zip(session.tokens.clone())
            .filter(|_| session.in_keychain);
        let (r, t) = (reg.clone(), tokens.clone());
        let in_keychain = tauri::async_runtime::spawn_blocking(move || keychain_save(&r, &t))
            .await
            .map(|r| r.is_ok())
            .unwrap_or(false);
        if !in_keychain {
            // A keychain entry from an earlier sign-in must not outlive this one.
            let _ = tauri::async_runtime::spawn_blocking(keychain_delete).await;
        }
        // A cancel that arrived while the keychain was written still wins:
        // put back what the keychain held before, and keep nothing.
        if cancel.load(Ordering::SeqCst) {
            restore_keychain(previous).await;
            return Err("The sign-in was cancelled.".to_string());
        }
        // The grant is revoked when this fails, so the keychain must not keep it.
        if let Err(e) = write_registration(&dir, Some(&reg)) {
            restore_keychain(previous).await;
            return Err(e);
        }
        // No await from here on: the checks above and the install are one step
        // under the session lock.
        let allowed = reg.plan_allowed();
        session.reg = Some(reg);
        session.tokens = Some(tokens);
        session.in_keychain = in_keychain;
        session.generation += 1;
        Ok(allowed)
    }
    .await;
    if kept.is_err() {
        // Tokens issued for an attempt that is not kept are revoked.
        revoke(client_id, &grant.refresh_token).await;
    }
    kept
}

// ---------------------------------------------------------------------------
// Commands

/// Who is signed in, and whether a sign-in is under way.
#[tauri::command]
pub async fn chatgpt_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, ChatGptAuthState>,
) -> Result<ChatGptStatus, String> {
    let mut session = state.session.lock().await;
    ensure_loaded(&mut session, &app).await?;
    Ok(session.status(state.signing_in()))
}

/// Starts a sign-in: binds the callback listener and gives the page to open.
/// `another_account` forgets the saved registration first, so the browser
/// registers GeoLibre for whichever account signs in.
#[tauri::command]
pub async fn chatgpt_sign_in_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, ChatGptAuthState>,
    another_account: Option<bool>,
) -> Result<ChatGptSignInStart, String> {
    let _starting = state.starting.lock().await;
    state.cancel_login();
    let generation = state.login_generation.load(Ordering::SeqCst);
    let (dir, saved, old_to_revoke, cleanup_err) = {
        let mut session = state.session.lock().await;
        ensure_loaded(&mut session, &app).await?;
        let dir = session.dir.clone().ok_or("No config folder")?;
        let mut revoke_info: Option<(String, Tokens)> = None;
        let mut cleanup_err: Option<String> = None;
        if another_account.unwrap_or(false) && session.reg.is_some() {
            let (old, _) = session.clear_signed_in_state();
            let client_id = session.reg.take().map(|r| r.client_id).unwrap_or_default();
            if let Some(old) = old {
                revoke_info = Some((client_id, old));
            }
            let reg_dir = dir.clone();
            let write_result = tauri::async_runtime::spawn_blocking(move || {
                let _ = keychain_delete();
                write_registration(&reg_dir, None)?;
                Ok::<(), String>(())
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|res| res);
            if let Err(err) = write_result {
                cleanup_err = Some(err);
            }
        }
        (dir, session.reg.clone(), revoke_info, cleanup_err)
    };
    if let Some((client_id, old)) = old_to_revoke {
        tauri::async_runtime::spawn(async move {
            revoke(&client_id, &old.refresh_token).await;
        });
    }
    if let Some(err) = cleanup_err {
        return Err(err);
    }
    let host = host_id(&dir)?;
    let (listener, port) = TcpListener::bind(("127.0.0.1", PORT))
        .or_else(|_| TcpListener::bind(("127.0.0.1", 0)))
        .and_then(|l| l.local_addr().map(|a| (l, a.port())))
        .map_err(|e| format!("Can't start the sign-in listener: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let pending = Pending {
        redirect_uri: format!("http://127.0.0.1:{port}/auth/callback"),
        verifier: random_token()?,
        state: random_token()?,
        nonce: random_token()?,
        client_id: saved
            .as_ref()
            .map_or_else(|| REGISTER.to_string(), |r| r.client_id.clone()),
        subject: saved
            .as_ref()
            .map(|r| r.subject.clone())
            .unwrap_or_default(),
    };
    let url = authorize_url(&Authorization {
        client_id: &pending.client_id,
        host_id: &host,
        redirect_uri: &pending.redirect_uri,
        challenge: &pkce_challenge(&pending.verifier),
        state: &pending.state,
        nonce: &pending.nonce,
        login_hint: saved.as_ref().map_or("", |r| r.email.as_str()),
        consent: saved.as_ref().is_some_and(|r| r.plan_declined),
    });
    let cancel = Arc::new(AtomicBool::new(false));
    let outcome: Arc<Mutex<Option<Result<(), String>>>> = Arc::default();
    let (stop, out, session) = (cancel.clone(), outcome.clone(), state.session.clone());
    std::thread::spawn(move || {
        let result = serve(&listener, &stop, &pending, &session);
        *out.lock().unwrap_or_else(|p| p.into_inner()) = Some(result);
    });
    {
        let mut login = state.login.lock().unwrap_or_else(|p| p.into_inner());
        // A cancel or sign-out while this start was under way stops it here.
        if state.login_generation.load(Ordering::SeqCst) != generation {
            cancel.store(true, Ordering::SeqCst);
            return Err("The sign-in was cancelled.".into());
        }
        *login = Some(LoginAttempt { cancel, outcome });
    }
    Ok(ChatGptSignInStart { url })
}

/// The sign-in's progress.
#[tauri::command]
pub fn chatgpt_sign_in_poll(state: tauri::State<'_, ChatGptAuthState>) -> ChatGptSignInPoll {
    let login = state.login.lock().unwrap_or_else(|p| p.into_inner());
    let Some(attempt) = login.as_ref() else {
        return ChatGptSignInPoll {
            state: "idle",
            error: None,
        };
    };
    let outcome = attempt.outcome.lock().unwrap_or_else(|p| p.into_inner());
    match outcome.as_ref() {
        None => ChatGptSignInPoll {
            state: "pending",
            error: None,
        },
        Some(Ok(())) => ChatGptSignInPoll {
            state: "done",
            error: None,
        },
        Some(Err(e)) => ChatGptSignInPoll {
            state: "failed",
            error: Some(e.clone()),
        },
    }
}

/// Stops a sign-in under way; a grant that arrives afterwards is revoked.
#[tauri::command]
pub fn chatgpt_sign_in_cancel(state: tauri::State<'_, ChatGptAuthState>) {
    state.cancel_login();
}

/// Signs out: forgets the tokens here and in the keychain, then revokes the
/// refresh token. `forget` also drops the registration, so the next sign-in
/// registers GeoLibre again (for another account, say).
#[tauri::command]
pub async fn chatgpt_sign_out(
    app: tauri::AppHandle,
    state: tauri::State<'_, ChatGptAuthState>,
    forget: Option<bool>,
) -> Result<ChatGptSignOut, String> {
    state.cancel_login();
    let forget = forget.unwrap_or(false);
    let (client_id, tokens, cleanup_err) = {
        let mut session = state.session.lock().await;
        ensure_loaded(&mut session, &app).await?;
        let client_id = session
            .reg
            .as_ref()
            .map(|r| r.client_id.clone())
            .unwrap_or_default();
        let (tokens, mut reg_write) = session.clear_signed_in_state();
        if forget {
            session.reg = None;
            reg_write = session.dir.clone().map(|dir| (dir, None));
        }
        let write_result = tauri::async_runtime::spawn_blocking(move || {
            let _ = keychain_delete();
            if let Some((dir, reg)) = reg_write {
                if forget {
                    write_registration(&dir, None)?;
                } else {
                    let _ = write_registration(&dir, reg.as_ref());
                }
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|res| res);
        (client_id, tokens, write_result.err())
    };
    let revoked = match tokens {
        Some(tokens) => revoke(&client_id, &tokens.refresh_token).await,
        None => true,
    };
    if let Some(err) = cleanup_err {
        return Err(err);
    }
    Ok(ChatGptSignOut { revoked })
}

/// Sends one request of the signed-in account to the Responses API (`path`
/// `responses`, POST) or its model list (`models`, GET) and streams the reply
/// back: a [`ChatGptEvent::Head`], [`ChatGptEvent::Chunk`]s, then [`ChatGptEvent::End`]. Resolves
/// once the reply has ended. The access token is put on here and never leaves
/// this process; an expired one is renewed (once) and the request retried.
#[tauri::command]
pub async fn chatgpt_request(
    app: tauri::AppHandle,
    state: tauri::State<'_, ChatGptAuthState>,
    request_id: String,
    path: String,
    body: Option<String>,
    events: tauri::ipc::Channel<ChatGptEvent>,
) -> Result<(), String> {
    let (route, method) = api_route(&path).ok_or("This request isn't allowed.")?;
    if method == reqwest::Method::POST && body.is_none() {
        return Err("The request has no body.".into());
    }
    let cancel = Arc::new(Cancel::default());
    if state
        .requests
        .try_insert_unique(request_id.clone(), cancel.clone())
        .is_err()
    {
        return Err("Duplicate request id.".into());
    }
    struct Done<'a>(&'a ChatGptAuthState, String);
    impl Drop for Done<'_> {
        fn drop(&mut self) {
            let _ = self.0.requests.remove(&self.1);
        }
    }
    let _done = Done(&state, request_id);

    let url = format!("{API}/{route}");
    const CANCELLED: &str = "The request was cancelled.";
    let mut response = None;
    let mut generation = None;
    for attempt in 0..2 {
        let token = {
            let mut session = state.session.lock().await;
            ensure_loaded(&mut session, &app).await?;
            // The retry stays with the account the request began with.
            if generation.is_some_and(|g| g != session.generation) {
                return Err("The ChatGPT sign-in changed; send the request again.".into());
            }
            generation = Some(session.generation);
            fresh_access_token(&mut session, attempt > 0).await?
        };
        if cancel.is_cancelled() {
            return Err(CANCELLED.into());
        }
        let mut builder = client()?
            .request(method.clone(), &url)
            .bearer_auth(&token)
            .header(
                reqwest::header::ACCEPT,
                if route == "responses" {
                    "text/event-stream"
                } else {
                    "application/json"
                },
            );
        if let Some(body) = &body {
            builder = builder
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body.clone());
        }
        let reply = cancel
            .or_cancelled(builder.send())
            .await
            .ok_or(CANCELLED)?
            .map_err(|e| format!("Can't reach OpenAI: {}", e.without_url()))?;
        if reply.status().as_u16() == 401 && attempt == 0 {
            continue;
        }
        response = Some(reply);
        break;
    }
    let Some(mut response) = response else {
        return Err("OpenAI refused the ChatGPT sign-in; sign in again.".into());
    };
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    events
        .send(ChatGptEvent::Head {
            status: response.status().as_u16(),
            content_type,
        })
        .map_err(|e| e.to_string())?;
    while let Some(chunk) = cancel
        .or_cancelled(response.chunk())
        .await
        .ok_or(CANCELLED)?
        .map_err(|e| format!("The reply was interrupted: {}", e.without_url()))?
    {
        events
            .send(ChatGptEvent::Chunk {
                data: STANDARD.encode(&chunk),
            })
            .map_err(|e| e.to_string())?;
    }
    events.send(ChatGptEvent::End).map_err(|e| e.to_string())
}

/// Stops a [`chatgpt_request`] in progress.
#[tauri::command]
pub fn chatgpt_request_cancel(state: tauri::State<'_, ChatGptAuthState>, request_id: String) {
    if let Some(cancel) = state.requests.get_cloned(&request_id) {
        cancel.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_cancel_interrupts_a_pending_wait() {
        let cancel = Arc::new(Cancel::default());
        assert_eq!(
            tauri::async_runtime::block_on(cancel.or_cancelled(async { 7 })),
            Some(7)
        );
        // A wait that would never end returns once cancelled from elsewhere.
        let other = cancel.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            other.cancel();
        });
        let pending = std::future::pending::<()>();
        assert_eq!(
            tauri::async_runtime::block_on(cancel.or_cancelled(pending)),
            None
        );
        canceller.join().unwrap();
        // Already cancelled: the work is not even started.
        assert_eq!(
            tauri::async_runtime::block_on(cancel.or_cancelled(async { 7 })),
            None
        );
    }

    #[test]
    fn pkce_matches_the_rfc_7636_example() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn host_ids_are_v4_uuids() {
        let id = host_id_from([0xff; 16]);
        assert!(valid_host_id(&id), "{id}");
        assert_eq!(&id[9..], "ffffffff-ffff-4fff-bfff-ffffffffffff");
        assert!(!valid_host_id("urn:uuid:nope"));
        assert!(!valid_host_id("ffffffff-ffff-4fff-bfff-ffffffffffff"));
    }

    fn params(url: &str) -> Vec<(String, String)> {
        Url::parse(url)
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect()
    }

    fn get<'a>(p: &'a [(String, String)], k: &str) -> Option<&'a str> {
        p.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }

    #[test]
    fn a_first_sign_in_registers_geolibre() {
        let url = authorize_url(&Authorization {
            client_id: REGISTER,
            host_id: "urn:uuid:x",
            redirect_uri: "http://localhost:1455/auth/callback",
            challenge: "c",
            state: "s",
            nonce: "n",
            login_hint: "someone@example.com",
            consent: false,
        });
        assert!(url.starts_with(AUTHORIZE_URL));
        let p = params(&url);
        assert_eq!(get(&p, "client_id"), Some(REGISTER));
        assert_eq!(get(&p, "agent_name_hint"), Some("GeoLibre"));
        assert_eq!(get(&p, "scope"), Some(SCOPES));
        assert_eq!(get(&p, "resource"), Some(API));
        assert_eq!(get(&p, "code_challenge_method"), Some("S256"));
        assert_eq!(get(&p, "ext_agent_host_id"), Some("urn:uuid:x"));
        // A registration has no account to hint yet.
        assert_eq!(get(&p, "login_hint"), None);
        assert_eq!(get(&p, "prompt"), None);
    }

    #[test]
    fn a_later_sign_in_reuses_the_registration() {
        let url = authorize_url(&Authorization {
            client_id: "oaiapp_1",
            host_id: "h",
            redirect_uri: "http://localhost:1455/auth/callback",
            challenge: "c",
            state: "s",
            nonce: "n",
            login_hint: "someone@example.com",
            consent: true,
        });
        let p = params(&url);
        assert_eq!(get(&p, "client_id"), Some("oaiapp_1"));
        assert_eq!(get(&p, "agent_name_hint"), None);
        assert_eq!(get(&p, "login_hint"), Some("someone@example.com"));
        assert_eq!(get(&p, "prompt"), Some("consent"));
    }

    fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn callback_client_ids() {
        assert_eq!(
            callback_client_id(&pairs(&[("client_id", "oaiapp_1")]), REGISTER),
            Ok("oaiapp_1".into())
        );
        assert!(callback_client_id(&pairs(&[]), REGISTER).is_err());
        assert!(callback_client_id(&pairs(&[("client_id", REGISTER)]), REGISTER).is_err());
        assert_eq!(
            callback_client_id(&pairs(&[]), "oaiapp_1"),
            Ok("oaiapp_1".into())
        );
        assert!(callback_client_id(&pairs(&[("client_id", "oaiapp_2")]), "oaiapp_1").is_err());
        assert!(callback_client_id(
            &pairs(&[("client_id", "oaiapp_1"), ("client_id", "oaiapp_1")]),
            "oaiapp_1"
        )
        .is_err());
    }

    #[test]
    fn the_callback_state_must_match_exactly_once() {
        assert!(callback_state_matches(&pairs(&[("state", "a")]), "a"));
        assert!(!callback_state_matches(&pairs(&[("state", "b")]), "a"));
        assert!(!callback_state_matches(
            &pairs(&[("state", "a"), ("state", "a")]),
            "a"
        ));
        assert!(!callback_state_matches(&pairs(&[]), "a"));
        assert!(!callback_state_matches(&pairs(&[("state", "")]), ""));
    }

    #[test]
    fn grants_and_their_refusals() {
        let ok = parse_grant(
            200,
            br#"{"access_token":"a","refresh_token":"r","id_token":"i","expires_in":60,"scope":"openid chatgpt.tokens.use.direct"}"#,
        )
        .unwrap();
        assert_eq!(ok.access_token, "a");
        assert_eq!(ok.scopes.as_deref().map(|s| s.len()), Some(2));
        assert_eq!(
            parse_grant(
                400,
                br#"{"error":"invalid_grant","error_description":"secret r"}"#
            ),
            Err(GrantError::Unusable)
        );
        // Descriptions (which may echo credentials) are never reported.
        let other = parse_grant(400, br#"{"error":"weird","error_description":"secret r"}"#);
        assert_eq!(other, Err(GrantError::Other("HTTP 400".into())));
        assert!(parse_grant(200, br#"{"refresh_token":"r"}"#).is_err());
    }

    #[test]
    fn renewal_rotates_the_refresh_token_and_keeps_the_old_one_otherwise() {
        let old = Tokens {
            access_token: "a0".into(),
            refresh_token: "r0".into(),
            id_token: "i0".into(),
            expires_at: 1,
        };
        let g = Grant {
            access_token: "a1".into(),
            expires_in: 100,
            ..Grant::default()
        };
        let t = renewed(&old, &g, 1000);
        assert_eq!(
            (t.access_token.as_str(), t.refresh_token.as_str()),
            ("a1", "r0")
        );
        assert_eq!(t.expires_at, 1100);
        let g = Grant {
            refresh_token: "r1".into(),
            ..g
        };
        assert_eq!(renewed(&old, &g, 0).refresh_token, "r1");
    }

    #[test]
    fn access_tokens_renew_before_they_expire() {
        let t = Tokens {
            access_token: "a".into(),
            expires_at: 10_000,
            ..Tokens::default()
        };
        assert!(!t.expires_soon(10_000 - REFRESH_MARGIN - 1));
        assert!(t.expires_soon(10_000 - REFRESH_MARGIN));
        assert!(Tokens::default().expires_soon(0));
    }

    #[test]
    fn id_token_claims_are_checked() {
        let claims = json!({"iss": ISSUER, "aud": ["oaiapp_1"], "exp": 2000, "nonce": "n", "sub": "user-1", "email": "a@b.c"});
        assert_eq!(
            check_id_claims(&claims, "oaiapp_1", "n", 1000),
            Ok(("user-1".into(), "a@b.c".into()))
        );
        assert!(check_id_claims(&claims, "oaiapp_2", "n", 1000).is_err());
        assert!(check_id_claims(&claims, "oaiapp_1", "other", 1000).is_err());
        assert!(check_id_claims(&claims, "oaiapp_1", "n", 2000 + CLOCK_SKEW + 1).is_err());
        let mut forged = claims.clone();
        forged["iss"] = json!("https://evil.example");
        assert!(check_id_claims(&forged, "oaiapp_1", "n", 1000).is_err());
    }

    #[test]
    fn unsigned_or_unknown_key_id_tokens_are_refused() {
        let b64 = |v: Value| URL_SAFE_NO_PAD.encode(v.to_string());
        let payload = b64(json!({"sub": "x"}));
        let none = format!("{}.{payload}.c2ln", b64(json!({"alg": "none"})));
        assert!(verify_jwt(&none, &json!({"keys": []})).is_err());
        let rs = format!(
            "{}.{payload}.c2ln",
            b64(json!({"alg": "RS256", "kid": "k"}))
        );
        assert!(verify_jwt(
            &rs,
            &json!({"keys": [{"kty": "RSA", "kid": "other", "n": "AQ", "e": "AQAB"}]})
        )
        .is_err());
        assert!(verify_jwt("a.b", &json!({})).is_err());
    }

    #[test]
    fn only_the_sign_in_service_is_trusted_for_endpoints() {
        let config = json!({"jwks_uri": "https://auth.openai.com/.well-known/jwks.json", "revocation_endpoint": "https://auth.openai.com.evil.example/revoke"});
        assert!(discovered(&config, "jwks_uri").is_some());
        assert!(discovered(&config, "revocation_endpoint").is_none());
    }

    #[test]
    fn only_the_responses_api_and_model_list_are_reachable() {
        assert!(api_route("responses").is_some());
        assert!(api_route("models").is_some());
        assert!(api_route("files").is_none());
        assert!(api_route("../responses").is_none());
    }

    #[test]
    fn the_registration_file_never_holds_a_token() {
        let reg = Registration {
            client_id: "oaiapp_1".into(),
            subject: "s".into(),
            email: "e".into(),
            scopes: vec![PLAN_SCOPE.into()],
            plan_declined: false,
            signed_in: true,
        };
        let text = serde_json::to_string(&reg).unwrap();
        assert!(!text.contains("token\""), "{text}");
        assert!(reg.plan_allowed());
        let dir =
            std::env::temp_dir().join(format!("geolibre-chatgpt-{}", random_token().unwrap()));
        write_registration(&dir, Some(&reg)).unwrap();
        assert_eq!(read_registration(&dir), Some(reg));
        write_registration(&dir, None).unwrap();
        assert_eq!(read_registration(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_callback_target_is_read_from_a_get_request() {
        let cancel = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut ok: &[u8] =
            b"GET /auth/callback?code=x&state=y HTTP/1.1\r\nHost: localhost\r\n\r\n";
        assert_eq!(
            request_target(&mut ok, &cancel, deadline).as_deref(),
            Some("/auth/callback?code=x&state=y")
        );
        let mut post: &[u8] = b"POST /auth/callback HTTP/1.1\r\n\r\n";
        assert_eq!(request_target(&mut post, &cancel, deadline), None);
        let mut cut: &[u8] = b"GET /auth/callback HTTP/1.1\r\n";
        assert_eq!(request_target(&mut cut, &cancel, deadline), None);
    }
}
