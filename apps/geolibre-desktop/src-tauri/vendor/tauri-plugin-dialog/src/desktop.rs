// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Use native message and file open/save dialogs.
//!
//! This module exposes non-blocking APIs on its root, relying on callback closures
//! to give results back. This is particularly useful when running dialogs from the main thread.
//! When using on asynchronous contexts such as async commands, the [`blocking`] APIs are recommended.

use raw_window_handle::{HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle};
use rfd::{AsyncFileDialog, AsyncMessageDialog};
use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::{models::*, FileDialogBuilder, FilePath, MessageDialogBuilder};

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Dialog<R>> {
    Ok(Dialog(app.clone()))
}

/// Access to the dialog APIs.
#[derive(Debug)]
pub struct Dialog<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Clone for Dialog<R> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<R: Runtime> Dialog<R> {
    pub(crate) fn app_handle(&self) -> &AppHandle<R> {
        &self.0
    }
}

impl From<MessageDialogKind> for rfd::MessageLevel {
    fn from(kind: MessageDialogKind) -> Self {
        match kind {
            MessageDialogKind::Info => Self::Info,
            MessageDialogKind::Warning => Self::Warning,
            MessageDialogKind::Error => Self::Error,
        }
    }
}

#[derive(Debug)]
pub(crate) struct WindowHandle {
    window_handle: RawWindowHandle,
    display_handle: RawDisplayHandle,
}

impl WindowHandle {
    pub(crate) fn new(window_handle: RawWindowHandle, display_handle: RawDisplayHandle) -> Self {
        Self {
            window_handle,
            display_handle,
        }
    }
}

impl HasWindowHandle for WindowHandle {
    fn window_handle(
        &self,
    ) -> Result<raw_window_handle::WindowHandle<'_>, raw_window_handle::HandleError> {
        Ok(unsafe { raw_window_handle::WindowHandle::borrow_raw(self.window_handle) })
    }
}

impl HasDisplayHandle for WindowHandle {
    fn display_handle(
        &self,
    ) -> Result<raw_window_handle::DisplayHandle<'_>, raw_window_handle::HandleError> {
        Ok(unsafe { raw_window_handle::DisplayHandle::borrow_raw(self.display_handle) })
    }
}

impl<R: Runtime> From<FileDialogBuilder<R>> for AsyncFileDialog {
    fn from(d: FileDialogBuilder<R>) -> Self {
        let mut builder = AsyncFileDialog::new();

        if let Some(title) = d.title {
            builder = builder.set_title(title);
        }
        if let Some(starting_directory) = d.starting_directory {
            builder = builder.set_directory(starting_directory);
        }
        if let Some(file_name) = d.file_name {
            builder = builder.set_file_name(file_name);
        }
        for filter in d.filters {
            let v: Vec<&str> = filter.extensions.iter().map(|x| &**x).collect();
            builder = builder.add_filter(&filter.name, &v);
        }
        #[cfg(desktop)]
        if let Some(parent) = d.parent {
            builder = builder.set_parent(&parent);
        }

        builder = builder.set_can_create_directories(d.can_create_directories.unwrap_or(true));

        builder
    }
}

impl From<MessageDialogButtons> for rfd::MessageButtons {
    fn from(value: MessageDialogButtons) -> Self {
        match value {
            MessageDialogButtons::Ok => Self::Ok,
            MessageDialogButtons::OkCancel => Self::OkCancel,
            MessageDialogButtons::YesNo => Self::YesNo,
            MessageDialogButtons::OkCustom(ok) => Self::OkCustom(ok),
            MessageDialogButtons::OkCancelCustom(ok, cancel) => Self::OkCancelCustom(ok, cancel),
            MessageDialogButtons::YesNoCancel => Self::YesNoCancel,
            MessageDialogButtons::YesNoCancelCustom(yes, no, cancel) => {
                Self::YesNoCancelCustom(yes, no, cancel)
            }
        }
    }
}

impl<R: Runtime> From<MessageDialogBuilder<R>> for AsyncMessageDialog {
    fn from(d: MessageDialogBuilder<R>) -> Self {
        let mut dialog = AsyncMessageDialog::new()
            .set_title(&d.title)
            .set_description(&d.message)
            .set_level(d.kind.into())
            .set_buttons(d.buttons.into());

        if let Some(parent) = d.parent {
            dialog = dialog.set_parent(&parent);
        }

        dialog
    }
}

pub fn pick_file<R: Runtime, F: FnOnce(Option<FilePath>) + Send + 'static>(
    dialog: FileDialogBuilder<R>,
    f: F,
) {
    let f = |path: Option<rfd::FileHandle>| f(path.map(|p| p.path().to_path_buf().into()));
    let handle = dialog.dialog.app_handle().to_owned();
    let _ = handle.run_on_main_thread(move || {
        let dialog = AsyncFileDialog::from(dialog).pick_file();
        std::thread::spawn(move || f(tauri::async_runtime::block_on(dialog)));
    });
}

pub fn pick_files<R: Runtime, F: FnOnce(Option<Vec<FilePath>>) + Send + 'static>(
    dialog: FileDialogBuilder<R>,
    f: F,
) {
    let f = |paths: Option<Vec<rfd::FileHandle>>| {
        f(paths.map(|list| {
            list.into_iter()
                .map(|p| p.path().to_path_buf().into())
                .collect()
        }))
    };
    let handle = dialog.dialog.app_handle().to_owned();
    let _ = handle.run_on_main_thread(move || {
        let dialog = AsyncFileDialog::from(dialog).pick_files();
        std::thread::spawn(move || f(tauri::async_runtime::block_on(dialog)));
    });
}

pub fn pick_folder<R: Runtime, F: FnOnce(Option<FilePath>) + Send + 'static>(
    dialog: FileDialogBuilder<R>,
    f: F,
) {
    let f = |path: Option<rfd::FileHandle>| f(path.map(|p| p.path().to_path_buf().into()));
    let handle = dialog.dialog.app_handle().to_owned();
    let _ = handle.run_on_main_thread(move || {
        let dialog = AsyncFileDialog::from(dialog).pick_folder();
        std::thread::spawn(move || f(tauri::async_runtime::block_on(dialog)));
    });
}

pub fn pick_folders<R: Runtime, F: FnOnce(Option<Vec<FilePath>>) + Send + 'static>(
    dialog: FileDialogBuilder<R>,
    f: F,
) {
    let f = |paths: Option<Vec<rfd::FileHandle>>| {
        f(paths.map(|list| {
            list.into_iter()
                .map(|p| p.path().to_path_buf().into())
                .collect()
        }))
    };
    let handle = dialog.dialog.app_handle().to_owned();
    let _ = handle.run_on_main_thread(move || {
        let dialog = AsyncFileDialog::from(dialog).pick_folders();
        std::thread::spawn(move || f(tauri::async_runtime::block_on(dialog)));
    });
}

pub fn save_file<R: Runtime, F: FnOnce(Option<FilePath>) + Send + 'static>(
    dialog: FileDialogBuilder<R>,
    f: F,
) {
    let f = |path: Option<rfd::FileHandle>| f(path.map(|p| p.path().to_path_buf().into()));
    let handle = dialog.dialog.app_handle().to_owned();
    let _ = handle.run_on_main_thread(move || {
        let dialog = AsyncFileDialog::from(dialog).save_file();
        std::thread::spawn(move || f(tauri::async_runtime::block_on(dialog)));
    });
}

/// Shows a message dialog
pub fn show_message_dialog<R: Runtime, F: FnOnce(MessageDialogResult) + Send + 'static>(
    dialog: MessageDialogBuilder<R>,
    callback: F,
) {
    let f = move |res: rfd::MessageDialogResult| callback(res.into());

    let handle = dialog.dialog.app_handle().to_owned();
    let _ = handle.run_on_main_thread(move || {
        let buttons = dialog.buttons.clone();
        let dialog = AsyncMessageDialog::from(dialog).show();
        std::thread::spawn(move || {
            let result = tauri::async_runtime::block_on(dialog);
            // on Linux rfd does not return rfd::MessageDialogResult::Custom, so we must map manually
            let result = match (result, buttons) {
                (rfd::MessageDialogResult::Ok, MessageDialogButtons::OkCustom(s)) => {
                    rfd::MessageDialogResult::Custom(s)
                }
                (
                    rfd::MessageDialogResult::Ok,
                    MessageDialogButtons::OkCancelCustom(ok, _cancel),
                ) => rfd::MessageDialogResult::Custom(ok),
                (
                    rfd::MessageDialogResult::Cancel,
                    MessageDialogButtons::OkCancelCustom(_ok, cancel),
                ) => rfd::MessageDialogResult::Custom(cancel),
                (
                    rfd::MessageDialogResult::Yes,
                    MessageDialogButtons::YesNoCancelCustom(yes, _no, _cancel),
                ) => rfd::MessageDialogResult::Custom(yes),
                (
                    rfd::MessageDialogResult::No,
                    MessageDialogButtons::YesNoCancelCustom(_yes, no, _cancel),
                ) => rfd::MessageDialogResult::Custom(no),
                (
                    rfd::MessageDialogResult::Cancel,
                    MessageDialogButtons::YesNoCancelCustom(_yes, _no, cancel),
                ) => rfd::MessageDialogResult::Custom(cancel),
                (result, _) => result,
            };
            f(result);
        });
    });
}
