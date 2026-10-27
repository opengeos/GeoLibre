// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use serde::{Serialize, ser::Serializer};

/// Alias for `Result<T, Error>` used throughout this crate.
pub type Result<T> = std::result::Result<T, Error>;

/// Errors that can occur while showing or interacting with a dialog.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// An error forwarded from the Tauri core.
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
    /// An I/O error, for example while resolving a picked path.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// Forwarding a request to, or receiving a response from, the mobile plugin failed.
    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    /// The folder picker was requested through the `open` command, but folder picking is not implemented on mobile.
    #[cfg(mobile)]
    #[error("Folder picker is not implemented on mobile")]
    FolderPickerNotImplemented,
    /// An error forwarded from the `fs` plugin, returned when granting filesystem scope to a picked path fails.
    #[error(transparent)]
    Fs(#[from] tauri_plugin_fs::Error),
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
