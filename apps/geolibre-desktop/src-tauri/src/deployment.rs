//! Administrator-managed configuration: the machine-wide and per-user
//! `deployment.json` policy, the legacy admin UI profile, and the policy-gated
//! `read_allowed_file` command for external plugins.

use crate::is_safe_absolute_path;
use crate::plugins_io::MAX_PLUGIN_ENTRY_BYTES;
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::Path;
use tauri::Manager;

/// Read optional configuration without parsing or normalizing its UTF-8 text.
/// Only a missing file is treated as absent; all other read errors propagate.
fn read_optional_config_file(path: &Path) -> Result<Option<String>, std::io::Error> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn read_admin_profile_file(path: &Path) -> Result<Option<String>, String> {
    read_optional_config_file(path)
        .map_err(|error| format!("Could not read admin profile: {error}"))
}

/// Read the optional legacy admin UI-profile file
/// (`<app_config_dir>/admin-profile.json`), still honoured when the primary
/// `deployment.json` policy has no non-empty `interface` section.
///
/// Returns `Ok(None)` when the file is absent so a missing file is not an error.
/// See `docs/ui-profiles.md`.
#[tauri::command]
pub(crate) fn read_admin_profile(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Could not resolve config directory: {error}"))?;
    let path = config_dir.join("admin-profile.json");
    read_admin_profile_file(&path)
}

/// Returns the platform-specific machine-wide deployment policy path, if any.
/// Windows: `%ProgramData%\GeoLibre\deployment.json`
/// Linux: `/etc/geolibre/deployment.json`
/// macOS: `/Library/Application Support/GeoLibre/deployment.json`
fn machine_deployment_policy_path() -> Option<std::path::PathBuf> {
    #[cfg(test)]
    {
        if let Ok(path) = std::env::var("GEOLIBRE_TEST_MACHINE_DEPLOYMENT_PATH") {
            return Some(std::path::PathBuf::from(path));
        }
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("ProgramData")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from(r"C:\ProgramData"));
        Some(base.join("GeoLibre").join("deployment.json"))
    }
    #[cfg(target_os = "macos")]
    {
        Some(std::path::PathBuf::from(
            "/Library/Application Support/GeoLibre/deployment.json",
        ))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Some(std::path::PathBuf::from("/etc/geolibre/deployment.json"))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    {
        None
    }
}

/// Whether the active deployment policy originates from a machine-wide deployment.json file.
#[tauri::command]
pub(crate) fn is_machine_deployment_policy() -> bool {
    machine_deployment_policy_path()
        .and_then(|p| fs::metadata(p).ok())
        .is_some_and(|m| m.is_file())
}

/// Read the optional deployment policy. Honours machine-wide deployment.json
/// with documented precedence over per-user `<app_config_dir>/deployment.json`.
/// Returns raw UTF-8 text, or `None` only when both files are absent.
#[tauri::command]
pub(crate) fn read_deployment_policy(app: tauri::AppHandle) -> Result<Option<String>, String> {
    if let Some(machine_path) = machine_deployment_policy_path() {
        if let Some(policy) = read_optional_config_file(&machine_path)
            .map_err(|error| format!("Could not read machine deployment policy: {error}"))?
        {
            return Ok(Some(policy));
        }
    }

    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Could not resolve config directory: {error}"))?;
    read_optional_config_file(&config_dir.join("deployment.json"))
        .map_err(|error| format!("Could not read deployment policy: {error}"))
}

/// Read an allowed file for an external plugin, gated by the machine-wide
/// deployment policy (`plugins.fileAccess`).
///
/// Returns the file text as UTF-8, capped at 50 MB.
/// Bypasses the webview fs scope. Both the requested path and the policy allowlist
/// entries are canonicalised before comparison to prevent path traversal and symlink
/// escapes.
#[tauri::command]
pub(crate) fn read_allowed_file(plugin_id: String, path: String) -> Result<String, String> {
    read_allowed_file_impl(
        &plugin_id,
        &path,
        machine_deployment_policy_path().as_deref(),
    )
}

/// The `plugins.fileAccess` entries for `plugin_id`, validated with the UI
/// parser's rules. The UI drops the whole `plugins` section when `fileAccess`
/// is malformed (a non-object, a blank or duplicate key after trimming, or a
/// non-string, blank or duplicate entry), so the native gate denies every read
/// in that case rather than granting from a section the app ignores.
fn machine_file_access_allowlist(
    policy: &serde_json::Value,
    plugin_id: &str,
) -> Result<Vec<String>, String> {
    let malformed = || {
        "Machine deployment policy has an invalid plugins.fileAccess section; plugin fileAccess is denied"
            .to_string()
    };
    let Some(file_access) = policy.get("plugins").and_then(|p| p.get("fileAccess")) else {
        return Err(format!(
            "Plugin '{plugin_id}' has no fileAccess allowlist configured in machine deployment policy"
        ));
    };
    let file_access = file_access.as_object().ok_or_else(malformed)?;
    let mut keys = HashSet::new();
    let mut found = None;
    for (raw_key, raw_list) in file_access {
        // JS `trim()` also strips a BOM, which Rust's `trim()` does not.
        let key = raw_key.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
        if key.is_empty() || !keys.insert(key) {
            return Err(malformed());
        }
        let list = raw_list.as_array().ok_or_else(malformed)?;
        let mut entries = Vec::with_capacity(list.len());
        let mut seen = HashSet::new();
        for raw_entry in list {
            let entry = raw_entry
                .as_str()
                .map(|e| e.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}'))
                .filter(|e| !e.is_empty())
                .ok_or_else(malformed)?;
            if !seen.insert(entry) {
                return Err(malformed());
            }
            entries.push(entry.to_string());
        }
        if key == plugin_id {
            found = Some(entries);
        }
    }
    found.ok_or_else(|| {
        format!("Plugin '{plugin_id}' has no fileAccess allowlist configured in machine deployment policy")
    })
}

fn read_allowed_file_impl(
    plugin_id: &str,
    path: &str,
    policy_path: Option<&std::path::Path>,
) -> Result<String, String> {
    let trimmed_id = plugin_id.trim();
    if trimmed_id.is_empty() {
        return Err("Plugin ID must be a non-blank string".to_string());
    }

    let Some(policy_path) = policy_path else {
        return Err(
            "No machine deployment policy configured; plugin fileAccess is denied".to_string(),
        );
    };
    let Some(policy_contents) = read_optional_config_file(policy_path)
        .map_err(|error| format!("Could not read machine deployment policy: {error}"))?
    else {
        return Err(
            "Machine deployment policy does not exist; plugin fileAccess is denied".to_string(),
        );
    };

    // The UI parser accepts a leading UTF-8 BOM, so the native gate must too.
    let policy_text = policy_contents
        .strip_prefix('\u{feff}')
        .unwrap_or(&policy_contents);
    let policy: serde_json::Value = serde_json::from_str(policy_text)
        .map_err(|error| format!("Could not parse machine deployment policy: {error}"))?;
    // The UI ignores a policy with an unsupported version; never grant from one.
    if policy.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(
            "Machine deployment policy has an unsupported version; plugin fileAccess is denied"
                .to_string(),
        );
    }

    let allowlist = machine_file_access_allowlist(&policy, trimmed_id)?;

    if !is_safe_absolute_path(path) {
        return Err(format!(
            "Refusing to read \"{path}\": not a safe absolute local file path"
        ));
    }

    let canonical_requested = fs::canonicalize(path)
        .map_err(|error| format!("Could not resolve path \"{path}\": {error}"))?;

    let metadata = fs::metadata(&canonical_requested)
        .map_err(|error| format!("Could not inspect path \"{path}\": {error}"))?;
    // Regular files only: a directory cannot be read, and opening a FIFO or
    // device with no writer would block this command indefinitely.
    if !metadata.is_file() {
        return Err(format!("Refusing to read \"{path}\": not a regular file"));
    }

    let mut is_allowed = false;
    for trimmed_entry in &allowlist {
        let trimmed_entry = trimmed_entry.as_str();
        if !is_safe_absolute_path(trimmed_entry) {
            continue;
        }
        if let Ok(canonical_entry) = fs::canonicalize(trimmed_entry) {
            if canonical_entry == canonical_requested {
                is_allowed = true;
                break;
            }
        }
    }

    if !is_allowed {
        return Err(format!(
            "Path \"{path}\" is not in the fileAccess allowlist for plugin '{trimmed_id}'"
        ));
    }

    // `fs::File`, not `File`: the bare import is compiled out of MAS builds.
    let file = fs::File::open(&canonical_requested)
        .map_err(|error| format!("Could not open file \"{path}\": {error}"))?;
    let mut text = String::new();
    file.take(MAX_PLUGIN_ENTRY_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|error| format!("Could not read file \"{path}\" as UTF-8: {error}"))?;
    if text.len() as u64 > MAX_PLUGIN_ENTRY_BYTES {
        return Err(format!(
            "File \"{path}\" exceeds the {}-MB size limit",
            MAX_PLUGIN_ENTRY_BYTES / (1024 * 1024)
        ));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use crate::test_support::ScratchDir;
    use std::fs;

    #[test]
    fn optional_config_file_returns_none_only_when_missing() {
        let root = ScratchDir::new("optional-config-missing");
        let path = root.path().join("deployment.json");
        assert_eq!(super::read_optional_config_file(&path).unwrap(), None);
        assert_eq!(super::read_admin_profile_file(&path).unwrap(), None);
    }

    #[test]
    fn optional_config_file_preserves_raw_utf8_text() {
        let root = ScratchDir::new("optional-config-text");
        let path = root.path().join("deployment.json");
        for contents in [
            "",
            " \r\n{\"name\":\"café\"}\r\n ",
            "\u{feff}{\"enabled\":true}\n",
        ] {
            fs::write(&path, contents).unwrap();
            assert_eq!(
                super::read_optional_config_file(&path).unwrap(),
                Some(contents.to_owned())
            );
            assert_eq!(
                super::read_admin_profile_file(&path).unwrap(),
                Some(contents.to_owned())
            );
        }
    }

    #[test]
    fn optional_config_file_propagates_non_not_found_errors() {
        let root = ScratchDir::new("optional-config-errors");
        let directory = root.path().join("deployment.json");
        fs::create_dir(&directory).unwrap();
        let invalid_utf8 = root.path().join("admin-profile.json");
        fs::write(&invalid_utf8, [0xff]).unwrap();

        for path in [&directory, &invalid_utf8] {
            let original_error = fs::read_to_string(path).unwrap_err();
            let error = super::read_optional_config_file(path).unwrap_err();
            assert_ne!(error.kind(), std::io::ErrorKind::NotFound);
            assert_eq!(error.kind(), original_error.kind());
            assert_eq!(error.to_string(), original_error.to_string());
            assert_eq!(
                super::read_admin_profile_file(path).unwrap_err(),
                format!("Could not read admin profile: {original_error}")
            );
        }
    }

    #[test]
    fn read_allowed_file_honors_machine_policy_and_blocks_unauthorized() {
        let root = ScratchDir::new("plugin-file-access");
        let allowed_file = root.path().join("allowed.json");
        fs::write(&allowed_file, "{\"hello\":\"world\"}").unwrap();
        let unlisted_file = root.path().join("secret.json");
        fs::write(&unlisted_file, "{\"secret\":123}").unwrap();

        let allowed_str = allowed_file.to_str().unwrap().replace('\\', "/");
        let unlisted_str = unlisted_file.to_str().unwrap().replace('\\', "/");

        let policy_path = root.path().join("deployment.json");
        let policy_json = format!(
            r#"{{"version":1,"plugins":{{"fileAccess":{{"my-plugin":["{}"]}}}}}}"#,
            allowed_str
        );
        fs::write(&policy_path, policy_json).unwrap();

        // 1. Allowed path matches and reads
        let res = super::read_allowed_file_impl("my-plugin", &allowed_str, Some(&policy_path));
        assert_eq!(res.unwrap(), "{\"hello\":\"world\"}");

        // 2. Unlisted path is rejected
        let res_unlisted =
            super::read_allowed_file_impl("my-plugin", &unlisted_str, Some(&policy_path));
        assert!(res_unlisted.is_err());
        assert!(res_unlisted
            .unwrap_err()
            .contains("not in the fileAccess allowlist"));

        // 3. Wrong plugin id is rejected
        let res_wrong_id =
            super::read_allowed_file_impl("other-plugin", &allowed_str, Some(&policy_path));
        assert!(res_wrong_id.is_err());
        assert!(res_wrong_id
            .unwrap_err()
            .contains("has no fileAccess allowlist"));

        // 4. Traversal using .. is rejected
        let traversal_str = format!(
            "{}/../secret.json",
            allowed_file
                .parent()
                .unwrap()
                .to_str()
                .unwrap()
                .replace('\\', "/")
        );
        let res_traversal =
            super::read_allowed_file_impl("my-plugin", &traversal_str, Some(&policy_path));
        assert!(res_traversal.is_err());
        assert!(res_traversal
            .unwrap_err()
            .contains("not a safe absolute local file path"));

        // 5. No machine-wide policy (None, or an absent file) denies every read
        let res_none = super::read_allowed_file_impl("my-plugin", &allowed_str, None);
        assert!(res_none.is_err());
        assert!(res_none
            .unwrap_err()
            .contains("No machine deployment policy configured"));

        let absent_policy = root.path().join("absent.json");
        let res_absent =
            super::read_allowed_file_impl("my-plugin", &allowed_str, Some(&absent_policy));
        assert!(res_absent.is_err());
        assert!(res_absent.unwrap_err().contains("does not exist"));

        // 6. Policy keys are matched after trimming, as the UI parser does.
        let padded_policy = root.path().join("padded.json");
        fs::write(
            &padded_policy,
            format!(
                r#"{{"version":1,"plugins":{{"fileAccess":{{" my-plugin ":["{}"]}}}}}}"#,
                allowed_str
            ),
        )
        .unwrap();
        let res_padded =
            super::read_allowed_file_impl("my-plugin", &allowed_str, Some(&padded_policy));
        assert_eq!(res_padded.unwrap(), "{\"hello\":\"world\"}");

        // 7. A BOM-prefixed policy parses, as it does in the UI.
        let bom_policy = root.path().join("bom.json");
        fs::write(
            &bom_policy,
            format!(
                "\u{feff}{{\"version\":1,\"plugins\":{{\"fileAccess\":{{\"my-plugin\":[\"{}\"]}}}}}}",
                allowed_str
            ),
        )
        .unwrap();
        let res_bom = super::read_allowed_file_impl("my-plugin", &allowed_str, Some(&bom_policy));
        assert_eq!(res_bom.unwrap(), "{\"hello\":\"world\"}");

        // 8. An unsupported version never grants access.
        let v2_policy = root.path().join("v2.json");
        fs::write(
            &v2_policy,
            format!(
                r#"{{"version":2,"plugins":{{"fileAccess":{{"my-plugin":["{}"]}}}}}}"#,
                allowed_str
            ),
        )
        .unwrap();
        let res_v2 = super::read_allowed_file_impl("my-plugin", &allowed_str, Some(&v2_policy));
        assert!(res_v2.unwrap_err().contains("unsupported version"));

        // 9. A fileAccess section the UI would drop grants nothing natively.
        for bad in [
            format!(r#"{{"my-plugin":["{allowed_str}",""]}}"#),
            format!(
                r#"{{"my-plugin":["{allowed_str}"],"other":[" {allowed_str} ","{allowed_str}"]}}"#
            ),
            format!(r#"{{"my-plugin":["{allowed_str}"]," my-plugin":["{allowed_str}"]}}"#),
            format!(r#"{{"my-plugin":["{allowed_str}"],"   ":[]}}"#),
            r#"["not-an-object"]"#.to_string(),
        ] {
            let bad_policy = root.path().join("bad.json");
            fs::write(
                &bad_policy,
                format!(r#"{{"version":1,"plugins":{{"fileAccess":{bad}}}}}"#),
            )
            .unwrap();
            let res_bad =
                super::read_allowed_file_impl("my-plugin", &allowed_str, Some(&bad_policy));
            assert!(
                res_bad.unwrap_err().contains("invalid plugins.fileAccess"),
                "{bad}"
            );
        }

        // 10. A directory listed in the allowlist is not a regular file.
        let dir_str = root.path().to_str().unwrap().replace('\\', "/");
        let dir_policy = root.path().join("dir.json");
        fs::write(
            &dir_policy,
            format!(
                r#"{{"version":1,"plugins":{{"fileAccess":{{"my-plugin":["{}"]}}}}}}"#,
                dir_str
            ),
        )
        .unwrap();
        let res_dir = super::read_allowed_file_impl("my-plugin", &dir_str, Some(&dir_policy));
        assert!(res_dir.unwrap_err().contains("not a regular file"));
    }

    #[cfg(unix)]
    #[test]
    fn read_allowed_file_blocks_symlink_escape() {
        use std::os::unix::fs::symlink;
        let root = ScratchDir::new("plugin-symlink-escape");
        let secret_file = root.path().join("secret.txt");
        fs::write(&secret_file, "forbidden").unwrap();

        let link = root.path().join("link_to_secret.txt");
        symlink(&secret_file, &link).unwrap();

        let safe_file = root.path().join("safe.txt");
        fs::write(&safe_file, "safe").unwrap();

        let policy_path = root.path().join("deployment.json");
        let policy_json = format!(
            r#"{{"version":1,"plugins":{{"fileAccess":{{"my-plugin":["{}"]}}}}}}"#,
            safe_file.to_str().unwrap()
        );
        fs::write(&policy_path, policy_json).unwrap();

        let link_str = link.to_str().unwrap();
        let res = super::read_allowed_file_impl("my-plugin", link_str, Some(&policy_path));
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("not in the fileAccess allowlist"));
    }
}
