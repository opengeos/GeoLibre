use thiserror::Error;

#[derive(Debug, Error)]
pub enum IoError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("GeoJSON parse error: {0}")]
    GeoJson(Box<geojson::Error>),
    #[error("unsupported GeoJSON geometry")]
    UnsupportedGeometry,
}

impl From<geojson::Error> for IoError {
    fn from(value: geojson::Error) -> Self {
        Self::GeoJson(Box::new(value))
    }
}

pub type Result<T> = std::result::Result<T, IoError>;
