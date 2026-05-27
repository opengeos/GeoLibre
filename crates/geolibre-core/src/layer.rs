use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{VectorData, VectorStyle};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayerCommon {
    pub id: String,
    pub name: String,
    pub visible: bool,
    pub opacity: f32,
    #[serde(default)]
    pub metadata: Map<String, Value>,
}

impl LayerCommon {
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            visible: true,
            opacity: 1.0,
            metadata: Map::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VectorSource {
    GeoJson { path: String },
    FlatGeobuf { path: String },
    DuckDbGeoParquet { path: String, table: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RasterSource {
    Cog { path: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TileType {
    Raster,
    Vector,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TileSource {
    Xyz { url: String, tile_type: TileType },
    PMTiles { path: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DatabaseSource {
    DuckDb { path: String, table: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "source", rename_all = "snake_case")]
pub enum LayerSource {
    Vector(VectorSource),
    Raster(RasterSource),
    Tile(TileSource),
    Database(DatabaseSource),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VectorLayer {
    pub common: LayerCommon,
    pub source: VectorSource,
    pub style: VectorStyle,
    #[serde(skip)]
    pub data: VectorData,
}

impl VectorLayer {
    pub fn new(id: impl Into<String>, name: impl Into<String>, source: VectorSource) -> Self {
        Self {
            common: LayerCommon::new(id, name),
            source,
            style: VectorStyle::default(),
            data: VectorData::default(),
        }
    }

    pub fn with_data(mut self, data: VectorData) -> Self {
        self.data = data;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RasterLayer {
    pub common: LayerCommon,
    pub source: RasterSource,
}

impl RasterLayer {
    pub fn new(id: impl Into<String>, name: impl Into<String>, source: RasterSource) -> Self {
        Self {
            common: LayerCommon::new(id, name),
            source,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TileLayer {
    pub common: LayerCommon,
    pub source: TileSource,
    pub maplibre_style_json: Option<Value>,
}

impl TileLayer {
    pub fn new(id: impl Into<String>, name: impl Into<String>, source: TileSource) -> Self {
        Self {
            common: LayerCommon::new(id, name),
            source,
            maplibre_style_json: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DatabaseLayer {
    pub common: LayerCommon,
    pub source: DatabaseSource,
}

impl DatabaseLayer {
    pub fn new(id: impl Into<String>, name: impl Into<String>, source: DatabaseSource) -> Self {
        Self {
            common: LayerCommon::new(id, name),
            source,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Layer {
    Vector(VectorLayer),
    Raster(RasterLayer),
    Tile(TileLayer),
    Database(DatabaseLayer),
}

impl Layer {
    pub fn common(&self) -> &LayerCommon {
        match self {
            Layer::Vector(layer) => &layer.common,
            Layer::Raster(layer) => &layer.common,
            Layer::Tile(layer) => &layer.common,
            Layer::Database(layer) => &layer.common,
        }
    }

    pub fn common_mut(&mut self) -> &mut LayerCommon {
        match self {
            Layer::Vector(layer) => &mut layer.common,
            Layer::Raster(layer) => &mut layer.common,
            Layer::Tile(layer) => &mut layer.common,
            Layer::Database(layer) => &mut layer.common,
        }
    }

    pub fn id(&self) -> &str {
        &self.common().id
    }

    pub fn name(&self) -> &str {
        &self.common().name
    }

    pub fn visible(&self) -> bool {
        self.common().visible
    }

    pub fn set_visible(&mut self, visible: bool) {
        self.common_mut().visible = visible;
    }

    pub fn opacity(&self) -> f32 {
        self.common().opacity
    }

    pub fn set_opacity(&mut self, opacity: f32) {
        self.common_mut().opacity = opacity.clamp(0.0, 1.0);
    }

    pub fn source_label(&self) -> &'static str {
        match self {
            Layer::Vector(VectorLayer {
                source: VectorSource::GeoJson { .. },
                ..
            }) => "GeoJSON",
            Layer::Vector(VectorLayer {
                source: VectorSource::FlatGeobuf { .. },
                ..
            }) => "FlatGeobuf placeholder",
            Layer::Vector(VectorLayer {
                source: VectorSource::DuckDbGeoParquet { .. },
                ..
            }) => "DuckDB/GeoParquet placeholder",
            Layer::Raster(RasterLayer {
                source: RasterSource::Cog { .. },
                ..
            }) => "COG placeholder",
            Layer::Tile(TileLayer {
                source: TileSource::Xyz { .. },
                ..
            }) => "XYZ tiles placeholder",
            Layer::Tile(TileLayer {
                source: TileSource::PMTiles { .. },
                ..
            }) => "PMTiles placeholder",
            Layer::Database(_) => "Database placeholder",
        }
    }
}
