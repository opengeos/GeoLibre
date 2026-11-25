mod app_error;
mod arcgis_http;
mod aws_credentials;
mod aws_sts;
mod deep_links;
mod deployment;
mod desktop_updater;
mod fs_util;
mod guarded_http;
mod http_client;
mod image_scope;
mod in_flight;
mod linux_webkit;
mod local_files;
mod local_media_protocol;
mod mbtiles;
mod native_document_copies;
mod offline_extraction_jobs;
mod offline_mbtiles;
mod offline_package_commands;
mod offline_packages;
mod plugin_http;
mod plugins_io;
#[cfg(not(feature = "mas"))]
mod process_lifetime;
mod project_launch;
mod remote_download;
#[cfg(test)]
mod test_support;
#[cfg(not(feature = "mas"))]
mod uv_bootstrap;
// Earth Engine sign-in uses Google's OAuth loopback-redirect flow, which binds
// a listener on 127.0.0.1 to accept the browser's redirect. Accepting an
// inbound connection requires the `com.apple.security.network.server`
// entitlement, which App Review rejects for an app that otherwise only makes
// outgoing requests (guideline 2.4.5, submission 76036eca). Both Apple App
// Store targets therefore compile the whole flow out and hide the Earth Engine
// UI, so no Apple build ever binds a listening socket: the `mas` (macOS) build,
// and iOS — which ships through the same review pipeline and has no way to
// justify a listener either. Every other target (Developer ID macOS, Windows,
// Linux, Android, web) keeps it. See docs/mac-app-store.md.
#[cfg(not(any(feature = "mas", target_os = "ios")))]
mod earth_engine_oauth;
// App Store stub, mirroring the `native_duckdb` pattern below: the commands stay
// in the handler list (so a stale panel state or an external plugin gets a clear
// message instead of an "unknown command" error) but no socket is ever bound.
#[cfg(any(feature = "mas", target_os = "ios"))]
mod earth_engine_oauth {
    const UNAVAILABLE: &str =
        "Earth Engine sign-in is not available in the App Store build of GeoLibre.";

    #[tauri::command]
    pub fn start_earth_engine_oauth(_client_id: String) -> Result<serde_json::Value, String> {
        Err(UNAVAILABLE.to_string())
    }

    #[tauri::command]
    pub fn poll_earth_engine_oauth(_state_id: String) -> Result<Option<serde_json::Value>, String> {
        Err(UNAVAILABLE.to_string())
    }
}
// Sign in with ChatGPT for the AI Assistant: an OAuth loopback listener like
// Earth Engine's (so never in an Apple App Store build), with the refresh token
// in the OS keychain (so desktop only).
#[cfg(all(
    any(target_os = "macos", target_os = "windows", target_os = "linux"),
    not(feature = "mas")
))]
mod chatgpt_auth;
#[cfg(not(all(
    any(target_os = "macos", target_os = "windows", target_os = "linux"),
    not(feature = "mas")
)))]
mod chatgpt_auth {
    const UNAVAILABLE: &str = "Sign in with ChatGPT is not available in this build of GeoLibre.";

    #[derive(Default)]
    pub struct ChatGptAuthState;

    #[tauri::command]
    pub fn chatgpt_status() -> Result<serde_json::Value, String> {
        Err(UNAVAILABLE.to_string())
    }

    #[tauri::command]
    pub fn chatgpt_sign_in_start() -> Result<serde_json::Value, String> {
        Err(UNAVAILABLE.to_string())
    }

    #[tauri::command]
    pub fn chatgpt_sign_in_poll() -> Result<serde_json::Value, String> {
        Err(UNAVAILABLE.to_string())
    }

    #[tauri::command]
    pub fn chatgpt_sign_in_cancel() {}

    #[tauri::command]
    pub fn chatgpt_sign_out() -> Result<serde_json::Value, String> {
        Err(UNAVAILABLE.to_string())
    }

    #[tauri::command]
    pub fn chatgpt_request() -> Result<(), String> {
        Err(UNAVAILABLE.to_string())
    }

    #[tauri::command]
    pub fn chatgpt_request_cancel() {}
}
#[cfg(feature = "native-duckdb")]
mod native_duckdb;
#[cfg(not(feature = "native-duckdb"))]
mod native_duckdb {
    #[tauri::command]
    pub async fn count_native_vector_file_features(
        _path: String,
        _layer: Option<String>,
        _override_source_crs: Option<String>,
        _bbox: Option<[f64; 4]>,
    ) -> Result<usize, String> {
        Err("Native DuckDB is not enabled in this build.".to_string())
    }

    #[tauri::command]
    pub async fn load_native_vector_file(
        _path: String,
        _layer: Option<String>,
        _override_source_crs: Option<String>,
        _bbox: Option<[f64; 4]>,
    ) -> Result<serde_json::Value, String> {
        Err("Native DuckDB is not enabled in this build.".to_string())
    }

    #[tauri::command]
    pub async fn load_native_vector_file_binary(
        _path: String,
        _layer: Option<String>,
        _override_source_crs: Option<String>,
        _bbox: Option<[f64; 4]>,
        _format: Option<String>,
    ) -> Result<tauri::ipc::Response, String> {
        Err("Native DuckDB is not enabled in this build.".to_string())
    }
}

// The `mas` (Mac App Store) feature builds for the App Sandbox, where the app
// may neither download executable code (guideline 2.5.2) nor spawn it. DuckDB
// loads its spatial extension as unsigned native code at runtime, so the two
// features can never be combined.
#[cfg(all(feature = "mas", feature = "native-duckdb"))]
compile_error!("the `mas` (Mac App Store) build must not enable `native-duckdb`: DuckDB loads its spatial extension as unsigned native code at runtime, which App Sandbox and App Store guideline 2.5.2 forbid.");

mod http_body;
// In-process PostGIS vector tiles (ST_AsMVT) for Android/iOS, which cannot run
// the Martin tile server (GeoLibre#2091). Outbound connections only: no
// listening socket and no spawned process, so every build target can carry it.
mod postgis_tiles;
// OS credential store across all platforms: macOS/iOS Keychain, Windows
// Credential Manager, Linux Secret Service, and encrypted AES-256-GCM vault on
// Android (issue #1667, #3570).
mod secure_store;

#[cfg(not(any(feature = "mas", target_os = "ios")))]
use earth_engine_oauth::EarthEngineOAuthState;
use earth_engine_oauth::{poll_earth_engine_oauth, start_earth_engine_oauth};
#[cfg(not(feature = "mas"))]
use flate2::read::GzDecoder;
use serde::Serialize;
#[cfg(not(feature = "mas"))]
use std::collections::HashSet;
use std::collections::VecDeque;
use std::env;
#[cfg(not(feature = "mas"))]
use std::ffi::OsStr;
#[cfg(not(feature = "mas"))]
use std::fs;
#[cfg(not(feature = "mas"))]
use std::fs::File;
#[cfg(not(feature = "mas"))]
use std::io::Read;
#[cfg(not(feature = "mas"))]
use std::io::{BufRead, BufReader, Cursor, Write};
#[cfg(not(feature = "mas"))]
use std::net::TcpListener;
use std::path::Path;
#[cfg(not(feature = "mas"))]
use std::path::PathBuf;
#[cfg(not(feature = "mas"))]
use std::process::{Child, Command, Stdio};
#[cfg(not(feature = "mas"))]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(not(feature = "mas"))]
use std::sync::Arc;
use std::sync::Mutex;
#[cfg(not(feature = "mas"))]
use std::thread;
#[cfg(not(feature = "mas"))]
use std::time::Duration;
use tauri::Manager;

// OAuth popups are a desktop-only, multi-window concept; Android/iOS have no
// equivalent, and `WebviewWindowBuilder::{on_new_window, window_features}` do
// not exist on the mobile runtime.
#[cfg(desktop)]
static POPUP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[cfg(not(feature = "mas"))]
const MARTIN_VERSION: &str = "martin-v1.10.1";
#[cfg(not(feature = "mas"))]
const MARTIN_RELEASE_BASE_URL: &str = "https://github.com/maplibre/martin/releases/download";
#[cfg(not(feature = "mas"))]
const MARTIN_START_ATTEMPTS: usize = 3;
#[cfg(not(feature = "mas"))]
const MARTIN_HEALTH_ATTEMPTS: usize = 30;
#[cfg(not(feature = "mas"))]
const SIDECAR_HEALTH_ATTEMPTS: usize = 180;
#[cfg(not(feature = "mas"))]
const SIDECAR_PORT: u16 = 8765;
// Returned when a sidecar from an earlier launch holds SIDECAR_PORT and could not
// be reclaimed. The frontend (src/lib/sidecar.ts) recognizes it by the phrase
// "does not accept this session's token" and shows it instead of the bare 401
// the stale sidecar would answer later requests with (GeoLibre#2959).
#[cfg(not(feature = "mas"))]
const STALE_SIDECAR_ERROR: &str = "A GeoLibre processing server from a previous session is \
     still running on port 8765 but does not accept this session's token. Quit any stray \
     GeoLibre processes and try again.";
// The sidecar's PostGIS endpoints refuse every destination until this variable
// names the allowed hosts — the check that stops a *shared* deployment (the
// Docker image, where the sidecar is reachable same-origin through the nginx
// proxy) from being pointed at arbitrary internal databases. See
// `_validate_postgis_target` in
// backend/geolibre_server/geolibre_server/app/postgis.py.
#[cfg(not(feature = "mas"))]
const POSTGIS_HOSTS_ENV: &str = "GEOLIBRE_POSTGIS_HOSTS";
// SQL Server endpoints use the same destination restriction for shared deployments.
#[cfg(not(feature = "mas"))]
const MSSQL_HOSTS_ENV: &str = "GEOLIBRE_MSSQL_HOSTS";
#[cfg(not(feature = "mas"))]
const MSSQL_HOSTS_DESKTOP_DEFAULT: &str = "*";
// Desktop starts its loopback sidecar for one user, so the default is unrestricted.
#[cfg(not(feature = "mas"))]
const POSTGIS_HOSTS_DESKTOP_DEFAULT: &str = "*";
// The desktop JupyterLab server for the Notebook panel. Loopback-bound and
// token-gated; uses its own uv project environment so it never disturbs the
// FastAPI sidecar's env. First start can be slow while uv syncs JupyterLab.
#[cfg(not(feature = "mas"))]
const JUPYTER_PORT: u16 = 8766;
// Polled once per second, so up to ~4 minutes — generous headroom for the
// first-run `uv sync` of JupyterLab on a cold cache.
#[cfg(not(feature = "mas"))]
const JUPYTER_HEALTH_ATTEMPTS: usize = 240;
#[cfg(all(unix, not(feature = "mas")))]
const SIGTERM: i32 = 15;
#[cfg(all(unix, not(feature = "mas")))]
const SIGKILL: i32 = 9;

#[cfg(all(unix, not(feature = "mas")))]
unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

#[cfg(not(feature = "mas"))]
struct MartinServerState {
    process: Mutex<Option<MartinProcess>>,
    // Serialize concurrent starts so two callers do not race to bind ports.
    lifecycle: Mutex<()>,
    // Bumped immediately on stop/exit so an in-progress startup drops its child
    // instead of installing it, without making Stop wait for startup to finish.
    generation: std::sync::atomic::AtomicU64,
}

#[cfg(not(feature = "mas"))]
struct SidecarServerState {
    process: Mutex<Option<SidecarProcess>>,
    // Serialize start/stop across every UI surface that can request the shared
    // sidecar. Without this, two callers can both pass the reuse check and race
    // to bind the fixed port, or a restart can overlap the previous teardown.
    lifecycle: Mutex<()>,
    // Bumped on exit so an in-progress startup drops its child instead of
    // storing it after teardown.
    generation: std::sync::atomic::AtomicU64,
}

#[cfg(not(feature = "mas"))]
struct JupyterServerState {
    process: Mutex<Option<JupyterProcess>>,
    // Token of the currently running server, so a reuse path can hand the same
    // URL back without restarting.
    token: Mutex<Option<String>>,
    // Held for the whole of start_jupyter_server_blocking so two concurrent
    // start calls can't both spawn on the same port (the loser would exit 1).
    startup: Mutex<()>,
    // Bumped immediately on stop/exit so Stop returns immediately while any
    // in-progress startup discards its child instead of installing it.
    generation: std::sync::atomic::AtomicU64,
}

#[cfg(not(feature = "mas"))]
struct MartinProcess {
    child: Child,
}

#[cfg(not(feature = "mas"))]
impl MartinProcess {
    /// Whether the Martin child is still alive. A server that crashed or was
    /// killed from outside must not keep blocking new starts with "already
    /// running", so the start path clears the slot when this reports false.
    /// Only a confirmed exit counts: a failed `try_wait` keeps the process, so
    /// a transient inspection error can never kill a healthy server.
    fn is_running(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(Some(_)))
    }
}

/// Clear a recorded Martin process that has already exited, then report
/// whether a live one is still holding the slot.
#[cfg(not(feature = "mas"))]
fn martin_slot_is_busy(process: &mut Option<MartinProcess>) -> bool {
    if process.as_mut().is_some_and(|martin| !martin.is_running()) {
        *process = None;
    }
    process.is_some()
}

#[cfg(not(feature = "mas"))]
struct SidecarProcess {
    child: Child,
}

#[cfg(not(feature = "mas"))]
struct JupyterProcess {
    child: Child,
}

#[cfg(not(feature = "mas"))]
impl SidecarProcess {
    fn terminate(&mut self) {
        terminate_sidecar_child(&mut self.child);
    }
}

#[cfg(not(feature = "mas"))]
impl Drop for MartinProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(not(feature = "mas"))]
impl Drop for SidecarProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg(not(feature = "mas"))]
impl JupyterProcess {
    fn terminate(&mut self) {
        // Same process-group teardown as the sidecar (the child is spawned with
        // its own group, so this reaps `uv`/`jupyter`/kernel descendants).
        terminate_sidecar_child(&mut self.child);
    }
}

#[cfg(not(feature = "mas"))]
impl Drop for JupyterProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    linux_webkit::configure_linux_webkit();

    let pending_project_paths = project_launch::PendingProjectPaths(Mutex::new(VecDeque::from(
        project_launch::project_paths_from_args(
            env::args_os().skip(1),
            &project_launch::current_working_directory(),
        ),
    )));
    let builder = tauri::Builder::default();

    // Windows and Linux deliver a file-association launch by starting another
    // process with the document path in argv. Keep one workspace and forward
    // that path to it. Register this first, as required by the plugin.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        let paths = project_launch::project_paths_from_args(
            args.into_iter().skip(1).map(std::ffi::OsString::from),
            Path::new(&cwd),
        );
        project_launch::enqueue_project_paths(app, paths);
        project_launch::focus_main_window(app);
    }));

    let builder = builder
        .manage(pending_project_paths)
        .manage(image_scope::SelectedImagePaths::default())
        .manage(arcgis_http::ArcGISRequests::default())
        .manage(plugin_http::PluginHttpRequests::default())
        .manage(remote_download::RemoteDownloads::default())
        .manage(local_media_protocol::LocalMediaPools::default())
        .manage(offline_package_commands::NativeOfflinePackages::default())
        .register_asynchronous_uri_scheme_protocol("mbtiles", |ctx, request, responder| {
            local_media_protocol::handle_mbtiles_protocol(
                ctx.app_handle().clone(),
                request,
                responder,
            );
        })
        .register_asynchronous_uri_scheme_protocol("local-pmtiles", |ctx, request, responder| {
            local_media_protocol::handle_range_media_protocol(
                ctx.app_handle().clone(),
                request,
                responder,
                &[".pmtiles"],
                "application/octet-stream",
            );
        })
        .register_asynchronous_uri_scheme_protocol("local-cog", |ctx, request, responder| {
            local_media_protocol::handle_range_media_protocol(
                ctx.app_handle().clone(),
                request,
                responder,
                &[".tif", ".tiff"],
                "image/tiff",
            );
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Runs before persisted-scope's setup hook so legacy photo grants are
        // removed before its synchronous restore can delay window creation.
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("photo-scope-cleanup")
                .setup(|app, _api| {
                    image_scope::prune_persisted_image_scopes(app);
                    Ok(())
                })
                .build(),
        )
        // Must init after the fs plugin: it restores previously-granted fs
        // scope (e.g. Browser-panel pinned folders) so they survive a restart.
        //
        // SECURITY / SCOPE NOTE (deliberate, maintainer-approved): this persists
        // *every* dialog-granted fs scope for the life of the install, not just
        // Browser-panel folder pins — "Open Vector File", "Open Raster", "Save
        // Project As", etc. also extend fs scope to the picked path, and all of
        // those now survive a restart. There is also no per-path "forget", so
        // unpinning a folder in the Browser panel removes the UI pin but does
        // not revoke its (persisted) read scope. Accepted for durable pins;
        // revisit if a narrower per-source scope or a revoke path is wanted.
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_geolocation::init())
        .plugin(tauri_plugin_gnss_bluetooth::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init());

    let context = tauri::generate_context!();

    // Signed desktop auto-updater for non-Store desktop builds. The plugin
    // panics during app build when `plugins.updater` is missing or invalid
    // (its `pubkey` is required), so only register it when its own config
    // deserializer accepts the block. Otherwise the update commands report
    // `configured: false` (issue #3631).
    #[cfg(all(
        any(target_os = "macos", target_os = "windows", target_os = "linux"),
        feature = "desktop-updater",
        not(feature = "mas")
    ))]
    let builder = {
        let configured =
            desktop_updater::updater_plugin_configured(context.config().plugins.0.get("updater"));
        let builder = builder.manage(desktop_updater::DesktopUpdaterEnabled(configured));
        if configured {
            builder.plugin(tauri_plugin_updater::Builder::new().build())
        } else {
            builder
        }
    };

    // The Earth Engine OAuth loopback listener is compiled out of the Apple App
    // Store builds (see the module gate at the top of this file); the stub
    // commands are stateless, so the state goes with it.
    #[cfg(not(any(feature = "mas", target_os = "ios")))]
    let builder = builder.manage(EarthEngineOAuthState::default());

    // The AWS SSO device sign-in is HTTPS plus a cache file, so it runs in
    // every build, the App Store one included (which has no AWS CLI fallback).
    let builder = builder.manage(aws_credentials::AwsSsoLoginState::default());

    // The ChatGPT sign-in (and the requests it authorizes) for the AI Assistant.
    let builder = builder.manage(chatgpt_auth::ChatGptAuthState::default());

    // Pools for the in-process PostGIS tile renderer, created on first connect.
    let builder = builder.manage(postgis_tiles::PostgisTilesState::default());

    // The plugin bundles the asset read may serve from; external plugins are
    // compiled out of the MAS build, so the state goes with them.
    #[cfg(not(feature = "mas"))]
    let builder = builder.manage(plugins_io::LoadedPluginBundles::default());

    // The Martin/sidecar/Jupyter process managers exist only where the commands
    // that spawn those processes do; the MAS build compiles both out together.
    #[cfg(not(feature = "mas"))]
    let builder = builder
        .manage(MartinServerState {
            process: Mutex::new(None),
            lifecycle: Mutex::new(()),
            generation: std::sync::atomic::AtomicU64::new(0),
        })
        .manage(SidecarServerState {
            process: Mutex::new(None),
            lifecycle: Mutex::new(()),
            generation: std::sync::atomic::AtomicU64::new(0),
        })
        .manage(JupyterServerState {
            process: Mutex::new(None),
            token: Mutex::new(None),
            startup: Mutex::new(()),
            generation: std::sync::atomic::AtomicU64::new(0),
        });

    let app = builder
        .invoke_handler(tauri::generate_handler![
            offline_package_commands::prepare_native_offline_extraction,
            offline_package_commands::cancel_native_offline_extraction,
            offline_package_commands::inspect_native_mbtiles_source,
            offline_package_commands::extract_native_mbtiles_package,
            offline_package_commands::list_native_offline_packages,
            offline_package_commands::save_native_offline_package,
            offline_package_commands::verify_native_offline_package,
            offline_package_commands::update_native_offline_package,
            offline_package_commands::delete_native_offline_package,
            close_oauth_popups,
            native_duckdb::count_native_vector_file_features,
            ensure_martin_binary,
            guarded_http::fetch_url_bytes,
            guarded_http::fetch_url_response,
            arcgis_http::fetch_arcgis_response,
            arcgis_http::cancel_arcgis_request,
            plugin_http::plugin_http_request,
            plugin_http::cancel_plugin_http_request,
            remote_download::download_remote_file,
            remote_download::cancel_remote_download,
            remote_download::pick_download_folder,
            remote_download::write_file_to_folder,
            remote_download::take_cached_download,
            aws_credentials::aws_list_profiles,
            aws_credentials::aws_resolve_credentials,
            aws_credentials::aws_sso_login_start,
            aws_credentials::aws_sso_login_poll,
            plugins_io::install_external_plugin_archive,
            plugins_io::list_installed_plugin_archives,
            plugins_io::uninstall_external_plugin_archive,
            native_duckdb::load_native_vector_file,
            native_duckdb::load_native_vector_file_binary,
            desktop_updater::check_desktop_update,
            desktop_updater::install_desktop_update,
            plugins_io::load_external_plugin_bundles,
            plugins_io::read_external_plugin_asset,
            image_scope::pick_image_paths,
            image_scope::read_selected_image,
            deployment::read_admin_profile,
            deployment::read_deployment_policy,
            deployment::is_machine_deployment_policy,
            deployment::read_allowed_file,
            read_env_vars,
            project_launch::take_pending_project_paths,
            native_document_copies::initialize_native_document_copies,
            local_files::allow_raster_asset,
            local_files::sandbox_hidden_drop_paths,
            local_files::read_local_file,
            local_files::write_local_geojson_file,
            project_launch::read_project_file,
            local_files::read_shapefile_siblings,
            guarded_http::resolve_url_redirect,
            mbtiles::read_mbtiles_metadata,
            mbtiles::read_mbtiles_tile,
            start_martin_server,
            stop_martin_server,
            start_geolibre_sidecar,
            stop_geolibre_sidecar,
            start_jupyter_server,
            stop_jupyter_server,
            start_earth_engine_oauth,
            poll_earth_engine_oauth,
            chatgpt_auth::chatgpt_status,
            chatgpt_auth::chatgpt_sign_in_start,
            chatgpt_auth::chatgpt_sign_in_poll,
            chatgpt_auth::chatgpt_sign_in_cancel,
            chatgpt_auth::chatgpt_sign_out,
            chatgpt_auth::chatgpt_request,
            chatgpt_auth::chatgpt_request_cancel,
            secure_store::secure_store_get_many,
            secure_store::secure_store_seal,
            secure_store::secure_store_set,
            secure_store::secure_store_delete,
            postgis_tiles::postgis_tiles_list_sources,
            postgis_tiles::postgis_tiles_source_info,
            postgis_tiles::postgis_tiles_tile,
            postgis_tiles::postgis_tiles_disconnect
        ])
        // A new document in a webview hydrates credentials again, so give it
        // back its one startup read (secure_store.rs, issue #2858).
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                secure_store::reset_read_gate(webview.label());
            }
        })
        .setup(|app| {
            create_main_window(app)?;
            // Nothing on Linux claims the OAuth callback scheme for us.
            // `tauri-bundler` writes `Exec=` into the bundled .desktop with no
            // field code, so `xdg-open org.geolibre.desktop:/oauth/callback?...`
            // starts the app with an empty argv and the authorization code is
            // dropped on the floor; an AppImage installs no .desktop at all.
            // Registering at runtime writes a `%u`-qualified handler entry and
            // makes it the scheme default, which covers deb, rpm, AppImage and
            // the AUR/COPR repackages alike (#2667). Off the main thread: this
            // shells out to update-desktop-database and xdg-mime, and window
            // creation must not wait on them.
            #[cfg(target_os = "linux")]
            deep_links::spawn_deep_link_registration(app);
            // The portable zip has no installer step, so nothing registers the
            // OAuth callback scheme and a sign-in link from the browser never
            // reaches the app (#2667). `build-portable.ps1` drops a marker next
            // to the exe; that build always claims the scheme, per user, at
            // runtime. The bare `geolibre-desktop_windows_x64.exe` release
            // asset has no installer or marker either, so any other non-MSIX
            // build claims it too when no live handler exists (#3042). NSIS/MSI
            // register it at install time, so their handler is live and left
            // alone, and MSIX declares it in the package manifest and
            // virtualizes HKCU writes.
            #[cfg(windows)]
            if deep_links::windows_deep_link_needs_registration() {
                deep_links::spawn_deep_link_registration(app);
            }
            Ok(())
        })
        .build(context)
        .expect("error while building GeoLibre Desktop");

    app.run(|app, event| {
        #[cfg(all(feature = "mas", not(target_os = "macos")))]
        let _ = (&app, &event);
        #[cfg(not(feature = "mas"))]
        if let tauri::RunEvent::Exit = event {
            let martin = app.state::<MartinServerState>();
            martin
                .generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            take_and_drop(&martin.process);

            let sidecar = app.state::<SidecarServerState>();
            sidecar
                .generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            take_and_drop(&sidecar.process);

            let jupyter = app.state::<JupyterServerState>();
            jupyter
                .generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            take_and_drop(&jupyter.process);
        }
        // macOS delivers associated files as native open events instead
        // of argv. Queue them through the same path as a second desktop launch.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            let paths = project_launch::project_paths_from_args(
                urls.into_iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .map(std::ffi::OsString::from),
                Path::new("/"),
            );
            project_launch::enqueue_project_paths(app, paths);
            project_launch::focus_main_window(app);
        }
    });
}

#[cfg(not(feature = "mas"))]
fn take_and_drop<T>(slot: &Mutex<Option<T>>) {
    if let Ok(mut guard) = slot.lock() {
        let taken = guard.take();
        drop(guard);
        drop(taken);
    }
}

/// The only environment variable names `read_env_vars` will ever return. This
/// is a hard, server-side boundary: external plugins and any other JavaScript
/// run in the same (unsandboxed) webview can `invoke("read_env_vars", …)` with
/// arbitrary names, so the allowlist cannot live in the frontend alone or a
/// malicious caller could exfiltrate unrelated shell secrets (SSH_AUTH_SOCK,
/// GITHUB_TOKEN, ambient cloud credentials, …). Kept in sync with
/// `OS_ENV_VAR_NAMES` in `apps/geolibre-desktop/src/lib/assistant/provider.ts`
/// — the `assistant-os-env` test parses this list and asserts the two match.
const ALLOWED_ENV_VARS: &[&str] = &[
    "GEOLIBRE_ASSISTANT_PROVIDER",
    "GEOLIBRE_ASSISTANT_MODEL",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENROUTER_MODEL",
    "AI_GATEWAY_API_KEY",
    "AI_GATEWAY_MODEL",
    "TRUSTEDROUTER_API_KEY",
    "TRUSTEDROUTER_MODEL",
    "OLLAMA_BASE_URL",
    "OLLAMA_MODEL",
    "OPENAI_COMPATIBLE_BASE_URL",
    "OPENAI_COMPATIBLE_API_KEY",
    "OPENAI_COMPATIBLE_MODEL",
    "TAVILY_API_KEY",
    "JEV_API_KEY",
];

/// Read the AI Assistant's allowlisted variables from the OS environment.
///
/// Only names in `ALLOWED_ENV_VARS` that the caller requests are returned,
/// and only when present and non-empty, so the desktop app never leaks the full
/// process environment — nor any variable outside the allowlist — into the
/// webview. This lets the assistant source provider API keys from the user's
/// system/shell environment instead of the project file (issue #1141), keeping
/// secrets out of the saved `.geolibre.json`.
#[tauri::command]
fn read_env_vars(names: Vec<String>) -> std::collections::HashMap<String, String> {
    names
        .into_iter()
        .filter(|name| ALLOWED_ENV_VARS.contains(&name.as_str()))
        .filter_map(|name| {
            let value = env::var(&name).ok()?;
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some((name, trimmed.to_string()))
            }
        })
        .collect()
}

#[tauri::command]
fn close_oauth_popups(app: tauri::AppHandle) {
    for window in app.webview_windows().values() {
        let is_oauth_popup = window.label().starts_with("oauthPopup")
            || window
                .title()
                .map(|title| {
                    title.contains("Earth Engine sign-in")
                        || title.contains("accounts.google.com")
                        || title.contains("Google")
                })
                .unwrap_or(false);
        if is_oauth_popup {
            let _ = window.close();
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MartinBinaryInfo {
    path: String,
    downloaded: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MartinServerInfo {
    base_url: String,
    binary_path: String,
    port: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarServerInfo {
    base_url: String,
    port: u16,
    /// Per-launch bearer token the frontend must send on every sidecar request
    /// (see [`sidecar_token`]).
    token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JupyterServerInfo {
    url: String,
    port: u16,
    token: String,
}

// Mac App Store stubs. The App Sandbox forbids spawning downloaded executables
// and guideline 2.5.2 forbids downloading executable code, so the `mas` feature
// compiles out everything that does either: the Python sidecar, the Jupyter
// server, the Martin tile server, the managed uv install, and external plugin
// installation. Each stub keeps the real command's name, signature, and Ok type
// so the generate_handler! list and the frontend's invoke calls are unchanged;
// they fail with a clear message instead. DuckDB-WASM processing and the
// plugins bundled into the app are unaffected.
#[cfg(feature = "mas")]
#[tauri::command]
async fn ensure_martin_binary(_app: tauri::AppHandle) -> Result<MartinBinaryInfo, String> {
    Err("The Martin tile server is not available in the Mac App Store build.".to_string())
}

#[cfg(feature = "mas")]
#[tauri::command]
async fn start_martin_server(
    _app: tauri::AppHandle,
    _connection_string: String,
    _default_srid: Option<String>,
) -> Result<MartinServerInfo, String> {
    Err("The Martin tile server is not available in the Mac App Store build.".to_string())
}

// The real command borrows tauri::State<MartinServerState>, but that state is
// neither defined nor managed in this build, so the stub takes no argument (the
// frontend passes none; state is injected server-side).
#[cfg(feature = "mas")]
#[tauri::command]
async fn stop_martin_server() -> Result<(), String> {
    Err("The Martin tile server is not available in the Mac App Store build.".to_string())
}

#[cfg(feature = "mas")]
#[tauri::command]
async fn start_geolibre_sidecar(_app: tauri::AppHandle) -> Result<SidecarServerInfo, String> {
    Err("The GeoLibre processing server is not available in the Mac App Store build.".to_string())
}

#[cfg(feature = "mas")]
#[tauri::command]
async fn stop_geolibre_sidecar(_app: tauri::AppHandle) -> Result<(), String> {
    Err("The GeoLibre processing server is not available in the Mac App Store build.".to_string())
}

#[cfg(feature = "mas")]
#[tauri::command]
async fn start_jupyter_server(_app: tauri::AppHandle) -> Result<JupyterServerInfo, String> {
    Err("The Jupyter notebook server is not available in the Mac App Store build.".to_string())
}

#[cfg(feature = "mas")]
#[tauri::command]
async fn stop_jupyter_server(_app: tauri::AppHandle) -> Result<(), String> {
    Err("The Jupyter notebook server is not available in the Mac App Store build.".to_string())
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
async fn ensure_martin_binary(app: tauri::AppHandle) -> Result<MartinBinaryInfo, String> {
    tauri::async_runtime::spawn_blocking(move || ensure_martin_binary_path(&app))
        .await
        .map_err(|error| format!("Could not join Martin binary check task: {error}"))?
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
async fn start_martin_server(
    app: tauri::AppHandle,
    connection_string: String,
    default_srid: Option<String>,
) -> Result<MartinServerInfo, String> {
    let start_gen = app
        .state::<MartinServerState>()
        .generation
        .load(std::sync::atomic::Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        start_martin_server_blocking(app, connection_string, default_srid, start_gen)
    })
    .await
    .map_err(|error| format!("Could not join Martin startup task: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn start_martin_server_blocking(
    app: tauri::AppHandle,
    connection_string: String,
    default_srid: Option<String>,
    start_gen: u64,
) -> Result<MartinServerInfo, String> {
    if connection_string.trim().is_empty() {
        return Err("Enter a PostgreSQL connection string.".to_string());
    }

    let state = app.state::<MartinServerState>();
    if state.generation.load(std::sync::atomic::Ordering::SeqCst) != start_gen {
        return Err("Martin server startup was cancelled.".to_string());
    }
    let binary = ensure_martin_binary_path(&app)?;
    let _lifecycle = state
        .lifecycle
        .lock()
        .map_err(|_| "Could not lock Martin lifecycle.".to_string())?;
    if state.generation.load(std::sync::atomic::Ordering::SeqCst) != start_gen {
        return Err("Martin server startup was cancelled.".to_string());
    }
    {
        let mut process = state
            .process
            .lock()
            .map_err(|_| "Could not lock Martin process state.".to_string())?;
        if martin_slot_is_busy(&mut process) {
            return Err(
                "A Martin server is already running. Stop it before starting a new one."
                    .to_string(),
            );
        }
    }

    let mut last_error = "Could not start Martin.".to_string();
    for _ in 0..MARTIN_START_ATTEMPTS {
        if state.generation.load(std::sync::atomic::Ordering::SeqCst) != start_gen {
            return Err("Martin server startup was cancelled.".to_string());
        }
        match spawn_martin_server(
            &binary.path,
            connection_string.trim(),
            default_srid.as_deref(),
        ) {
            Ok(info) => {
                let mut process = state
                    .process
                    .lock()
                    .map_err(|_| "Could not lock Martin process state.".to_string())?;
                if state.generation.load(std::sync::atomic::Ordering::SeqCst) != start_gen {
                    drop(process);
                    drop(info.process);
                    return Err("Martin server startup was cancelled.".to_string());
                }
                if martin_slot_is_busy(&mut process) {
                    drop(process);
                    drop(info.process);
                    return Err(
                        "A Martin server is already running. Stop it before starting a new one."
                            .to_string(),
                    );
                }
                *process = Some(info.process);
                return Ok(MartinServerInfo {
                    base_url: info.base_url,
                    binary_path: binary.path,
                    port: info.port,
                });
            }
            Err(error) => {
                last_error = error;
            }
        }
    }

    Err(last_error)
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
async fn stop_martin_server(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_martin_server_blocking(app))
        .await
        .map_err(|error| format!("Could not join Martin stop task: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn stop_martin_server_blocking(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<MartinServerState>();
    // Bump generation without blocking on `lifecycle` so Stop is immediate even
    // while a startup attempt is in flight; the startup checks `generation`
    // under `process.lock()` before storing any child.
    state
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let mut process = state
        .process
        .lock()
        .map_err(|_| "Could not lock Martin process state.".to_string())?;
    let taken = process.take();
    drop(process);
    drop(taken);
    Ok(())
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
async fn start_geolibre_sidecar(app: tauri::AppHandle) -> Result<SidecarServerInfo, String> {
    let start_gen = app
        .state::<SidecarServerState>()
        .generation
        .load(std::sync::atomic::Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || start_geolibre_sidecar_blocking(app, start_gen))
        .await
        .map_err(|error| format!("Could not join sidecar startup task: {error}"))?
}

// Interpreter for the uv project environments behind the sidecar and Jupyter.
// Left unpinned, uv takes the newest Python it can find or download, which can
// be a release that locked wheels (psycopg-binary, for one) don't support yet,
// and then `uv run` fails before the server starts. 3.12 matches the Whitebox and
// conversion runtime defaults and the version CI tests.
#[cfg(not(feature = "mas"))]
const SIDECAR_PYTHON_VERSION: &str = "3.12";

// uv replaces an existing project environment built on another Python, so this
// also repairs installs whose environment was created before the pin.
#[cfg(not(feature = "mas"))]
fn add_sidecar_python_pin(command: &mut Command) {
    command.arg("--python").arg(SIDECAR_PYTHON_VERSION);
}

#[cfg(not(feature = "mas"))]
fn add_main_sidecar_extras(command: &mut Command) {
    command
        .arg("--extra")
        .arg("ml")
        .arg("--extra")
        .arg("postgis")
        .arg("--extra")
        .arg("mssql");
}

#[cfg(not(feature = "mas"))]
fn start_geolibre_sidecar_blocking(
    app: tauri::AppHandle,
    start_gen: u64,
) -> Result<SidecarServerInfo, String> {
    let base_url = sidecar_base_url();
    let state = app.state::<SidecarServerState>();
    let _lifecycle = state
        .lifecycle
        .lock()
        .map_err(|_| "Could not lock sidecar lifecycle.".to_string())?;
    if state.generation.load(std::sync::atomic::Ordering::SeqCst) != start_gen {
        return Err("GeoLibre sidecar startup was cancelled.".to_string());
    }
    {
        let mut process = state
            .process
            .lock()
            .map_err(|_| "Could not lock sidecar process state.".to_string())?;
        if let Some(sidecar) = process.as_mut() {
            if sidecar
                .child
                .try_wait()
                .map_err(|error| format!("Could not inspect sidecar process: {error}"))?
                .is_none()
            {
                return Ok(SidecarServerInfo {
                    base_url,
                    port: SIDECAR_PORT,
                    token: sidecar_token().to_string(),
                });
            }
            *process = None;
        }
    }

    if sidecar_health_is_ready(&base_url) {
        if sidecar_accepts_token(&base_url, sidecar_token()) {
            return Ok(SidecarServerInfo {
                base_url,
                port: SIDECAR_PORT,
                token: sidecar_token().to_string(),
            });
        }
        // A sidecar is listening but rejects this session's token — usually an
        // orphan from a previous app launch. Reclaim it when the OS-specific
        // listener inspection can prove it is one of our sidecars. The process
        // identity guard prevents terminating an unrelated service that happens
        // to use the same port.
        terminate_sidecar_listeners_on_port(SIDECAR_PORT)?;
        // Bind-testing the port is the authoritative check that the reclaim
        // worked: a listener we could not terminate may also have stopped
        // answering /health, and falling through to spawn would then surface as
        // an opaque uvicorn "address already in use" instead of this message.
        if !wait_for_port_free(SIDECAR_PORT) {
            return Err(STALE_SIDECAR_ERROR.to_string());
        }
    }

    let uv = ensure_managed_uv(&app)?;
    let project_dir = sidecar_project_dir(&app)?;
    let runtime_dir = app_runtime_dir(&app)?;
    // A value already in the environment wins, so a desktop user who does want
    // the allowlist can narrow it by launching the app with it set.
    let postgis_hosts = env::var(POSTGIS_HOSTS_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| POSTGIS_HOSTS_DESKTOP_DEFAULT.to_string());
    let mssql_hosts = env::var(MSSQL_HOSTS_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| MSSQL_HOSTS_DESKTOP_DEFAULT.to_string());

    let mut command = Command::new(&uv);
    command
        .arg("run")
        // Read the bundled uv.lock as-is: never re-lock, never write to the
        // project directory. See the same flag in start_jupyter_server_blocking.
        .arg("--frozen")
        .arg("--project")
        .arg(&project_dir);
    add_sidecar_python_pin(&mut command);
    // The main sidecar serves AI segmentation, editable PostGIS and SQL Server
    // layers. Unlike whitebox/conversion (separate managed venvs), their extras
    // must be synced into this environment here.
    add_main_sidecar_extras(&mut command);
    command
        .arg("uvicorn")
        .arg("geolibre_server.app.main:app")
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(SIDECAR_PORT.to_string())
        .current_dir(&project_dir)
        .env("GEOLIBRE_UV", &uv)
        .env("GEOLIBRE_SIDECAR_TOKEN", sidecar_token())
        // Makes the Live MCP relay available on this desktop port. Access is
        // disabled until the authenticated /relay/access request applies the
        // user's setting, including when processing starts the sidecar first.
        .env("GEOLIBRE_LIVE_RELAY_PORT", SIDECAR_PORT.to_string())
        .env("GEOLIBRE_RUNTIME_DIR", &runtime_dir)
        .env(POSTGIS_HOSTS_ENV, &postgis_hosts)
        .env(MSSQL_HOSTS_ENV, &mssql_hosts)
        .env("GEOLIBRE_MSSQL_DESKTOP_AUTH", "1")
        .env("UV_CACHE_DIR", runtime_dir.join("uv-cache"))
        .env("UV_PYTHON_INSTALL_DIR", runtime_dir.join("uv-python"))
        .env("UV_PROJECT_ENVIRONMENT", runtime_dir.join("sidecar-server"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_sidecar_process(&mut command);

    let mut child = process_lifetime::spawn_managed_child(command)
        .map_err(|error| format!("Could not start GeoLibre sidecar: {error}"))?;
    // Drain both pipes from the moment we spawn. Reading them only after the
    // child exits (the old shape) deadlocks a cold-cache `uv sync`, whose
    // per-package output overflows the 64 KB pipe long before uvicorn can bind:
    // the child blocks on write, never becomes ready, and the failure surfaces
    // as a bare timeout with no output to explain it.
    let output = CapturedOutput::attach(&mut child);

    if let Err(error) = wait_for_sidecar_health(&base_url, &mut child, &output) {
        terminate_sidecar_child(&mut child);
        return Err(error);
    }

    let mut process = state
        .process
        .lock()
        .map_err(|_| "Could not lock sidecar process state.".to_string())?;
    if state.generation.load(std::sync::atomic::Ordering::SeqCst) != start_gen {
        drop(process);
        // Drop triggers `SidecarProcess::drop` -> `terminate()` exactly once.
        drop(SidecarProcess { child });
        return Err("GeoLibre sidecar startup was cancelled.".to_string());
    }
    if process.is_some() {
        drop(process);
        drop(SidecarProcess { child });
    } else {
        *process = Some(SidecarProcess { child });
    }

    Ok(SidecarServerInfo {
        base_url,
        port: SIDECAR_PORT,
        token: sidecar_token().to_string(),
    })
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
async fn stop_geolibre_sidecar(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_geolibre_sidecar_blocking(app))
        .await
        .map_err(|error| format!("Could not join sidecar stop task: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn stop_geolibre_sidecar_blocking(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<SidecarServerState>();
    // Bump generation immediately without blocking on `lifecycle` so Stop stays
    // responsive during a slow `uv` install or health wait; any in-progress
    // startup checks `generation` under `process.lock()` and tears down its
    // child instead of installing it.
    let stop_gen = state
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    {
        let mut process = state
            .process
            .lock()
            .map_err(|_| "Could not lock sidecar process state.".to_string())?;
        // SidecarProcess::Drop calls terminate() automatically, so taking the
        // value out is enough to tear down the child. Calling terminate() here
        // as well would double-signal the (possibly recycled) process group.
        let taken = process.take();
        drop(process); // release the MutexGuard before the 250 ms SIGTERM grace
        drop(taken); // terminate() runs here, outside the lock
    }

    if let Ok(_lifecycle) = state.lifecycle.try_lock() {
        let should_reap_port = || {
            state.generation.load(std::sync::atomic::Ordering::SeqCst) == stop_gen
                && state.process.lock().is_ok_and(|process| process.is_none())
        };
        let base_url = sidecar_base_url();
        if should_reap_port() && sidecar_health_is_ready(&base_url) {
            request_sidecar_shutdown(&base_url);
            wait_for_sidecar_stop(&base_url);
        }
        if should_reap_port() && sidecar_health_is_ready(&base_url) {
            terminate_sidecar_listeners_on_port(SIDECAR_PORT)?;
            wait_for_sidecar_stop(&base_url);
        }
        if should_reap_port() && sidecar_health_is_ready(&base_url) {
            return Err(format!(
                "GeoLibre sidecar is still running on port {SIDECAR_PORT}."
            ));
        }
    }
    Ok(())
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
async fn start_jupyter_server(app: tauri::AppHandle) -> Result<JupyterServerInfo, String> {
    let start_gen = app
        .state::<JupyterServerState>()
        .generation
        .load(std::sync::atomic::Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || start_jupyter_server_blocking(app, start_gen))
        .await
        .map_err(|error| format!("Could not join Jupyter startup task: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn start_jupyter_server_blocking(
    app: tauri::AppHandle,
    start_gen: u64,
) -> Result<JupyterServerInfo, String> {
    let state = app.state::<JupyterServerState>();
    // Serialize the whole startup. Concurrent calls (e.g. React StrictMode
    // double-invoking the Notebook panel's mount effect in dev) would otherwise
    // both pass the reuse check below and both spawn on JUPYTER_PORT; with
    // `--port-retries=0` the loser fails to bind and exits 1. The second caller
    // blocks here, then finds the live process in the reuse check and returns it.
    let _startup = state
        .startup
        .lock()
        .map_err(|_| "Could not lock Jupyter startup.".to_string())?;
    if state.generation.load(std::sync::atomic::Ordering::SeqCst) != start_gen {
        return Err("Jupyter server startup was cancelled.".to_string());
    }
    // Reuse an already-running server: hand back the same URL + token.
    {
        let mut process = state
            .process
            .lock()
            .map_err(|_| "Could not lock Jupyter process state.".to_string())?;
        if let Some(server) = process.as_mut() {
            if server
                .child
                .try_wait()
                .map_err(|error| format!("Could not inspect Jupyter process: {error}"))?
                .is_none()
            {
                let token = state
                    .token
                    .lock()
                    .map_err(|_| "Could not lock Jupyter token.".to_string())?
                    .clone()
                    .unwrap_or_default();
                return Ok(JupyterServerInfo {
                    url: jupyter_base_url(),
                    port: JUPYTER_PORT,
                    token,
                });
            }
            *process = None;
        }
    }

    let runtime_dir = app_runtime_dir(&app)?;

    // A Jupyter server from a previous app session may still hold the port. We
    // can't reuse it (its per-launch token is unknown to us), and because we
    // spawn with `--ServerApp.port_retries=0`, a new server would fail to bind
    // and exit 1 ("exited before it was ready") while the orphan lingers. Clear
    // any stale listener and wait for the port to free before spawning.
    let _ = terminate_jupyter_listeners_on_port(JUPYTER_PORT, &runtime_dir);
    // Best-effort here: if the port never frees, the spawn below fails with
    // Jupyter's own bind error, which is already reported to the user.
    let _ = wait_for_port_free(JUPYTER_PORT);

    let uv = ensure_managed_uv(&app)?;
    let project_dir = sidecar_project_dir(&app)?;
    let config_path = project_dir.join("jupyter_server_config.py");
    // Notebooks are saved here (the JupyterLab file browser root). Jupyter is
    // launched with `--ServerApp.root_dir` pointing at this directory and
    // refuses to start when it is missing, so a creation failure has to surface
    // here. Swallowing it reached the user several steps later as an opaque
    // "Bad config encountered during initialization: No such directory"
    // (issue #1642).
    let notebooks_dir = runtime_dir.join("notebooks");
    fs::create_dir_all(&notebooks_dir).map_err(|error| {
        format!(
            "Could not create the notebooks directory {}: {error}",
            notebooks_dir.display()
        )
    })?;
    // Seed the example notebooks (the same ones bundled into JupyterLite on web)
    // only when missing, so we never clobber a user's edits.
    for notebook in ["Welcome.ipynb", "Explore_GeoLibre.ipynb"] {
        let dest = notebooks_dir.join(notebook);
        if !dest.exists() {
            let _ = fs::copy(project_dir.join("notebook_examples").join(notebook), &dest);
        }
    }
    // Make the kernel-side `geolibre` client importable from any notebook: copy
    // it out of the bundled backend resource into a dedicated lib dir placed on
    // the kernel's PYTHONPATH (so `import geolibre` works regardless of where the
    // notebook lives).
    // Not fatal, unlike the notebooks root: Jupyter starts fine without this
    // one, and losing it only costs `import geolibre` inside the notebooks. So
    // report it rather than failing the whole panel -- but do report it, since
    // silently discarding the result is what made #1642 so hard to read.
    let lib_dir = runtime_dir.join("notebook-lib");
    if let Err(error) = fs::create_dir_all(&lib_dir) {
        eprintln!(
            "Jupyter: could not create the notebook library directory {} ({error}); \
             `import geolibre` will not resolve in notebooks.",
            lib_dir.display()
        );
    }
    let _ = fs::copy(
        project_dir.join("notebook_client.py"),
        lib_dir.join("geolibre.py"),
    );
    let token = generate_jupyter_token();

    let mut command = Command::new(&uv);
    command
        .arg("run")
        // Read the bundled uv.lock as-is. Without this uv re-locks whenever it
        // thinks the lock is stale and WRITES uv.lock back into the project
        // directory — which in an installed build is the read-only resource dir
        // (C:\Program Files\..., /usr/lib/GeoLibre Desktop/...). That write fails
        // with "Permission denied" and uv exits 2, which reached the user as the
        // opaque "Jupyter server exited before it was ready (exit code: 2)".
        // `--frozen` also keeps a released build pinned to the versions it was
        // tested against instead of re-resolving against live PyPI per machine.
        .arg("--frozen")
        .arg("--project")
        .arg(&project_dir);
    add_sidecar_python_pin(&mut command);
    command
        // The `notebook` extra carries JupyterLab. Synced into a dedicated
        // project environment so it never disturbs the FastAPI sidecar's env
        // (which syncs the `ml` extra).
        .arg("--extra")
        .arg("notebook")
        .arg("jupyter")
        .arg("lab")
        .arg("--no-browser")
        .arg(format!("--config={}", config_path.display()))
        .arg("--ServerApp.ip=127.0.0.1")
        .arg(format!("--ServerApp.port={JUPYTER_PORT}"))
        // Fail fast instead of hopping to another port we'd never discover.
        .arg("--ServerApp.port_retries=0")
        .arg(format!("--ServerApp.root_dir={}", notebooks_dir.display()))
        .arg(format!("--IdentityProvider.token={token}"))
        .current_dir(&project_dir)
        .env("GEOLIBRE_UV", &uv)
        .env("GEOLIBRE_RUNTIME_DIR", &runtime_dir)
        .env("UV_CACHE_DIR", runtime_dir.join("uv-cache"))
        .env("UV_PYTHON_INSTALL_DIR", runtime_dir.join("uv-python"))
        .env("UV_PROJECT_ENVIRONMENT", runtime_dir.join("jupyter-server"))
        // Prepend the bundled `geolibre` client to the kernel import path,
        // preserving any inherited PYTHONPATH rather than replacing it.
        .env("PYTHONPATH", prepend_pythonpath(&lib_dir))
        .stdin(Stdio::null())
        // Pipe (don't inherit) stdout/stderr, and drain both on background
        // threads via CapturedOutput. Inheriting used to be the only way to keep
        // a chatty child — `uv sync` of JupyterLab plus JupyterLab's own startup
        // write a lot — from filling an undrained 64 KB pipe and blocking before
        // it could become ready. But release builds are GUI-subsystem
        // (`windows_subsystem = "windows"`), and a desktop-launched app on Linux
        // has no terminal either, so inherited output went nowhere and a startup
        // failure surfaced as a bare exit status with no way to find the cause.
        // Draining keeps the child unblocked, tees the log to the parent's stdio
        // for dev terminals, and keeps the tail so the error can quote it.
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_sidecar_process(&mut command);

    let mut child = process_lifetime::spawn_managed_child(command)
        .map_err(|error| format!("Could not start Jupyter server: {error}"))?;
    let output = CapturedOutput::attach(&mut child);

    let base_url = jupyter_base_url();
    if let Err(error) = wait_for_jupyter_health(&base_url, &token, &mut child, &output) {
        terminate_sidecar_child(&mut child);
        return Err(error);
    }

    // Record our server unless a concurrent stop or app exit bumped
    // `generation` while startup was running.
    {
        let mut process = state
            .process
            .lock()
            .map_err(|_| "Could not lock Jupyter process state.".to_string())?;
        if state.generation.load(std::sync::atomic::Ordering::SeqCst) != start_gen {
            drop(process);
            terminate_sidecar_child(&mut child);
            return Err("Jupyter server startup was cancelled.".to_string());
        }
        *process = Some(JupyterProcess { child });
        *state
            .token
            .lock()
            .map_err(|_| "Could not lock Jupyter token.".to_string())? = Some(token.clone());
    }

    Ok(JupyterServerInfo {
        url: base_url,
        port: JUPYTER_PORT,
        token,
    })
}

#[cfg(not(feature = "mas"))]
#[tauri::command]
async fn stop_jupyter_server(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_jupyter_server_blocking(app))
        .await
        .map_err(|error| format!("Could not join Jupyter stop task: {error}"))?
}

#[cfg(not(feature = "mas"))]
fn stop_jupyter_server_blocking(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<JupyterServerState>();
    // Bump generation immediately without blocking on `startup` so Stop stays
    // responsive even during a slow `uv sync` or health wait; any in-progress
    // startup checks `generation` under `process.lock()` and tears down its
    // child instead of installing it.
    let stop_gen = state
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    {
        let mut process = state
            .process
            .lock()
            .map_err(|_| "Could not lock Jupyter process state.".to_string())?;
        // Clear the token in the same `process` critical section as taking the
        // process so a concurrent start cannot publish a fresh token that gets
        // wiped by a late clear.
        let taken = process.take();
        if let Ok(mut token) = state.token.lock() {
            *token = None;
        }
        drop(process);
        // JupyterProcess::Drop terminates the child's process group outside the lock.
        drop(taken);
    }
    // Backstop: reap anything still bound to the port only when no startup is
    // in flight and no newer start has installed a live server in the meantime.
    if let Ok(_startup) = state.startup.try_lock() {
        if state.generation.load(std::sync::atomic::Ordering::SeqCst) == stop_gen
            && state.process.lock().is_ok_and(|process| process.is_none())
        {
            match app_runtime_dir(&app) {
                Ok(runtime_dir) => {
                    let _ = terminate_jupyter_listeners_on_port(JUPYTER_PORT, &runtime_dir);
                }
                Err(error) => {
                    eprintln!("Jupyter: skipping the port {JUPYTER_PORT} backstop ({error}).")
                }
            }
        }
    }
    Ok(())
}

/// Directory holding everything the app installs at runtime (the managed uv, its
/// caches and project environments, and the notebook root). Lives under the
/// per-user app data directory, so nothing outside it belongs to us.
#[cfg(not(feature = "mas"))]
fn app_runtime_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("runtime"))
}

#[cfg(not(feature = "mas"))]
fn jupyter_base_url() -> String {
    format!("http://127.0.0.1:{JUPYTER_PORT}")
}

// Wait (briefly) until `port` can be bound, i.e. a just-terminated listener has
// fully released it. Binding then dropping leaves a small race window, but it is
// enough to avoid a `--port-retries=0` bind failure right after killing an orphan.
// Returns whether the port actually came free within the timeout, so a caller
// that can report a better error than the failed spawn is able to bail out.
#[cfg(not(feature = "mas"))]
fn wait_for_port_free(port: u16) -> bool {
    for _ in 0..20 {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

// Prepend `dir` to any inherited PYTHONPATH (platform separator), so a user's
// existing value is preserved rather than clobbered. The inherited value is
// taken *after* AppImage sanitation, so the AppDir entry AppRun injects is not
// carried into the child (see appdir_free_path_var).
#[cfg(not(feature = "mas"))]
fn prepend_pythonpath(dir: &Path) -> String {
    let dir = dir.display().to_string();
    match appdir_free_path_var("PYTHONPATH") {
        Some(existing) if !existing.is_empty() => {
            let sep = if cfg!(windows) { ";" } else { ":" };
            format!("{dir}{sep}{existing}")
        }
        _ => dir,
    }
}

#[cfg(not(feature = "mas"))]
fn jupyter_health_is_ready(
    client: &reqwest::blocking::Client,
    base_url: &str,
    token: &str,
) -> bool {
    client
        .get(format!("{base_url}/api/status"))
        .header("Authorization", format!("token {token}"))
        .send()
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

#[cfg(not(feature = "mas"))]
fn wait_for_jupyter_health(
    base_url: &str,
    token: &str,
    child: &mut Child,
    output: &CapturedOutput,
) -> Result<(), String> {
    // Build the HTTP client once and reuse it across all health polls (this loop
    // runs up to JUPYTER_HEALTH_ATTEMPTS = 240 times).
    let client =
        loopback_http_client().map_err(|error| format!("Could not build HTTP client: {error}"))?;
    for _ in 0..JUPYTER_HEALTH_ATTEMPTS {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not inspect Jupyter process: {error}"))?
        {
            return Err(child_failure_message(
                &format!("Jupyter server exited before it was ready (exit status: {status})."),
                output,
            ));
        }

        if jupyter_health_is_ready(&client, base_url, token) {
            return Ok(());
        }

        thread::sleep(Duration::from_secs(1));
    }

    Err(child_failure_message(
        "Jupyter server did not become ready in time.",
        output,
    ))
}

// Append the tail of a managed child's output to a failure summary. That output
// is the only thing that identifies *why* startup failed (a uv resolution error,
// a missing `jupyter` executable, a port conflict...), and in an installed build
// there is no terminal to read it from, so it has to travel with the error.
// Shared by the Jupyter, sidecar and Martin waiters, and by both of their
// failure paths (early exit and timeout), so no path can quietly drop the one
// useful detail.
#[cfg(not(feature = "mas"))]
fn child_failure_message(summary: &str, output: &CapturedOutput) -> String {
    // The child may have only just exited, with its last lines still in flight.
    output.settle();
    let tail = output.tail();
    if tail.is_empty() {
        format!("{summary} It produced no output.")
    } else {
        format!("{summary}\n\nLast output:\n{tail}")
    }
}

// A loopback-bound, per-launch token for the desktop Jupyter server. It is the
// only barrier once the XSRF check is disabled for the embedded iframe (see
// jupyter_server_config.py), so use the OS CSPRNG (128 random bits) rather than
// anything derived from the clock/pid.
#[cfg(not(feature = "mas"))]
fn generate_jupyter_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("OS CSPRNG (getrandom) unavailable");
    let mut token = String::with_capacity(32);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(token, "{byte:02x}");
    }
    token
}

#[cfg(not(feature = "mas"))]
fn sidecar_base_url() -> String {
    format!("http://127.0.0.1:{SIDECAR_PORT}")
}

/// A short-timeout HTTP client for the app's own loopback servers (the
/// sidecar, Jupyter and Martin health, token and shutdown probes).
///
/// The proxy is disabled: reqwest otherwise follows `HTTP_PROXY`-style env vars
/// and, on Windows, the system proxy, whose `ProxyOverride` list it copies
/// verbatim without expanding `<local>`. A corporate proxy then answers these
/// `127.0.0.1` requests itself (often with a 403), so a healthy sidecar never
/// reads as ready and startup waits out every attempt (issue #3003). The
/// webview's own sidecar requests already bypass the proxy in
/// `src/lib/sidecar-fetch.ts`.
#[cfg(not(feature = "mas"))]
fn loopback_http_client() -> reqwest::Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(500))
        .no_proxy()
        .build()
}

/// A per-launch shared secret the frontend must present on every sidecar
/// request. The sidecar binds loopback and is CORS-restricted, but neither stops
/// a cross-origin simple POST (CSRF) or a DNS-rebinding read; this token does.
///
/// Generated once per desktop process (128 CSPRNG bits) and reused for the
/// process lifetime so the early-return paths of `start_geolibre_sidecar` (when
/// the sidecar is already running) hand back the same token that was injected
/// via `GEOLIBRE_SIDECAR_TOKEN` at spawn time. A sidecar started outside this
/// process (e.g. a `python -m` dev run) leaves the env var unset and simply does
/// not enforce the token, so those flows keep working.
#[cfg(not(feature = "mas"))]
fn sidecar_token() -> &'static str {
    static TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TOKEN.get_or_init(generate_jupyter_token)
}

#[cfg(not(feature = "mas"))]
fn sidecar_health_is_ready(base_url: &str) -> bool {
    let client = loopback_http_client();
    let Ok(client) = client else {
        return false;
    };
    client
        .get(format!("{base_url}/health"))
        .send()
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

/// Whether the sidecar already listening at `base_url` accepts `token`.
///
/// `/health` is token-exempt, so it cannot reveal a token mismatch. This probes
/// `/token-check` (a no-op authenticated endpoint) *with* the token so an orphan
/// sidecar from a previous launch — started with a different per-launch token,
/// and not killed because `Drop` doesn't run on `SIGKILL` — is detected rather
/// than silently 401ing every later request. A tokenless dev sidecar
/// (`GEOLIBRE_SIDECAR_TOKEN` unset) accepts any header and returns 200, so it is
/// still reused.
#[cfg(not(feature = "mas"))]
fn sidecar_accepts_token(base_url: &str, token: &str) -> bool {
    let Ok(client) = loopback_http_client() else {
        return false;
    };
    client
        .get(format!("{base_url}/token-check"))
        .header("x-geolibre-token", token)
        .send()
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

#[cfg(not(feature = "mas"))]
fn request_sidecar_shutdown(base_url: &str) {
    let client = loopback_http_client();
    if let Ok(client) = client {
        // /shutdown is token-protected (only /health is exempt), so attach this
        // session's token. This shuts down a sidecar we started or adopted (same
        // token); a true cross-launch orphan (different token) 401s and falls
        // through to the force-kill path, as before.
        let _ = client
            .post(format!("{base_url}/shutdown"))
            .header("x-geolibre-token", sidecar_token())
            .send();
    }
}

#[cfg(not(feature = "mas"))]
fn wait_for_sidecar_stop(base_url: &str) {
    for _ in 0..20 {
        if !sidecar_health_is_ready(base_url) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(not(feature = "mas"))]
fn wait_for_sidecar_health(
    base_url: &str,
    child: &mut Child,
    output: &CapturedOutput,
) -> Result<(), String> {
    for _ in 0..SIDECAR_HEALTH_ATTEMPTS {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not inspect sidecar process: {error}"))?
        {
            return Err(child_failure_message(
                &format!("GeoLibre sidecar exited before it was ready: {status}"),
                output,
            ));
        }

        if sidecar_health_is_ready(base_url) {
            return Ok(());
        }

        thread::sleep(Duration::from_secs(1));
    }

    Err(child_failure_message(
        "GeoLibre sidecar did not become ready in time.",
        output,
    ))
}

// How many trailing output lines a captured child keeps, and how many of them a
// failure message quotes. The log is a ring buffer so a chatty child (uv sync +
// JupyterLab startup write hundreds of lines) can never grow without bound, and
// the tail is what matters: the error that killed the process is at the end.
#[cfg(not(feature = "mas"))]
const CAPTURED_LOG_MAX_LINES: usize = 200;
#[cfg(not(feature = "mas"))]
const CAPTURED_LOG_REPORTED_LINES: usize = 20;
// How long a failure report waits for the reader threads to reach EOF before
// quoting what they have. `try_wait` reports the exit as soon as the process is
// reaped, which can be before the readers have consumed the last lines still
// sitting in the pipe — and those last lines are the error itself. Waiting is
// necessarily *bounded*: `uv` spawns `jupyter`, which spawns kernels that
// inherit these same pipe handles, so a grandchild outliving the child keeps the
// write end open and EOF never arrives. An unbounded join would hang the Tauri
// command forever, which is worse than a truncated tail.
#[cfg(not(feature = "mas"))]
const CAPTURED_LOG_SETTLE: Duration = Duration::from_millis(500);
#[cfg(not(feature = "mas"))]
const CAPTURED_LOG_SETTLE_POLL: Duration = Duration::from_millis(10);

/// The trailing output of a spawned child, drained on background threads.
///
/// `Stdio::piped()` alone is not enough for a child we only poll for health: an
/// undrained OS pipe fills at ~64 KB and blocks the writer forever, so a chatty
/// child would hang instead of becoming ready. These readers consume both
/// streams continuously, keep the last `CAPTURED_LOG_MAX_LINES` in memory, and
/// echo each line to the parent's own stdio so a dev terminal still shows the
/// live log.
#[cfg(not(feature = "mas"))]
#[derive(Clone)]
struct CapturedOutput {
    lines: Arc<Mutex<VecDeque<String>>>,
    // Reader threads that have not yet seen EOF. Drives `settle`.
    draining: Arc<AtomicUsize>,
}

#[cfg(not(feature = "mas"))]
impl CapturedOutput {
    fn new() -> Self {
        Self {
            lines: Arc::new(Mutex::new(VecDeque::with_capacity(CAPTURED_LOG_MAX_LINES))),
            draining: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Take the child's piped stdout/stderr and start draining them.
    fn attach(child: &mut Child) -> Self {
        let captured = Self::new();
        if let Some(stdout) = child.stdout.take() {
            captured.drain(stdout, false);
        }
        if let Some(stderr) = child.stderr.take() {
            captured.drain(stderr, true);
        }
        captured
    }

    fn drain<R>(&self, stream: R, is_stderr: bool)
    where
        R: Read + Send + 'static,
    {
        let captured = self.clone();
        // Registered before the thread starts, so a `settle` racing the spawn
        // still sees this reader as outstanding.
        self.draining.fetch_add(1, Ordering::SeqCst);
        // Detached: the thread ends on its own when the pipe closes at child
        // exit. `settle` waits on the counter rather than a JoinHandle so the
        // wait can be bounded (see CAPTURED_LOG_SETTLE).
        thread::spawn(move || {
            for line in BufReader::new(stream).lines() {
                let Ok(line) = line else { break };
                // Tee to the parent's stdio. In a dev terminal this preserves
                // the old inherit-style live log; in a bundled GUI build (no
                // console on Windows) it is simply discarded.
                if is_stderr {
                    let _ = writeln!(std::io::stderr(), "{line}");
                } else {
                    let _ = writeln!(std::io::stdout(), "{line}");
                }
                captured.push(line);
            }
            captured.draining.fetch_sub(1, Ordering::SeqCst);
        });
    }

    /// Give the reader threads a bounded moment to reach EOF, so a report made
    /// right after `try_wait` sees the child's final lines instead of racing
    /// them. Returns early once every reader is done; otherwise gives up at
    /// `CAPTURED_LOG_SETTLE` and lets the caller quote a partial tail.
    fn settle(&self) {
        let deadline = CAPTURED_LOG_SETTLE.as_millis() / CAPTURED_LOG_SETTLE_POLL.as_millis();
        for _ in 0..deadline {
            if self.draining.load(Ordering::SeqCst) == 0 {
                return;
            }
            thread::sleep(CAPTURED_LOG_SETTLE_POLL);
        }
    }

    /// Record one line, evicting the oldest once the ring buffer is full.
    fn push(&self, line: String) {
        let Ok(mut lines) = self.lines.lock() else {
            return;
        };
        while lines.len() >= CAPTURED_LOG_MAX_LINES {
            lines.pop_front();
        }
        lines.push_back(line);
    }

    /// The last few captured lines, blank-trimmed, for an error message.
    /// Empty when the child produced no output at all.
    fn tail(&self) -> String {
        let Ok(lines) = self.lines.lock() else {
            return String::new();
        };
        let start = lines.len().saturating_sub(CAPTURED_LOG_REPORTED_LINES);
        lines
            .iter()
            .skip(start)
            .map(|line| line.trim_end())
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// The AppImage mount root, when running from an AppImage. `APPDIR` is exported
/// by AppRun and is the prefix of everything it injects.
#[cfg(not(feature = "mas"))]
fn appimage_dir() -> Option<String> {
    env::var("APPDIR").ok().filter(|dir| !dir.is_empty())
}

/// Read a `PATH`-style variable with any entry that points inside the AppImage
/// mount removed. Returns `None` when the variable is unset or every entry was
/// an AppDir entry (so the caller unsets it rather than passing an empty value).
/// Outside an AppImage the value is returned untouched.
#[cfg(not(feature = "mas"))]
fn appdir_free_path_var(name: &str) -> Option<String> {
    let value = env::var(name).ok()?;
    let Some(appdir) = appimage_dir() else {
        return Some(value);
    };
    let sep = if cfg!(windows) { ';' } else { ':' };
    let kept: Vec<&str> = value
        .split(sep)
        .filter(|entry| !entry.is_empty() && !entry.starts_with(appdir.as_str()))
        .collect();
    if kept.is_empty() {
        None
    } else {
        Some(kept.join(&sep.to_string()))
    }
}

/// Undo the environment an AppImage forces on every child process.
///
/// AppImageKit's AppRun exports a fixed set of variables so the bundled GUI can
/// find its own libraries, including:
///
/// ```text
/// PYTHONHOME=$APPDIR/usr/
/// PYTHONPATH=$APPDIR/usr/share/pyshared/:$PYTHONPATH
/// LD_LIBRARY_PATH=$APPDIR/usr/lib/:…:$LD_LIBRARY_PATH
/// ```
///
/// They leak into everything we spawn. `PYTHONHOME` is the fatal one: a Python
/// that honours it looks for its standard library under the AppImage mount,
/// finds no `encodings` module, and aborts with "Failed to import encodings
/// module" before executing a line of code. That killed `uv`'s build backend —
/// and so the Notebook panel and the sidecar — in every AppImage build, while
/// the .deb/.rpm (which have no AppRun) were unaffected.
///
/// We never want an inherited `PYTHONHOME`: the interpreter is chosen by uv and
/// the project environment we point it at, so drop it unconditionally rather
/// than only under an AppImage. The two search paths keep any entries the user
/// legitimately set and lose only the AppDir ones.
#[cfg(not(feature = "mas"))]
fn clear_appimage_python_env(command: &mut Command) {
    command.env_remove("PYTHONHOME");
    for name in ["LD_LIBRARY_PATH", "PYTHONPATH"] {
        // The Jupyter launch sets its own PYTHONPATH (already AppDir-free, via
        // prepend_pythonpath) before this runs, and overwriting it here would
        // drop the notebook-lib directory that makes `import geolibre` work.
        if command
            .get_envs()
            .any(|(key, value)| key == OsStr::new(name) && value.is_some())
        {
            continue;
        }
        match appdir_free_path_var(name) {
            Some(value) => command.env(name, value),
            None => command.env_remove(name),
        };
    }
}

#[cfg(not(feature = "mas"))]
fn configure_sidecar_process(command: &mut Command) {
    // Both callers (the sidecar and Jupyter launches) run Python through uv.
    clear_appimage_python_env(command);
    configure_sidecar_process_impl(command);
}

#[cfg(all(unix, not(feature = "mas")))]
fn configure_sidecar_process_impl(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
}

#[cfg(all(not(unix), not(feature = "mas")))]
fn configure_sidecar_process_impl(command: &mut Command) {
    hide_console_window(command);
}

/// Keep a spawned console program from opening a console window.
///
/// Release builds are GUI-subsystem (`windows_subsystem = "windows"`), so they
/// have no console of their own. Spawning `uv.exe` (a console program) then
/// makes Windows allocate a fresh console *window* for it, which appears on the
/// user's desktop and stays for as long as the child runs -- for the Notebook
/// panel that is the whole session. `CREATE_NO_WINDOW` runs the child without
/// one. Output is unaffected: every caller already pipes stdout/stderr and
/// drains them (see CapturedOutput).
#[cfg(all(target_os = "windows", not(feature = "mas")))]
fn hide_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(all(not(target_os = "windows"), not(feature = "mas")))]
fn hide_console_window(_command: &mut Command) {}

#[cfg(not(feature = "mas"))]
fn terminate_sidecar_child(child: &mut Child) {
    // Signal the process group first so surviving grandchildren (such as
    // Jupyter kernels or uvicorn workers) are terminated even if the group
    // leader already exited. Skip `child.kill()` / `child.wait()` once
    // `try_wait()` confirms the leader was already reaped.
    terminate_sidecar_process_group(child);
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(all(unix, not(feature = "mas")))]
fn terminate_sidecar_process_group(child: &mut Child) {
    // Guard the negation: a PID that wrapped to a non-positive i32 would make
    // `kill` target process group 0 (the caller's own group, including the
    // Tauri parent) or overflow on i32::MIN.
    let Some(process_group) = i32::try_from(child.id())
        .ok()
        .filter(|pid| *pid > 0)
        .and_then(|pid| pid.checked_neg())
    else {
        return;
    };
    let _ = unsafe { kill(process_group, SIGTERM) };
    thread::sleep(Duration::from_millis(250));
    let _ = unsafe { kill(process_group, SIGKILL) };
}

#[cfg(all(not(unix), not(feature = "mas")))]
fn terminate_sidecar_process_group(_child: &mut Child) {}

#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn terminate_sidecar_listeners_on_port(port: u16) -> Result<(), String> {
    terminate_listeners_on_port(port, is_geolibre_sidecar_process)
}

// Reap a stale Jupyter server that still holds the port (e.g. orphaned by a
// non-graceful exit of a previous app session). Recognized by its cmdline so we
// never touch an unrelated jupyter (the user's own JupyterHub, etc.).
#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn terminate_jupyter_listeners_on_port(
    port: u16,
    _runtime_dir: &std::path::Path,
) -> Result<(), String> {
    terminate_listeners_on_port(port, is_geolibre_jupyter_process)
}

// Known gap: still a no-op on macOS (there is no /proc, and the Windows IP
// Helper route below does not exist either). The current session's child is
// reaped on exit via JupyterProcess::Drop, but an orphan left by a *previous*
// crashed session can keep holding the port, in which case the next launch
// fails to bind and surfaces "exited before it was ready". An lsof-based
// port-owner lookup would be needed to close this.
#[cfg(all(
    not(target_os = "linux"),
    not(target_os = "windows"),
    not(feature = "mas")
))]
fn terminate_jupyter_listeners_on_port(
    _port: u16,
    _runtime_dir: &std::path::Path,
) -> Result<(), String> {
    Ok(())
}

// Windows equivalent of the Linux reaper (issue #1643): an orphaned Jupyter
// server from a crashed session keeps holding 8766, and every later launch dies
// with "the port 8766 is already in use" until the user kills it by hand.
//
// There is no /proc here, so the owner of the listening socket comes from the IP
// Helper TCP table, and "is it ours?" is answered by the process image path: we
// only ever terminate a listener whose executable lives inside this user's own
// GeoLibre runtime directory (the uv-managed environment under
// `%APPDATA%\org.geolibre.desktop\runtime\`). A Jupyter the user installed
// themselves lives outside it and is left alone. The sidecar's port is reaped
// the same way but recognized by its command line instead (see
// terminate_sidecar_listeners_on_port), since its interpreter can be a system
// Python that uv picked outside the runtime directory.
#[cfg(all(target_os = "windows", not(feature = "mas")))]
fn terminate_jupyter_listeners_on_port(
    port: u16,
    runtime_dir: &std::path::Path,
) -> Result<(), String> {
    for pid in listening_tcp_pids(port) {
        terminate_listener_if(pid, |process| process_image_is_under(process, runtime_dir));
    }
    Ok(())
}

// PIDs of the processes listening on `port`, over both IPv4 and IPv6. The two
// families are read independently: a machine with IPv6 disabled outright can
// fail the second read, and letting that discard the IPv4 result would drop the
// orphan we are here to reclaim (Jupyter binds 127.0.0.1, so it is nearly
// always the IPv4 table that holds it).
#[cfg(all(target_os = "windows", not(feature = "mas")))]
fn listening_tcp_pids(port: u16) -> HashSet<u32> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID,
    };

    // The address families as GetExtendedTcpTable wants them: a plain u32, not
    // the u16 `ADDRESS_FAMILY` the WinSock module exports.
    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;

    let mut pids = HashSet::new();
    match extended_tcp_table(AF_INET) {
        Ok(table) => collect_owner_pids::<MIB_TCPROW_OWNER_PID>(
            &table,
            port,
            |row| (row.dwLocalPort, row.dwOwningPid),
            &mut pids,
        ),
        Err(error) => eprintln!("GeoLibre: {error}"),
    }
    match extended_tcp_table(AF_INET6) {
        Ok(table) => collect_owner_pids::<MIB_TCP6ROW_OWNER_PID>(
            &table,
            port,
            |row| (row.dwLocalPort, row.dwOwningPid),
            &mut pids,
        ),
        Err(error) => eprintln!("GeoLibre: {error}"),
    }
    pids
}

// Walk one MIB_TCP*TABLE_OWNER_PID and collect the PIDs listening on `port`.
// Both the IPv4 and IPv6 tables have the same shape -- a DWORD entry count
// followed by the rows -- so the row type and the two fields we need are the
// only things that differ.
#[cfg(all(target_os = "windows", not(feature = "mas")))]
fn collect_owner_pids<Row>(
    buffer: &[u32],
    port: u16,
    fields: fn(&Row) -> (u32, u32),
    pids: &mut HashSet<u32>,
) {
    use std::mem::{size_of, size_of_val};

    if buffer.is_empty() {
        return;
    }
    let base = buffer.as_ptr();
    // SAFETY: `buffer` is a u32-aligned allocation that GetExtendedTcpTable
    // filled for this table class, and it holds at least the leading entry
    // count. Every row type here has 4-byte alignment, so the rows -- which
    // start one DWORD in -- are aligned too. The walk is capped at the number
    // of rows the allocation can actually hold, so an entry count that
    // disagrees with the reported size cannot read past the end.
    let count = unsafe { *base } as usize;
    let capacity = (size_of_val(buffer) - size_of::<u32>()) / size_of::<Row>();
    let rows = unsafe { base.add(1) }.cast::<Row>();
    for index in 0..count.min(capacity) {
        let (local_port, owning_pid) = fields(unsafe { &*rows.add(index) });
        if tcp_table_port(local_port) == port {
            pids.insert(owning_pid);
        }
    }
}

// Read the TCP listener table for one address family into a u32-aligned buffer.
// GetExtendedTcpTable reports the size it needs on the first (null) call, but
// the table can grow between that call and the read, so retry a bounded number
// of times rather than trusting the first answer.
#[cfg(all(target_os = "windows", not(feature = "mas")))]
fn extended_tcp_table(family: u32) -> Result<Vec<u32>, String> {
    use std::mem::size_of;
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, TCP_TABLE_OWNER_PID_LISTENER,
    };

    const NO_ERROR: u32 = 0;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
    const ATTEMPTS: usize = 8;

    let mut size: u32 = 0;
    let mut buffer: Vec<u32> = Vec::new();
    for _ in 0..ATTEMPTS {
        // SAFETY: the pointer and `size` describe the same allocation (null and
        // zero on the sizing call, which is what the API asks for), and the API
        // only writes within `size` bytes.
        let result = unsafe {
            GetExtendedTcpTable(
                if buffer.is_empty() {
                    std::ptr::null_mut()
                } else {
                    buffer.as_mut_ptr().cast()
                },
                &mut size,
                0, // unsorted: we look up a single port
                family,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        match result {
            NO_ERROR => return Ok(buffer),
            ERROR_INSUFFICIENT_BUFFER => {
                if size == 0 {
                    return Ok(Vec::new());
                }
                buffer = vec![0u32; (size as usize).div_ceil(size_of::<u32>())];
            }
            other => {
                return Err(format!(
                    "Could not read the TCP listener table for address family {family}: \
                     Windows error {other}."
                ))
            }
        }
    }
    Err("Could not read the TCP listener table: it kept growing between calls.".to_string())
}

// Terminate `pid`, but only if `is_ours` recognizes the process. Does nothing
// when the process has already exited or we may not touch it.
//
// The identity check and the kill deliberately share ONE handle. An open handle
// pins the process object, so the PID cannot be recycled onto some unrelated
// process in between -- re-opening by PID to terminate would leave exactly that
// window, and the whole point of the identity check is that we never kill a
// process that is not ours.
//
// Windows has no SIGTERM, so unlike the Linux path there is no graceful step to
// try first: an orphan from a previous session has no channel we can ask it to
// shut down through.
#[cfg(all(target_os = "windows", not(feature = "mas")))]
fn terminate_listener_if(
    pid: u32,
    is_ours: impl FnOnce(windows_sys::Win32::Foundation::HANDLE) -> bool,
) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };

    // SAFETY: one handle for both the query and the kill; closed on every path.
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
            0,
            pid,
        )
    };
    if process.is_null() {
        return;
    }
    if is_ours(process) {
        // SAFETY: the same handle, opened with PROCESS_TERMINATE above.
        let _ = unsafe { TerminateProcess(process, 1) };
    }
    let _ = unsafe { CloseHandle(process) };
}

// Whether the executable of `process` lives inside `runtime_dir`.
#[cfg(all(target_os = "windows", not(feature = "mas")))]
fn process_image_is_under(
    process: windows_sys::Win32::Foundation::HANDLE,
    runtime_dir: &Path,
) -> bool {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Threading::{QueryFullProcessImageNameW, PROCESS_NAME_WIN32};

    // Sized for an extended-length path rather than MAX_PATH, so a deeply
    // nested app-data directory is not silently truncated into a non-match.
    let mut buffer = vec![0u16; 32_768];
    let mut length = buffer.len() as u32;
    // SAFETY: `buffer` holds `length` u16s; on success the API sets `length` to
    // the number it wrote, which is never more than the value passed in.
    let queried = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            buffer.as_mut_ptr(),
            &mut length,
        )
    };
    if queried == 0 {
        return false;
    }
    let image = PathBuf::from(OsString::from_wide(
        &buffer[..(length as usize).min(buffer.len())],
    ));
    path_is_under(&image, runtime_dir)
}

// The full command line of `process`, via ProcessCommandLineInformation (Windows
// 8.1+), which only needs PROCESS_QUERY_LIMITED_INFORMATION. None when the
// query fails, e.g. the process has exited.
#[cfg(all(target_os = "windows", not(feature = "mas")))]
fn process_command_line(process: windows_sys::Win32::Foundation::HANDLE) -> Option<String> {
    use std::mem::size_of;
    use windows_sys::Wdk::System::Threading::{
        NtQueryInformationProcess, ProcessCommandLineInformation,
    };
    use windows_sys::Win32::Foundation::UNICODE_STRING;

    // NTSTATUS codes for "buffer too small"; the call reports the size it needs.
    // Which one this info class returns is not documented, so accept all three.
    const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004_u32 as i32;
    const STATUS_BUFFER_TOO_SMALL: i32 = 0xC000_0023_u32 as i32;
    const STATUS_BUFFER_OVERFLOW: i32 = 0x8000_0005_u32 as i32;

    // The result is a UNICODE_STRING header followed by the text it points at.
    // A u64 buffer keeps the header's pointer field aligned.
    let mut buffer = vec![0u64; 512];
    for _ in 0..4 {
        let capacity = (buffer.len() * size_of::<u64>()) as u32;
        let mut needed: u32 = 0;
        // SAFETY: the pointer and `capacity` describe the same allocation, and
        // the call writes at most `capacity` bytes.
        let status = unsafe {
            NtQueryInformationProcess(
                process,
                ProcessCommandLineInformation,
                buffer.as_mut_ptr().cast(),
                capacity,
                &mut needed,
            )
        };
        if matches!(
            status,
            STATUS_INFO_LENGTH_MISMATCH | STATUS_BUFFER_TOO_SMALL | STATUS_BUFFER_OVERFLOW
        ) && needed > capacity
        {
            buffer = vec![0u64; (needed as usize).div_ceil(size_of::<u64>())];
            continue;
        }
        if status < 0 {
            return None;
        }
        // SAFETY: on success the buffer starts with an initialized, aligned
        // UNICODE_STRING.
        let header = unsafe { &*buffer.as_ptr().cast::<UNICODE_STRING>() };
        let start = buffer.as_ptr() as usize;
        let end = start + capacity as usize;
        let text = header.Buffer as usize;
        let bytes = usize::from(header.Length);
        // The text must lie inside our allocation; anything else is not a
        // shape we trust enough to read.
        if header.Buffer.is_null()
            || text < start + size_of::<UNICODE_STRING>()
            || text
                .checked_add(bytes)
                .is_none_or(|text_end| text_end > end)
            || !text.is_multiple_of(std::mem::align_of::<u16>())
        {
            return None;
        }
        // SAFETY: bounds and alignment were checked against our allocation.
        let units = unsafe { std::slice::from_raw_parts(header.Buffer, bytes / 2) };
        return Some(String::from_utf16_lossy(units));
    }
    None
}

// MIB_TCP*ROW_OWNER_PID keeps the local port in the low word of a DWORD, in
// network byte order.
#[cfg(any(all(target_os = "windows", not(feature = "mas")), test))]
fn tcp_table_port(value: u32) -> u16 {
    u16::from_be((value & 0xFFFF) as u16)
}

// Whether `path` sits inside `root`. Compared with separators normalized and
// case folded, because Windows paths are case-insensitive and the image path
// the OS reports need not spell the directory the way we built it. The trailing
// separator is what keeps `...\runtime` from matching `...\runtime-old`.
//
// Folding is ASCII-only on purpose. What actually varies between the path we
// built and the one the OS reports is the drive letter and the segments we
// wrote ourselves, all ASCII; the rest (a user's name in the profile path) is
// byte-identical on both sides. Unicode `to_lowercase` would buy nothing there
// and can change a string's length (Turkish dotless I, sharp S), which would
// misalign the prefix comparison.
#[cfg(any(all(target_os = "windows", not(feature = "mas")), test))]
fn path_is_under(path: &Path, root: &Path) -> bool {
    fn normalize(value: &Path) -> String {
        value
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase()
    }

    let root = normalize(root);
    let root = root.trim_end_matches('\\');
    if root.is_empty() {
        return false;
    }
    normalize(path).starts_with(&format!("{root}\\"))
}

// Kill the processes listening on `port` that `is_ours` recognizes (SIGTERM then
// SIGKILL). The `is_ours` guard prevents killing an unrelated process that
// happens to hold the port.
#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn terminate_listeners_on_port(port: u16, is_ours: fn(i32) -> bool) -> Result<(), String> {
    let inodes = listening_tcp_inodes(port)?;
    if inodes.is_empty() {
        return Ok(());
    }

    let mut pids = HashSet::new();
    for entry in fs::read_dir("/proc").map_err(|error| format!("Could not read /proc: {error}"))? {
        let entry = entry.map_err(|error| format!("Could not read /proc entry: {error}"))?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|value| value.parse::<i32>().ok())
        else {
            continue;
        };
        if process_has_socket(pid, &inodes)? && is_ours(pid) {
            pids.insert(pid);
        }
    }

    terminate_pids(&pids, is_ours);
    Ok(())
}

// Windows: the listener's owner comes from the IP Helper TCP table, and it is
// only terminated when its command line names our sidecar app -- the same
// identity guard Linux uses. The image path is no help here: uv may run the
// sidecar on a system Python outside the runtime directory.
#[cfg(all(target_os = "windows", not(feature = "mas")))]
fn terminate_sidecar_listeners_on_port(port: u16) -> Result<(), String> {
    for pid in listening_tcp_pids(port) {
        terminate_listener_if(pid, |process| {
            process_command_line(process)
                .is_some_and(|command_line| is_geolibre_sidecar_command_line(&command_line))
        });
    }
    Ok(())
}

// macOS has no /proc, so the listener comes from lsof and its command line from
// ps. Both ship with the OS at fixed paths, which keeps a PATH override from
// substituting either. A failed lookup reclaims nothing rather than erroring, so
// the caller still reports the stale-session message the frontend recognizes.
#[cfg(all(target_os = "macos", not(feature = "mas")))]
fn terminate_sidecar_listeners_on_port(port: u16) -> Result<(), String> {
    let pids: HashSet<i32> = listening_tcp_pids_lsof(port)
        .into_iter()
        .filter(|pid| is_geolibre_sidecar_pid(*pid))
        .collect();
    terminate_pids(&pids, is_geolibre_sidecar_pid);
    Ok(())
}

#[cfg(all(target_os = "macos", not(feature = "mas")))]
fn is_geolibre_sidecar_pid(pid: i32) -> bool {
    process_command_line_ps(pid)
        .is_some_and(|command_line| is_geolibre_sidecar_command_line(&command_line))
}

#[cfg(all(target_os = "macos", not(feature = "mas")))]
fn listening_tcp_pids_lsof(port: u16) -> HashSet<i32> {
    let output = match Command::new("/usr/sbin/lsof")
        .args(["-nP", "-t", "-sTCP:LISTEN"])
        .arg(format!("-iTCP:{port}"))
        .stdin(Stdio::null())
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            eprintln!("GeoLibre: could not run lsof: {error}");
            return HashSet::new();
        }
    };
    // lsof exits 1 when nothing matches, so the status is not an error signal;
    // an empty stdout is.
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<i32>().ok())
        .filter(|pid| *pid > 0)
        .collect()
}

#[cfg(all(target_os = "macos", not(feature = "mas")))]
fn process_command_line_ps(pid: i32) -> Option<String> {
    let output = Command::new("/bin/ps")
        .args(["-ww", "-o", "command="])
        .arg("-p")
        .arg(pid.to_string())
        .stdin(Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

// SIGTERM, a short grace, then SIGKILL for whatever is still alive. `kill(2)`
// cannot pin a process the way a Windows handle does, so `is_ours` is checked
// again right before each signal: a sidecar that exited on SIGTERM frees its
// PID, and the OS may hand it to an unrelated process during the grace period.
#[cfg(all(any(target_os = "linux", target_os = "macos"), not(feature = "mas")))]
fn terminate_pids(pids: &HashSet<i32>, is_ours: fn(i32) -> bool) {
    if pids.is_empty() {
        return;
    }
    for pid in pids {
        if is_ours(*pid) {
            terminate_pid(*pid, SIGTERM);
        }
    }
    thread::sleep(Duration::from_millis(250));
    for pid in pids {
        if is_ours(*pid) {
            terminate_pid(*pid, SIGKILL);
        }
    }
}

#[cfg(all(
    not(any(target_os = "linux", target_os = "windows", target_os = "macos")),
    not(feature = "mas")
))]
fn terminate_sidecar_listeners_on_port(_port: u16) -> Result<(), String> {
    Ok(())
}

#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn listening_tcp_inodes(port: u16) -> Result<HashSet<String>, String> {
    let mut inodes = HashSet::new();
    collect_listening_tcp_inodes("/proc/net/tcp", port, &mut inodes, false)?;
    // Systems booted with `ipv6.disable=1` have no `/proc/net/tcp6`; treat a
    // missing IPv6 table as empty rather than failing IPv4 port reclaim.
    collect_listening_tcp_inodes("/proc/net/tcp6", port, &mut inodes, true)?;
    Ok(inodes)
}

#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn collect_listening_tcp_inodes(
    path: &str,
    port: u16,
    inodes: &mut HashSet<String>,
    optional: bool,
) -> Result<(), String> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if optional && error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not read {path}: {error}")),
    };
    let expected_port = format!("{port:04X}");
    for line in content.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() <= 9 || fields[3] != "0A" {
            continue;
        }
        let Some(local_port) = fields[1].rsplit_once(':').map(|(_, value)| value) else {
            continue;
        };
        if local_port.eq_ignore_ascii_case(&expected_port) {
            inodes.insert(fields[9].to_string());
        }
    }
    Ok(())
}

#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn process_has_socket(pid: i32, inodes: &HashSet<String>) -> Result<bool, String> {
    let fd_dir = format!("/proc/{pid}/fd");
    let Ok(entries) = fs::read_dir(&fd_dir) else {
        return Ok(false);
    };
    for entry in entries {
        let Ok(entry) = entry else {
            continue; // process may have exited between the /proc scan and this read
        };
        let Ok(target) = fs::read_link(entry.path()) else {
            continue;
        };
        let target = target.to_string_lossy();
        if let Some(inode) = target
            .strip_prefix("socket:[")
            .and_then(|value| value.strip_suffix(']'))
        {
            if inodes.contains(inode) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn is_geolibre_sidecar_process(pid: i32) -> bool {
    let path = format!("/proc/{pid}/cmdline");
    let Ok(command_line) = fs::read(path) else {
        return false;
    };
    let command_line = String::from_utf8_lossy(&command_line);
    // Linux has always also accepted the app's directory path; Windows and macOS
    // match only the module the sidecar is launched with.
    is_geolibre_sidecar_command_line(&command_line) || command_line.contains("geolibre_server/app")
}

// Whether a process command line is one of our sidecars, started by
// start_geolibre_sidecar_blocking as `uvicorn geolibre_server.app.main:app`.
#[cfg(any(
    all(
        any(target_os = "linux", target_os = "windows", target_os = "macos"),
        not(feature = "mas")
    ),
    test
))]
fn is_geolibre_sidecar_command_line(command_line: &str) -> bool {
    command_line.contains("geolibre_server.app.main")
}

// Recognize OUR Jupyter server (started by start_jupyter_server) by the bundled
// config path on its command line — specific enough not to match the user's own
// jupyter/JupyterHub processes.
#[cfg(all(target_os = "linux", not(feature = "mas")))]
fn is_geolibre_jupyter_process(pid: i32) -> bool {
    let path = format!("/proc/{pid}/cmdline");
    let Ok(command_line) = fs::read(path) else {
        return false;
    };
    let command_line = String::from_utf8_lossy(&command_line);
    command_line.contains("jupyter_server_config.py") && command_line.contains("geolibre_server")
}

#[cfg(all(unix, not(feature = "mas")))]
fn terminate_pid(pid: i32, signal: i32) {
    let _ = unsafe { kill(pid, signal) };
}

#[cfg(not(feature = "mas"))]
fn sidecar_project_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = env::var("GEOLIBRE_SIDECAR_PROJECT_DIR") {
        return validate_sidecar_project_dir(PathBuf::from(path));
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        if let Some(path) = resolve_sidecar_in_resource_dir(&resource_dir) {
            return Ok(path);
        }
    }

    validate_sidecar_project_dir(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join("backend")
            .join("geolibre_server"),
    )
}

/// Locate the bundled Python sidecar project under a Tauri resource directory.
///
/// Tauri bundles the `../../../backend/geolibre_server` resource by rewriting
/// every leading `..` in the source path to an `_up_` directory, so in an
/// installed build the project lands at
/// `<resource_dir>/_up_/_up_/_up_/backend/geolibre_server` rather than directly
/// under the resource dir (issue #1223). We probe the plain locations first,
/// then a few `_up_` depths so the lookup keeps working if the number of `..`
/// segments in the resource path ever changes.
#[cfg(not(feature = "mas"))]
fn resolve_sidecar_in_resource_dir(resource_dir: &std::path::Path) -> Option<PathBuf> {
    // Plain resource root plus a few `_up_` levels of margin over the observed
    // 3-level bundle depth, so the lookup survives a change in Tauri's bundling.
    const MAX_UP_DEPTH: usize = 4;
    let mut prefix = resource_dir.to_path_buf();
    for _ in 0..=MAX_UP_DEPTH {
        if let Ok(path) =
            validate_sidecar_project_dir(prefix.join("backend").join("geolibre_server"))
        {
            return Some(path);
        }
        if let Ok(path) = validate_sidecar_project_dir(prefix.join("geolibre_server")) {
            return Some(path);
        }
        prefix = prefix.join("_up_");
    }
    None
}

#[cfg(not(feature = "mas"))]
fn validate_sidecar_project_dir(path: PathBuf) -> Result<PathBuf, String> {
    let path = path
        .canonicalize()
        .map_err(|error| format!("Could not resolve sidecar project path: {error}"))?;
    if path.join("pyproject.toml").exists() {
        Ok(path)
    } else {
        Err(format!(
            "Could not find GeoLibre sidecar project at {}",
            path.display()
        ))
    }
}

#[cfg(not(feature = "mas"))]
fn ensure_managed_uv(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = env::var("GEOLIBRE_UV") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
    }

    if let Some(path) = find_executable_on_path(uv_executable_name()) {
        return Ok(path);
    }

    install_managed_uv(app)
}

#[cfg(not(feature = "mas"))]
fn install_managed_uv(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let uv_dir = app_runtime_dir(app)?.join("uv-bin");
    // A pinned release archive, SHA-256 verified before extraction; no remote
    // install script is ever run. The shared lock covers sidecar and Jupyter.
    uv_bootstrap::ensure_pinned_uv(&uv_dir)
}

#[cfg(not(feature = "mas"))]
fn uv_executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "uv.exe"
    } else {
        "uv"
    }
}

#[cfg(not(feature = "mas"))]
fn find_executable_on_path(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file() && is_executable(candidate))
}

#[cfg(all(unix, not(feature = "mas")))]
fn is_executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(all(not(unix), not(feature = "mas")))]
fn is_executable(_path: &std::path::Path) -> bool {
    true
}

#[cfg(not(feature = "mas"))]
fn ensure_martin_binary_path(app: &tauri::AppHandle) -> Result<MartinBinaryInfo, String> {
    let asset_name = martin_asset_name()?;
    let executable_name = martin_executable_name();
    let martin_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("martin")
        .join(MARTIN_VERSION)
        .join(
            asset_name
                .trim_end_matches(".tar.gz")
                .trim_end_matches(".zip"),
        );
    let binary_path = martin_dir.join(executable_name);
    let temp_binary_path = martin_dir.join(format!("{executable_name}.download"));

    if binary_path.exists() {
        return Ok(MartinBinaryInfo {
            path: binary_path.to_string_lossy().to_string(),
            downloaded: false,
        });
    }

    fs::create_dir_all(&martin_dir)
        .map_err(|error| format!("Could not create Martin cache directory: {error}"))?;
    let _ = fs::remove_file(&temp_binary_path);
    let archive = download_martin_asset(asset_name)?;
    if let Err(error) = extract_martin_binary(&archive, asset_name, &temp_binary_path)
        .and_then(|_| make_executable(&temp_binary_path))
        .and_then(|_| {
            fs::rename(&temp_binary_path, &binary_path)
                .map_err(|error| format!("Could not install Martin binary: {error}"))
        })
    {
        let _ = fs::remove_file(&temp_binary_path);
        return Err(error);
    }

    Ok(MartinBinaryInfo {
        path: binary_path.to_string_lossy().to_string(),
        downloaded: true,
    })
}

#[cfg(not(feature = "mas"))]
fn martin_asset_name() -> Result<&'static str, String> {
    if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
        return Ok("martin-x86_64-unknown-linux-musl.tar.gz");
    }
    if cfg!(target_os = "linux") && cfg!(target_arch = "aarch64") {
        return Ok("martin-aarch64-unknown-linux-musl.tar.gz");
    }
    if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        return Ok("martin-aarch64-apple-darwin.tar.gz");
    }
    if cfg!(target_os = "macos") && cfg!(target_arch = "x86_64") {
        return Ok("martin-x86_64-apple-darwin.tar.gz");
    }
    if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
        return Ok("martin-x86_64-pc-windows-msvc.zip");
    }

    Err("No Martin binary release is available for this platform.".to_string())
}

#[cfg(not(feature = "mas"))]
fn martin_executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "martin.exe"
    } else {
        "martin"
    }
}

#[cfg(not(feature = "mas"))]
fn download_martin_asset(asset_name: &str) -> Result<Vec<u8>, String> {
    let url = format!("{MARTIN_RELEASE_BASE_URL}/{MARTIN_VERSION}/{asset_name}");
    let response = reqwest::blocking::Client::builder()
        .user_agent("GeoLibre Desktop")
        .build()
        .map_err(|error| format!("Could not create HTTP client: {error}"))?
        .get(url)
        .send()
        .map_err(|error| format!("Could not download Martin: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Martin download failed with status {status}"));
    }

    response
        .bytes()
        .map(|bytes| bytes.to_vec())
        .map_err(|error| format!("Could not read Martin download: {error}"))
}

#[cfg(not(feature = "mas"))]
fn extract_martin_binary(
    archive: &[u8],
    asset_name: &str,
    binary_path: &Path,
) -> Result<(), String> {
    if asset_name.ends_with(".zip") {
        extract_martin_binary_from_zip(archive, binary_path)
    } else {
        extract_martin_binary_from_tar_gz(archive, binary_path)
    }
}

#[cfg(not(feature = "mas"))]
fn extract_martin_binary_from_tar_gz(archive: &[u8], binary_path: &Path) -> Result<(), String> {
    let decoder = GzDecoder::new(Cursor::new(archive));
    let mut archive = tar::Archive::new(decoder);
    let executable_name = martin_executable_name();
    let entries = archive
        .entries()
        .map_err(|error| format!("Could not read Martin archive: {error}"))?;

    for entry in entries {
        let mut entry = entry.map_err(|error| format!("Could not read Martin archive: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("Could not read Martin archive path: {error}"))?;
        if path.file_name().and_then(|name| name.to_str()) != Some(executable_name) {
            continue;
        }

        copy_archive_entry_to_path(&mut entry, binary_path)?;
        return Ok(());
    }

    Err("Martin archive did not contain the expected executable.".to_string())
}

#[cfg(not(feature = "mas"))]
fn extract_martin_binary_from_zip(archive: &[u8], binary_path: &Path) -> Result<(), String> {
    let reader = Cursor::new(archive);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|error| format!("Could not read Martin zip: {error}"))?;
    let executable_name = martin_executable_name();

    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|error| format!("Could not read Martin zip entry: {error}"))?;
        let name = file
            .name()
            .map_err(|error| format!("Could not read Martin zip entry name: {error}"))?;
        let path = PathBuf::from(name.as_ref());
        if path.file_name().and_then(|name| name.to_str()) != Some(executable_name) {
            continue;
        }

        copy_archive_entry_to_path(&mut file, binary_path)?;
        return Ok(());
    }

    Err("Martin zip did not contain the expected executable.".to_string())
}

#[cfg(not(feature = "mas"))]
fn copy_archive_entry_to_path<R: Read>(reader: &mut R, path: &Path) -> Result<(), String> {
    let mut output =
        File::create(path).map_err(|error| format!("Could not create Martin binary: {error}"))?;
    if let Err(error) = std::io::copy(reader, &mut output) {
        let _ = fs::remove_file(path);
        return Err(format!("Could not extract Martin binary: {error}"));
    }
    Ok(())
}

#[cfg(all(unix, not(feature = "mas")))]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path)
        .map_err(|error| format!("Could not read Martin binary permissions: {error}"))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .map_err(|error| format!("Could not mark Martin executable: {error}"))
}

#[cfg(all(not(unix), not(feature = "mas")))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(not(feature = "mas"))]
struct SpawnedMartinServer {
    base_url: String,
    port: u16,
    process: MartinProcess,
}

#[cfg(not(feature = "mas"))]
fn spawn_martin_server(
    binary_path: &str,
    connection_string: &str,
    default_srid: Option<&str>,
) -> Result<SpawnedMartinServer, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Could not reserve a local Martin port: {error}"))?;
    let port = listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("Could not read local Martin port: {error}"))?;
    let listen_address = format!("127.0.0.1:{port}");
    let base_url = format!("http://127.0.0.1:{port}");
    let mut command = Command::new(binary_path);
    command
        .arg("-l")
        .arg(&listen_address)
        .env("DATABASE_URL", connection_string)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(default_srid) = default_srid
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        command.env("DEFAULT_SRID", default_srid);
    }

    // Martin is a console program too, and it runs for as long as the PostGIS
    // connection is open.
    hide_console_window(&mut command);

    drop(listener);
    let mut child = process_lifetime::spawn_managed_child(command)
        .map_err(|error| format!("Could not start Martin: {error}"))?;
    // Drain both pipes from the moment we spawn, and for as long as Martin
    // runs. Martin logs at least one line per auto-published table before it
    // binds its port, so a database with a few hundred tables overflows the
    // pipe buffer during discovery: reading only after exit (the old shape)
    // left Martin blocked on a log write and every health poll timing out.
    let output = CapturedOutput::attach(&mut child);

    if let Err(error) = wait_for_martin_health(&base_url, &mut child, &output) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    Ok(SpawnedMartinServer {
        base_url,
        port,
        process: MartinProcess { child },
    })
}

#[cfg(not(feature = "mas"))]
fn wait_for_martin_health(
    base_url: &str,
    child: &mut Child,
    output: &CapturedOutput,
) -> Result<(), String> {
    let health_url = format!("{base_url}/health");
    let client =
        loopback_http_client().map_err(|error| format!("Could not create HTTP client: {error}"))?;

    for _ in 0..MARTIN_HEALTH_ATTEMPTS {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not inspect Martin process: {error}"))?
        {
            return Err(child_failure_message(
                &format!("Martin exited before it was ready (exit status: {status})."),
                output,
            ));
        }

        if client
            .get(&health_url)
            .send()
            .map(|response| response.status().is_success())
            .unwrap_or(false)
        {
            return Ok(());
        }

        thread::sleep(Duration::from_millis(100));
    }

    Err(child_failure_message(
        "Martin did not become ready in time.",
        output,
    ))
}

fn create_main_window(app: &mut tauri::App) -> tauri::Result<()> {
    let window_config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .expect("GeoLibre Desktop requires a main window config");

    let builder = tauri::WebviewWindowBuilder::from_config(app, &window_config)?;

    // Only desktop opens OAuth flows in child windows; on mobile they navigate
    // in-page (or via the system browser), so skip the new-window handler.
    #[cfg(desktop)]
    let builder = {
        let app_handle = app.handle().clone();
        builder.on_new_window(move |url, features| {
            create_oauth_popup_window(app_handle.clone(), url, features)
        })
    };

    builder.build()?;

    Ok(())
}

#[cfg(desktop)]
fn create_oauth_popup_window(
    app_handle: tauri::AppHandle,
    url: tauri::Url,
    features: tauri::webview::NewWindowFeatures,
) -> tauri::webview::NewWindowResponse<tauri::Wry> {
    let popup_id = POPUP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let child_app_handle = app_handle.clone();
    let blank_url: tauri::Url = match "about:blank".parse() {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("OAuth popup: could not parse blank URL: {error}");
            return tauri::webview::NewWindowResponse::Deny;
        }
    };
    let window = match tauri::WebviewWindowBuilder::new(
        &app_handle,
        format!("oauthPopup{popup_id}"),
        tauri::WebviewUrl::External(blank_url),
    )
    .window_features(features)
    .title(url.as_str())
    .on_new_window(move |url, features| {
        create_oauth_popup_window(child_app_handle.clone(), url, features)
    })
    .on_document_title_changed(|window, title| {
        let _ = window.set_title(&title);
    })
    .build()
    {
        Ok(window) => window,
        Err(error) => {
            eprintln!("OAuth popup: failed to create popup window: {error}");
            return tauri::webview::NewWindowResponse::Deny;
        }
    };

    tauri::webview::NewWindowResponse::Create { window }
}

#[cfg(test)]
mod tests {
    use super::{is_geolibre_sidecar_command_line, path_is_under, tcp_table_port};
    #[cfg(not(feature = "mas"))]
    use crate::test_support::ScratchDir;
    // Everything these imports feed is compiled out of the `mas` build, so the
    // tests that exercise it (and their scaffolding) are gated with it.
    #[cfg(not(feature = "mas"))]
    use super::{
        add_main_sidecar_extras, add_sidecar_python_pin, child_failure_message,
        clear_appimage_python_env, resolve_sidecar_in_resource_dir, sidecar_accepts_token,
        sidecar_health_is_ready, CapturedOutput, CAPTURED_LOG_MAX_LINES,
        CAPTURED_LOG_REPORTED_LINES, CAPTURED_LOG_SETTLE,
    };
    // Only the unix-only Martin tests (they spawn `sh`) use these.
    #[cfg(all(unix, not(feature = "mas")))]
    use super::{martin_slot_is_busy, wait_for_martin_health, MartinProcess};
    #[cfg(not(feature = "mas"))]
    use std::env;
    #[cfg(not(feature = "mas"))]
    use std::ffi::{OsStr, OsString};
    #[cfg(not(feature = "mas"))]
    use std::io::Write;
    #[cfg(not(feature = "mas"))]
    use std::process::Command;
    #[cfg(not(feature = "mas"))]
    use std::sync::Mutex;
    #[cfg(not(feature = "mas"))]
    use std::time::Duration;

    // `std::env::set_var` is process-global, so the tests that stage an AppImage
    // environment must not run concurrently with each other.
    #[cfg(not(feature = "mas"))]
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[cfg(not(feature = "mas"))]
    #[test]
    fn main_sidecar_installs_database_runtimes() {
        let mut command = Command::new("uv");
        add_main_sidecar_extras(&mut command);
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(
            args,
            [
                OsStr::new("--extra"),
                OsStr::new("ml"),
                OsStr::new("--extra"),
                OsStr::new("postgis"),
                OsStr::new("--extra"),
                OsStr::new("mssql"),
            ]
        );
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn sidecar_environments_pass_the_python_pin() {
        let mut command = Command::new("uv");
        add_sidecar_python_pin(&mut command);
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, [OsStr::new("--python"), OsStr::new("3.12")]);
    }

    // Regression for issue #1223: installed builds place the bundled sidecar at
    // `<resource_dir>/_up_/_up_/_up_/backend/geolibre_server`, so the resolver
    // must follow the `_up_` chain rather than only checking the resource root.
    #[cfg(not(feature = "mas"))]
    #[test]
    fn resolves_bundled_sidecar_under_up_prefix() {
        let root = ScratchDir::new("sidecar-up");
        let project = root
            .path()
            .join("_up_")
            .join("_up_")
            .join("_up_")
            .join("backend")
            .join("geolibre_server");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("pyproject.toml"), "[project]\n").unwrap();

        let resolved =
            resolve_sidecar_in_resource_dir(root.path()).expect("sidecar should be found");
        assert_eq!(resolved, project.canonicalize().unwrap());

        // The plain (0-level) layout used by portable builds, where the sidecar
        // sits at `backend/geolibre_server` directly under the resource dir.
        let plain_root = ScratchDir::new("sidecar-plain");
        let plain_project = plain_root.path().join("backend").join("geolibre_server");
        std::fs::create_dir_all(&plain_project).unwrap();
        std::fs::write(plain_project.join("pyproject.toml"), "[project]\n").unwrap();
        let plain_resolved = resolve_sidecar_in_resource_dir(plain_root.path())
            .expect("plain sidecar should be found");
        assert_eq!(plain_resolved, plain_project.canonicalize().unwrap());

        // A resource dir without the project (and without a pyproject marker)
        // resolves to nothing rather than a false positive.
        let empty = ScratchDir::new("sidecar-empty");
        assert!(resolve_sidecar_in_resource_dir(empty.path()).is_none());
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn captured_output_keeps_only_the_trailing_lines() {
        let captured = CapturedOutput::new();
        for index in 0..(CAPTURED_LOG_MAX_LINES * 3) {
            captured.push(format!("line {index}"));
        }
        let tail = captured.tail();
        let lines: Vec<_> = tail.lines().collect();
        // The buffer is bounded and the report quotes only its end, so a child
        // that writes thousands of lines still yields a short, recent tail.
        assert_eq!(lines.len(), CAPTURED_LOG_REPORTED_LINES);
        let last = CAPTURED_LOG_MAX_LINES * 3 - 1;
        assert_eq!(lines[lines.len() - 1], format!("line {last}"));
        assert_eq!(
            lines[0],
            format!("line {}", last + 1 - CAPTURED_LOG_REPORTED_LINES)
        );
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn captured_output_drops_blank_lines_from_the_tail() {
        let captured = CapturedOutput::new();
        captured.push("error: Failed to spawn: `jupyter`".to_string());
        captured.push("   ".to_string());
        captured.push(String::new());
        captured.push("  Caused by: No such file or directory (os error 2)  ".to_string());
        assert_eq!(
            captured.tail(),
            "error: Failed to spawn: `jupyter`\n  Caused by: No such file or directory (os error 2)"
        );
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn child_failure_message_quotes_the_child_output() {
        let captured = CapturedOutput::new();
        captured.push("error: Extra `notebook` is not defined".to_string());
        let message = child_failure_message("Jupyter server exited.", &captured);
        assert!(message.starts_with("Jupyter server exited."));
        // The cause has to travel with the error: an installed build is
        // GUI-subsystem on Windows and has no terminal to read it from.
        assert!(message.contains("error: Extra `notebook` is not defined"));
    }

    #[cfg(not(feature = "mas"))]
    #[test]
    fn child_failure_message_says_so_when_there_was_no_output() {
        let message = child_failure_message("Jupyter server exited.", &CapturedOutput::new());
        assert_eq!(message, "Jupyter server exited. It produced no output.");
    }

    // Regression for #2677. Martin writes one or more log lines per discovered
    // table before it binds its port, so a large schema overflows the pipe
    // buffer during startup. With the pipes left unread the child blocked on
    // that write and never exited, and the waiter reported a bare timeout. A
    // child that writes well past the buffer and then exits must be seen to
    // exit, with its last line quoted.
    #[cfg(all(unix, not(feature = "mas")))]
    #[test]
    fn martin_waiter_drains_a_log_larger_than_the_pipe_buffer() {
        use std::process::{Command, Stdio};

        // The last line goes to stdout too: stdout and stderr are separate
        // pipes drained by separate threads, so a stderr line written after
        // the stdout flood can land in the buffer before the stdout reader
        // catches up, and the flood then evicts it from the reported tail.
        // Only one stream has a defined order to assert on.
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(
                "i=0; while [ $i -lt 2000 ]; do \
                 echo \"INFO martin: source public.table_$i added, no spatial index\"; \
                 i=$((i+1)); done; echo 'error: last line'; exit 3",
            )
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn a chatty child");
        let output = CapturedOutput::attach(&mut child);
        // Port 9 (discard) is never serving HTTP, so health never succeeds and
        // the only way out before the timeout is the child exiting.
        let error = wait_for_martin_health("http://127.0.0.1:9", &mut child, &output)
            .expect_err("the child exits without becoming healthy");
        let _ = child.kill();
        let _ = child.wait();
        assert!(error.contains("exited before it was ready"), "got: {error}");
        assert!(error.contains("error: last line"), "got: {error}");
    }

    // The stderr half of the test above: a child that reports its failure on
    // stderr (with stdout quiet, so there is no cross-pipe ordering to race)
    // must have that line quoted in the waiter's error.
    #[cfg(all(unix, not(feature = "mas")))]
    #[test]
    fn martin_waiter_quotes_the_stderr_tail() {
        use std::process::{Command, Stdio};

        let mut child = Command::new("sh")
            .arg("-c")
            .arg("echo 'error: bind failed' >&2; exit 3")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn a failing child");
        let output = CapturedOutput::attach(&mut child);
        let error = wait_for_martin_health("http://127.0.0.1:9", &mut child, &output)
            .expect_err("the child exits without becoming healthy");
        let _ = child.kill();
        let _ = child.wait();
        assert!(error.contains("exited before it was ready"), "got: {error}");
        assert!(error.contains("error: bind failed"), "got: {error}");
    }

    // The sidecar probes must reach 127.0.0.1 directly. A corporate proxy picked
    // up from the environment or the Windows system settings would otherwise
    // answer them itself, so a healthy sidecar never reads as ready (#3003).
    // reqwest reads the proxy env vars each time a client is built, so pointing
    // them at a proxy that refuses everything shows whether the probes bypass it.
    #[cfg(not(feature = "mas"))]
    #[test]
    fn sidecar_probes_bypass_a_configured_proxy() {
        use std::io::Read;
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use std::thread;

        /// Serves every connection with `response` and returns the server's
        /// address plus a count of the requests it answered.
        fn serve(response: &'static [u8]) -> (String, Arc<AtomicUsize>) {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
            let address = listener.local_addr().unwrap().to_string();
            let hits = Arc::new(AtomicUsize::new(0));
            let counter = Arc::clone(&hits);
            thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let mut buffer = [0_u8; 1024];
                    let _ = stream.read(&mut buffer);
                    counter.fetch_add(1, Ordering::SeqCst);
                    let _ = stream.write_all(response);
                }
            });
            (address, hits)
        }

        /// Restores the proxy env vars even when an assertion fails.
        struct ProxyEnv(Vec<(&'static str, Option<OsString>)>);
        impl Drop for ProxyEnv {
            fn drop(&mut self) {
                for (name, value) in &self.0 {
                    match value {
                        Some(value) => env::set_var(name, value),
                        None => env::remove_var(name),
                    }
                }
            }
        }

        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (sidecar, _) =
            serve(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
        let (proxy, proxy_hits) =
            serve(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");

        let names = [
            "HTTP_PROXY",
            "http_proxy",
            "ALL_PROXY",
            "all_proxy",
            "NO_PROXY",
            "no_proxy",
        ];
        let saved = names.iter().map(|name| (*name, env::var_os(name)));
        let _restore = ProxyEnv(saved.collect());
        for name in names {
            env::remove_var(name);
        }
        env::set_var("HTTP_PROXY", format!("http://{proxy}"));
        env::set_var("http_proxy", format!("http://{proxy}"));

        let base_url = format!("http://{sidecar}");
        assert!(sidecar_health_is_ready(&base_url));
        assert!(sidecar_accepts_token(&base_url, "token"));
        let proxy_requests = proxy_hits.load(Ordering::SeqCst);
        assert_eq!(proxy_requests, 0, "a probe went through the proxy");
    }

    // A Martin that died or was killed from outside must not keep blocking new
    // starts with "already running"; a live one still must.
    #[cfg(all(unix, not(feature = "mas")))]
    #[test]
    fn martin_slot_clears_an_exited_process_but_keeps_a_live_one() {
        use std::process::{Command, Stdio};

        let spawn = |script: &str| {
            Command::new("sh")
                .arg("-c")
                .arg(script)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn a child")
        };

        let mut exited = spawn("exit 0");
        exited.wait().expect("wait for the child to exit");
        let mut slot = Some(MartinProcess { child: exited });
        assert!(!martin_slot_is_busy(&mut slot));
        assert!(slot.is_none());

        let mut slot = Some(MartinProcess {
            child: spawn("sleep 30"),
        });
        assert!(martin_slot_is_busy(&mut slot));
        assert!(slot.is_some());
        // Dropping the MartinProcess kills and reaps the sleeper.
        drop(slot);

        let mut empty: Option<MartinProcess> = None;
        assert!(!martin_slot_is_busy(&mut empty));
    }

    // The whole point of the capture is that the child's *last* lines — the
    // error that killed it — reach the report. `try_wait` can observe the exit
    // while those lines are still in the pipe, so the report has to wait for the
    // readers to drain. Uses a real child so the race is real: a spawn that
    // writes and exits immediately, reported the way the health waiters do.
    #[cfg(all(unix, not(feature = "mas")))]
    #[test]
    fn child_failure_message_waits_for_output_still_in_the_pipe() {
        use std::process::{Command, Stdio};

        let mut child = Command::new("sh")
            .arg("-c")
            .arg("echo 'error: the cause'; echo 'to stderr' >&2")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn a child that writes and exits");
        let output = CapturedOutput::attach(&mut child);
        // Mirror the waiters: report as soon as the exit is observed.
        while child.try_wait().expect("inspect child").is_none() {
            std::thread::sleep(Duration::from_millis(5));
        }
        let message = child_failure_message("Child exited.", &output);
        assert!(message.contains("error: the cause"), "got: {message}");
        assert!(message.contains("to stderr"), "got: {message}");
    }

    // The race the report has to win, made deterministic. A reader that is
    // provably still behind at report time stands in for bytes sitting in the
    // OS pipe after `try_wait` has already reported the child gone. Without
    // `settle` the report races past it and quotes nothing — which is the
    // failure mode the capture exists to prevent. (The real-child test above
    // exercises the same path end to end, but its timing is not guaranteed:
    // on a fast machine the reader usually wins on its own.)
    #[cfg(not(feature = "mas"))]
    #[test]
    fn child_failure_message_waits_for_output_still_in_flight() {
        struct SlowThenEof {
            sent: bool,
        }
        impl std::io::Read for SlowThenEof {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.sent {
                    return Ok(0); // EOF
                }
                std::thread::sleep(Duration::from_millis(100));
                let line = b"error: the cause\n";
                buf[..line.len()].copy_from_slice(line);
                self.sent = true;
                Ok(line.len())
            }
        }

        let captured = CapturedOutput::new();
        captured.drain(SlowThenEof { sent: false }, false);
        let message = child_failure_message("Child exited.", &captured);
        assert!(message.contains("error: the cause"), "got: {message}");
    }

    // AppImageKit's AppRun exports PYTHONHOME=$APPDIR/usr/ into every child. A
    // Python that honours it looks for its stdlib inside the AppImage mount and
    // aborts with "Failed to import encodings module" before running any code,
    // which is how the Notebook panel and the sidecar died in AppImage builds.
    // Serialized with the other env-mutating test: these share process env.
    #[cfg(not(feature = "mas"))]
    #[test]
    fn appimage_python_env_is_stripped_from_children() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let appdir = "/tmp/.mount_GeoLibreXXXX";
        // Reproduce what AppRun exports.
        env::set_var("APPDIR", appdir);
        env::set_var("PYTHONHOME", format!("{appdir}/usr/"));
        env::set_var(
            "PYTHONPATH",
            format!("{appdir}/usr/share/pyshared/:/home/me/lib"),
        );
        env::set_var(
            "LD_LIBRARY_PATH",
            format!("{appdir}/usr/lib/:{appdir}/lib/"),
        );

        let mut command = Command::new("true");
        clear_appimage_python_env(&mut command);
        let envs: Vec<_> = command.get_envs().collect();
        let lookup = |name: &str| {
            envs.iter()
                .find(|(key, _)| *key == OsStr::new(name))
                .map(|(_, value)| *value)
        };

        // PYTHONHOME is dropped outright — it is the fatal one.
        assert_eq!(lookup("PYTHONHOME"), Some(None));
        // The user's own PYTHONPATH entry survives; the AppDir one does not.
        assert_eq!(lookup("PYTHONPATH"), Some(Some(OsStr::new("/home/me/lib"))));
        // Every LD_LIBRARY_PATH entry was an AppDir entry, so the variable is
        // unset rather than passed through empty.
        assert_eq!(lookup("LD_LIBRARY_PATH"), Some(None));

        env::remove_var("APPDIR");
        env::remove_var("PYTHONHOME");
        env::remove_var("PYTHONPATH");
        env::remove_var("LD_LIBRARY_PATH");
    }

    // Outside an AppImage nothing is filtered: a user who deliberately set these
    // for their own Python must keep them.
    #[cfg(not(feature = "mas"))]
    #[test]
    fn python_env_is_untouched_outside_an_appimage() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        env::remove_var("APPDIR");
        env::set_var("PYTHONPATH", "/home/me/lib:/opt/other");

        let mut command = Command::new("true");
        clear_appimage_python_env(&mut command);
        let value = command
            .get_envs()
            .find(|(key, _)| *key == OsStr::new("PYTHONPATH"))
            .map(|(_, value)| value);
        assert_eq!(value, Some(Some(OsStr::new("/home/me/lib:/opt/other"))));

        env::remove_var("PYTHONPATH");
    }

    // The Jupyter launch sets PYTHONPATH itself (notebook-lib, so `import
    // geolibre` works) before the sanitizer runs; the sanitizer must not
    // overwrite it.
    #[cfg(not(feature = "mas"))]
    #[test]
    fn a_pythonpath_the_caller_already_set_is_preserved() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        env::set_var("APPDIR", "/tmp/.mount_GeoLibreXXXX");
        env::set_var("PYTHONPATH", "/tmp/.mount_GeoLibreXXXX/usr/share/pyshared/");

        let mut command = Command::new("true");
        command.env("PYTHONPATH", "/app/runtime/notebook-lib");
        clear_appimage_python_env(&mut command);
        let value = command
            .get_envs()
            .find(|(key, _)| *key == OsStr::new("PYTHONPATH"))
            .map(|(_, value)| value);
        assert_eq!(value, Some(Some(OsStr::new("/app/runtime/notebook-lib"))));

        env::remove_var("APPDIR");
        env::remove_var("PYTHONPATH");
    }

    // A reader that never reaches EOF must not hang the report: `uv` spawns
    // `jupyter`, which spawns kernels holding these same pipe handles, so a
    // grandchild outliving the child keeps the write end open forever. `settle`
    // is bounded for exactly this case.
    #[cfg(not(feature = "mas"))]
    #[test]
    fn settle_gives_up_on_a_reader_that_never_reaches_eof() {
        struct NeverEnds;
        impl std::io::Read for NeverEnds {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                std::thread::sleep(Duration::from_millis(50));
                buf[0] = b'\n';
                Ok(1)
            }
        }

        let captured = CapturedOutput::new();
        captured.drain(NeverEnds, false);
        let started = std::time::Instant::now();
        captured.settle();
        // Bounded: returns at the deadline rather than blocking forever. The
        // generous upper bound keeps this from flaking on a loaded CI runner.
        assert!(
            started.elapsed() < CAPTURED_LOG_SETTLE * 10,
            "settle blocked for {:?}",
            started.elapsed()
        );
    }

    // The Windows reaper reads the local port out of a DWORD that holds it in
    // network byte order in its low word. Getting this wrong would match the
    // wrong listener (or none), so pin the decoding here -- these are pure
    // functions, so the check runs on every platform even though their only
    // caller is Windows-only.
    #[test]
    fn decodes_a_network_order_port_from_the_tcp_table() {
        // 8766 = 0x223E; network byte order puts 0x22 first, so the DWORD's low
        // word reads 0x3E22, and the high word is padding the API does not use.
        assert_eq!(tcp_table_port(0x0000_3E22), 8766);
        assert_eq!(tcp_table_port(0xDEAD_3E22), 8766);
        assert_eq!(tcp_table_port(0x0000_223E), 0x3E22);
    }

    // The image-path guard is what keeps the reaper from killing a Jupyter the
    // user installed themselves: only executables under our own runtime
    // directory are ours to terminate.
    #[test]
    fn recognizes_only_paths_inside_the_runtime_directory() {
        let root =
            std::path::Path::new(r"C:\Users\me\AppData\Roaming\org.geolibre.desktop\runtime");
        assert!(path_is_under(
            std::path::Path::new(
                r"C:\Users\me\AppData\Roaming\org.geolibre.desktop\runtime\jupyter-server\Scripts\python.exe"
            ),
            root
        ));
        // Case and separator differences are not a mismatch on Windows.
        assert!(path_is_under(
            std::path::Path::new(
                r"c:\users\me\appdata\roaming\org.geolibre.desktop\RUNTIME/uv-bin/uv.exe"
            ),
            root
        ));
        // A sibling directory sharing the prefix is not inside it.
        assert!(!path_is_under(
            std::path::Path::new(
                r"C:\Users\me\AppData\Roaming\org.geolibre.desktop\runtime-old\jupyter-server\python.exe"
            ),
            root
        ));
        // The user's own Python is left alone.
        assert!(!path_is_under(
            std::path::Path::new(r"C:\Program Files\Python312\python.exe"),
            root
        ));
        // A non-ASCII profile name survives the fold: ASCII case folding leaves
        // it byte-identical on both sides, where Unicode lowercasing could
        // change its length and misalign the prefix.
        let unicode_root = std::path::Path::new(r"C:\Users\İŞIL\AppData\Roaming\runtime");
        assert!(path_is_under(
            std::path::Path::new(
                r"C:\Users\İŞIL\AppData\Roaming\runtime\jupyter-server\python.exe"
            ),
            unicode_root
        ));
        // The directory itself is not "inside" itself, and an empty root never
        // matches (which would otherwise make every listener look like ours).
        assert!(!path_is_under(root, root));
        assert!(!path_is_under(
            std::path::Path::new(r"C:\anything"),
            std::path::Path::new("")
        ));
    }

    #[test]
    fn recognizes_only_geolibre_sidecar_command_lines() {
        // Windows: uv's uvicorn.exe trampoline hands the app spec to Python.
        assert!(is_geolibre_sidecar_command_line(
            r#""C:\Python312\python.exe" "C:\Users\me\AppData\Roaming\org.geolibre.desktop\runtime\sidecar-server\Scripts\uvicorn.exe" geolibre_server.app.main:app --host 127.0.0.1 --port 8765"#
        ));
        // Linux /proc cmdline (NUL-separated) and macOS ps output.
        assert!(is_geolibre_sidecar_command_line(
            "/runtime/sidecar-server/bin/python3\0/runtime/sidecar-server/bin/uvicorn\0geolibre_server.app.main:app\0"
        ));
        // The user's own server on the same port is left alone.
        assert!(!is_geolibre_sidecar_command_line(
            "python -m uvicorn myapp.main:app --port 8765"
        ));
        // A different server merely run from inside the package's directory is
        // not the sidecar.
        assert!(!is_geolibre_sidecar_command_line(
            "python /src/geolibre_server/app/other_server.py --port 8765"
        ));
        assert!(!is_geolibre_sidecar_command_line(""));
    }

    // src/lib/sidecar.ts classifies the start failure by this phrase; if it
    // drifts, a stale sidecar is ignored again and users get a bare 401.
    #[cfg(not(feature = "mas"))]
    #[test]
    fn stale_sidecar_error_keeps_the_phrase_the_frontend_matches() {
        assert!(super::STALE_SIDECAR_ERROR.contains("does not accept this session's token"));
    }

    #[cfg(all(target_os = "linux", not(feature = "mas")))]
    #[test]
    fn collect_listening_tcp_inodes_ignores_missing_optional_table() {
        let mut inodes = std::collections::HashSet::new();
        let result = super::collect_listening_tcp_inodes(
            "/proc/net/geolibre_nonexistent_tcp6",
            8080,
            &mut inodes,
            true,
        );
        assert!(result.is_ok());
        assert!(inodes.is_empty());

        let required = super::collect_listening_tcp_inodes(
            "/proc/net/geolibre_nonexistent_tcp",
            8080,
            &mut inodes,
            false,
        );
        assert!(required.is_err());
    }

    #[cfg(all(unix, not(feature = "mas")))]
    #[test]
    fn terminate_sidecar_child_handles_already_exited_process() {
        let mut child = std::process::Command::new("true")
            .spawn()
            .expect("spawn true");
        let status = child.wait().expect("wait for true");
        assert!(status.success());
        super::terminate_sidecar_child(&mut child);
        assert!(matches!(child.try_wait(), Ok(Some(s)) if s.success()));
    }
}
