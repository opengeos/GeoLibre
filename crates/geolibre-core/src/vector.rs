use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Extent {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl Extent {
    pub fn new(min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> Self {
        Self {
            min_x,
            min_y,
            max_x,
            max_y,
        }
    }

    pub fn from_coord(coord: [f64; 2]) -> Self {
        Self::new(coord[0], coord[1], coord[0], coord[1])
    }

    pub fn include_coord(&mut self, coord: [f64; 2]) {
        self.min_x = self.min_x.min(coord[0]);
        self.min_y = self.min_y.min(coord[1]);
        self.max_x = self.max_x.max(coord[0]);
        self.max_y = self.max_y.max(coord[1]);
    }

    pub fn union(&mut self, other: Self) {
        self.include_coord([other.min_x, other.min_y]);
        self.include_coord([other.max_x, other.max_y]);
    }

    pub fn width(&self) -> f64 {
        self.max_x - self.min_x
    }

    pub fn height(&self) -> f64 {
        self.max_y - self.min_y
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "coordinates")]
pub enum Geometry {
    Point([f64; 2]),
    MultiPoint(Vec<[f64; 2]>),
    LineString(Vec<[f64; 2]>),
    MultiLineString(Vec<Vec<[f64; 2]>>),
    Polygon(Vec<Vec<[f64; 2]>>),
    MultiPolygon(Vec<Vec<Vec<[f64; 2]>>>),
    GeometryCollection(Vec<Geometry>),
}

impl Geometry {
    pub fn extent(&self) -> Option<Extent> {
        let mut extent: Option<Extent> = None;
        self.visit_coords(&mut |coord| {
            if let Some(current) = &mut extent {
                current.include_coord(coord);
            } else {
                extent = Some(Extent::from_coord(coord));
            }
        });
        extent
    }

    pub fn visit_coords(&self, visitor: &mut impl FnMut([f64; 2])) {
        match self {
            Geometry::Point(coord) => visitor(*coord),
            Geometry::MultiPoint(coords) | Geometry::LineString(coords) => {
                for coord in coords {
                    visitor(*coord);
                }
            }
            Geometry::MultiLineString(lines) | Geometry::Polygon(lines) => {
                for line in lines {
                    for coord in line {
                        visitor(*coord);
                    }
                }
            }
            Geometry::MultiPolygon(polygons) => {
                for polygon in polygons {
                    for ring in polygon {
                        for coord in ring {
                            visitor(*coord);
                        }
                    }
                }
            }
            Geometry::GeometryCollection(geometries) => {
                for geometry in geometries {
                    geometry.visit_coords(visitor);
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VectorFeature {
    pub id: Option<String>,
    pub properties: Map<String, Value>,
    pub geometry: Option<Geometry>,
}

impl VectorFeature {
    pub fn extent(&self) -> Option<Extent> {
        self.geometry.as_ref().and_then(Geometry::extent)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct VectorData {
    pub features: Vec<VectorFeature>,
    pub bbox: Option<Extent>,
}

impl VectorData {
    pub fn from_features(features: Vec<VectorFeature>) -> Self {
        let bbox = features.iter().filter_map(VectorFeature::extent).fold(
            None,
            |acc: Option<Extent>, item| {
                let mut merged = acc.unwrap_or(item);
                if acc.is_some() {
                    merged.union(item);
                }
                Some(merged)
            },
        );
        Self { features, bbox }
    }

    pub fn feature_count(&self) -> usize {
        self.features.len()
    }
}
