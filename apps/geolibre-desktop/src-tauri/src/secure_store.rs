//! Tauri commands backed by the OS credential store (issue #1667).
//!
//! Every credential is its own entry under one service, keyed by an account
//! name the frontend chooses (`settings.shareToken`, `ai.<profile>.<key>`,
//! `postgres.connection.<uuid>`). Account names are stored in users' keychains,
//! so renaming one orphans existing credentials.
//!
//! Reads are a one-shot startup capability (issue #2858). External plugins run
//! in the same webview as the app and can call any command it can, so an
//! unrestricted read would hand every saved token to any installed plugin. The
//! frontend reads every account it needs in a single call during startup
//! hydration, before any external plugin is imported, so the first read (or an
//! explicit [`secure_store_seal`]) closes reads for that webview until its next
//! page load. Writes and deletes stay open: the app saves credentials whenever
//! Settings change, and a write cannot disclose a stored secret.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

/// Keychain service name; matches the bundle identifier.
const SERVICE: &str = "org.geolibre.desktop";
const MAX_ACCOUNT_BYTES: usize = 512;

/// Serializes every store call. keyring documents that the Windows credential
/// store does not order concurrent access to the same entry.
static STORE_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn validate_account(account: &str) -> Result<(), String> {
    // macOS treats an empty account as a wildcard that matches any entry.
    if account.is_empty() {
        return Err("Credential name must not be empty.".to_string());
    }
    if account.len() > MAX_ACCOUNT_BYTES {
        return Err("Credential name is too long.".to_string());
    }
    if account.chars().any(char::is_control) {
        return Err("Credential name must not contain control characters.".to_string());
    }
    Ok(())
}

const READS_SEALED: &str = "Saved credentials can only be read once, while GeoLibre starts up.";

/// Which webviews have used their one credential read since their last page
/// load, by webview label.
#[derive(Debug, Default)]
pub(crate) struct ReadGate {
    sealed: HashSet<String>,
}

impl ReadGate {
    /// Takes the read for `label`: succeeds once, then fails until [`Self::reset`].
    pub(crate) fn claim(&mut self, label: &str) -> Result<(), String> {
        if self.sealed.insert(label.to_string()) {
            Ok(())
        } else {
            Err(READS_SEALED.to_string())
        }
    }

    /// Closes reads for `label` without reading. Idempotent.
    pub(crate) fn seal(&mut self, label: &str) {
        self.sealed.insert(label.to_string());
    }

    /// Reopens the read for `label`; called when its webview starts a page load.
    pub(crate) fn reset(&mut self, label: &str) {
        self.sealed.remove(label);
    }

    #[cfg(test)]
    fn is_sealed(&self, label: &str) -> bool {
        self.sealed.contains(label)
    }
}

static READ_GATE: Mutex<Option<ReadGate>> = Mutex::new(None);

fn with_read_gate<T>(f: impl FnOnce(&mut ReadGate) -> T) -> T {
    // A panic while holding the lock leaves the set consistent: every update
    // is a single insert or remove.
    let mut guard = READ_GATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(guard.get_or_insert_with(ReadGate::default))
}

/// Reopens the startup read for the webview `label`. Called from the page-load
/// hook when a navigation starts, so a reload can hydrate credentials again.
pub fn reset_read_gate(label: &str) {
    with_read_gate(|gate| gate.reset(label));
}

#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux"
))]
fn entry(account: &str) -> Result<keyring::Entry, String> {
    validate_account(account)?;
    keyring::Entry::new(SERVICE, account).map_err(|error| error.to_string())
}

/// Authenticated app-private credential vault using AES-256-GCM (`ring::aead`)
/// for Android (where `keyring` has no native backend).
///
/// Each write generates a fresh 96-bit random nonce and stores the vault and
/// key atomically with owner-only (`0600`) permissions inside Android's
/// app-private data directory. Because the key file sits alongside the
/// ciphertext inside app-private storage, AES-256-GCM provides integrity /
/// tamper detection and avoids plaintext secrets on disk; full hardware-backed
/// confidentiality requires Android Keystore key-wrapping and excluding
/// `secure_vault/` from Android Auto Backup.
#[cfg(any(target_os = "android", test))]
pub(crate) mod encrypted_vault {
    use super::{validate_account, SERVICE};
    use crate::fs_util::{write_file_atomic, AtomicWriteOptions};
    use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
    use ring::rand::{SecureRandom, SystemRandom};
    use std::collections::HashMap;
    use std::fs;
    use std::path::{Path, PathBuf};

    const VAULT_MAGIC: &[u8; 4] = b"GLV1";
    const KEY_LEN: usize = 32;

    fn vault_paths(base_dir: &Path) -> (PathBuf, PathBuf) {
        let dir = base_dir.join("secure_vault");
        (dir.join("vault.key"), dir.join("credentials.enc"))
    }

    fn read_existing_key(key_path: &Path) -> Result<[u8; KEY_LEN], String> {
        let bytes = fs::read(key_path)
            .map_err(|error| format!("Could not read credential vault key: {error}"))?;
        if bytes.len() != KEY_LEN {
            return Err(format!(
                "Credential vault key has invalid length ({} bytes, expected {KEY_LEN}).",
                bytes.len()
            ));
        }
        let mut key = [0u8; KEY_LEN];
        key.copy_from_slice(&bytes);
        Ok(key)
    }

    /// Load an existing vault key or create one ONLY when initializing a brand-new
    /// vault (neither `vault.key` nor `credentials.enc` exists). Never replaces a
    /// key after a read error or length corruption, so existing credentials are
    /// never silently orphaned.
    fn load_or_init_key_for_write(
        key_path: &Path,
        vault_path: &Path,
    ) -> Result<[u8; KEY_LEN], String> {
        match fs::read(key_path) {
            Ok(bytes) => {
                if bytes.len() != KEY_LEN {
                    return Err(format!(
                        "Credential vault key has invalid length ({} bytes, expected {KEY_LEN}).",
                        bytes.len()
                    ));
                }
                let mut key = [0u8; KEY_LEN];
                key.copy_from_slice(&bytes);
                Ok(key)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if vault_path.exists() {
                    return Err(
                        "Credential vault key is missing for an existing vault; refusing to overwrite."
                            .to_string(),
                    );
                }
                let rng = SystemRandom::new();
                let mut key = [0u8; KEY_LEN];
                rng.fill(&mut key)
                    .map_err(|_| "Could not generate credential vault key.".to_string())?;
                write_file_atomic(
                    key_path,
                    &key,
                    AtomicWriteOptions {
                        create_parents: true,
                        owner_only_unix: true,
                        sync: true,
                        preserve_permissions: None,
                    },
                )
                .map_err(|write_err| {
                    format!("Could not persist credential vault key: {write_err}")
                })?;
                Ok(key)
            }
            Err(error) => Err(format!("Could not read credential vault key: {error}")),
        }
    }

    fn read_map(base_dir: &Path) -> Result<HashMap<String, String>, String> {
        let (key_path, vault_path) = vault_paths(base_dir);
        let raw = match fs::read(&vault_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(HashMap::new());
            }
            Err(error) => return Err(format!("Could not read encrypted vault: {error}")),
        };
        if raw.len() < VAULT_MAGIC.len() + NONCE_LEN || &raw[..VAULT_MAGIC.len()] != VAULT_MAGIC {
            return Err("Encrypted credential vault header is invalid.".to_string());
        }
        let key_bytes = read_existing_key(&key_path)?;
        let unbound = UnboundKey::new(&AES_256_GCM, &key_bytes)
            .map_err(|_| "Could not initialize credential vault cipher.".to_string())?;
        let key = LessSafeKey::new(unbound);
        let nonce_start = VAULT_MAGIC.len();
        let nonce_end = nonce_start + NONCE_LEN;
        let nonce = Nonce::try_assume_unique_for_key(&raw[nonce_start..nonce_end])
            .map_err(|_| "Invalid credential vault nonce.".to_string())?;
        let mut in_out = raw[nonce_end..].to_vec();
        let plaintext = key
            .open_in_place(nonce, Aad::from(SERVICE.as_bytes()), &mut in_out)
            .map_err(|_| {
                "Could not decrypt credential vault (integrity check failed).".to_string()
            })?;
        serde_json::from_slice(plaintext)
            .map_err(|error| format!("Could not parse decrypted credential vault: {error}"))
    }

    fn write_map(base_dir: &Path, entries: &HashMap<String, String>) -> Result<(), String> {
        let (key_path, vault_path) = vault_paths(base_dir);
        let key_bytes = load_or_init_key_for_write(&key_path, &vault_path)?;
        let unbound = UnboundKey::new(&AES_256_GCM, &key_bytes)
            .map_err(|_| "Could not initialize credential vault cipher.".to_string())?;
        let key = LessSafeKey::new(unbound);
        let rng = SystemRandom::new();
        let mut nonce_bytes = [0u8; NONCE_LEN];
        rng.fill(&mut nonce_bytes)
            .map_err(|_| "Could not generate credential vault nonce.".to_string())?;
        let nonce = Nonce::assume_unique_for_key(nonce_bytes);
        let mut in_out = serde_json::to_vec(entries)
            .map_err(|error| format!("Could not serialize credential vault: {error}"))?;
        key.seal_in_place_append_tag(nonce, Aad::from(SERVICE.as_bytes()), &mut in_out)
            .map_err(|_| "Could not encrypt credential vault.".to_string())?;
        let mut blob = Vec::with_capacity(VAULT_MAGIC.len() + NONCE_LEN + in_out.len());
        blob.extend_from_slice(VAULT_MAGIC);
        blob.extend_from_slice(&nonce_bytes);
        blob.extend_from_slice(&in_out);
        write_file_atomic(
            &vault_path,
            &blob,
            AtomicWriteOptions {
                create_parents: true,
                owner_only_unix: true,
                sync: true,
                preserve_permissions: None,
            },
        )
        .map_err(|error| format!("Could not write encrypted credential vault: {error}"))
    }

    pub(crate) fn get_many(
        base_dir: &Path,
        accounts: &[String],
    ) -> Result<HashMap<String, String>, String> {
        let map = read_map(base_dir)?;
        let mut found = HashMap::with_capacity(accounts.len());
        for account in accounts {
            validate_account(account)?;
            if let Some(secret) = map.get(account) {
                found.insert(account.clone(), secret.clone());
            }
        }
        Ok(found)
    }

    pub(crate) fn set(base_dir: &Path, account: &str, secret: &str) -> Result<(), String> {
        validate_account(account)?;
        let mut map = read_map(base_dir)?;
        map.insert(account.to_string(), secret.to_string());
        write_map(base_dir, &map)
    }

    pub(crate) fn delete(base_dir: &Path, account: &str) -> Result<(), String> {
        validate_account(account)?;
        let mut map = read_map(base_dir)?;
        if map.remove(account).is_some() {
            write_map(base_dir, &map)?;
        }
        Ok(())
    }
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    // A panic while holding the lock leaves no partial state to protect.
    STORE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux"
))]
fn get_many_blocking(
    _app_data_dir: Option<std::path::PathBuf>,
    accounts: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    let _guard = lock();
    let mut found = HashMap::with_capacity(accounts.len());
    for account in accounts {
        match entry(&account)?.get_password() {
            Ok(secret) => {
                found.insert(account, secret);
            }
            Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(found)
}

#[cfg(target_os = "android")]
fn get_many_blocking(
    app_data_dir: Option<std::path::PathBuf>,
    accounts: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    let dir = app_data_dir.ok_or_else(|| "Could not resolve app data directory.".to_string())?;
    let _guard = lock();
    encrypted_vault::get_many(&dir, &accounts)
}

/// Reads one entry for the app's own Rust code (not the webview): the read gate
/// guards only [`secure_store_get_many`].
#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux"
))]
pub(crate) fn get_blocking(account: &str) -> Result<Option<String>, String> {
    let _guard = lock();
    match entry(account)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Entries only the app's own Rust code may write or delete. The ChatGPT
/// sign-in's refresh token (chatgpt_auth.rs) lives here; external plugins share
/// the webview and could otherwise replace or erase it.
const RESERVED_PREFIX: &str = "chatgpt.";

fn check_webview_account(account: &str) -> Result<(), String> {
    // Windows credential targets are case-insensitive, so `ChatGPT.signIn`
    // names the same entry as `chatgpt.signIn`.
    let reserved = account
        .get(..RESERVED_PREFIX.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(RESERVED_PREFIX));
    if reserved {
        return Err("This credential is managed by GeoLibre.".to_string());
    }
    Ok(())
}

#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux"
))]
pub(crate) fn set_blocking(account: String, secret: String) -> Result<(), String> {
    let _guard = lock();
    entry(&account)?
        .set_password(&secret)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
fn set_blocking_with_dir(
    app_data_dir: Option<std::path::PathBuf>,
    account: String,
    secret: String,
) -> Result<(), String> {
    let dir = app_data_dir.ok_or_else(|| "Could not resolve app data directory.".to_string())?;
    let _guard = lock();
    encrypted_vault::set(&dir, &account, &secret)
}

#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux"
))]
pub(crate) fn delete_blocking(account: String) -> Result<(), String> {
    let _guard = lock();
    match entry(&account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(target_os = "android")]
fn delete_blocking_with_dir(
    app_data_dir: Option<std::path::PathBuf>,
    account: String,
) -> Result<(), String> {
    let dir = app_data_dir.ok_or_else(|| "Could not resolve app data directory.".to_string())?;
    let _guard = lock();
    encrypted_vault::delete(&dir, &account)
}

/// Returns the secrets for the accounts that exist; absent accounts are omitted.
/// Any other store error fails the whole call.
///
/// Answers once per page load of the calling webview, and not at all after
/// [`secure_store_seal`]; the read is used up even when it fails.
#[tauri::command]
pub async fn secure_store_get_many(
    #[allow(unused_variables)] app: tauri::AppHandle,
    webview: tauri::Webview,
    accounts: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    with_read_gate(|gate| gate.claim(webview.label()))?;
    let accounts = accounts
        .into_iter()
        .filter(|account| check_webview_account(account).is_ok())
        .collect();
    #[cfg(target_os = "android")]
    let app_data_dir = {
        use tauri::Manager;
        app.path().app_data_dir().ok()
    };
    #[cfg(not(target_os = "android"))]
    let app_data_dir = None;
    tauri::async_runtime::spawn_blocking(move || get_many_blocking(app_data_dir, accounts))
        .await
        .map_err(|error| format!("Could not join secure storage task: {error}"))?
}

/// Closes credential reads for the calling webview until its next page load.
/// The frontend calls it before importing an external plugin, so reads are
/// closed even when startup hydration never issued its read.
#[tauri::command]
pub fn secure_store_seal(webview: tauri::Webview) {
    with_read_gate(|gate| gate.seal(webview.label()));
}

#[tauri::command]
pub async fn secure_store_set(
    #[allow(unused_variables)] app: tauri::AppHandle,
    account: String,
    secret: String,
) -> Result<(), String> {
    check_webview_account(&account)?;
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let app_data_dir = app.path().app_data_dir().ok();
        return tauri::async_runtime::spawn_blocking(move || {
            set_blocking_with_dir(app_data_dir, account, secret)
        })
        .await
        .map_err(|error| format!("Could not join secure storage task: {error}"))?;
    }
    #[cfg(not(target_os = "android"))]
    tauri::async_runtime::spawn_blocking(move || set_blocking(account, secret))
        .await
        .map_err(|error| format!("Could not join secure storage task: {error}"))?
}

/// Deleting an account that does not exist succeeds.
#[tauri::command]
pub async fn secure_store_delete(
    #[allow(unused_variables)] app: tauri::AppHandle,
    account: String,
) -> Result<(), String> {
    check_webview_account(&account)?;
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let app_data_dir = app.path().app_data_dir().ok();
        return tauri::async_runtime::spawn_blocking(move || {
            delete_blocking_with_dir(app_data_dir, account)
        })
        .await
        .map_err(|error| format!("Could not join secure storage task: {error}"))?;
    }
    #[cfg(not(target_os = "android"))]
    tauri::async_runtime::spawn_blocking(move || delete_blocking(account))
        .await
        .map_err(|error| format!("Could not join secure storage task: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::{check_webview_account, validate_account, ReadGate, READS_SEALED};

    #[test]
    fn webview_cannot_touch_reserved_credentials() {
        assert!(check_webview_account("chatgpt.signIn").is_err());
        assert!(check_webview_account("ChatGPT.signIn").is_err());
        assert!(check_webview_account("CHATGPT.SIGNIN").is_err());
        assert!(check_webview_account("chatgpt").is_ok());
        assert!(check_webview_account("é").is_ok());
        assert!(check_webview_account("ai.profile.OPENAI_API_KEY").is_ok());
    }

    #[test]
    fn read_gate_answers_one_read_per_page_load() {
        let mut gate = ReadGate::default();
        assert_eq!(gate.claim("main"), Ok(()));
        assert_eq!(gate.claim("main"), Err(READS_SEALED.to_string()));
        assert_eq!(gate.claim("main"), Err(READS_SEALED.to_string()));
        gate.reset("main");
        assert_eq!(gate.claim("main"), Ok(()));
        assert_eq!(gate.claim("main"), Err(READS_SEALED.to_string()));
    }

    #[test]
    fn read_gate_seal_closes_reads_without_reading() {
        let mut gate = ReadGate::default();
        gate.seal("main");
        gate.seal("main");
        assert!(gate.is_sealed("main"));
        assert_eq!(gate.claim("main"), Err(READS_SEALED.to_string()));
        gate.reset("main");
        assert!(!gate.is_sealed("main"));
        assert_eq!(gate.claim("main"), Ok(()));
    }

    #[test]
    fn read_gate_tracks_webviews_separately() {
        let mut gate = ReadGate::default();
        assert_eq!(gate.claim("main"), Ok(()));
        assert_eq!(gate.claim("other"), Ok(()));
        gate.reset("other");
        assert_eq!(gate.claim("main"), Err(READS_SEALED.to_string()));
        assert_eq!(gate.claim("other"), Ok(()));
    }

    #[test]
    fn secure_store_accepts_app_account_names() {
        for account in [
            "settings.shareToken",
            "ai.3f1c2a9e-8f0b-4c55-9d1e-2b7a4c6d8e90.GEMINI_API_KEY",
            "postgres.connection.9",
        ] {
            assert_eq!(validate_account(account), Ok(()), "{account}");
        }
    }

    #[test]
    fn secure_store_rejects_empty_account() {
        assert_eq!(
            validate_account(""),
            Err("Credential name must not be empty.".to_string())
        );
    }

    #[test]
    fn secure_store_rejects_long_account() {
        assert_eq!(validate_account(&"a".repeat(512)), Ok(()));
        assert_eq!(
            validate_account(&"a".repeat(513)),
            Err("Credential name is too long.".to_string())
        );
    }

    #[test]
    fn secure_store_rejects_control_characters() {
        assert_eq!(
            validate_account("settings.share\nToken"),
            Err("Credential name must not contain control characters.".to_string())
        );
    }

    #[test]
    fn encrypted_vault_round_trips_and_detects_tampering() {
        let dir = std::env::temp_dir().join(format!(
            "geolibre-vault-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        super::encrypted_vault::set(&dir, "settings.shareToken", "secret-123").unwrap();
        super::encrypted_vault::set(&dir, "ai.default.KEY", "api-xyz").unwrap();
        let found = super::encrypted_vault::get_many(
            &dir,
            &[
                "settings.shareToken".to_string(),
                "ai.default.KEY".to_string(),
                "missing.key".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(
            found.get("settings.shareToken").map(String::as_str),
            Some("secret-123")
        );
        assert_eq!(
            found.get("ai.default.KEY").map(String::as_str),
            Some("api-xyz")
        );
        assert!(!found.contains_key("missing.key"));

        super::encrypted_vault::delete(&dir, "settings.shareToken").unwrap();
        let after_delete =
            super::encrypted_vault::get_many(&dir, &["settings.shareToken".to_string()]).unwrap();
        assert!(after_delete.is_empty());

        // Corrupting the key file must fail without overwriting the key.
        let key_path = dir.join("secure_vault").join("vault.key");
        let original_key = std::fs::read(&key_path).unwrap();
        std::fs::write(&key_path, b"short").unwrap();
        assert!(super::encrypted_vault::get_many(&dir, &["ai.default.KEY".to_string()]).is_err());
        assert_eq!(std::fs::read(&key_path).unwrap(), b"short");

        // Removing the key file when ciphertext exists must fail without creating a new key.
        std::fs::remove_file(&key_path).unwrap();
        assert!(super::encrypted_vault::set(&dir, "another.key", "v").is_err());
        assert!(!key_path.exists());
        std::fs::write(&key_path, &original_key).unwrap();

        // Tampering with ciphertext must fail GCM authentication.
        let enc_path = dir.join("secure_vault").join("credentials.enc");
        let mut bytes = std::fs::read(&enc_path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xFF;
        std::fs::write(&enc_path, &bytes).unwrap();
        assert!(super::encrypted_vault::get_many(&dir, &["ai.default.KEY".to_string()]).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
