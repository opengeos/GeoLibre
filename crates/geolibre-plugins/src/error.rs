use thiserror::Error;

#[derive(Debug, Error)]
pub enum PluginError {
    #[error("plugin failed: {0}")]
    Failed(String),
}

pub type Result<T> = std::result::Result<T, PluginError>;
