//! Reauthorize retained iOS imports and resolve their current container root.

#[derive(serde::Serialize)]
pub(crate) struct NativeDocumentCopies {
    root: Option<String>,
    problems: Vec<String>,
}

#[tauri::command]
pub(crate) async fn initialize_native_document_copies(
    app: tauri::AppHandle,
) -> Result<NativeDocumentCopies, String> {
    #[cfg(target_os = "ios")]
    {
        use tauri::Manager;
        use tauri_plugin_fs::FsExt;
        tauri::async_runtime::spawn_blocking(move || {
            let root = app
                .path()
                .app_local_data_dir()
                .map_err(|error| error.to_string())?
                .join("picked-documents");
            let local_data = app
                .path()
                .local_data_dir()
                .map_err(|error| error.to_string())?;
            let anchor = local_data
                .parent()
                .ok_or("Missing local storage ancestor")?;
            let (files, mut problems) = tauri_plugin_dialog::retained_document_files(&root, anchor)
                .map_err(|error| error.to_string())?;
            for path in files {
                for result in [
                    app.fs_scope().allow_file(&path),
                    app.asset_protocol_scope().allow_file(&path),
                ] {
                    if let Err(error) = result {
                        problems.push(format!("{}: {error}", path.display()));
                    }
                }
            }
            // Per-import failures retain the root and healthy grants. Root-level
            // failures propagate above so the frontend holds retained projects.
            let canonical = std::fs::canonicalize(&root).unwrap_or(root);
            Ok(NativeDocumentCopies {
                root: Some(crate::canonical_local_path_string(&canonical)?),
                problems,
            })
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        Ok(NativeDocumentCopies {
            root: None,
            problems: Vec::new(),
        })
    }
}
