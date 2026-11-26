mod app_error;
mod arcgis_http;
mod aws_credentials;
mod aws_sts;
#[cfg(not(feature = "mas"))]
mod child_process;
mod deep_links;
mod deployment;
mod desktop_updater;
mod fs_util;
mod guarded_http;
mod http_client;
mod image_scope;
mod in_flight;
mod jupyter;
mod linux_webkit;
mod local_files;
mod local_media_protocol;
mod martin;
mod mbtiles;
mod native_document_copies;
mod offline_extraction_jobs;
mod offline_mbtiles;
mod offline_package_commands;
mod offline_packages;
mod ogc_process_http;
mod plugin_http;
mod plugins_io;
mod port_reclaim;
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
mod sidecar;

#[cfg(not(any(feature = "mas", target_os = "ios")))]
use earth_engine_oauth::EarthEngineOAuthState;
use earth_engine_oauth::{poll_earth_engine_oauth, start_earth_engine_oauth};
use std::collections::VecDeque;
use std::env;
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use std::path::Path;
#[cfg(desktop)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Manager;

// OAuth popups are a desktop-only, multi-window concept; Android/iOS have no
// equivalent, and `WebviewWindowBuilder::{on_new_window, window_features}` do
// not exist on the mobile runtime.
#[cfg(desktop)]
static POPUP_COUNTER: AtomicU64 = AtomicU64::new(0);

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
        .manage(martin::MartinServerState {
            process: Mutex::new(None),
            lifecycle: Mutex::new(()),
            generation: std::sync::atomic::AtomicU64::new(0),
        })
        .manage(sidecar::SidecarServerState {
            process: Mutex::new(None),
            lifecycle: Mutex::new(()),
            generation: std::sync::atomic::AtomicU64::new(0),
        })
        .manage(jupyter::JupyterServerState {
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
            martin::ensure_martin_binary,
            guarded_http::fetch_url_bytes,
            guarded_http::fetch_url_response,
            ogc_process_http::ogc_process_http_request,
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
            martin::start_martin_server,
            martin::stop_martin_server,
            sidecar::start_geolibre_sidecar,
            sidecar::stop_geolibre_sidecar,
            jupyter::start_jupyter_server,
            jupyter::stop_jupyter_server,
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
            let martin = app.state::<martin::MartinServerState>();
            martin
                .generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            take_and_drop(&martin.process);

            let sidecar = app.state::<sidecar::SidecarServerState>();
            sidecar
                .generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            take_and_drop(&sidecar.process);

            let jupyter = app.state::<jupyter::JupyterServerState>();
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
