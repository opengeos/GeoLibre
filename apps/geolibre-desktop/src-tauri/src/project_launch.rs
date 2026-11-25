//! Project files handed to the app by the operating system (argv, a second
//! launch, or a macOS open event), the queue the webview drains, and the
//! guarded `read_project_file` command.

use std::collections::VecDeque;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

const OPEN_PROJECT_FILES_EVENT: &str = "open-project-files";

#[derive(Default)]
pub(crate) struct PendingProjectPaths(pub(crate) Mutex<VecDeque<String>>);

pub(crate) fn current_working_directory() -> PathBuf {
    env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn has_geolibre_project_extension(path: &Path) -> bool {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    lower.ends_with(".geolibre") || lower.ends_with(".geolibre.json")
}

fn project_path_string(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(target_os = "windows")]
    if let Some(unprefixed) = value.strip_prefix(r"\\?\") {
        return unprefixed.to_string();
    }
    value.into_owned()
}

/// A launch argument as a local path.
///
/// The Linux desktop entry uses the `%u` field code, which is the only one that
/// serves both the project file association and the OAuth callback scheme, and
/// it hands over a URI. GIO localizes `file://` to a plain path before exec, but
/// KIO and others do not, so both spellings arrive in practice (#2671).
///
/// Anything that is not a resolvable local `file://` URI is passed through
/// untouched, so a non-UTF-8 path keeps its original bytes and a URI that names
/// a remote host falls through to the caller's extension and canonicalize
/// checks, which reject it.
fn launch_argument_path(argument: std::ffi::OsString) -> PathBuf {
    if let Some(text) = argument.to_str() {
        // Scheme comparison is case-insensitive per RFC 3986. Every real
        // launcher emits lowercase, but matching exactly would silently drop
        // the launch rather than fall back to anything useful.
        if text
            .get(..7)
            .is_some_and(|scheme| scheme.eq_ignore_ascii_case("file://"))
        {
            if let Some(path) = tauri::Url::parse(text)
                .ok()
                .and_then(|url| url.to_file_path().ok())
            {
                return path;
            }
        }
    }
    PathBuf::from(argument)
}

/// Resolve existing GeoLibre project files supplied by the operating system.
///
/// Other CLI flags are deliberately ignored. Resolving the path before it
/// reaches the webview both handles a relative command-line path correctly and
/// prevents a symlink with a project-looking name from bypassing the existing
/// `read_project_file` extension check.
pub(crate) fn project_paths_from_args<I>(args: I, cwd: &Path) -> Vec<String>
where
    I: IntoIterator<Item = std::ffi::OsString>,
{
    args.into_iter()
        .filter_map(|argument| {
            let candidate = launch_argument_path(argument);
            if !has_geolibre_project_extension(&candidate) {
                return None;
            }
            let absolute = if candidate.is_absolute() {
                candidate
            } else {
                cwd.join(candidate)
            };
            let canonical = fs::canonicalize(absolute).ok()?;
            if !canonical.is_file() || !has_geolibre_project_extension(&canonical) {
                return None;
            }
            let path = project_path_string(&canonical);
            is_allowed_project_path(&path).then_some(path)
        })
        .collect()
}

pub(crate) fn enqueue_project_paths(app: &tauri::AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    app.state::<PendingProjectPaths>()
        .0
        .lock()
        .expect("pending project path lock poisoned")
        .extend(paths);
    let _ = app.emit(OPEN_PROJECT_FILES_EVENT, ());
}

pub(crate) fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // `unminimize` is desktop-only in Tauri v2: there is no minimized state
        // on mobile, and referencing it fails to compile for both
        // aarch64-linux-android and aarch64-apple-ios.
        #[cfg(desktop)]
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Drain project paths that arrived through argv or an OS file-open event.
#[tauri::command]
pub(crate) fn take_pending_project_paths(
    state: tauri::State<'_, PendingProjectPaths>,
) -> Vec<String> {
    state
        .0
        .lock()
        .expect("pending project path lock poisoned")
        .drain(..)
        .collect()
}

/// Whether `read_project_file` may read `path`: an absolute local path (POSIX
/// `/...` or a Windows drive-letter `C:\...`, never a UNC `\\host\share`), free
/// of `..` traversal, ending in a GeoLibre project extension — `.geolibre` or
/// `.geolibre.json`. These are the canonical formats `saveProject` writes and
/// `isGeoLibreProjectFileName` recognizes in `file-io/paths.ts`.
///
/// Without this, the command was an arbitrary local-file reader: any webview JS
/// or loaded plugin could `invoke("read_project_file", { path: "~/.ssh/id_rsa" })`
/// and receive the contents. A bare `.json` extension is deliberately NOT
/// accepted: plenty of real secrets are JSON (GCP service-account keys,
/// `application_default_credentials.json`, editor/CLI configs with tokens), so
/// requiring the `.geolibre` marker keeps those out while still reading every
/// real project. Byte-oriented like `is_allowed_local_vector_path` so Windows
/// paths behave the same on any host.
pub(crate) fn is_allowed_project_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    let is_separator = |byte: u8| byte == b'/' || byte == b'\\';

    // Reject UNC paths ("\\server\share" and "//server/share").
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

    if path.split(['/', '\\']).any(|segment| segment == "..") {
        return false;
    }

    let lower = path.to_ascii_lowercase();
    lower.ends_with(".geolibre") || lower.ends_with(".geolibre.json")
}

#[tauri::command]
pub(crate) fn read_project_file(path: String) -> Result<String, String> {
    if !is_allowed_project_path(&path) {
        return Err(format!(
            "Refusing to read \"{path}\": a project file must be an absolute local path whose name ends in .geolibre or .geolibre.json"
        ));
    }
    // Resolve symlinks and re-check the extension, so a symlink named
    // `*.geolibre`/`*.geolibre.json` can't redirect the read to an arbitrary
    // target (e.g. `~/notes.geolibre.json -> ~/.ssh/id_rsa`). Only the resolved
    // extension is re-checked (not the full guard): `canonicalize` yields a
    // `\\?\C:\…` verbatim path on Windows, which the UNC check would reject.
    let canonical =
        fs::canonicalize(&path).map_err(|error| format!("Could not read project file: {error}"))?;
    let resolved = canonical.to_string_lossy().to_ascii_lowercase();
    if !(resolved.ends_with(".geolibre") || resolved.ends_with(".geolibre.json")) {
        return Err(format!(
            "Refusing to read \"{path}\": resolves to a non-project file"
        ));
    }
    fs::read_to_string(&canonical).map_err(|error| format!("Could not read project file: {error}"))
}

#[cfg(test)]
mod tests {
    use super::is_allowed_project_path;
    #[cfg(not(feature = "mas"))]
    use super::{project_path_string, project_paths_from_args};
    #[cfg(not(feature = "mas"))]
    use crate::test_support::ScratchDir;
    #[cfg(not(feature = "mas"))]
    use std::ffi::OsString;

    #[cfg(not(feature = "mas"))]
    #[test]
    fn resolves_only_existing_project_arguments() {
        let root = ScratchDir::new("project-arguments");
        let short = root.path().join("short.geolibre");
        let legacy = root.path().join("legacy.geolibre.json");
        let ordinary_json = root.path().join("ordinary.json");
        std::fs::write(&short, "{}").unwrap();
        std::fs::write(&legacy, "{}").unwrap();
        std::fs::write(&ordinary_json, "{}").unwrap();

        let paths = project_paths_from_args(
            [
                OsString::from("--verbose"),
                OsString::from("short.geolibre"),
                legacy.clone().into_os_string(),
                ordinary_json.into_os_string(),
                OsString::from("missing.geolibre"),
            ],
            root.path(),
        );

        assert_eq!(
            paths,
            [
                project_path_string(&short.canonicalize().unwrap()),
                project_path_string(&legacy.canonicalize().unwrap()),
            ]
        );
    }

    #[cfg(all(unix, not(feature = "mas")))]
    #[test]
    fn accepts_file_uri_arguments_from_linux_launchers() {
        let root = ScratchDir::new("project-argument-file-uri");
        let spaced = root.path().join("my project.geolibre");
        std::fs::write(&spaced, "{}").unwrap();
        let canonical = spaced.canonicalize().unwrap();
        // Percent-encoded, exactly as a launcher that does not localize `%u`
        // spells it. The bare path spelling is covered above.
        let uri = format!(
            "file://{}",
            canonical
                .to_str()
                .unwrap()
                .replace('%', "%25")
                .replace(' ', "%20")
        );

        assert_eq!(
            project_paths_from_args([OsString::from(uri)], root.path()),
            [project_path_string(&canonical)]
        );
    }

    #[cfg(all(unix, not(feature = "mas")))]
    #[test]
    fn accepts_file_uris_whatever_the_scheme_casing() {
        let root = ScratchDir::new("project-argument-uri-casing");
        let project = root.path().join("cased.geolibre");
        std::fs::write(&project, "{}").unwrap();
        let canonical = project.canonicalize().unwrap();

        for scheme in ["file", "FILE", "File"] {
            assert_eq!(
                project_paths_from_args(
                    [OsString::from(format!(
                        "{scheme}://{}",
                        canonical.to_str().unwrap()
                    ))],
                    root.path()
                ),
                [project_path_string(&canonical)],
                "{scheme}:// was not accepted"
            );
        }
    }

    #[cfg(all(unix, not(feature = "mas")))]
    #[test]
    fn rejects_file_uris_that_name_a_remote_host() {
        let root = ScratchDir::new("project-argument-remote-uri");
        assert!(project_paths_from_args(
            [OsString::from("file://example.com/shared/project.geolibre")],
            root.path()
        )
        .is_empty());
    }

    #[cfg(all(unix, not(feature = "mas")))]
    #[test]
    fn rejects_project_named_symlinks_to_other_file_types() {
        let root = ScratchDir::new("project-argument-symlink");
        let target = root.path().join("private.json");
        let link = root.path().join("looks-safe.geolibre");
        std::fs::write(&target, "{}").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert!(project_paths_from_args([link.into_os_string()], root.path()).is_empty());
    }

    #[test]
    fn project_path_guard_allows_projects_and_blocks_secrets() {
        assert!(is_allowed_project_path("/home/u/map.geolibre.json"));
        assert!(is_allowed_project_path("/home/u/map.geolibre"));
        assert!(is_allowed_project_path("C:\\Users\\u\\map.geolibre.json"));
        // Secrets and traversal are refused.
        assert!(!is_allowed_project_path("/home/u/.ssh/id_rsa"));
        assert!(!is_allowed_project_path("/home/u/.aws/credentials"));
        assert!(!is_allowed_project_path(
            "/home/u/../../etc/hosts.geolibre.json"
        ));
        assert!(!is_allowed_project_path("relative/map.geolibre.json"));
        assert!(!is_allowed_project_path(
            "\\\\server\\share\\map.geolibre.json"
        ));
        // A bare .json file (e.g. a JSON credential store) is NOT a project.
        assert!(!is_allowed_project_path(
            "/home/u/.config/gcloud/application_default_credentials.json"
        ));
        assert!(!is_allowed_project_path("C:\\Users\\u\\map.json"));
    }
}
