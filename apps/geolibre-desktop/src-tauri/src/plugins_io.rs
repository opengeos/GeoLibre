//! External plugin I/O: installing, listing and uninstalling packaged plugin
//! archives, scanning plugin directories for bundles, and serving a loaded
//! bundle's assets. The Mac App Store build compiles all of it out and keeps
//! stub commands with the same names and signatures.

#[cfg(not(feature = "mas"))]
use crate::local_files::{is_safe_absolute_path, is_unc_resolved_path};
use serde::{Deserialize, Serialize};
#[cfg(not(feature = "mas"))]
use std::collections::HashSet;
#[cfg(not(feature = "mas"))]
use std::fs;
#[cfg(not(feature = "mas"))]
use std::fs::File;
#[cfg(not(feature = "mas"))]
use std::io::Read;
#[cfg(not(feature = "mas"))]
use std::path::{Path, PathBuf};
#[cfg(not(feature = "mas"))]
use std::sync::Mutex;
#[cfg(not(feature = "mas"))]
use tauri::Manager;

/// Canonical paths of the plugin bundles (zip archives or directories) that
/// the most recent `load_external_plugin_bundles` scan loaded. The asset read
/// accepts only these sources, so the webview cannot widen the readable set by
/// naming its own roots: a scan registers only bundles that carry a valid
/// `plugin.json`, never an arbitrary directory such as `$HOME`.
#[cfg(not(feature = "mas"))]
#[derive(Default)]
pub(crate) struct LoadedPluginBundles(Mutex<HashSet<PathBuf>>);

#[cfg(not(feature = "mas"))]
impl LoadedPluginBundles {
    /// Replace the recorded set with the canonical form of `sources`. Sources
    /// that no longer resolve are dropped.
    fn replace<I, S>(&self, sources: I)
    where
        I: IntoIterator<Item = S>,
        S: AsRef<Path>,
    {
        let canonical = sources
            .into_iter()
            .filter_map(|source| source.as_ref().canonicalize().ok())
            .collect::<HashSet<_>>();
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = canonical;
    }

    /// The canonical path of `source` when it is a recorded bundle, else None.
    fn canonical_known_source(&self, source: &Path) -> Option<PathBuf> {
        let canonical = source.canonicalize().ok()?;
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains(&canonical)
            .then_some(canonical)
    }
}

pub(crate) const MAX_PLUGIN_ENTRY_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalPluginManifest {
    id: String,
    name: String,
    version: String,
    entry: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    capabilities: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledExternalPluginArchive {
    id: String,
    name: String,
    version: String,
    archive_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    capabilities: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalPluginBundle {
    archive_name: String,
    manifest: ExternalPluginManifest,
    entry_source: String,
    style_source: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalPluginBundleError {
    archive_name: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalPluginBundleLoadResult {
    plugins_directories: Vec<String>,
    bundles: Vec<ExternalPluginBundle>,
    errors: Vec<ExternalPluginBundleError>,
}

/// Install a packaged plugin from a local `.zip` archive into GeoLibre's
/// app-data `plugins/` directory so it persists across restarts and is picked up
/// by the regular plugin scan. The archive is validated first (parsing
/// `plugin.json`, enforcing the manifest rules, and confirming the entry and
/// optional style are present and within the size limit), so only a loadable
/// plugin lands in the plugins directory. Returns the installed plugin id.
#[cfg(not(feature = "mas"))]
#[tauri::command]
pub(crate) async fn install_external_plugin_archive(
    app: tauri::AppHandle,
    source_path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install_external_plugin_archive_blocking(&app, source_path)
    })
    .await
    .map_err(|error| format!("Plugin install task failed: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn install_external_plugin_archive_blocking(
    app: &tauri::AppHandle,
    source_path: String,
) -> Result<String, String> {
    if !is_safe_absolute_path(&source_path) {
        return Err(format!(
            "Refusing to install \"{source_path}\": plugin path must be an absolute local path"
        ));
    }
    let source = PathBuf::from(&source_path);
    if !is_zip_path(&source) {
        return Err("Plugin file must be a .zip archive".to_string());
    }
    let canonical_source = fs::canonicalize(&source)
        .map_err(|error| format!("Could not resolve plugin archive: {error}"))?;
    let resolved = canonical_source.to_string_lossy();
    if is_unc_resolved_path(&resolved)
        || !is_zip_path(&canonical_source)
        || !canonical_source.is_file()
    {
        return Err("Plugin file must resolve to a local .zip archive".to_string());
    }

    // Validate the archive up front by loading it the same way the startup scan
    // does; this rejects a malformed manifest, a missing/oversized entry, or an
    // unsafe asset path before any file is written.
    let bundle = load_external_plugin_archive(&canonical_source, &source_path)?;
    let plugin_id = bundle.manifest.id;

    let plugins_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("plugins");
    fs::create_dir_all(&plugins_dir)
        .map_err(|error| format!("Could not create plugins directory: {error}"))?;

    let destination = plugins_dir.join(plugin_archive_file_name(&plugin_id));

    // Reinstalling from a file already inside the plugins directory (e.g. the
    // user re-selects the installed copy) would otherwise truncate the source
    // mid-copy. Treat the no-op copy as a successful install.
    let same_file = destination
        .canonicalize()
        .ok()
        .is_some_and(|to| canonical_source == to);
    if !same_file {
        fs::copy(&canonical_source, &destination)
            .map_err(|error| format!("Could not install plugin archive: {error}"))?;
    }

    Ok(plugin_id)
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
pub(crate) async fn list_installed_plugin_archives(
    app: tauri::AppHandle,
) -> Result<Vec<InstalledExternalPluginArchive>, String> {
    tauri::async_runtime::spawn_blocking(move || list_installed_plugin_archives_blocking(&app))
        .await
        .map_err(|error| format!("Plugin archive list task failed: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn list_installed_plugin_archives_blocking(
    app: &tauri::AppHandle,
) -> Result<Vec<InstalledExternalPluginArchive>, String> {
    let plugins_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("plugins");
    if !plugins_dir.exists() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(&plugins_dir)
        .map_err(|error| format!("Could not read plugins directory: {error}"))?;
    let mut installed = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !is_zip_path(&path) {
            continue;
        }
        // Use the bare file name as a readable display label for the Manage Plugins UI;
        // `scan_external_plugin_directory` separately records the canonical absolute path
        // as the collision-free source key used for exact-match uninstall and asset reads.
        let archive_name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string());
        if let Ok(bundle) = load_external_plugin_archive(&path, &archive_name) {
            let capabilities = bundle.manifest.capabilities.map(|caps| {
                caps.into_iter()
                    .filter(|cap| {
                        matches!(
                            cap.as_str(),
                            "network" | "filesystem" | "sidecar" | "mapWrite" | "ui"
                        )
                    })
                    .collect()
            });
            installed.push(InstalledExternalPluginArchive {
                id: bundle.manifest.id,
                name: bundle.manifest.name,
                version: bundle.manifest.version,
                archive_name,
                capabilities,
            });
        }
    }
    installed.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.id.cmp(&b.id))
    });
    Ok(installed)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UninstallExternalPluginArchiveResult {
    removed_paths: Vec<String>,
    plugins_dir: String,
    error: Option<String>,
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
pub(crate) async fn uninstall_external_plugin_archive(
    app: tauri::AppHandle,
    plugin_id: String,
) -> Result<UninstallExternalPluginArchiveResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        uninstall_external_plugin_archive_blocking(&app, &plugin_id)
    })
    .await
    .map_err(|error| format!("Plugin uninstall task failed: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn uninstall_external_plugin_archive_blocking(
    app: &tauri::AppHandle,
    plugin_id: &str,
) -> Result<UninstallExternalPluginArchiveResult, String> {
    validate_required_manifest_string("plugin_id", plugin_id)?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    let plugins_dir = app_data_dir.join("plugins");
    if !plugins_dir.exists() {
        let resolved_plugins_dir = fs::canonicalize(&app_data_dir)
            .map(|canonical_app_data| canonical_app_data.join("plugins"))
            .unwrap_or(plugins_dir);
        return Ok(UninstallExternalPluginArchiveResult {
            removed_paths: Vec::new(),
            plugins_dir: resolved_plugins_dir.to_string_lossy().into_owned(),
            error: None,
        });
    }
    let canonical_dir = fs::canonicalize(&plugins_dir)
        .map_err(|error| format!("Could not resolve plugins directory: {error}"))?;
    let plugins_dir_str = canonical_dir.to_string_lossy().into_owned();

    let mut targets: Vec<PathBuf> = Vec::new();
    let mut seen_canonical: HashSet<PathBuf> = HashSet::new();
    let direct = plugins_dir.join(plugin_archive_file_name(plugin_id));
    if direct.is_file() {
        let label = direct.to_string_lossy().to_string();
        if let Ok(bundle) = load_external_plugin_archive(&direct, &label) {
            if bundle.manifest.id == plugin_id {
                if let Ok(canonical) = fs::canonicalize(&direct) {
                    if seen_canonical.insert(canonical) {
                        targets.push(direct);
                    }
                }
            }
        }
    }
    if let Ok(entries) = fs::read_dir(&plugins_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || !is_zip_path(&path) {
                continue;
            }
            let Ok(canonical) = fs::canonicalize(&path) else {
                continue;
            };
            if seen_canonical.contains(&canonical) {
                continue;
            }
            let label = path.to_string_lossy().to_string();
            if let Ok(bundle) = load_external_plugin_archive(&path, &label) {
                if bundle.manifest.id == plugin_id && seen_canonical.insert(canonical) {
                    targets.push(path);
                }
            }
        }
    }

    // Preflight-validate every target before deleting any archive so a symlink
    // or non-zip target cannot leave a partial deletion behind.
    let mut validated_targets: Vec<PathBuf> = Vec::with_capacity(targets.len());
    for candidate in targets {
        let canonical = fs::canonicalize(&candidate)
            .map_err(|error| format!("Could not resolve installed plugin archive: {error}"))?;
        if !canonical.starts_with(&canonical_dir)
            || !canonical.is_file()
            || !is_zip_path(&canonical)
        {
            return Err("Refusing to remove a file outside the plugins directory.".to_string());
        }
        validated_targets.push(canonical);
    }

    let mut removed_paths = Vec::new();
    let mut removal_error: Option<String> = None;
    for canonical in validated_targets {
        match fs::remove_file(&canonical) {
            Ok(()) => removed_paths.push(canonical.to_string_lossy().into_owned()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                removal_error = Some(format!("Could not remove plugin archive: {error}"));
                break;
            }
        }
    }
    if let Some(error) = removal_error {
        if removed_paths.is_empty() {
            return Err(error);
        }
        return Ok(UninstallExternalPluginArchiveResult {
            removed_paths,
            plugins_dir: plugins_dir_str,
            error: Some(error),
        });
    }
    Ok(UninstallExternalPluginArchiveResult {
        removed_paths,
        plugins_dir: plugins_dir_str,
        error: None,
    })
}

/// Build a filesystem-safe `<id>.zip` name for an installed plugin archive.
///
/// The manifest `id` is validated for emptiness and whitespace but not for
/// filesystem safety, so any character outside `[A-Za-z0-9._-]` is replaced with
/// `_` and leading dots are stripped to keep the name from escaping the plugins
/// directory or producing a hidden file. Using the id as the file name gives a
/// reinstall natural overwrite semantics.
#[cfg(not(feature = "mas"))]
fn plugin_archive_file_name(id: &str) -> String {
    let sanitized: String = id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric()
                || character == '-'
                || character == '_'
                || character == '.'
            {
                character
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = sanitized.trim_start_matches('.');
    let safe = if trimmed.is_empty() {
        "plugin"
    } else {
        trimmed
    };
    format!("{safe}.zip")
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
pub(crate) async fn load_external_plugin_bundles(
    app: tauri::AppHandle,
    additional_plugin_directories: Vec<String>,
) -> Result<ExternalPluginBundleLoadResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        load_external_plugin_bundles_blocking(&app, additional_plugin_directories)
    })
    .await
    .map_err(|error| format!("External plugin scan task failed: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn load_external_plugin_bundles_blocking(
    app: &tauri::AppHandle,
    additional_plugin_directories: Vec<String>,
) -> Result<ExternalPluginBundleLoadResult, String> {
    let plugins_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("plugins");

    fs::create_dir_all(&plugins_dir)
        .map_err(|error| format!("Could not create plugins directory: {error}"))?;

    let plugin_dirs = plugin_roots(additional_plugin_directories, plugins_dir);

    let mut bundles = Vec::new();
    let mut errors = Vec::new();
    for plugin_dir in &plugin_dirs {
        scan_external_plugin_directory(plugin_dir, &mut bundles, &mut errors);
    }
    // Remember exactly what loaded, so read_external_plugin_asset can refuse
    // any source the scan did not itself find.
    app.state::<LoadedPluginBundles>().replace(
        bundles
            .iter()
            .map(|bundle| PathBuf::from(&bundle.archive_name)),
    );

    Ok(ExternalPluginBundleLoadResult {
        plugins_directories: plugin_dirs
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect(),
        bundles,
        errors,
    })
}

/// The deduplicated plugin root directories the startup scan walks: the
/// user-configured additional directories first, then the app-data plugins
/// directory.
#[cfg(not(feature = "mas"))]
fn plugin_roots(additional_plugin_directories: Vec<String>, plugins_dir: PathBuf) -> Vec<PathBuf> {
    let mut plugin_dirs = Vec::new();
    let mut seen_dirs = HashSet::new();
    for directory in additional_plugin_directories {
        let directory = directory.trim();
        if directory.is_empty() {
            continue;
        }
        let path = PathBuf::from(directory);
        let key = normalize_path_key(&path);
        if seen_dirs.insert(key) {
            plugin_dirs.push(path);
        }
    }
    if seen_dirs.insert(normalize_path_key(&plugins_dir)) {
        plugin_dirs.push(plugins_dir);
    }
    plugin_dirs
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
pub(crate) async fn read_external_plugin_asset(
    app: tauri::AppHandle,
    source_path: String,
    relative_path: String,
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_external_plugin_asset_blocking(&app, &source_path, &relative_path)
    })
    .await
    .map_err(|error| format!("External plugin asset read task failed: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn read_external_plugin_asset_blocking(
    app: &tauri::AppHandle,
    source_path: &str,
    relative_path: &str,
) -> Result<tauri::ipc::Response, String> {
    validate_external_plugin_path("relative_path", relative_path)?;
    // The source must be a bundle the last scan loaded. The roots are not
    // taken from the caller: a webview that could name its own root could
    // point this read at any directory on disk.
    let canonical_source = app
        .state::<LoadedPluginBundles>()
        .canonical_known_source(Path::new(source_path))
        .ok_or_else(|| {
            "Refusing to read plugin assets: source is not a loaded plugin bundle".to_string()
        })?;
    // Dispatch on what is actually on disk, not on the recorded name: a
    // directory may legitimately be named `*.zip`, and a symlink may resolve to
    // either shape, so the extension alone would route the read to the wrong
    // reader.
    let is_directory = fs::metadata(&canonical_source)
        .map_err(|error| format!("Plugin source is unavailable: {error}"))?
        .is_dir();
    if is_directory {
        Ok(tauri::ipc::Response::new(
            read_directory_plugin_asset_bytes(&canonical_source, relative_path)?,
        ))
    } else {
        Ok(tauri::ipc::Response::new(read_zip_plugin_asset_bytes(
            &canonical_source,
            relative_path,
        )?))
    }
}

#[cfg(not(feature = "mas"))]
fn read_zip_plugin_asset_bytes(
    archive_path: &Path,
    relative_path: &str,
) -> Result<Vec<u8>, String> {
    let file =
        File::open(archive_path).map_err(|error| format!("Could not open plugin zip: {error}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("Could not read plugin zip: {error}"))?;
    // Assets resolve against the manifest's own directory, mirroring how the
    // entry/style paths resolve at load time (a wrapping folder is tolerated).
    let manifest_path = find_zip_manifest_path(&archive)
        .ok_or_else(|| "Plugin archive is missing a plugin.json".to_string())?;
    let prefix = manifest_path.strip_suffix("plugin.json").unwrap_or("");
    let entry_name = format!("{prefix}{relative_path}");
    let entry = archive.by_name(&entry_name).map_err(|_| {
        format!("Plugin asset '{relative_path}' does not exist in the plugin archive")
    })?;
    if entry.is_dir() {
        return Err(format!("Plugin asset '{relative_path}' must be a file"));
    }
    // Cap the actual bytes read instead of trusting the zip header size,
    // which a hand-crafted archive can spoof.
    let mut bytes = Vec::new();
    entry
        .take(MAX_PLUGIN_ENTRY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read plugin asset '{relative_path}': {error}"))?;
    if bytes.len() as u64 > MAX_PLUGIN_ENTRY_BYTES {
        return Err(format!(
            "Plugin asset '{relative_path}' exceeds the {}-MB size limit",
            MAX_PLUGIN_ENTRY_BYTES / (1024 * 1024)
        ));
    }
    Ok(bytes)
}

#[cfg(not(feature = "mas"))]
fn read_directory_plugin_asset_bytes(
    plugin_dir: &Path,
    relative_path: &str,
) -> Result<Vec<u8>, String> {
    let canonical_root = plugin_dir
        .canonicalize()
        .unwrap_or_else(|_| plugin_dir.to_path_buf());
    let entry_path = canonical_root.join(relative_path);
    // Resolve through path metadata so a symlink inside the plugin directory
    // cannot redirect the read outside it, then re-check containment on the
    // resolved path (same resolved-path re-check read_project_file applies).
    let canonical_entry = entry_path
        .canonicalize()
        .map_err(|_| format!("Plugin asset '{relative_path}' does not exist"))?;
    if !canonical_entry.starts_with(&canonical_root) {
        return Err(format!(
            "Refusing to read \"{relative_path}\": it resolves outside the plugin directory"
        ));
    }
    if !canonical_entry.is_file() {
        return Err(format!("Plugin asset '{relative_path}' must be a file"));
    }
    let file = File::open(&canonical_entry)
        .map_err(|error| format!("Could not read plugin asset '{relative_path}': {error}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_PLUGIN_ENTRY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read plugin asset '{relative_path}': {error}"))?;
    if bytes.len() as u64 > MAX_PLUGIN_ENTRY_BYTES {
        return Err(format!(
            "Plugin asset '{relative_path}' exceeds the {}-MB size limit",
            MAX_PLUGIN_ENTRY_BYTES / (1024 * 1024)
        ));
    }
    Ok(bytes)
}

#[cfg(not(feature = "mas"))]
fn normalize_path_key(path: &Path) -> String {
    // Canonicalize so symlinks and case differences on case-insensitive file
    // systems (Windows, macOS) dedupe to one key; fall back to the raw path
    // when it does not exist yet.
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    canonical.to_string_lossy().replace('\\', "/")
}

#[cfg(not(feature = "mas"))]
fn scan_external_plugin_directory(
    plugin_dir: &Path,
    bundles: &mut Vec<ExternalPluginBundle>,
    errors: &mut Vec<ExternalPluginBundleError>,
) {
    if !plugin_dir.exists() {
        // User-configured development directories may not exist yet; the app
        // data plugins directory is always created before scanning. Skip
        // silently instead of warning on every startup.
        return;
    }

    if plugin_dir.join("plugin.json").is_file() {
        let bundle_name = plugin_dir.to_string_lossy().to_string();
        match load_external_plugin_directory(plugin_dir, &bundle_name) {
            Ok(bundle) => bundles.push(bundle),
            Err(message) => errors.push(ExternalPluginBundleError {
                archive_name: bundle_name,
                message,
            }),
        }
        return;
    }

    let mut entries = match fs::read_dir(plugin_dir) {
        Ok(entries) => entries.filter_map(Result::ok).collect::<Vec<_>>(),
        Err(error) => {
            errors.push(ExternalPluginBundleError {
                archive_name: plugin_dir.to_string_lossy().to_string(),
                message: format!("Could not read plugins directory: {error}"),
            });
            return;
        }
    };
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_string());

    for entry in entries {
        let path = entry.path();
        // Resolve through path metadata rather than the directory entry so
        // symlinked zips and plugin directories are followed, not skipped.
        let metadata = match path.metadata() {
            Ok(metadata) => metadata,
            Err(error) => {
                errors.push(ExternalPluginBundleError {
                    archive_name: path.to_string_lossy().to_string(),
                    message: format!("Could not inspect plugin entry: {error}"),
                });
                continue;
            }
        };

        if metadata.is_file() && is_zip_path(&path) {
            let canonical = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            let bundle_name = canonical.to_string_lossy().to_string();
            match load_external_plugin_archive(&canonical, &bundle_name) {
                Ok(bundle) => bundles.push(bundle),
                Err(message) => errors.push(ExternalPluginBundleError {
                    archive_name: bundle_name,
                    message,
                }),
            }
        } else if metadata.is_dir() && path.join("plugin.json").is_file() {
            let bundle_name = path.to_string_lossy().to_string();
            match load_external_plugin_directory(&path, &bundle_name) {
                Ok(bundle) => bundles.push(bundle),
                Err(message) => errors.push(ExternalPluginBundleError {
                    archive_name: bundle_name,
                    message,
                }),
            }
        }
    }
}

#[cfg(not(feature = "mas"))]
fn is_zip_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
}

#[cfg(not(feature = "mas"))]
fn load_external_plugin_archive(
    path: &Path,
    archive_name: &str,
) -> Result<ExternalPluginBundle, String> {
    let file = File::open(path).map_err(|error| format!("Could not open zip: {error}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("Could not read zip: {error}"))?;
    // Tolerate a wrapping folder (`my-plugin/plugin.json`) as produced by zipping
    // a plugin directory, not just a root `plugin.json`. The entry/style paths
    // then resolve against the manifest's own directory.
    let manifest_path = find_zip_manifest_path(&archive)
        .ok_or_else(|| "Plugin archive is missing a plugin.json".to_string())?;
    let prefix = manifest_path
        .strip_suffix("plugin.json")
        .unwrap_or("")
        .to_string();
    let manifest_text = read_zip_text_entry(&mut archive, &manifest_path, "plugin manifest")?;
    let manifest: ExternalPluginManifest = serde_json::from_str(&manifest_text)
        .map_err(|error| format!("Could not parse plugin.json: {error}"))?;
    validate_external_plugin_manifest(&manifest)?;

    let entry_source = read_zip_text_entry(
        &mut archive,
        &format!("{prefix}{}", manifest.entry),
        "plugin entry",
    )?;
    let style_source = match manifest.style.as_deref() {
        Some(style) => Some(read_zip_text_entry(
            &mut archive,
            &format!("{prefix}{style}"),
            "plugin style",
        )?),
        None => None,
    };

    Ok(ExternalPluginBundle {
        archive_name: archive_name.to_string(),
        manifest,
        entry_source,
        style_source,
    })
}

/// Find plugin.json inside a zip, tolerating a single wrapping folder. Prefers a
/// root `plugin.json`, otherwise returns the shallowest `*/plugin.json`, ignoring
/// the `__MACOSX/` metadata folder macOS adds to archives. Returns the manifest's
/// full path within the archive, or None when no plugin.json is present.
#[cfg(not(feature = "mas"))]
fn find_zip_manifest_path<R: Read + std::io::Seek>(archive: &zip::ZipArchive<R>) -> Option<String> {
    // Entries whose names can't be decoded can't be the manifest; skip them.
    let owned: Vec<_> = archive.file_names().filter_map(Result::ok).collect();
    let names: Vec<&str> = owned.iter().map(|name| name.as_ref()).collect();
    if names.contains(&"plugin.json") {
        return Some("plugin.json".to_string());
    }
    let mut best: Option<&str> = None;
    let mut best_depth = usize::MAX;
    for name in names {
        if name.starts_with("__MACOSX/") || !name.ends_with("/plugin.json") {
            continue;
        }
        let depth = name.matches('/').count();
        if depth < best_depth || (depth == best_depth && best.is_none_or(|b| name < b)) {
            best = Some(name);
            best_depth = depth;
        }
    }
    best.map(str::to_string)
}

#[cfg(not(feature = "mas"))]
fn load_external_plugin_directory(
    path: &Path,
    archive_name: &str,
) -> Result<ExternalPluginBundle, String> {
    let manifest_text = read_fs_text_entry(path, "plugin.json", "plugin manifest")?;
    let manifest: ExternalPluginManifest = serde_json::from_str(&manifest_text)
        .map_err(|error| format!("Could not parse plugin.json: {error}"))?;
    validate_external_plugin_manifest(&manifest)?;

    let entry_source = read_fs_text_entry(path, &manifest.entry, "plugin entry")?;
    let style_source = match manifest.style.as_deref() {
        Some(style) => Some(read_fs_text_entry(path, style, "plugin style")?),
        None => None,
    };

    Ok(ExternalPluginBundle {
        archive_name: archive_name.to_string(),
        manifest,
        entry_source,
        style_source,
    })
}

#[cfg(not(feature = "mas"))]
fn read_fs_text_entry(root: &Path, entry_name: &str, label: &str) -> Result<String, String> {
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let entry_path = canonical_root.join(entry_name);
    let canonical_entry = entry_path
        .canonicalize()
        .map_err(|_| format!("Could not read {label} '{entry_name}': file does not exist"))?;
    if !canonical_entry.starts_with(&canonical_root) {
        return Err(format!(
            "Refusing to read {label} '{entry_name}': resolves outside the plugin directory"
        ));
    }
    if !canonical_entry.is_file() {
        return Err(format!(
            "Could not read {label} '{entry_name}': file does not exist"
        ));
    }

    let file = File::open(&canonical_entry)
        .map_err(|error| format!("Could not read {label} '{entry_name}': {error}"))?;
    let mut text = String::new();
    file.take(MAX_PLUGIN_ENTRY_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|error| format!("Could not read {label} '{entry_name}' as UTF-8: {error}"))?;
    if text.len() as u64 > MAX_PLUGIN_ENTRY_BYTES {
        return Err(format!(
            "{label} '{entry_name}' exceeds the {}-MB size limit",
            MAX_PLUGIN_ENTRY_BYTES / (1024 * 1024)
        ));
    }
    Ok(text)
}

#[cfg(not(feature = "mas"))]
fn read_zip_text_entry<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    entry_name: &str,
    label: &str,
) -> Result<String, String> {
    let entry = archive
        .by_name(entry_name)
        .map_err(|error| format!("Could not read {label} '{entry_name}': {error}"))?;
    if entry.is_dir() {
        return Err(format!("{label} '{entry_name}' must be a file"));
    }

    // Cap the actual bytes read instead of trusting the zip header size,
    // which a hand-crafted archive can spoof.
    let mut text = String::new();
    entry
        .take(MAX_PLUGIN_ENTRY_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|error| format!("Could not read {label} '{entry_name}' as UTF-8: {error}"))?;
    if text.len() as u64 > MAX_PLUGIN_ENTRY_BYTES {
        return Err(format!(
            "{label} '{entry_name}' exceeds the {}-MB size limit",
            MAX_PLUGIN_ENTRY_BYTES / (1024 * 1024)
        ));
    }
    Ok(text)
}

#[cfg(not(feature = "mas"))]
fn validate_external_plugin_manifest(manifest: &ExternalPluginManifest) -> Result<(), String> {
    validate_required_manifest_string("id", &manifest.id)?;
    validate_required_manifest_string("name", &manifest.name)?;
    validate_required_manifest_string("version", &manifest.version)?;
    validate_required_manifest_string("entry", &manifest.entry)?;
    validate_external_plugin_path("entry", &manifest.entry)?;
    if !manifest.entry.ends_with(".js") && !manifest.entry.ends_with(".mjs") {
        return Err("entry must point to a .js or .mjs file".to_string());
    }

    if let Some(description) = manifest.description.as_deref() {
        validate_optional_manifest_string("description", description)?;
    }
    if let Some(style) = manifest.style.as_deref() {
        validate_optional_manifest_string("style", style)?;
        validate_external_plugin_path("style", style)?;
        if !style.ends_with(".css") {
            return Err("style must point to a .css file".to_string());
        }
    }
    if let Some(capabilities) = manifest.capabilities.as_deref() {
        for capability in capabilities {
            validate_required_manifest_string("capabilities", capability)?;
            match capability.as_str() {
                "network" | "filesystem" | "sidecar" | "mapWrite" | "ui" => {}
                other => {
                    // Capabilities are advisory metadata; ignore unknown labels
                    // so manifests declaring future capabilities stay loadable.
                    eprintln!(
                        "[GeoLibre] Ignoring unrecognized advisory plugin capability '{other}' in '{}'",
                        manifest.id
                    );
                }
            }
        }
    }

    Ok(())
}

#[cfg(not(feature = "mas"))]
fn validate_required_manifest_string(field: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if value.trim() != value {
        return Err(format!(
            "{field} must not have leading or trailing whitespace"
        ));
    }
    Ok(())
}

#[cfg(not(feature = "mas"))]
fn validate_optional_manifest_string(field: &str, value: &str) -> Result<(), String> {
    if value.trim() != value {
        return Err(format!(
            "{field} must not have leading or trailing whitespace"
        ));
    }
    Ok(())
}

#[cfg(not(feature = "mas"))]
fn validate_external_plugin_path(field: &str, value: &str) -> Result<(), String> {
    if value.starts_with('/') {
        return Err(format!("{field} must be a relative path"));
    }
    if value.contains('\\') {
        return Err(format!("{field} must use forward slashes"));
    }
    if value.contains(':') {
        return Err(format!(
            "{field} must not contain drive letters or ':' characters"
        ));
    }
    if value
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(format!(
            "{field} must not contain empty, '.', or '..' segments"
        ));
    }
    Ok(())
}

// Mac App Store stubs: see the note above the Martin, sidecar and Jupyter
// stubs in lib.rs.
#[cfg(feature = "mas")]
#[tauri::command]
pub(crate) async fn install_external_plugin_archive(
    _app: tauri::AppHandle,
    _source_path: String,
) -> Result<String, String> {
    Err("External plugin installation is not available in the Mac App Store build.".to_string())
}

#[cfg(feature = "mas")]
#[tauri::command]
pub(crate) async fn list_installed_plugin_archives(
    _app: tauri::AppHandle,
) -> Result<Vec<InstalledExternalPluginArchive>, String> {
    Ok(Vec::new())
}

#[cfg(feature = "mas")]
#[tauri::command]
pub(crate) async fn uninstall_external_plugin_archive(
    _app: tauri::AppHandle,
    _plugin_id: String,
) -> Result<UninstallExternalPluginArchiveResult, String> {
    Err("External plugin removal is not available in the Mac App Store build.".to_string())
}

// Succeeds with an empty scan rather than erroring, so the startup plugin load
// degrades silently instead of surfacing a failure on every launch.
#[cfg(feature = "mas")]
#[tauri::command]
pub(crate) async fn load_external_plugin_bundles(
    _app: tauri::AppHandle,
    _additional_plugin_directories: Vec<String>,
) -> Result<ExternalPluginBundleLoadResult, String> {
    Ok(ExternalPluginBundleLoadResult {
        plugins_directories: Vec::new(),
        bundles: Vec::new(),
        errors: Vec::new(),
    })
}

// Mirrors the non-MAS command's refusal: the MAS build ships no external
// plugin support, so there are no bundles to read assets from.
#[cfg(feature = "mas")]
#[tauri::command]
pub(crate) async fn read_external_plugin_asset(
    _app: tauri::AppHandle,
    _source_path: String,
    _relative_path: String,
) -> Result<tauri::ipc::Response, String> {
    Err("External plugin assets are not available in the Mac App Store build.".to_string())
}

#[cfg(all(test, not(feature = "mas")))]
mod tests {
    use super::{
        find_zip_manifest_path, plugin_archive_file_name, read_directory_plugin_asset_bytes,
        read_zip_plugin_asset_bytes, LoadedPluginBundles,
    };
    use std::env;
    use std::fs;
    use std::io::{Cursor, Write};
    use std::path::PathBuf;

    #[cfg(not(feature = "mas"))]
    fn zip_with_contents(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, contents) in files {
            writer.start_file(*name, options).unwrap();
            writer.write_all(contents).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn reads_zip_plugin_asset_relative_to_manifest_directory() {
        let dir = env::temp_dir().join("geolibre-read-asset-zip-test");
        fs::create_dir_all(&dir).unwrap();
        let archive_path = dir.join("wrapped-plugin.zip");
        fs::write(
            &archive_path,
            zip_with_contents(&[
                ("my-plugin/plugin.json", b"{}"),
                ("my-plugin/assets/conn.json", b"{\"host\":\"db\"}"),
            ]),
        )
        .unwrap();
        let bytes = read_zip_plugin_asset_bytes(&archive_path, "assets/conn.json").unwrap();
        assert_eq!(bytes, b"{\"host\":\"db\"}");
        assert!(read_zip_plugin_asset_bytes(&archive_path, "missing.json").is_err());
        fs::remove_file(&archive_path).unwrap();
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn reads_directory_plugin_asset_and_refuses_escapes() {
        // A per-run directory: concurrent or interrupted runs must not share
        // fixtures, and cleanup stays inside this test's own root.
        let dir = env::temp_dir().join(format!(
            "geolibre-read-asset-dir-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir.join("assets")).unwrap();
        fs::write(dir.join("assets/conn.json"), b"{\"host\":\"db\"}").unwrap();
        let bytes = read_directory_plugin_asset_bytes(&dir, "assets/conn.json").unwrap();
        assert_eq!(bytes, b"{\"host\":\"db\"}");
        // Missing entries are refused.
        assert!(read_directory_plugin_asset_bytes(&dir, "missing.json").is_err());
        // A dot-segment escape that resolves to an existing sibling file is
        // refused by the resolved-path containment re-check.
        let escape = dir.parent().unwrap().join("escape.json");
        fs::write(&escape, b"secret").unwrap();
        assert!(read_directory_plugin_asset_bytes(&dir, "../escape.json").is_err());
        // Remove the sibling too: leaving it behind leaks `secret` into the
        // shared temp directory and collides with a later interrupted run.
        fs::remove_file(&escape).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(all(unix, not(feature = "mas")))]
    #[test]
    fn directory_plugin_asset_read_follows_no_symlink_escape() {
        let dir = env::temp_dir().join("geolibre-read-asset-symlink-test");
        fs::create_dir_all(&dir).unwrap();
        let outside = env::temp_dir().join("geolibre-read-asset-symlink-outside.txt");
        fs::write(&outside, b"secret").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("evil")).unwrap();
        // canonicalize resolves the symlink, and the containment re-check
        // refuses the read even though the textual join stayed inside.
        assert!(read_directory_plugin_asset_bytes(&dir, "evil").is_err());
        fs::remove_file(&outside).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn loaded_plugin_bundles_accept_only_scanned_sources() {
        let root = env::temp_dir().join(format!(
            "geolibre-loaded-bundles-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let plugin = root.join("plugins").join("my-plugin");
        fs::create_dir_all(&plugin).unwrap();
        fs::write(plugin.join("plugin.json"), b"{}").unwrap();
        let bundles = LoadedPluginBundles::default();
        bundles.replace([&plugin]);
        // The scanned bundle is accepted, also through a non-canonical spelling.
        assert!(bundles.canonical_known_source(&plugin).is_some());
        assert!(bundles
            .canonical_known_source(&plugin.join("..").join("my-plugin"))
            .is_some());
        // A directory the scan never loaded is refused, even one that contains
        // the bundle (the caller-chosen-root attack: `$HOME` + `.ssh/id_rsa`).
        assert!(bundles.canonical_known_source(&root).is_none());
        assert!(bundles
            .canonical_known_source(&root.join("plugins"))
            .is_none());
        assert!(bundles
            .canonical_known_source(&root.join("missing"))
            .is_none());
        // A rescan replaces the set rather than adding to it.
        bundles.replace(Vec::<PathBuf>::new());
        assert!(bundles.canonical_known_source(&plugin).is_none());
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(not(feature = "mas"))]
    fn zip_with_names(names: &[&str]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for name in names {
            writer.start_file(*name, options).unwrap();
            writer.write_all(b"x").unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[cfg(not(feature = "mas"))]
    fn manifest_path(names: &[&str]) -> Option<String> {
        let bytes = zip_with_names(names);
        let archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        find_zip_manifest_path(&archive)
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn finds_root_manifest() {
        assert_eq!(
            manifest_path(&["plugin.json", "dist/plugin.js"]).as_deref(),
            Some("plugin.json")
        );
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn finds_manifest_inside_a_wrapping_folder() {
        assert_eq!(
            manifest_path(&["my-plugin/plugin.json", "my-plugin/dist/plugin.js"]).as_deref(),
            Some("my-plugin/plugin.json")
        );
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn prefers_root_and_ignores_macosx_metadata() {
        // A root manifest wins over a deeper one.
        assert_eq!(
            manifest_path(&["wrap/plugin.json", "plugin.json"]).as_deref(),
            Some("plugin.json")
        );
        // The __MACOSX folder is skipped, so the real wrapped manifest is found.
        assert_eq!(
            manifest_path(&["__MACOSX/wrap/._plugin.json", "wrap/plugin.json"]).as_deref(),
            Some("wrap/plugin.json")
        );
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn returns_none_without_a_manifest() {
        assert_eq!(manifest_path(&["dist/plugin.js"]), None);
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn keeps_safe_plugin_ids() {
        assert_eq!(plugin_archive_file_name("maplibre-foo"), "maplibre-foo.zip");
        assert_eq!(plugin_archive_file_name("foo.bar_2"), "foo.bar_2.zip");
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn sanitizes_unsafe_characters_and_traversal() {
        // Path separators and other characters cannot escape the plugins dir;
        // leading dots are then stripped, so "../evil" collapses to "_evil".
        assert_eq!(plugin_archive_file_name("../evil"), "_evil.zip");
        assert_eq!(plugin_archive_file_name("a/b"), "a_b.zip");
        // Leading dots are stripped so the archive is never hidden.
        assert_eq!(plugin_archive_file_name("..hidden"), "hidden.zip");
        // A name that sanitizes away entirely falls back to a fixed stem.
        assert_eq!(plugin_archive_file_name("..."), "plugin.zip");
    }

    #[cfg(all(unix, not(feature = "mas")))]
    #[test]
    fn read_fs_text_entry_rejects_symlink_escape() {
        let base = std::env::temp_dir().join(format!(
            "geolibre-plugin-symlink-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let plugin_dir = base.join("plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        let outside = base.join("outside.txt");
        std::fs::write(&outside, "outside").unwrap();
        std::os::unix::fs::symlink(&outside, plugin_dir.join("entry.js")).unwrap();
        let err = super::read_fs_text_entry(&plugin_dir, "entry.js", "plugin entry")
            .expect_err("symlink escaping plugin dir must fail");
        assert!(err.contains("resolves outside the plugin directory"));
        let _ = std::fs::remove_dir_all(&base);
    }
}
