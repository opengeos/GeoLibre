pub mod algorithms;
pub mod error;

pub use algorithms::{
    BoundingBoxAlgorithm, BufferPlaceholderAlgorithm, ReprojectPlaceholderAlgorithm,
};
pub use error::{ProcessingError, Result};

use geolibre_core::{GeoLibreProject, Layer};

pub trait ProcessingAlgorithm {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn run(&self, project: &GeoLibreProject, layer_id: &str) -> Result<ProcessingOutput>;
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProcessingOutput {
    Message(String),
    Layer(Layer),
}
