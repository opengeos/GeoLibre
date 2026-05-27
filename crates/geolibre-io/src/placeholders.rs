use geolibre_core::{
    DatabaseLayer, DatabaseSource, Layer, RasterLayer, RasterSource, TileLayer, TileSource,
    TileType, VectorLayer, VectorSource,
};

pub fn flatgeobuf_placeholder_layer(
    id: impl Into<String>,
    name: impl Into<String>,
    path: impl Into<String>,
) -> Layer {
    Layer::Vector(VectorLayer::new(
        id,
        name,
        VectorSource::FlatGeobuf { path: path.into() },
    ))
}

pub fn pmtiles_placeholder_layer(
    id: impl Into<String>,
    name: impl Into<String>,
    path: impl Into<String>,
) -> Layer {
    Layer::Tile(TileLayer::new(
        id,
        name,
        TileSource::PMTiles { path: path.into() },
    ))
}

pub fn cog_placeholder_layer(
    id: impl Into<String>,
    name: impl Into<String>,
    path: impl Into<String>,
) -> Layer {
    Layer::Raster(RasterLayer::new(
        id,
        name,
        RasterSource::Cog { path: path.into() },
    ))
}

pub fn xyz_tile_layer(
    id: impl Into<String>,
    name: impl Into<String>,
    url: impl Into<String>,
    tile_type: TileType,
) -> Layer {
    Layer::Tile(TileLayer::new(
        id,
        name,
        TileSource::Xyz {
            url: url.into(),
            tile_type,
        },
    ))
}

pub fn duckdb_placeholder_layer(
    id: impl Into<String>,
    name: impl Into<String>,
    path: impl Into<String>,
    table: Option<String>,
) -> Layer {
    Layer::Database(DatabaseLayer::new(
        id,
        name,
        DatabaseSource::DuckDb {
            path: path.into(),
            table,
        },
    ))
}

pub fn geoduckdb_vector_placeholder_layer(
    id: impl Into<String>,
    name: impl Into<String>,
    path: impl Into<String>,
    table: Option<String>,
) -> Layer {
    Layer::Vector(VectorLayer::new(
        id,
        name,
        VectorSource::DuckDbGeoParquet {
            path: path.into(),
            table,
        },
    ))
}
