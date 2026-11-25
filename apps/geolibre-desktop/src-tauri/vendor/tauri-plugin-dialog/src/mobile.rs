// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use serde::{Deserialize, de::DeserializeOwned};
use tauri::{
    AppHandle, Runtime,
    plugin::{PluginApi, PluginHandle},
};

use crate::{FileDialogBuilder, FilePath, MessageDialogBuilder, MessageDialogResult};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.tauri.dialog";

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_dialog);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Dialog<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "DialogPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_dialog)?;
    Ok(Dialog(handle))
}

/// Access to the dialog APIs.
#[derive(Debug)]
pub struct Dialog<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Clone for Dialog<R> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<R: Runtime> Dialog<R> {
    pub(crate) fn app_handle(&self) -> &AppHandle<R> {
        self.0.app()
    }
}

#[derive(Debug, Deserialize)]
struct FilePickerResponse {
    files: Vec<FilePath>,
}

#[derive(Debug, Deserialize)]
struct SaveFileResponse {
    file: FilePath,
}

// The callback-only Rust picker interface cannot carry an error. The JS open
// command uses this result-bearing path for explicit data copies instead.
pub(crate) async fn pick_data_files<R: Runtime>(
    dialog: FileDialogBuilder<R>,
    multiple: bool,
) -> crate::Result<Option<Vec<FilePath>>> {
    // Both the synchronous mobile bridge and streaming/fsync must stay off the
    // async runtime worker, including time waiting for the user or import lock.
    tauri::async_runtime::spawn_blocking(move || pick_data_files_blocking(dialog, multiple)).await?
}

fn pick_data_files_blocking<R: Runtime>(
    dialog: FileDialogBuilder<R>,
    multiple: bool,
) -> crate::Result<Option<Vec<FilePath>>> {
    #[cfg(target_os = "ios")]
    let app = dialog.dialog.app_handle().clone();
    let selected = dialog
        .dialog
        .0
        .run_mobile_plugin::<crate::models::DataFilePickerResponse>(
            "showFilePicker",
            dialog.payload(multiple),
        )?
        .into_result()?;
    #[cfg(target_os = "ios")]
    {
        let Some(files) = selected else {
            return Ok(None);
        };
        use tauri::Manager;
        let sources = files
            .into_iter()
            .map(|file| {
                file.into_path()
                    .map_err(|error| std::io::Error::other(error.to_string()))
            })
            .collect::<std::io::Result<Vec<_>>>()?;
        let root = app.path().app_local_data_dir()?.join("picked-documents");
        let local_data = app.path().local_data_dir()?;
        let anchor = local_data
            .parent()
            .ok_or_else(|| std::io::Error::other("Missing local storage ancestor"))?;
        return crate::ios_data_copy::persist_selection(&root, anchor, &sources)
            .map(|paths| Some(paths.into_iter().map(FilePath::Path).collect()))
            .map_err(Into::into);
    }
    #[cfg(not(target_os = "ios"))]
    Ok(selected)
}

pub fn pick_file<R: Runtime, F: FnOnce(Option<FilePath>) + Send + 'static>(
    dialog: FileDialogBuilder<R>,
    f: F,
) {
    std::thread::spawn(move || {
        let res = dialog
            .dialog
            .0
            .run_mobile_plugin::<FilePickerResponse>("showFilePicker", dialog.payload(false));
        if let Ok(response) = res {
            f(Some(response.files.into_iter().next().unwrap()))
        } else {
            f(None)
        }
    });
}

pub fn pick_files<R: Runtime, F: FnOnce(Option<Vec<FilePath>>) + Send + 'static>(
    dialog: FileDialogBuilder<R>,
    f: F,
) {
    std::thread::spawn(move || {
        let res = dialog
            .dialog
            .0
            .run_mobile_plugin::<FilePickerResponse>("showFilePicker", dialog.payload(true));
        if let Ok(response) = res {
            f(Some(response.files))
        } else {
            f(None)
        }
    });
}

pub fn save_file<R: Runtime, F: FnOnce(Option<FilePath>) + Send + 'static>(
    dialog: FileDialogBuilder<R>,
    f: F,
) {
    std::thread::spawn(move || {
        let res = dialog
            .dialog
            .0
            .run_mobile_plugin::<SaveFileResponse>("saveFileDialog", dialog.payload(false));
        if let Ok(response) = res {
            f(Some(response.file))
        } else {
            f(None)
        }
    });
}

#[derive(Debug, Deserialize)]
struct ShowMessageDialogResponse {
    value: String,
}

/// Shows a message dialog
pub fn show_message_dialog<R: Runtime, F: FnOnce(MessageDialogResult) + Send + 'static>(
    dialog: MessageDialogBuilder<R>,
    f: F,
) {
    std::thread::spawn(move || {
        let res = dialog
            .dialog
            .0
            .run_mobile_plugin::<ShowMessageDialogResponse>("showMessageDialog", dialog.payload());

        let res = res.map(|res| res.value.into());
        f(res.unwrap_or_default())
    });
}
