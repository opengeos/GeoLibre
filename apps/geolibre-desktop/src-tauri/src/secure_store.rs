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

const READS_SEALED: &str =
    "Saved credentials can only be read once, while GeoLibre starts up.";

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
    let mut guard = READ_GATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    f(guard.get_or_insert_with(ReadGate::default))
}

/// Reopens the startup read for the webview `label`. Called from the page-load
/// hook when a navigation starts, so a reload can hydrate credentials again.
pub fn reset_read_gate(label: &str) {
    with_read_gate(|gate| gate.reset(label));
}

fn entry(account: &str) -> Result<keyring::Entry, String> {
    validate_account(account)?;
    keyring::Entry::new(SERVICE, account).map_err(|error| error.to_string())
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    // A panic while holding the lock leaves no partial state to protect.
    STORE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn get_many_blocking(accounts: Vec<String>) -> Result<HashMap<String, String>, String> {
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

fn set_blocking(account: String, secret: String) -> Result<(), String> {
    let _guard = lock();
    entry(&account)?
        .set_password(&secret)
        .map_err(|error| error.to_string())
}

fn delete_blocking(account: String) -> Result<(), String> {
    let _guard = lock();
    match entry(&account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Returns the secrets for the accounts that exist; absent accounts are omitted.
/// Any other store error fails the whole call.
///
/// Answers once per page load of the calling webview, and not at all after
/// [`secure_store_seal`]; the read is used up even when it fails.
#[tauri::command]
pub async fn secure_store_get_many(
    webview: tauri::Webview,
    accounts: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    with_read_gate(|gate| gate.claim(webview.label()))?;
    tauri::async_runtime::spawn_blocking(move || get_many_blocking(accounts))
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
pub async fn secure_store_set(account: String, secret: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_blocking(account, secret))
        .await
        .map_err(|error| format!("Could not join secure storage task: {error}"))?
}

/// Deleting an account that does not exist succeeds.
#[tauri::command]
pub async fn secure_store_delete(account: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_blocking(account))
        .await
        .map_err(|error| format!("Could not join secure storage task: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::{validate_account, ReadGate, READS_SEALED};

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
}
