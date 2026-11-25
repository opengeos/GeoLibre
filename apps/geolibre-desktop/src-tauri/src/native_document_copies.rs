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
            let (files, mut problems) = match tauri_plugin_dialog::retained_document_files(&root) {
                Ok(inventory) => inventory,
                Err(error) => (Vec::new(), vec![error.to_string()]),
            };
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
            // The app-resolved root remains useful for rebasing even if a damaged
            // import cannot be inventoried. Readers report unavailable files normally.
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
