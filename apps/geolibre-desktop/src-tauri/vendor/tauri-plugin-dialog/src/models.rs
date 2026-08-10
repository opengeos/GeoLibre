// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Types of message, ask and confirm dialogs.
#[non_exhaustive]
#[derive(Debug, Copy, Clone, PartialEq, Eq, Hash, Default)]
pub enum MessageDialogKind {
    /// Information dialog.
    #[default]
    Info,
    /// Warning dialog.
    Warning,
    /// Error dialog.
    Error,
}

impl<'de> Deserialize<'de> for MessageDialogKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Ok(match s.to_lowercase().as_str() {
            "info" => MessageDialogKind::Info,
            "warning" => MessageDialogKind::Warning,
            "error" => MessageDialogKind::Error,
            _ => MessageDialogKind::Info,
        })
    }
}

impl Serialize for MessageDialogKind {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Info => serializer.serialize_str("info"),
            Self::Warning => serializer.serialize_str("warning"),
            Self::Error => serializer.serialize_str("error"),
        }
    }
}

/// Set of button that will be displayed on the dialog
#[non_exhaustive]
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub enum MessageDialogButtons {
    #[default]
    /// A single `Ok` button with OS default dialog text
    Ok,
    /// 2 buttons `Ok` and `Cancel` with OS default dialog texts
    OkCancel,
    /// 2 buttons `Yes` and `No` with OS default dialog texts
    YesNo,
    /// 3 buttons `Yes`, `No` and `Cancel` with OS default dialog texts
    YesNoCancel,
    /// A single `Ok` button with custom text
    OkCustom(String),
    /// 2 buttons `Ok` and `Cancel` with custom texts
    OkCancelCustom(String, String),
    /// 3 buttons `Yes`, `No` and `Cancel` with custom texts
    YesNoCancelCustom(String, String, String),
}

/// Result of a message dialog
#[derive(Debug, Default, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub enum MessageDialogResult {
    Yes,
    No,
    Ok,
    #[default]
    Cancel,
    #[serde(untagged)]
    Custom(String),
}

#[cfg(desktop)]
impl From<rfd::MessageDialogResult> for MessageDialogResult {
    fn from(result: rfd::MessageDialogResult) -> Self {
        match result {
            rfd::MessageDialogResult::Yes => Self::Yes,
            rfd::MessageDialogResult::No => Self::No,
            rfd::MessageDialogResult::Ok => Self::Ok,
            rfd::MessageDialogResult::Cancel => Self::Cancel,
            rfd::MessageDialogResult::Custom(s) => Self::Custom(s),
        }
    }
}

impl From<String> for MessageDialogResult {
    fn from(value: String) -> Self {
        match value.as_str() {
            "Yes" => Self::Yes,
            "No" => Self::No,
            "Ok" => Self::Ok,
            "Cancel" => Self::Cancel,
            _ => Self::Custom(value),
        }
    }
}
