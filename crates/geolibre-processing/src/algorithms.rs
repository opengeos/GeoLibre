use geolibre_core::{GeoLibreProject, Layer};

use crate::{ProcessingAlgorithm, ProcessingError, ProcessingOutput, Result};

pub struct BoundingBoxAlgorithm;

impl ProcessingAlgorithm for BoundingBoxAlgorithm {
    fn id(&self) -> &'static str {
        "native.bounding_box"
    }

    fn name(&self) -> &'static str {
        "Bounding Box"
    }

    fn description(&self) -> &'static str {
        "Computes the bounding box of a vector layer."
    }

    fn run(&self, project: &GeoLibreProject, layer_id: &str) -> Result<ProcessingOutput> {
        let layer = project
            .layer(layer_id)
            .ok_or_else(|| ProcessingError::LayerNotFound(layer_id.to_string()))?;

        let Layer::Vector(vector_layer) = layer else {
            return Err(ProcessingError::InvalidInput(
                "bounding box requires a vector layer".to_string(),
            ));
        };

        let bbox = vector_layer.data.bbox.ok_or_else(|| {
            ProcessingError::InvalidInput("vector layer has no extent".to_string())
        })?;

        Ok(ProcessingOutput::Message(format!(
            "Bounding box: {}, {}, {}, {}",
            bbox.min_x, bbox.min_y, bbox.max_x, bbox.max_y
        )))
    }
}

pub struct BufferPlaceholderAlgorithm;

impl ProcessingAlgorithm for BufferPlaceholderAlgorithm {
    fn id(&self) -> &'static str {
        "native.buffer_placeholder"
    }

    fn name(&self) -> &'static str {
        "Buffer"
    }

    fn description(&self) -> &'static str {
        "Placeholder for future vector buffering."
    }

    fn run(&self, _project: &GeoLibreProject, _layer_id: &str) -> Result<ProcessingOutput> {
        Err(ProcessingError::Placeholder(
            "Buffer will be implemented after robust geometry editing is added.".to_string(),
        ))
    }
}

pub struct ReprojectPlaceholderAlgorithm;

impl ProcessingAlgorithm for ReprojectPlaceholderAlgorithm {
    fn id(&self) -> &'static str {
        "native.reproject_placeholder"
    }

    fn name(&self) -> &'static str {
        "Reproject"
    }

    fn description(&self) -> &'static str {
        "Placeholder for future CRS transforms."
    }

    fn run(&self, _project: &GeoLibreProject, _layer_id: &str) -> Result<ProcessingOutput> {
        Err(ProcessingError::Placeholder(
            "Reproject will be implemented when CRS metadata and PROJ integration are added."
                .to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use geolibre_core::{
        GeoLibreProject, Geometry, Layer, VectorData, VectorFeature, VectorLayer, VectorSource,
    };
    use serde_json::Map;

    use crate::{BoundingBoxAlgorithm, ProcessingAlgorithm, ProcessingOutput};

    #[test]
    fn bounding_box_algorithm_reports_extent() {
        let data = VectorData::from_features(vec![VectorFeature {
            id: None,
            properties: Map::new(),
            geometry: Some(Geometry::LineString(vec![[1.0, 2.0], [3.0, 4.0]])),
        }]);
        let mut project = GeoLibreProject::new("Processing");
        project.add_layer(Layer::Vector(
            VectorLayer::new(
                "line",
                "Line",
                VectorSource::GeoJson {
                    path: "line.geojson".to_string(),
                },
            )
            .with_data(data),
        ));

        let output = BoundingBoxAlgorithm.run(&project, "line").unwrap();
        assert_eq!(
            output,
            ProcessingOutput::Message("Bounding box: 1, 2, 3, 4".to_string())
        );
    }
}
