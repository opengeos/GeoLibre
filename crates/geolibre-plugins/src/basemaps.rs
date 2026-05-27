use geolibre_core::{GeoLibreProject, TileType};
use geolibre_io::xyz_tile_layer;

use crate::{GeoLibrePlugin, Result};

pub struct AddOpenStreetMapBasemapPlugin;

impl GeoLibrePlugin for AddOpenStreetMapBasemapPlugin {
    fn id(&self) -> &'static str {
        "org.geolibre.plugins.openstreetmap-basemap"
    }

    fn name(&self) -> &'static str {
        "Add OpenStreetMap Basemap"
    }

    fn description(&self) -> &'static str {
        "Adds an OpenStreetMap XYZ raster tile layer placeholder."
    }

    fn activate(&self, project: &mut GeoLibreProject) -> Result<()> {
        let layer = xyz_tile_layer(
            "osm-basemap",
            "OpenStreetMap",
            "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
            TileType::Raster,
        );
        project.add_layer(layer);
        Ok(())
    }
}
