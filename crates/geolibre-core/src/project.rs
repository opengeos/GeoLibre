use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{CoreError, Layer, Result};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GeoLibreProject {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub layers: Vec<Layer>,
    pub active_layer_id: Option<String>,
    pub maplibre_style_json: Option<Value>,
}

impl GeoLibreProject {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            layers: Vec::new(),
            active_layer_id: None,
            maplibre_style_json: None,
        }
    }

    pub fn add_layer(&mut self, layer: Layer) {
        self.active_layer_id = Some(layer.id().to_string());
        self.layers.push(layer);
    }

    pub fn remove_layer(&mut self, id: &str) -> Option<Layer> {
        let index = self.layers.iter().position(|layer| layer.id() == id)?;
        let removed = self.layers.remove(index);
        if self.active_layer_id.as_deref() == Some(id) {
            self.active_layer_id = self.layers.last().map(|layer| layer.id().to_string());
        }
        Some(removed)
    }

    pub fn move_layer(&mut self, from_index: usize, to_index: usize) -> Result<()> {
        if from_index >= self.layers.len() || to_index >= self.layers.len() {
            return Err(CoreError::InvalidLayer(format!(
                "layer index out of bounds: {from_index} -> {to_index}"
            )));
        }
        if from_index == to_index {
            return Ok(());
        }
        let layer = self.layers.remove(from_index);
        self.layers.insert(to_index, layer);
        Ok(())
    }

    pub fn layer(&self, id: &str) -> Option<&Layer> {
        self.layers.iter().find(|layer| layer.id() == id)
    }

    pub fn layer_mut(&mut self, id: &str) -> Option<&mut Layer> {
        self.layers.iter_mut().find(|layer| layer.id() == id)
    }

    pub fn save_to_path(&self, path: impl AsRef<Path>) -> Result<()> {
        let json = serde_json::to_string_pretty(self)?;
        std::fs::write(path, json)?;
        Ok(())
    }

    pub fn load_from_path(path: impl AsRef<Path>) -> Result<Self> {
        let json = std::fs::read_to_string(path)?;
        Ok(serde_json::from_str(&json)?)
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use crate::{Layer, VectorLayer, VectorSource};

    use super::GeoLibreProject;

    #[test]
    fn project_save_load_round_trip() {
        let mut project = GeoLibreProject::new("Round Trip");
        project.add_layer(Layer::Vector(VectorLayer::new(
            "sample",
            "Sample",
            VectorSource::GeoJson {
                path: "examples/data/sample.geojson".to_string(),
            },
        )));

        let path = PathBuf::from(std::env::temp_dir()).join("geolibre-round-trip.geolibre.json");
        project.save_to_path(&path).unwrap();
        let loaded = GeoLibreProject::load_from_path(&path).unwrap();
        let _ = std::fs::remove_file(path);

        assert_eq!(loaded.name, "Round Trip");
        assert_eq!(loaded.layers.len(), 1);
        assert_eq!(loaded.layers[0].id(), "sample");
    }

    #[test]
    fn layer_model_visibility_opacity_remove_and_reorder() {
        let mut project = GeoLibreProject::new("Layer Model");
        project.add_layer(Layer::Vector(VectorLayer::new(
            "a",
            "A",
            VectorSource::GeoJson {
                path: "a.geojson".to_string(),
            },
        )));
        project.add_layer(Layer::Vector(VectorLayer::new(
            "b",
            "B",
            VectorSource::GeoJson {
                path: "b.geojson".to_string(),
            },
        )));

        let layer = project.layer_mut("a").unwrap();
        layer.set_visible(false);
        layer.set_opacity(1.5);
        assert!(!layer.visible());
        assert_eq!(layer.opacity(), 1.0);

        project.move_layer(0, 1).unwrap();
        assert_eq!(project.layers[1].id(), "a");

        let removed = project.remove_layer("a").unwrap();
        assert_eq!(removed.id(), "a");
        assert!(project.layer("a").is_none());
    }

    #[test]
    fn example_project_file_loads() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/projects/basic.geolibre.json");
        let project = GeoLibreProject::load_from_path(path).unwrap();

        assert_eq!(project.name, "Basic GeoLibre Project");
        assert_eq!(project.layers.len(), 2);
        assert_eq!(project.active_layer_id.as_deref(), Some("sample-geojson"));
    }
}
