pub mod error;
pub mod geojson_loader;
pub mod placeholders;

pub use error::{IoError, Result};
pub use geojson_loader::load_geojson_layer;
pub use placeholders::{
    cog_placeholder_layer, duckdb_placeholder_layer, flatgeobuf_placeholder_layer,
    geoduckdb_vector_placeholder_layer, pmtiles_placeholder_layer, xyz_tile_layer,
};
