//! OAuth callback URL scheme registration: the Linux runtime handler and the
//! Windows portable/bare-exe checks that decide whether to claim the scheme.

#[cfg(windows)]
use std::env;
#[cfg(any(windows, test))]
use std::path::Path;

#[cfg(any(target_os = "linux", windows))]
pub(crate) fn spawn_deep_link_registration(app: &tauri::App) {
    use tauri_plugin_deep_link::DeepLinkExt;
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        if let Err(error) = handle.deep_link().register_all() {
            eprintln!("Deep link: could not register URL schemes ({error}).");
        }
    });
}

/// Marker file `packaging/portable/build-portable.ps1` writes next to the exe.
#[cfg(any(windows, test))]
const PORTABLE_MARKER_FILE: &str = "portable.marker";

/// URL scheme the share-server OAuth callback uses (`plugins > deep-link` in
/// `tauri.conf.json`).
#[cfg(windows)]
const DEEP_LINK_SCHEME: &str = "org.geolibre.desktop";

/// Whether this process should claim the OAuth callback scheme at startup.
///
/// The portable build always does. An MSIX install never does. Any other
/// build (an NSIS/MSI install, or the bare exe from the release page) does
/// only when the scheme has no live handler, so a bare exe never takes the
/// scheme away from an installed copy.
#[cfg(windows)]
pub(crate) fn windows_deep_link_needs_registration() -> bool {
    let Ok(exe) = env::current_exe() else {
        return false;
    };
    if exe_has_portable_marker(&exe) {
        return true;
    }
    if is_msix_install(&exe) {
        return false;
    }
    // Without a `URL Protocol` value Windows never launches the key's command
    // for a URI, so such a key counts as no handler at all.
    let command = windows_registry::CLASSES_ROOT
        .open(DEEP_LINK_SCHEME)
        .ok()
        .filter(|scheme| scheme.get_string("URL Protocol").is_ok())
        .and_then(|scheme| {
            scheme
                .open("shell\\open\\command")
                .and_then(|key| key.get_string(""))
                .ok()
        });
    scheme_handler_missing(command.as_deref(), Path::is_file)
}

/// Whether a portable marker file sits next to `exe`. Kept free of
/// `current_exe()` so the check is testable on every platform.
#[cfg(any(windows, test))]
fn exe_has_portable_marker(exe: &Path) -> bool {
    exe.parent()
        .is_some_and(|dir| dir.join(PORTABLE_MARKER_FILE).is_file())
}

/// Whether `exe` runs from an MSIX package, which Windows always installs
/// under `...\WindowsApps\`.
#[cfg(any(windows, test))]
pub(crate) fn is_msix_install(exe: &Path) -> bool {
    exe.components().any(|component| {
        component
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case("WindowsApps")
    })
}

/// Whether a scheme's registered `shell\open\command` fails to launch an
/// existing program: nothing registered, an unparsable command, or a program
/// that was moved or deleted (such as a bare exe run once from Downloads).
/// So another handler is never overwritten on a guess, a program path with `%`
/// (an unexpanded `REG_EXPAND_SZ` variable) counts as live, and so does an
/// unquoted command: its path may contain spaces, and the handlers Tauri, NSIS
/// and MSI write are always quoted, so an unquoted one belongs to another app.
#[cfg(any(windows, test))]
fn scheme_handler_missing(command: Option<&str>, exists: impl Fn(&Path) -> bool) -> bool {
    let Some(command) = command.map(str::trim).filter(|command| !command.is_empty()) else {
        return true;
    };
    if !command.starts_with('"') {
        return false;
    }
    match handler_program(command) {
        Some(program) => !program.contains('%') && !exists(Path::new(program)),
        None => true,
    }
}

/// The program path of a quoted `shell\open\command` value
/// (`"C:\Program Files\App\app.exe" "%1"`), or `None` when the value is
/// unquoted or the quotes are empty.
#[cfg(any(windows, test))]
fn handler_program(command: &str) -> Option<&str> {
    let program = command.trim_start().strip_prefix('"')?.split('"').next()?;
    (!program.is_empty()).then_some(program)
}

#[cfg(all(test, not(feature = "mas")))]
mod tests {
    use crate::test_support::ScratchDir;

    // Only a regular marker file next to the exe marks the portable build: an
    // installed exe must never claim the scheme, and a same-named directory
    // (or a marker elsewhere) is not the packaging script's output.
    #[cfg(not(feature = "mas"))]
    #[test]
    fn portable_marker_requires_a_file_next_to_the_exe() {
        let root = ScratchDir::new("portable-marker");
        let exe = root.path().join("geolibre-desktop.exe");
        assert!(!super::exe_has_portable_marker(&exe));

        std::fs::create_dir(root.path().join(super::PORTABLE_MARKER_FILE)).unwrap();
        assert!(!super::exe_has_portable_marker(&exe));
        std::fs::remove_dir(root.path().join(super::PORTABLE_MARKER_FILE)).unwrap();

        let nested = root.path().join("bin");
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(root.path().join(super::PORTABLE_MARKER_FILE), "").unwrap();
        assert!(super::exe_has_portable_marker(&exe));
        assert!(!super::exe_has_portable_marker(
            &nested.join("geolibre-desktop.exe")
        ));
    }

    // The bare release exe claims the OAuth callback scheme only when no live
    // handler exists (#3042): an installed copy's handler stays put, while a
    // missing key or a handler pointing at a deleted exe gets replaced.
    #[cfg(not(feature = "mas"))]
    #[test]
    fn scheme_handler_missing_only_without_a_live_program() {
        let installed = r#""C:\Program Files\GeoLibre Desktop\geolibre-desktop.exe" "%1""#;
        assert_eq!(
            super::handler_program(installed),
            Some(r"C:\Program Files\GeoLibre Desktop\geolibre-desktop.exe")
        );
        assert_eq!(super::handler_program(r"C:\Tools\geolibre.exe %1"), None);
        assert_eq!(super::handler_program(r#""" "%1""#), None);
        assert_eq!(super::handler_program("   "), None);

        assert!(super::scheme_handler_missing(None, |_| true));
        assert!(super::scheme_handler_missing(Some(""), |_| true));
        assert!(!super::scheme_handler_missing(Some(installed), |_| true));
        assert!(super::scheme_handler_missing(Some(installed), |_| false));
        assert!(!super::scheme_handler_missing(
            Some(r#""%ProgramFiles%\GeoLibre Desktop\geolibre-desktop.exe" "%1""#),
            |_| false
        ));
        // An unquoted path may hold spaces, so another app's handler is kept.
        assert!(!super::scheme_handler_missing(
            Some(r"C:\Program Files\Other App\app.exe %1"),
            |_| false
        ));
        assert!(super::scheme_handler_missing(Some(r#""" "%1""#), |_| true));
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn msix_install_is_detected_by_windowsapps_path() {
        assert!(super::is_msix_install(std::path::Path::new(
            "/Program Files/WindowsApps/OpenGeospatialSolutions.GeoLibre_3.3.0.0_x64__abc/geolibre-desktop.exe"
        )));
        assert!(super::is_msix_install(std::path::Path::new(
            "/program files/windowsapps/pkg/geolibre-desktop.exe"
        )));
        assert!(!super::is_msix_install(std::path::Path::new(
            "/Users/me/Downloads/geolibre-desktop_windows_x64.exe"
        )));
        assert!(!super::is_msix_install(std::path::Path::new(
            "/Users/me/MyWindowsAppsBackup/geolibre-desktop.exe"
        )));
    }
}
