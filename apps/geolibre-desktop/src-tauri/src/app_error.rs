//! Structured error type for desktop backend modules.
//!
//! Serializes as its human-readable `Display` string so existing Tauri IPC
//! callers (which catch string errors from `invoke(...)`) remain 100%
//! backward-compatible while Rust modules get typed error variants instead of
//! bare `Result<T, String>`.

use std::fmt;

#[derive(Debug)]
#[allow(dead_code)]
pub(crate) enum AppError {
    InvalidInput(String),
    NotFound(String),
    Unauthorized(String),
    Cancelled,
    Io {
        context: String,
        source: std::io::Error,
    },
    Http(String),
    Internal(String),
}

impl AppError {
    pub(crate) fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        Self::Io {
            context: context.into(),
            source,
        }
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput(msg)
            | Self::NotFound(msg)
            | Self::Unauthorized(msg)
            | Self::Http(msg)
            | Self::Internal(msg) => f.write_str(msg),
            Self::Cancelled => f.write_str("Operation cancelled."),
            Self::Io { context, source } => {
                if context.is_empty() {
                    write!(f, "{source}")
                } else {
                    write!(f, "{context}: {source}")
                }
            }
        }
    }
}

impl std::error::Error for AppError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<AppError> for String {
    fn from(error: AppError) -> Self {
        error.to_string()
    }
}

impl From<String> for AppError {
    fn from(message: String) -> Self {
        Self::Internal(message)
    }
}

impl From<&str> for AppError {
    fn from(message: &str) -> Self {
        Self::Internal(message.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(source: std::io::Error) -> Self {
        Self::Io {
            context: String::new(),
            source,
        }
    }
}

impl From<reqwest::Error> for AppError {
    fn from(error: reqwest::Error) -> Self {
        Self::Http(error.without_url().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_display_string() {
        let err = AppError::io(
            "Could not write file",
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied"),
        );
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(json, "\"Could not write file: denied\"");
        assert_eq!(String::from(err), "Could not write file: denied");
    }

    #[test]
    fn cancelled_and_variant_display() {
        assert_eq!(AppError::Cancelled.to_string(), "Operation cancelled.");
        assert_eq!(
            AppError::InvalidInput("bad url".into()).to_string(),
            "bad url"
        );
    }
}
