//! Local file access outside the webview's fs scope: the path guards shared
//! across the crate (absolute, non-UNC, no traversal, vector extensions), the
//! `read_local_file`, `write_local_geojson_file` and `read_shapefile_siblings`
//! commands, GeoTIFF asset-scope grants, and Flatpak drop-path checks.

use crate::fs_util;
use serde::Serialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_fs::FsExt;

/// Local vector file extensions the restore path may re-read (lowercased, no
/// dot). Mirrors `VECTOR_FILE_DIALOG_EXTENSIONS` in `file-io/paths.ts`; keep the two
/// in step.
// SYNC: VECTOR_FILE_DIALOG_EXTENSIONS in src/lib/file-io/paths.ts — grep "SYNC:" to
// find the partner list and update both together.
const RESTORABLE_VECTOR_EXTENSIONS: [&str; 17] = [
    "geojson",
    "json",
    "gpkg",
    "geoparquet",
    "parquet",
    "fgb",
    "flatgeobuf",
    "csv",
    "tsv",
    "kml",
    "kmz",
    "gml",
    "gpx",
    "dxf",
    "tab",
    "shp",
    "zip",
];

/// Whether `path` ends in one of the known restorable local vector extensions.
pub(crate) fn has_allowed_local_vector_extension(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower
        .rsplit_once('.')
        .is_some_and(|(_, extension)| RESTORABLE_VECTOR_EXTENSIONS.contains(&extension))
}

/// Whether the renderer is permitted to re-read `path` through `read_local_file`:
/// an absolute local path (POSIX `/...` or a Windows drive-letter `C:\...`, never
/// a UNC `\\host\share`), free of `..` traversal segments, ending in a known
/// vector extension.
///
/// This is a Rust-side backstop mirroring the frontend guard
/// (`isAbsoluteLocalPath` + `hasPathTraversal` + `isRestorableVectorPath` in
/// `file-io/paths.ts`). It narrows the attack surface of a compromised webview or
/// rogue plugin: arbitrary system files (`/etc/passwd`, SSH keys, most shell and
/// app configs) are blocked. It does not make the command harmless — the
/// allowlist still includes broad extensions like `json`, so a script that knows
/// the path of a JSON-shaped secret could still read it — but it bounds reads to
/// the vector formats the restore path actually needs. The checks are
/// byte-oriented rather than `std::path` based so they behave identically for the
/// Windows-style paths a project may carry regardless of the host the binary
/// runs on.
pub(crate) fn is_allowed_local_vector_path(path: &str) -> bool {
    // Absolute, non-UNC, no `..` traversal — split into `is_safe_absolute_path`
    // so the security-relevant byte-parsing lives in one place rather than being
    // duplicated.
    if !is_safe_absolute_path(path) {
        return false;
    }

    // Known vector extension, case-insensitive, matching the JS
    // `RESTORABLE_VECTOR_PATH` regex (built from `VECTOR_FILE_DIALOG_EXTENSIONS`).
    has_allowed_local_vector_extension(path)
}

/// Convert a canonicalized local path to a UTF-8 string usable by native libraries
/// and asset-protocol scopes (stripping Windows' `\\?\` verbatim drive prefix
/// while preserving POSIX paths). Rejects non-UTF-8 canonical paths rather than
/// substituting replacement characters that could alias a different file.
/// Callers must check `is_unc_resolved_path` first.
pub(crate) fn canonical_local_path_string(canonical: &Path) -> Result<String, String> {
    let raw = canonical
        .to_str()
        .ok_or_else(|| "resolved path is not valid UTF-8".to_string())?;
    #[cfg(windows)]
    if let Some(stripped) = raw.strip_prefix(r"\\?\") {
        return Ok(stripped.to_string());
    }
    Ok(raw.to_string())
}

/// Read a local file's raw bytes so a project's file-referenced vector layers
/// can be re-read when the project is reopened.
///
/// On reopen, a layer saved as a file reference carries only its absolute
/// `sourcePath` (stored in the `.geolibre.json`); that path was never picked or
/// dropped this session, so it sits outside the `fs` plugin's runtime scope and
/// the JS `readFile`/`readTextFile` reject it. This reads the file directly,
/// mirroring `read_project_file` (which bypasses the same scope to read the
/// project file itself). The path is validated here by
/// `is_allowed_local_vector_path` (absolute, no `..` traversal, known vector
/// extension) and canonicalized so symlinks cannot redirect the read to
/// arbitrary files or network shares. Bytes are returned as a raw IPC response
/// (an `ArrayBuffer` on the JS side) so a large GeoJSON does not pay the cost
/// of a JSON number array.
#[tauri::command]
pub(crate) fn read_local_file(path: String) -> Result<tauri::ipc::Response, String> {
    if !is_allowed_local_vector_path(&path) {
        return Err(format!(
            "Refusing to read \"{path}\": not an absolute local vector file path"
        ));
    }
    let canonical =
        fs::canonicalize(&path).map_err(|error| format!("Could not read local file: {error}"))?;
    let resolved = canonical.to_string_lossy();
    if is_unc_resolved_path(&resolved) {
        return Err(format!(
            "Refusing to read \"{path}\": resolves to a network path"
        ));
    }
    if !has_allowed_local_vector_extension(&resolved) {
        return Err(format!(
            "Refusing to read \"{path}\": resolves to a non-vector file"
        ));
    }
    if !canonical.is_file() {
        return Err(format!("Refusing to read \"{path}\": not a file"));
    }
    fs::read(&canonical)
        .map(tauri::ipc::Response::new)
        .map_err(|error| format!("Could not read local file: {error}"))
}

/// Whether `path` names a GeoJSON file the attribute write-back may overwrite:
/// an absolute local path (see `is_safe_absolute_path`) ending in `.geojson` or
/// `.json`, excluding `.geolibre.json` project files.
fn is_allowed_geojson_write_path(path: &str) -> bool {
    if !is_safe_absolute_path(path) {
        return false;
    }
    let lower = path.to_ascii_lowercase();
    (lower.ends_with(".geojson") || lower.ends_with(".json")) && !lower.ends_with(".geolibre.json")
}

/// Whether `bytes` parse as a JSON object whose `type` is `FeatureCollection`
/// and whose `features` is an array of `Feature` objects (a leading UTF-8
/// byte-order mark is allowed).
fn is_geojson_feature_collection(bytes: &[u8]) -> bool {
    let bytes = bytes
        .strip_prefix(b"\xEF\xBB\xBF".as_slice())
        .unwrap_or(bytes);
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .is_some_and(|value| {
            value.get("type").and_then(|t| t.as_str()) == Some("FeatureCollection")
                && value
                    .get("features")
                    .and_then(|f| f.as_array())
                    .is_some_and(|features| {
                        features.iter().all(|feature| {
                            feature.get("type").and_then(|t| t.as_str()) == Some("Feature")
                        })
                    })
        })
}

/// Whether a canonicalized path points at a network share. `canonicalize` on
/// Windows returns a verbatim path, `\\?\C:\…` for a local drive but
/// `\\?\UNC\host\share\…` for a share; a symlink or junction can resolve to
/// one even when the path the caller passed was local.
pub(crate) fn is_unc_resolved_path(resolved: &str) -> bool {
    let rest = resolved
        .strip_prefix(r"\\?\")
        .or_else(|| resolved.strip_prefix(r"\\.\"));
    match rest {
        Some(rest) => rest.to_ascii_lowercase().starts_with(r"unc\"),
        None => resolved.starts_with(r"\\") || resolved.starts_with("//"),
    }
}

/// Overwrite an existing local GeoJSON file with edited contents, for Layer
/// actions > Save edits to source file (GeoLibre#2439).
///
/// A GeoJSON rewrite needs no GeoPandas, so it no longer goes through the
/// optional Python sidecar, which is not running unless something started it:
/// the save used to fail with a connection error and leave the file unchanged.
/// Like `read_local_file`, this bypasses the `fs` plugin's runtime scope, which
/// does not cover a path dropped onto the map or restored with a project. The
/// guard is narrower than a read's: the file must already exist (write-back
/// replaces a layer's own source, never creates a file), and the canonical
/// path is re-checked so a symlink cannot redirect the write. Because `.json` is
/// a common GeoJSON extension but also a common config format, both the file
/// being replaced and the new contents must be GeoJSON FeatureCollections, so
/// the command cannot clobber arbitrary JSON. The contents go to a temporary
/// file beside the target, which takes the target's permissions and is renamed
/// over it, so a failed write never leaves the source half-written.
#[tauri::command]
pub(crate) fn write_local_geojson_file(path: String, contents: String) -> Result<(), String> {
    if !is_allowed_geojson_write_path(&path) {
        return Err(format!(
            "Refusing to write \"{path}\": not an absolute local GeoJSON file path"
        ));
    }
    let canonical = fs::canonicalize(&path)
        .map_err(|error| format!("Could not save to source file: {error}"))?;
    // The full `is_safe_absolute_path` guard can't be re-run on the resolved
    // path, because `canonicalize` yields a `\\?\C:\…` verbatim path on
    // Windows that it would reject. Re-check the parts a symlink or junction
    // could change: the extension, and that it stays off network shares.
    let resolved = canonical.to_string_lossy().to_ascii_lowercase();
    if is_unc_resolved_path(&resolved) {
        return Err(format!(
            "Refusing to write \"{path}\": resolves to a network path"
        ));
    }
    if !((resolved.ends_with(".geojson") || resolved.ends_with(".json"))
        && !resolved.ends_with(".geolibre.json"))
    {
        return Err(format!(
            "Refusing to write \"{path}\": resolves to a non-GeoJSON file"
        ));
    }
    if !canonical.is_file() {
        return Err(format!("Refusing to write \"{path}\": not a file"));
    }
    if !is_geojson_feature_collection(contents.as_bytes()) {
        return Err(
            "Refusing to write: the edited layer is not a GeoJSON FeatureCollection".into(),
        );
    }
    let existing =
        fs::read(&canonical).map_err(|error| format!("Could not save to source file: {error}"))?;
    if !is_geojson_feature_collection(&existing) {
        return Err(format!(
            "Refusing to write \"{path}\": the file is not a GeoJSON FeatureCollection"
        ));
    }
    let permissions = fs::metadata(&canonical)
        .map_err(|error| format!("Could not save to source file: {error}"))?
        .permissions();
    fs_util::write_file_atomic(
        &canonical,
        contents.as_bytes(),
        fs_util::AtomicWriteOptions {
            create_parents: false,
            owner_only_unix: true,
            sync: true,
            preserve_permissions: Some(permissions),
        },
    )
    .map_err(|error| format!("Could not save to source file: {error}"))?;
    Ok(())
}

/// Add one GeoTIFF to the asset-protocol scope. The filesystem and asset scopes
/// are separate in Tauri; dialogs and native drops grant the former, but
/// maplibre-gl-raster fetches through the latter for range reads. A GeoTIFF
/// referenced by an imported project -- QGIS (`.qgs`/`.qgz`) or ArcGIS Pro
/// (`.aprx`/`.mapx`) -- is also accepted when that project file itself was
/// explicitly selected by the user.
#[tauri::command]
pub(crate) fn allow_raster_asset(
    app: tauri::AppHandle,
    path: String,
    import_project_path: Option<String>,
) -> Result<(), String> {
    let lower = path.to_ascii_lowercase();
    if !is_safe_absolute_path(&path) || !(lower.ends_with(".tif") || lower.ends_with(".tiff")) {
        return Err(format!(
            "Refusing to expose \"{path}\": not an absolute GeoTIFF path"
        ));
    }
    let selected_import_project = import_project_path.is_some_and(|project_path| {
        let lower = project_path.to_ascii_lowercase();
        is_safe_absolute_path(&project_path)
            && (lower.ends_with(".qgs")
                || lower.ends_with(".qgz")
                || lower.ends_with(".aprx")
                || lower.ends_with(".mapx"))
            && app.fs_scope().is_allowed(&project_path)
    });
    if !app.fs_scope().is_allowed(&path) && !selected_import_project {
        return Err(format!(
            "Refusing to expose \"{path}\": neither the file nor its imported project was selected by the user"
        ));
    }
    let canonical = fs::canonicalize(&path)
        .map_err(|error| format!("Could not authorize local raster: {error}"))?;
    let resolved = canonical
        .to_str()
        .ok_or_else(|| format!("Refusing to expose \"{path}\": resolved path is not valid UTF-8"))?
        .to_ascii_lowercase();
    if is_unc_resolved_path(&resolved) {
        return Err(format!(
            "Refusing to expose \"{path}\": resolves to a network path"
        ));
    }
    if !(resolved.ends_with(".tif") || resolved.ends_with(".tiff")) || !canonical.is_file() {
        return Err(format!(
            "Refusing to expose \"{path}\": resolves to a non-GeoTIFF file"
        ));
    }
    let allowed_path = PathBuf::from(
        canonical_local_path_string(&canonical)
            .map_err(|error| format!("Refusing to expose \"{path}\": {error}"))?,
    );
    app.asset_protocol_scope()
        .allow_file(&allowed_path)
        .map_err(|error| format!("Could not authorize local raster: {error}"))
}

/// Whether the app runs inside a Flatpak sandbox.
fn running_in_flatpak() -> bool {
    env::var_os("FLATPAK_ID").is_some() || Path::new("/.flatpak-info").exists()
}

/// Pick out the dropped paths a Flatpak sandbox cannot see.
///
/// A host file manager that does not route drags through the document portal
/// hands the sandboxed app the file's host path (issue #3393). Without a
/// `--filesystem` grant that path does not exist inside the sandbox, so every
/// later read fails with an opaque error. Only paths already in the fs scope
/// (which the fs plugin grants for every native drop) are checked, so this is
/// not a general existence oracle.
///
/// # Arguments
///
/// * `paths` - The paths reported by the native drop event.
/// * `in_flatpak` - Whether the app runs inside a Flatpak sandbox.
/// * `is_allowed` - Whether a path is in the fs scope.
fn hidden_drop_paths(
    paths: Vec<String>,
    in_flatpak: bool,
    is_allowed: impl Fn(&str) -> bool,
) -> Vec<String> {
    if !in_flatpak {
        return Vec::new();
    }
    paths
        .into_iter()
        // Only a confirmed miss counts: a permission or other metadata error
        // is a different problem than the sandbox hiding the path.
        .filter(|path| is_allowed(path) && matches!(Path::new(path).try_exists(), Ok(false)))
        .collect()
}

/// Return the dropped paths the Flatpak sandbox cannot read, so the drop
/// handler can explain the sandbox instead of failing on each file. Always
/// empty outside Flatpak.
#[tauri::command]
pub(crate) fn sandbox_hidden_drop_paths(app: tauri::AppHandle, paths: Vec<String>) -> Vec<String> {
    let scope = app.fs_scope();
    hidden_drop_paths(paths, running_in_flatpak(), |path| scope.is_allowed(path))
}

/// Shapefile sidecar extensions read alongside a `.shp` (lowercased, no dot).
const SHAPEFILE_SIDECAR_EXTENSIONS: [&str; 16] = [
    "shx", "dbf", "prj", "cpg", "sbn", "sbx", "qix", "qpj", "cst", "aih", "ain", "atx", "ixs",
    "mxs", "fbn", "fbx",
];

#[derive(Serialize)]
pub(crate) struct ShapefileSibling {
    /// `<shp base>.<lowercased sidecar extension>`, matching the `.shp` base name
    /// so GDAL resolves the sidecar when reading the `.shp` directly.
    name: String,
    data: Vec<u8>,
}

/// Read a shapefile's sidecar files (`.shx`, `.dbf`, `.prj`, `.cpg`, ...) sitting
/// next to the given `.shp`, so a loose `.shp` can be loaded without the user
/// selecting every component.
///
/// The JS `fs` plugin can only read paths the user explicitly picked or dropped,
/// so it cannot reach a sidecar that was not selected; this reads them directly.
/// It is scoped to shapefile sidecar extensions, so it cannot read arbitrary
/// files. The directory is matched case-insensitively (handling `.SHX`/`.DBF` and
/// mixed-case base names), and each sidecar is returned under the `.shp`'s base
/// name with a lowercased extension so the registered names line up. Missing
/// siblings are skipped; an unreadable directory yields an empty list.
#[tauri::command]
pub(crate) fn read_shapefile_siblings(path: String) -> Result<Vec<ShapefileSibling>, String> {
    if !is_safe_absolute_path(&path) || !path.to_ascii_lowercase().ends_with(".shp") {
        return Err(format!(
            "Refusing to read siblings for \"{path}\": not an absolute local shapefile path"
        ));
    }
    let canonical_shp = match fs::canonicalize(&path) {
        Ok(canonical) => canonical,
        Err(_) => return Ok(Vec::new()),
    };
    let resolved_shp = canonical_shp.to_string_lossy();
    if is_unc_resolved_path(&resolved_shp)
        || !resolved_shp.to_ascii_lowercase().ends_with(".shp")
        || !canonical_shp.is_file()
    {
        return Ok(Vec::new());
    }
    let Some(canonical_parent) = canonical_shp.parent() else {
        return Ok(Vec::new());
    };
    let Some(canonical_stem) = canonical_shp.file_stem().and_then(|stem| stem.to_str()) else {
        return Ok(Vec::new());
    };
    let Some(requested_stem) = Path::new(&path).file_stem().and_then(|stem| stem.to_str()) else {
        return Ok(Vec::new());
    };
    let entries = match fs::read_dir(canonical_parent) {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()),
    };
    let mut siblings = Vec::new();
    for entry in entries.flatten() {
        let entry_path = entry.path();
        let (Some(entry_stem), Some(extension)) = (
            entry_path.file_stem().and_then(|stem| stem.to_str()),
            entry_path
                .extension()
                .and_then(|extension| extension.to_str()),
        ) else {
            continue;
        };
        if !entry_stem.eq_ignore_ascii_case(canonical_stem) {
            continue;
        }
        let extension = extension.to_ascii_lowercase();
        if !SHAPEFILE_SIDECAR_EXTENSIONS.contains(&extension.as_str()) {
            continue;
        }
        // Canonicalize each sibling and verify it remains a regular sidecar
        // file inside the shapefile's directory so symlinks cannot escape.
        let Ok(canonical_entry) = fs::canonicalize(&entry_path) else {
            continue;
        };
        let resolved_entry = canonical_entry.to_string_lossy();
        if is_unc_resolved_path(&resolved_entry)
            || !canonical_entry.starts_with(canonical_parent)
            || !canonical_entry.is_file()
        {
            continue;
        }
        let canonical_ext = canonical_entry
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase());
        if !canonical_ext
            .as_deref()
            .is_some_and(|ext| SHAPEFILE_SIDECAR_EXTENSIONS.contains(&ext))
        {
            continue;
        }
        if let Ok(data) = fs::read(&canonical_entry) {
            siblings.push(ShapefileSibling {
                name: format!("{requested_stem}.{extension}"),
                data,
            });
        }
    }
    Ok(siblings)
}

/// Whether `path` is a safe absolute local path: an absolute POSIX (`/...`) or
/// Windows drive-letter (`C:\...`) path, never a UNC (`\\host\share`) share, and
/// free of `..` traversal segments. The shared absolute/non-UNC/no-traversal
/// guard behind [`is_allowed_local_vector_path`], kept separate so that
/// byte-parsing lives in one place rather than being duplicated per caller.
pub(crate) fn is_safe_absolute_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    let is_separator = |byte: u8| byte == b'/' || byte == b'\\';
    if bytes.len() >= 2 && is_separator(bytes[0]) && is_separator(bytes[1]) {
        return false;
    }
    let is_posix_absolute = bytes.first() == Some(&b'/');
    let is_windows_drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && is_separator(bytes[2]);
    if !is_posix_absolute && !is_windows_drive {
        return false;
    }
    !path.split(['/', '\\']).any(|segment| segment == "..")
}

#[cfg(test)]
mod tests {
    use super::{
        hidden_drop_paths, is_allowed_geojson_write_path, is_allowed_local_vector_path,
        is_safe_absolute_path, is_unc_resolved_path, write_local_geojson_file,
    };
    use std::env;
    use std::fs;

    #[test]
    fn allows_absolute_vector_paths() {
        assert!(is_allowed_local_vector_path("/home/u/cities.geojson"));
        assert!(is_allowed_local_vector_path(
            "C:\\Users\\smith\\Mile_Markers.geojson"
        ));
        assert!(is_allowed_local_vector_path("C:/data/roads.gpkg"));
        // Case-insensitive extension; a ".." inside the filename is fine.
        assert!(is_allowed_local_vector_path("/data/v1..2.SHP"));
    }

    #[test]
    fn geojson_write_path_accepts_only_absolute_geojson_files() {
        assert!(is_allowed_geojson_write_path("/data/parks.geojson"));
        assert!(is_allowed_geojson_write_path("/data/parks.JSON"));
        assert!(is_allowed_geojson_write_path("C:\\gis\\parks.GeoJSON"));
        // Other vector formats go through the sidecar, never this command.
        assert!(!is_allowed_geojson_write_path("/data/parks.gpkg"));
        assert!(!is_allowed_geojson_write_path("/data/parks.shp"));
        // Project files are not layer sources.
        assert!(!is_allowed_geojson_write_path("/data/map.geolibre.json"));
        assert!(!is_allowed_geojson_write_path("/data/map.GEOLIBRE.JSON"));
        // Relative, traversal, and UNC paths.
        assert!(!is_allowed_geojson_write_path("parks.geojson"));
        assert!(!is_allowed_geojson_write_path("/data/../etc/parks.geojson"));
        assert!(!is_allowed_geojson_write_path(
            "//server/share/parks.geojson"
        ));
        assert!(!is_allowed_geojson_write_path(""));
    }

    #[test]
    fn unc_resolved_paths_are_detected() {
        assert!(is_unc_resolved_path(r"\\?\unc\host\share\parks.geojson"));
        assert!(is_unc_resolved_path(r"\\?\UNC\host\share\parks.geojson"));
        assert!(is_unc_resolved_path(r"\\host\share\parks.geojson"));
        assert!(is_unc_resolved_path("//host/share/parks.geojson"));
        assert!(!is_unc_resolved_path(r"\\?\c:\gis\parks.geojson"));
        assert!(!is_unc_resolved_path("/home/user/parks.geojson"));
    }

    #[test]
    fn write_local_geojson_file_replaces_an_existing_file_only() {
        let dir = std::env::temp_dir().join(format!("geolibre-write-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let old = r#"{"type":"FeatureCollection","features":[]}"#;
        let new = r#"{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"area":99},"geometry":null}]}"#;
        let target = dir.join("parks.geojson");
        fs::write(&target, old).unwrap();
        let path = target.to_string_lossy().into_owned();

        write_local_geojson_file(path.clone(), new.into()).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), new);
        // Only the target remains: the temporary file was renamed over it.
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);

        // Contents that are not a FeatureCollection are refused, including a
        // FeatureCollection without a `features` array.
        assert!(write_local_geojson_file(path.clone(), r#"{"a":1}"#.into()).is_err());
        assert!(write_local_geojson_file(
            path.clone(),
            r#"{"type":"FeatureCollection","features":"x"}"#.into()
        )
        .is_err());
        assert!(
            write_local_geojson_file(path.clone(), r#"{"type":"FeatureCollection"}"#.into())
                .is_err()
        );
        // ...or one whose features are not all Feature objects.
        assert!(write_local_geojson_file(
            path.clone(),
            r#"{"type":"FeatureCollection","features":[null]}"#.into()
        )
        .is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), new);
        assert_eq!(fs::read_to_string(&target).unwrap(), new);

        // A missing file is not created.
        let missing = dir.join("missing.geojson").to_string_lossy().into_owned();
        assert!(write_local_geojson_file(missing, new.into()).is_err());
        assert!(!dir.join("missing.geojson").exists());

        // An existing `.json` file that is not GeoJSON (a config file, say) is
        // never overwritten.
        let config = dir.join("settings.json");
        fs::write(&config, r#"{"theme":"dark"}"#).unwrap();
        let config_path = config.to_string_lossy().into_owned();
        assert!(write_local_geojson_file(config_path, new.into()).is_err());
        assert_eq!(fs::read_to_string(&config).unwrap(), r#"{"theme":"dark"}"#);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn write_local_geojson_file_keeps_the_target_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("geolibre-perm-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("private.geojson");
        fs::write(&target, r#"{"type":"FeatureCollection","features":[]}"#).unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();

        write_local_geojson_file(
            target.to_string_lossy().into_owned(),
            r#"{"type":"FeatureCollection","features":[]}"#.into(),
        )
        .unwrap();
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_non_vector_relative_or_traversal_paths() {
        // Non-vector extension.
        assert!(!is_allowed_local_vector_path("/etc/passwd"));
        // Relative path.
        assert!(!is_allowed_local_vector_path("cities.geojson"));
        // Directory traversal segments.
        assert!(!is_allowed_local_vector_path("/data/../etc/secret.geojson"));
        assert!(!is_allowed_local_vector_path(
            "C:\\data\\..\\secret.geojson"
        ));
        // UNC network paths, both the backslash and forward-slash forms.
        assert!(!is_allowed_local_vector_path(
            "\\\\server\\share\\x.geojson"
        ));
        assert!(!is_allowed_local_vector_path("//server/share/x.geojson"));
        // Empty string is not an absolute path.
        assert!(!is_allowed_local_vector_path(""));
        // No extension, and a trailing dot (empty extension).
        assert!(!is_allowed_local_vector_path("/home/user/noextension"));
        assert!(!is_allowed_local_vector_path("/home/user/file."));
    }

    #[test]
    fn hidden_drop_paths_reports_missing_scoped_paths_only_in_flatpak() {
        let existing = env::temp_dir().to_string_lossy().into_owned();
        let missing = "/geolibre-issue-3393-missing/dem.tif".to_string();
        let unscoped = "/geolibre-issue-3393-unscoped/dem.tif".to_string();
        let paths = vec![existing.clone(), missing.clone(), unscoped.clone()];
        let allowed = |path: &str| path != unscoped;
        assert_eq!(
            hidden_drop_paths(paths.clone(), true, allowed),
            vec![missing]
        );
        assert!(hidden_drop_paths(paths, false, allowed).is_empty());
    }

    #[test]
    fn is_safe_absolute_path_accepts_absolute_local_dirs() {
        assert!(is_safe_absolute_path("/home/user/data"));
        assert!(is_safe_absolute_path("/data"));
        assert!(is_safe_absolute_path("C:\\Users\\me\\gis"));
        assert!(is_safe_absolute_path("C:/Users/me/gis"));
        // A ".." inside a name (not a traversal segment) is fine.
        assert!(is_safe_absolute_path("/home/user/v1..2"));
    }

    #[test]
    fn is_safe_absolute_path_rejects_unc_traversal_and_relative() {
        // UNC shares (both forms) can auto-authenticate against a remote host.
        assert!(!is_safe_absolute_path("\\\\server\\share"));
        assert!(!is_safe_absolute_path("//server/share"));
        // `..` traversal segments.
        assert!(!is_safe_absolute_path("/home/user/../etc"));
        assert!(!is_safe_absolute_path("C:\\a\\..\\b"));
        // Relative / non-absolute and empty input.
        assert!(!is_safe_absolute_path("home/user"));
        assert!(!is_safe_absolute_path("./data"));
        assert!(!is_safe_absolute_path(""));
        assert!(!is_safe_absolute_path("C:")); // drive letter without a separator
    }

    #[cfg(unix)]
    #[test]
    fn read_local_file_and_siblings_reject_symlink_escapes() {
        let dir = std::env::temp_dir().join(format!(
            "geolibre-symlink-guard-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let secret = dir.join("secret.txt");
        std::fs::write(&secret, b"secret").unwrap();
        let link = dir.join("evil.geojson");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        let err = match super::read_local_file(link.to_string_lossy().into_owned()) {
            Ok(_) => panic!("symlink to non-vector file must fail"),
            Err(err) => err,
        };
        assert!(err.contains("non-vector file"));

        let shp = dir.join("roads.shp");
        std::fs::write(&shp, b"shp").unwrap();
        let dbf_link = dir.join("roads.dbf");
        std::os::unix::fs::symlink(&secret, &dbf_link).unwrap();
        let siblings = super::read_shapefile_siblings(shp.to_string_lossy().into_owned()).unwrap();
        assert!(
            siblings.is_empty(),
            "symlinked non-sidecar sibling must be skipped"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
