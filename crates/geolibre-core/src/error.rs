use thiserror::Error;

pub type Result<T> = std::result::Result<T, CoreError>;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("layer not found: {0}")]
    LayerNotFound(String),
    #[error("invalid layer state: {0}")]
    InvalidLayer(String),
}
