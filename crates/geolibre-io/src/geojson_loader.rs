use std::{fs, path::Path};

use geojson::{feature::Id, Feature, GeoJson, Geometry as GeoJsonGeometry, Value};
use geolibre_core::{Geometry, VectorData, VectorFeature, VectorLayer, VectorSource};
use serde_json::Map;

use crate::Result;

pub fn load_geojson_layer(
    path: impl AsRef<Path>,
    id: impl Into<String>,
    name: impl Into<String>,
) -> Result<VectorLayer> {
    let path = path.as_ref();
    let text = fs::read_to_string(path)?;
    let geojson = text.parse::<GeoJson>()?;
    let features = features_from_geojson(geojson);
    let data = VectorData::from_features(features);

    Ok(VectorLayer::new(
        id,
        name,
        VectorSource::GeoJson {
            path: path.to_string_lossy().to_string(),
        },
    )
    .with_data(data))
}

fn features_from_geojson(geojson: GeoJson) -> Vec<VectorFeature> {
    match geojson {
        GeoJson::FeatureCollection(collection) => collection
            .features
            .into_iter()
            .map(feature_from_geojson)
            .collect(),
        GeoJson::Feature(feature) => vec![feature_from_geojson(feature)],
        GeoJson::Geometry(geometry) => vec![VectorFeature {
            id: None,
            properties: Map::new(),
            geometry: Some(geometry_from_geojson(geometry)),
        }],
    }
}

fn feature_from_geojson(feature: Feature) -> VectorFeature {
    VectorFeature {
        id: feature.id.map(id_to_string),
        properties: feature.properties.unwrap_or_default(),
        geometry: feature.geometry.map(geometry_from_geojson),
    }
}

fn id_to_string(id: Id) -> String {
    match id {
        Id::String(value) => value,
        Id::Number(value) => value.to_string(),
    }
}

fn geometry_from_geojson(geometry: GeoJsonGeometry) -> Geometry {
    match geometry.value {
        Value::Point(coord) => Geometry::Point(coord2(coord)),
        Value::MultiPoint(coords) => Geometry::MultiPoint(coords.into_iter().map(coord2).collect()),
        Value::LineString(coords) => Geometry::LineString(coords.into_iter().map(coord2).collect()),
        Value::MultiLineString(lines) => Geometry::MultiLineString(
            lines
                .into_iter()
                .map(|line| line.into_iter().map(coord2).collect())
                .collect(),
        ),
        Value::Polygon(rings) => Geometry::Polygon(
            rings
                .into_iter()
                .map(|ring| ring.into_iter().map(coord2).collect())
                .collect(),
        ),
        Value::MultiPolygon(polygons) => Geometry::MultiPolygon(
            polygons
                .into_iter()
                .map(|polygon| {
                    polygon
                        .into_iter()
                        .map(|ring| ring.into_iter().map(coord2).collect())
                        .collect()
                })
                .collect(),
        ),
        Value::GeometryCollection(geometries) => Geometry::GeometryCollection(
            geometries.into_iter().map(geometry_from_geojson).collect(),
        ),
    }
}

fn coord2(coord: Vec<f64>) -> [f64; 2] {
    [
        coord.first().copied().unwrap_or_default(),
        coord.get(1).copied().unwrap_or_default(),
    ]
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::load_geojson_layer;

    #[test]
    fn loads_sample_geojson() {
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/data/sample.geojson");
        let layer = load_geojson_layer(path, "sample", "Sample").unwrap();

        assert_eq!(layer.data.feature_count(), 3);
        assert!(layer.data.bbox.is_some());
    }
}
