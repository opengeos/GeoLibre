// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Native system dialogs for opening and saving files along with message dialogs.

#![doc(
    html_logo_url = "https://github.com/tauri-apps/tauri/raw/dev/app-icon.png",
    html_favicon_url = "https://github.com/tauri-apps/tauri/raw/dev/app-icon.png"
)]

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

use std::{
    path::{Path, PathBuf},
    sync::mpsc::sync_channel,
};

pub use models::*;

pub use tauri_plugin_fs::FilePath;
#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::*;
#[cfg(mobile)]
use mobile::*;

#[cfg(desktop)]
pub use desktop::Dialog;
#[cfg(mobile)]
pub use mobile::Dialog;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum PickerMode {
    Document,
    Media,
    Image,
    Video,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum FileAccessMode {
    Copy,
    Scoped,
}

pub(crate) const OK: &str = "Ok";
#[cfg(mobile)]
pub(crate) const CANCEL: &str = "Cancel";
#[cfg(mobile)]
pub(crate) const YES: &str = "Yes";
#[cfg(mobile)]
pub(crate) const NO: &str = "No";

macro_rules! blocking_fn {
    ($self:ident, $fn:ident) => {{
        let (tx, rx) = sync_channel(0);
        let cb = move |response| {
            tx.send(response).unwrap();
        };
        $self.$fn(cb);
        rx.recv().unwrap()
    }};
}

/// Extensions to [`tauri::App`], [`tauri::AppHandle`], [`tauri::WebviewWindow`], [`tauri::Webview`] and [`tauri::Window`] to access the dialog APIs.
pub trait DialogExt<R: Runtime> {
    fn dialog(&self) -> &Dialog<R>;
}

impl<R: Runtime, T: Manager<R>> crate::DialogExt<R> for T {
    fn dialog(&self) -> &Dialog<R> {
        self.state::<Dialog<R>>().inner()
    }
}

impl<R: Runtime> Dialog<R> {
    /// Create a new messaging dialog builder.
    /// The dialog can optionally ask the user for confirmation or include an OK button.
    ///
    /// # Examples
    ///
    /// - Message dialog:
    ///
    /// ```
    /// use tauri_plugin_dialog::DialogExt;
    ///
    /// tauri::Builder::default()
    ///   .setup(|app| {
    ///     app
    ///       .dialog()
    ///       .message("Tauri is Awesome!")
    ///       .show(|_| {
    ///         println!("dialog closed");
    ///       });
    ///     Ok(())
    ///   });
    /// ```
    ///
    /// - Ask dialog:
    ///
    /// ```
    /// use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    ///
    /// tauri::Builder::default()
    ///   .setup(|app| {
    ///     app.dialog()
    ///       .message("Are you sure?")
    ///       .buttons(MessageDialogButtons::OkCancelCustom("Yes", "No"))
    ///       .show(|yes| {
    ///         println!("user said {}", if yes { "yes" } else { "no" });
    ///       });
    ///     Ok(())
    ///   });
    /// ```
    ///
    /// - Message dialog with OK button:
    ///
    /// ```
    /// use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    ///
    /// tauri::Builder::default()
    ///   .setup(|app| {
    ///     app.dialog()
    ///       .message("Job completed successfully")
    ///       .buttons(MessageDialogButtons::Ok)
    ///       .show(|_| {
    ///         println!("dialog closed");
    ///       });
    ///     Ok(())
    ///   });
    /// ```
    ///
    /// # `show` vs `blocking_show`
    ///
    /// The dialog builder includes two separate APIs for rendering the dialog: `show` and `blocking_show`.
    /// The `show` function is asynchronous and takes a closure to be executed when the dialog is closed.
    /// To block the current thread until the user acted on the dialog, you can use `blocking_show`,
    /// but note that it cannot be executed on the main thread as it will freeze your application.
    ///
    /// ```
    /// use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    ///
    /// tauri::Builder::default()
    ///   .setup(|app| {
    ///     let handle = app.handle().clone();
    ///     std::thread::spawn(move || {
    ///       let yes = handle.dialog()
    ///         .message("Are you sure?")
    ///         .buttons(MessageDialogButtons::OkCancelCustom("Yes", "No"))
    ///         .blocking_show();
    ///     });
    ///
    ///     Ok(())
    ///   });
    /// ```
    pub fn message(&self, message: impl Into<String>) -> MessageDialogBuilder<R> {
        MessageDialogBuilder::new(
            self.clone(),
            self.app_handle().package_info().name.clone(),
            message,
        )
    }

    /// Creates a new builder for dialogs that lets the user select file(s) or folder(s).
    pub fn file(&self) -> FileDialogBuilder<R> {
        FileDialogBuilder::new(self.clone())
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    #[allow(unused_mut)]
    let mut builder = Builder::new("dialog");

    // Dialogs are implemented natively on Android
    #[cfg(not(target_os = "android"))]
    {
        builder = builder.js_init_script(include_str!("init-iife.js").to_string());
    }

    builder
        .invoke_handler(tauri::generate_handler![
            commands::open,
            commands::save,
            commands::message,
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let dialog = mobile::init(app, api)?;
            #[cfg(desktop)]
            let dialog = desktop::init(app, api)?;
            app.manage(dialog);
            Ok(())
        })
        .build()
}

/// A builder for message dialogs.
pub struct MessageDialogBuilder<R: Runtime> {
    #[allow(dead_code)]
    pub(crate) dialog: Dialog<R>,
    pub(crate) title: String,
    pub(crate) message: String,
    pub(crate) kind: MessageDialogKind,
    pub(crate) buttons: MessageDialogButtons,
    #[cfg(desktop)]
    pub(crate) parent: Option<crate::desktop::WindowHandle>,
}

/// Payload for the message dialog mobile API.
#[cfg(mobile)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageDialogPayload<'a> {
    title: &'a String,
    message: &'a String,
    kind: &'a MessageDialogKind,
    ok_button_label: Option<&'a str>,
    no_button_label: Option<&'a str>,
    cancel_button_label: Option<&'a str>,
}

// raw window handle :(
unsafe impl<R: Runtime> Send for MessageDialogBuilder<R> {}

impl<R: Runtime> MessageDialogBuilder<R> {
    /// Creates a new message dialog builder.
    pub fn new(dialog: Dialog<R>, title: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            dialog,
            title: title.into(),
            message: message.into(),
            kind: MessageDialogKind::default(),
            buttons: MessageDialogButtons::default(),
            #[cfg(desktop)]
            parent: None,
        }
    }

    #[cfg(mobile)]
    pub(crate) fn payload(&self) -> MessageDialogPayload<'_> {
        let (ok_button_label, no_button_label, cancel_button_label) = match &self.buttons {
            MessageDialogButtons::Ok => (Some(OK), None, None),
            MessageDialogButtons::OkCancel => (Some(OK), None, Some(CANCEL)),
            MessageDialogButtons::YesNo => (Some(YES), Some(NO), None),
            MessageDialogButtons::YesNoCancel => (Some(YES), Some(NO), Some(CANCEL)),
            MessageDialogButtons::OkCustom(ok) => (Some(ok.as_str()), None, None),
            MessageDialogButtons::OkCancelCustom(ok, cancel) => {
                (Some(ok.as_str()), None, Some(cancel.as_str()))
            }
            MessageDialogButtons::YesNoCancelCustom(yes, no, cancel) => {
                (Some(yes.as_str()), Some(no.as_str()), Some(cancel.as_str()))
            }
        };
        MessageDialogPayload {
            title: &self.title,
            message: &self.message,
            kind: &self.kind,
            ok_button_label,
            no_button_label,
            cancel_button_label,
        }
    }

    /// Sets the dialog title.
    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.title = title.into();
        self
    }

    /// Set parent windows explicitly (optional)
    #[cfg(desktop)]
    pub fn parent<W: raw_window_handle::HasWindowHandle + raw_window_handle::HasDisplayHandle>(
        mut self,
        parent: &W,
    ) -> Self {
        if let (Ok(window_handle), Ok(display_handle)) =
            (parent.window_handle(), parent.display_handle())
        {
            self.parent.replace(crate::desktop::WindowHandle::new(
                window_handle.as_raw(),
                display_handle.as_raw(),
            ));
        }
        self
    }

    /// Sets the dialog buttons.
    pub fn buttons(mut self, buttons: MessageDialogButtons) -> Self {
        self.buttons = buttons;
        self
    }

    /// Set type of a dialog.
    ///
    /// Depending on the system it can result in type specific icon to show up,
    /// the will inform user it message is a error, warning or just information.
    pub fn kind(mut self, kind: MessageDialogKind) -> Self {
        self.kind = kind;
        self
    }

    /// Shows a message dialog
    ///
    /// Returns `true` if the user pressed the OK/Yes button,
    pub fn show<F: FnOnce(bool) + Send + 'static>(self, f: F) {
        let ok_label = match &self.buttons {
            MessageDialogButtons::OkCustom(ok) => Some(ok.clone()),
            MessageDialogButtons::OkCancelCustom(ok, _) => Some(ok.clone()),
            MessageDialogButtons::YesNoCancelCustom(yes, _, _) => Some(yes.clone()),
            _ => None,
        };

        show_message_dialog(self, move |res| {
            let sucess = match res {
                MessageDialogResult::Ok | MessageDialogResult::Yes => true,
                MessageDialogResult::Custom(s) => {
                    ok_label.map_or(s == OK, |ok_label| ok_label == s)
                }
                _ => false,
            };

            f(sucess)
        })
    }

    /// Shows a message dialog and returns the button that was pressed.
    ///
    /// Returns a [`MessageDialogResult`] enum that indicates which button was pressed.
    pub fn show_with_result<F: FnOnce(MessageDialogResult) + Send + 'static>(self, f: F) {
        show_message_dialog(self, f)
    }

    /// Shows a message dialog.
    ///
    /// Returns `true` if the user pressed the OK/Yes button,
    ///
    /// This is a blocking operation,
    /// and should *NOT* be used when running on the main thread context.
    pub fn blocking_show(self) -> bool {
        blocking_fn!(self, show)
    }

    /// Shows a message dialog and returns the button that was pressed.
    ///
    /// Returns a [`MessageDialogResult`] enum that indicates which button was pressed.
    ///
    /// This is a blocking operation,
    /// and should *NOT* be used when running on the main thread context.
    pub fn blocking_show_with_result(self) -> MessageDialogResult {
        blocking_fn!(self, show_with_result)
    }
}
#[derive(Debug, Serialize)]
pub(crate) struct Filter {
    pub name: String,
    pub extensions: Vec<String>,
}

/// The file dialog builder.
///
/// Constructs file picker dialogs that can select single/multiple files or directories.
#[derive(Debug)]
pub struct FileDialogBuilder<R: Runtime> {
    #[allow(dead_code)]
    pub(crate) dialog: Dialog<R>,
    pub(crate) filters: Vec<Filter>,
    pub(crate) starting_directory: Option<PathBuf>,
    pub(crate) file_name: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) can_create_directories: Option<bool>,
    pub(crate) picker_mode: Option<PickerMode>,
    pub(crate) file_access_mode: Option<FileAccessMode>,
    #[cfg(desktop)]
    pub(crate) parent: Option<crate::desktop::WindowHandle>,
}

#[cfg(mobile)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileDialogPayload<'a> {
    file_name: &'a Option<String>,
    filters: &'a Vec<Filter>,
    multiple: bool,
    picker_mode: &'a Option<PickerMode>,
    file_access_mode: &'a Option<FileAccessMode>,
}

// raw window handle :(
unsafe impl<R: Runtime> Send for FileDialogBuilder<R> {}

impl<R: Runtime> FileDialogBuilder<R> {
    /// Gets the default file dialog builder.
    pub fn new(dialog: Dialog<R>) -> Self {
        Self {
            dialog,
            filters: Vec::new(),
            starting_directory: None,
            file_name: None,
            title: None,
            can_create_directories: None,
            picker_mode: None,
            file_access_mode: None,
            #[cfg(desktop)]
            parent: None,
        }
    }

    #[cfg(mobile)]
    pub(crate) fn payload(&self, multiple: bool) -> FileDialogPayload<'_> {
        FileDialogPayload {
            file_name: &self.file_name,
            filters: &self.filters,
            multiple,
            picker_mode: &self.picker_mode,
            file_access_mode: &self.file_access_mode,
        }
    }

    /// Add file extension filter. Takes in the name of the filter, and list of extensions
    #[must_use]
    pub fn add_filter(mut self, name: impl Into<String>, extensions: &[&str]) -> Self {
        self.filters.push(Filter {
            name: name.into(),
            extensions: extensions.iter().map(|e| e.to_string()).collect(),
        });
        self
    }

    /// Set starting directory of the dialog.
    #[must_use]
    pub fn set_directory<P: AsRef<Path>>(mut self, directory: P) -> Self {
        self.starting_directory.replace(directory.as_ref().into());
        self
    }

    /// Set starting file name of the dialog.
    #[must_use]
    pub fn set_file_name(mut self, file_name: impl Into<String>) -> Self {
        self.file_name.replace(file_name.into());
        self
    }

    /// Sets the parent window of the dialog.
    #[cfg(desktop)]
    #[must_use]
    pub fn set_parent<
        W: raw_window_handle::HasWindowHandle + raw_window_handle::HasDisplayHandle,
    >(
        mut self,
        parent: &W,
    ) -> Self {
        if let (Ok(window_handle), Ok(display_handle)) =
            (parent.window_handle(), parent.display_handle())
        {
            self.parent.replace(crate::desktop::WindowHandle::new(
                window_handle.as_raw(),
                display_handle.as_raw(),
            ));
        }
        self
    }

    /// Set the title of the dialog.
    #[must_use]
    pub fn set_title(mut self, title: impl Into<String>) -> Self {
        self.title.replace(title.into());
        self
    }

    /// Set whether it should be possible to create new directories in the dialog. Enabled by default. **macOS only**.
    pub fn set_can_create_directories(mut self, can: bool) -> Self {
        self.can_create_directories.replace(can);
        self
    }

    /// Set the picker mode of the dialog.
    /// This is meant for mobile platforms (iOS and Android) which have distinct file and media pickers.
    /// On desktop, this option is ignored.
    /// If not provided, the dialog will automatically choose the best mode based on the MIME types of the filters.
    pub fn set_picker_mode(mut self, mode: PickerMode) -> Self {
        self.picker_mode.replace(mode);
        self
    }

    /// Set the file access mode of the dialog.
    /// This is used on iOS and, in GeoLibre's vendored build, Android.
    /// On desktop, this option is ignored.
    pub fn set_file_access_mode(mut self, mode: FileAccessMode) -> Self {
        self.file_access_mode.replace(mode);
        self
    }

    /// Shows the dialog to select a single file.
    ///
    /// This is not a blocking operation,
    /// and should be used when running on the main thread to avoid deadlocks with the event loop.
    ///
    /// See [`Self::blocking_pick_file`] for a blocking version for use in other contexts.
    ///
    /// # Examples
    ///
    /// ```
    /// use tauri_plugin_dialog::DialogExt;
    /// tauri::Builder::default()
    ///   .setup(|app| {
    ///     app.dialog().file().pick_file(|file_path| {
    ///       // do something with the optional file path here
    ///       // the file path is `None` if the user closed the dialog
    ///     });
    ///     Ok(())
    ///   });
    /// ```
    pub fn pick_file<F: FnOnce(Option<FilePath>) + Send + 'static>(self, f: F) {
        pick_file(self, f)
    }

    /// Shows the dialog to select multiple files.
    ///
    /// This is not a blocking operation,
    /// and should be used when running on the main thread to avoid deadlocks with the event loop.
    ///
    /// See [`Self::blocking_pick_files`] for a blocking version for use in other contexts.
    ///
    /// # Reading the files
    ///
    /// The file paths cannot be read directly on Android as they are behind a content URI.
    /// The recommended way to read the files is using the [`fs`](https://v2.tauri.app/plugin/file-system/) plugin:
    ///
    /// ```
    /// use tauri_plugin_dialog::DialogExt;
    /// use tauri_plugin_fs::FsExt;
    /// tauri::Builder::default()
    ///   .setup(|app| {
    ///     let handle = app.handle().clone();
    ///     app.dialog().file().pick_file(move |file_path| {
    ///       let Some(path) = file_path else { return };
    ///       let Ok(contents) = handle.fs().read_to_string(path) else {
    ///         eprintln!("failed to read file, <todo add error handling!>");
    ///         return;
    ///       };
    ///     });
    ///     Ok(())
    ///   });
    /// ```
    ///
    /// See <https://developer.android.com/guide/topics/providers/content-provider-basics> for more information.
    ///
    /// # Examples
    ///
    /// ```
    /// use tauri_plugin_dialog::DialogExt;
    /// tauri::Builder::default()
    ///   .setup(|app| {
    ///     app.dialog().file().pick_files(|file_paths| {
    ///       // do something with the optional file paths here
    ///       // the file paths value is `None` if the user closed the dialog
    ///     });
    ///     Ok(())
    ///   });
    /// ```
    pub fn pick_files<F: FnOnce(Option<Vec<FilePath>>) + Send + 'static>(self, f: F) {
        pick_files(self, f)
    }

    /// Shows the dialog to select a single folder.
    ///
    /// This is not a blocking operation,
    /// and should be used when running on the main thread to avoid deadlocks with the event loop.
    ///
    /// See [`Self::blocking_pick_folder`] for a blocking version for use in other contexts.
    ///
    /// # Examples
    ///
    /// ```
    /// use tauri_plugin_dialog::DialogExt;
    /// tauri::Builder::default()
    ///   .setup(|app| {
    ///     app.dialog().file().pick_folder(|folder_path| {
    ///       // do something with the optional folder path here
    ///       // the folder path is `None` if the user closed the dialog
    ///     });
    ///     Ok(())
    ///   });
    /// ```
    #[cfg(desktop)]
    pub fn pick_folder<F: FnOnce(Option<FilePath>) + Send + 'static>(self, f: F) {
        pick_folder(self, f)
    }

    /// Shows the dialog to select multiple folders.
    ///
    /// This is not a blocking operation,
    /// and should be used when running on the main thread to avoid deadlocks with the event loop.
    ///
    /// See [`Self::blocking_pick_folders`] for a blocking version for use in other contexts.
    ///
    /// # Examples
    ///
    /// ```
    /// use tauri_plugin_dialog::DialogExt;
    /// tauri::Builder::default()
    ///   .setup(|app| {
    ///     app.dialog().file().pick_folders(|file_paths| {
    ///       // do something with the optional folder paths here
    ///       // the folder paths value is `None` if the user closed the dialog
    ///     });
    ///     Ok(())
    ///   });
    /// ```
    #[cfg(desktop)]
    pub fn pick_folders<F: FnOnce(Option<Vec<FilePath>>) + Send + 'static>(self, f: F) {
        pick_folders(self, f)
    }

    /// Shows the dialog to save a file.
    ///
    /// This is not a blocking operation,
    /// and should be used when running on the main thread to avoid deadlocks with the event loop.
    ///
    /// See [`Self::blocking_save_file`] for a blocking version for use in other contexts.
    ///
    /// # Examples
    ///
    /// ```
    /// use tauri_plugin_dialog::DialogExt;
    /// tauri::Builder::default()
    ///   .setup(|app| {
    ///     app.dialog().file().save_file(|file_path| {
    ///       // do something with the optional file path here
    ///       // the file path is `None` if the user closed the dialog
    ///     });
    ///     Ok(())
    ///   });
    /// ```
    pub fn save_file<F: FnOnce(Option<FilePath>) + Send + 'static>(self, f: F) {
        save_file(self, f)
    }
}

/// Blocking APIs.
impl<R: Runtime> FileDialogBuilder<R> {
    /// Shows the dialog to select a single file.
    ///
    /// This is a blocking operation,
    /// and should *NOT* be used when running on the main thread.
    ///
    /// See [`Self::pick_file`] for a non-blocking version for use in main-thread contexts.
    ///
    /// # Examples
    ///
    /// ```
    /// use tauri_plugin_dialog::DialogExt;
    /// #[tauri::command]
    /// async fn my_command(app: tauri::AppHandle) {
    ///   let file_path = app.dialog().file().blocking_pick_file();
    ///   // do something with the optional file path here
    ///   // the file path is `None` if the user closed the dialog
    /// }
    /// ```
    pub fn blocking_pick_file(self) -> Option<FilePath> {
        blocking_fn!(self, pick_file)
    }

    /// Shows the dialog to select multiple files.
    ///
    /// This is a blocking operation,
    /// and should *NOT* be used when running on the main thread.
    ///
    /// See [`Self::pick_files`] for a non-blocking version for use in main-thread contexts.
    ///
    /// # Examples
    ///
    /// ```
    /// use tauri_plugin_dialog::DialogExt;
    /// #[tauri::command]
    /// async fn my_command(app: tauri::AppHandle) {
    ///   let file_path = app.dialog().file().blocking_pick_files();
    ///   // do something with the optional file paths here
    ///   // the file paths value is `None` if the user closed the dialog
    /// }
    /// ```
    pub fn blocking_pick_files(self) -> Option<Vec<FilePath>> {
        blocking_fn!(self, pick_files)
    }

    /// Shows the dialog to select a single folder.
    ///
    /// This is a blocking operation,
    /// and should *NOT* be used when running on the main thread.
    ///
    /// See [`Self::pick_folder`] for a non-blocking version for use in main-thread contexts.
    ///
    /// # Examples
    ///
    /// ```
    /// use tauri_plugin_dialog::DialogExt;
    /// #[tauri::command]
    /// async fn my_command(app: tauri::AppHandle) {
    ///   let folder_path = app.dialog().file().blocking_pick_folder();
    ///   // do something with the optional folder path here
    ///   // the folder path is `None` if the user closed the dialog
    /// }
    /// ```
    #[cfg(desktop)]
    pub fn blocking_pick_folder(self) -> Option<FilePath> {
        blocking_fn!(self, pick_folder)
    }

    /// Shows the dialog to select multiple folders.
    ///
    /// This is a blocking operation,
    /// and should *NOT* be used when running on the main thread.
    ///
    /// See [`Self::pick_folders`] for a non-blocking version for use in main-thread contexts.
    ///
    /// # Examples
    ///
    /// ```
    /// use tauri_plugin_dialog::DialogExt;
    /// #[tauri::command]
    /// async fn my_command(app: tauri::AppHandle) {
    ///   let folder_paths = app.dialog().file().blocking_pick_folders();
    ///   // do something with the optional folder paths here
    ///   // the folder paths value is `None` if the user closed the dialog
    /// }
    /// ```
    #[cfg(desktop)]
    pub fn blocking_pick_folders(self) -> Option<Vec<FilePath>> {
        blocking_fn!(self, pick_folders)
    }

    /// Shows the dialog to save a file.
    ///
    /// This is a blocking operation,
    /// and should *NOT* be used when running on the main thread.
    ///
    /// See [`Self::save_file`] for a non-blocking version for use in main-thread contexts.
    ///
    /// # Examples
    ///
    /// ```
    /// use tauri_plugin_dialog::DialogExt;
    /// #[tauri::command]
    /// async fn my_command(app: tauri::AppHandle) {
    ///   let file_path = app.dialog().file().blocking_save_file();
    ///   // do something with the optional file path here
    ///   // the file path is `None` if the user closed the dialog
    /// }
    /// ```
    pub fn blocking_save_file(self) -> Option<FilePath> {
        blocking_fn!(self, save_file)
    }
}
