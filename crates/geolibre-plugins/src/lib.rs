pub mod basemaps;
pub mod error;

pub use basemaps::AddOpenStreetMapBasemapPlugin;
pub use error::{PluginError, Result};

use geolibre_core::GeoLibreProject;

pub trait GeoLibrePlugin {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn activate(&self, project: &mut GeoLibreProject) -> Result<()>;
}
