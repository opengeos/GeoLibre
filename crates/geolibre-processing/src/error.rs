use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProcessingError {
    #[error("layer not found: {0}")]
    LayerNotFound(String),
    #[error("algorithm is a placeholder: {0}")]
    Placeholder(String),
    #[error("algorithm input error: {0}")]
    InvalidInput(String),
}

pub type Result<T> = std::result::Result<T, ProcessingError>;
