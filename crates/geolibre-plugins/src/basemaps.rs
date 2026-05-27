use geolibre_core::{GeoLibreProject, TileType};
use geolibre_io::xyz_tile_layer;

use crate::{GeoLibrePlugin, Result};

fn unique_layer_id(base: &str, project: &GeoLibreProject) -> String {
    if project.layer(base).is_none() {
        return base.to_string();
    }
    let mut counter = 2u32;
    loop {
        let candidate = format!("{base}-{counter}");
        if project.layer(&candidate).is_none() {
            return candidate;
        }
        counter += 1;
    }
}

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
        let base_id = "osm-basemap";
        let id = unique_layer_id(base_id, project);
        let layer = xyz_tile_layer(
            &id,
            "OpenStreetMap",
            "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
            TileType::Raster,
        );
        project.add_layer(layer);
        Ok(())
    }
}
