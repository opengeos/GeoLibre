use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_linux_webkit();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![close_oauth_popups])
        .setup(|app| {
            create_main_window(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running GeoLibre Desktop");
}

#[tauri::command]
fn close_oauth_popups(app: tauri::AppHandle) {
    for window in app.webview_windows().values() {
        if window.label().starts_with("oauthPopup") {
            let _ = window.close();
        }
    }
}

fn create_main_window(app: &mut tauri::App) -> tauri::Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};

    static POPUP_COUNTER: AtomicU64 = AtomicU64::new(0);

    let window_config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .expect("GeoLibre Desktop requires a main window config");
    let app_handle = app.handle().clone();

    tauri::WebviewWindowBuilder::from_config(app, &window_config)?
        .on_new_window(move |url, features| {
            let popup_id = POPUP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let window = tauri::WebviewWindowBuilder::new(
                &app_handle,
                format!("oauthPopup{popup_id}"),
                tauri::WebviewUrl::External("about:blank".parse().expect("valid blank URL")),
            )
            .window_features(features)
            .title(url.as_str())
            .on_document_title_changed(|window, title| {
                let _ = window.set_title(&title);
            })
            .build()
            .expect("failed to create OAuth popup window");

            tauri::webview::NewWindowResponse::Create { window }
        })
        .build()?;

    Ok(())
}

#[cfg(target_os = "linux")]
fn configure_linux_webkit() {
    // WebKitGTK's DMABUF renderer can fail to allocate GBM buffers on some
    // Linux graphics stacks, leaving the Tauri window blank. Only set the
    // default when unset so an explicit user/distributor value wins.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_linux_webkit() {}
