//! MBTiles metadata and tile commands, plus the SQLite and decompression
//! helpers the offline package and `mbtiles://` protocol code share.

use crate::local_media_protocol;
use crate::offline_mbtiles;
#[cfg(test)]
use crate::{is_safe_absolute_path, is_unc_resolved_path};
use flate2::read::{GzDecoder, ZlibDecoder};
#[cfg(test)]
use rusqlite::OpenFlags;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
#[cfg(test)]
use std::fs;
use std::io::Read;
use std::path::Path;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MbtilesMetadata {
    pub(crate) name: String,
    pub(crate) format: String,
    pub(crate) tile_type: String,
    pub(crate) source_layers: Vec<String>,
    pub(crate) source_layer_fields: std::collections::BTreeMap<String, Vec<String>>,
    pub(crate) min_zoom: Option<i64>,
    pub(crate) max_zoom: Option<i64>,
    pub(crate) bounds: Option<[f64; 4]>,
    pub(crate) center: Option<[f64; 3]>,
    pub(crate) scheme: String,
}

#[tauri::command]
pub(crate) async fn read_mbtiles_metadata(
    app: tauri::AppHandle,
    path: String,
) -> Result<MbtilesMetadata, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pools = app.state::<local_media_protocol::LocalMediaPools>();
        let pooled = pools.mbtiles.get_or_open(&path)?;
        let connection = pooled
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        read_mbtiles_metadata_from_connection(&path, &connection)
    })
    .await
    .map_err(|error| format!("Could not join MBTiles metadata task: {error}"))?
}

fn read_mbtiles_metadata_from_connection(
    path: &str,
    connection: &Connection,
) -> Result<MbtilesMetadata, String> {
    let metadata = read_metadata_rows(connection)?;
    read_mbtiles_metadata_from_rows(path, connection, &metadata)
}

pub(crate) fn read_mbtiles_metadata_from_rows(
    path: &str,
    connection: &Connection,
    metadata: &std::collections::BTreeMap<String, String>,
) -> Result<MbtilesMetadata, String> {
    let metadata_min_zoom = metadata
        .get("minzoom")
        .and_then(|value| value.parse::<i64>().ok());
    let metadata_max_zoom = metadata
        .get("maxzoom")
        .and_then(|value| value.parse::<i64>().ok());
    let (tile_min_zoom, tile_max_zoom) = read_mbtiles_zoom_range(
        connection,
        metadata_min_zoom.is_none(),
        metadata_max_zoom.is_none(),
    )?;
    let fallback_name = Path::new(path)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("MBTiles Layer")
        .to_string();
    let format = metadata
        .get("format")
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_else(|| "pbf".to_string());
    let tile_type = match format.as_str() {
        "pbf" | "mvt" | "protobuf" => "vector",
        _ => "raster",
    }
    .to_string();

    Ok(MbtilesMetadata {
        name: metadata
            .get("name")
            .filter(|value| !value.trim().is_empty())
            .cloned()
            .unwrap_or(fallback_name),
        format,
        tile_type,
        source_layers: read_vector_source_layers(metadata.get("json")),
        source_layer_fields: offline_mbtiles::vector_source_layer_fields(
            metadata.get("json").map(String::as_str),
        ),
        min_zoom: metadata_min_zoom.or(tile_min_zoom),
        max_zoom: metadata_max_zoom.or(tile_max_zoom),
        bounds: metadata.get("bounds").and_then(|value| parse_bounds(value)),
        center: metadata.get("center").and_then(|value| parse_center(value)),
        scheme: metadata
            .get("scheme")
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_else(|| "tms".to_string()),
    })
}

fn read_mbtiles_zoom_range(
    connection: &Connection,
    need_min: bool,
    need_max: bool,
) -> Result<(Option<i64>, Option<i64>), String> {
    let read = |aggregate: &str| {
        connection
            .query_row(
                &format!("SELECT {aggregate}(zoom_level) FROM tiles"),
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("Could not read MBTiles zoom range: {error}"))
    };
    Ok((
        if need_min { read("MIN")? } else { None },
        if need_max { read("MAX")? } else { None },
    ))
}

pub(crate) const MAX_MBTILES_ZOOM: u32 = 30;
const MAX_DECOMPRESSED_TILE_BYTES: u64 = 32 * 1024 * 1024;

#[tauri::command]
pub(crate) async fn read_mbtiles_tile(
    app: tauri::AppHandle,
    path: String,
    z: u32,
    x: u32,
    y: u32,
) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let pools = app.state::<local_media_protocol::LocalMediaPools>();
        pools.mbtiles.read_tile(&path, z, x, y)
    })
    .await
    .map_err(|error| format!("Could not join MBTiles tile task: {error}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
fn read_mbtiles_tile_blocking(path: String, z: u32, x: u32, y: u32) -> Result<Vec<u8>, String> {
    local_media_protocol::MbtilesConnectionPool::default().read_tile(&path, z, x, y)
}

#[cfg(test)]
fn open_mbtiles(path: &str) -> Result<Connection, String> {
    if !is_safe_absolute_path(path) || !path.to_ascii_lowercase().ends_with(".mbtiles") {
        return Err(format!(
            "Refusing to open \"{path}\": not an absolute local MBTiles file path"
        ));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|_| "The selected MBTiles file does not exist".to_string())?;
    let resolved = canonical.to_string_lossy();
    if is_unc_resolved_path(&resolved) {
        return Err(format!(
            "Refusing to open \"{path}\": resolves to a network path"
        ));
    }
    if !resolved.to_ascii_lowercase().ends_with(".mbtiles") || !canonical.is_file() {
        return Err(format!(
            "Refusing to open \"{path}\": resolves to a non-MBTiles file"
        ));
    }

    Connection::open_with_flags(&canonical, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Could not open MBTiles file: {error}"))
}

fn read_metadata_rows(
    connection: &Connection,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    let mut statement = connection
        .prepare("SELECT name, value FROM metadata")
        .map_err(|error| format!("Could not read MBTiles metadata: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Could not query MBTiles metadata: {error}"))?;

    let mut metadata = std::collections::BTreeMap::new();
    for row in rows {
        let (name, value) =
            row.map_err(|error| format!("Could not parse MBTiles metadata: {error}"))?;
        metadata.insert(name.to_ascii_lowercase(), value);
    }
    Ok(metadata)
}

pub(crate) fn read_metadata_value(
    connection: &Connection,
    name: &str,
) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT value FROM metadata WHERE lower(name) = lower(?1)",
            [name],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not read MBTiles metadata: {error}"))
}

fn read_vector_source_layers(json: Option<&String>) -> Vec<String> {
    let Some(json) = json else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    value
        .get("vector_layers")
        .and_then(Value::as_array)
        .map(|layers| {
            layers
                .iter()
                .filter_map(|layer| layer.get("id").and_then(Value::as_str))
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn parse_bounds(value: &str) -> Option<[f64; 4]> {
    let values = parse_number_list(value);
    if values.len() != 4 {
        return None;
    }
    Some([values[0], values[1], values[2], values[3]])
}

fn parse_center(value: &str) -> Option<[f64; 3]> {
    let values = parse_number_list(value);
    if values.len() < 2 {
        return None;
    }
    Some([values[0], values[1], values.get(2).copied().unwrap_or(0.0)])
}

fn parse_number_list(value: &str) -> Vec<f64> {
    value
        .split(',')
        .filter_map(|part| part.trim().parse::<f64>().ok())
        .collect()
}

pub(crate) fn decompress_tile_data(data: Vec<u8>) -> Result<Vec<u8>, String> {
    if data.starts_with(&[0x1f, 0x8b]) {
        let decoder = GzDecoder::new(data.as_slice());
        let mut decoded = Vec::new();
        decoder
            .take(MAX_DECOMPRESSED_TILE_BYTES + 1)
            .read_to_end(&mut decoded)
            .map_err(|error| format!("Could not decompress gzip tile: {error}"))?;
        if decoded.len() as u64 > MAX_DECOMPRESSED_TILE_BYTES {
            return Err("Decompressed gzip tile exceeds the size limit".to_string());
        }
        return Ok(decoded);
    }

    if data.len() > 2 && data[0] == 0x78 {
        let decoder = ZlibDecoder::new(data.as_slice());
        let mut decoded = Vec::new();
        if decoder
            .take(MAX_DECOMPRESSED_TILE_BYTES + 1)
            .read_to_end(&mut decoded)
            .is_ok()
        {
            if decoded.len() as u64 > MAX_DECOMPRESSED_TILE_BYTES {
                return Err("Decompressed zlib tile exceeds the size limit".to_string());
            }
            return Ok(decoded);
        }
    }

    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::read_mbtiles_zoom_range;

    #[test]
    fn derives_mbtiles_zoom_range_from_tile_rows() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute("CREATE TABLE tiles (zoom_level INTEGER NOT NULL)", [])
            .unwrap();
        for zoom in [4, 9, 6] {
            connection
                .execute("INSERT INTO tiles (zoom_level) VALUES (?1)", [zoom])
                .unwrap();
        }

        assert_eq!(
            read_mbtiles_zoom_range(&connection, true, true).unwrap(),
            (Some(4), Some(9))
        );

        let no_tiles_table = rusqlite::Connection::open_in_memory().unwrap();
        assert_eq!(
            read_mbtiles_zoom_range(&no_tiles_table, false, false).unwrap(),
            (None, None)
        );
    }

    #[test]
    fn open_mbtiles_rejects_non_mbtiles_and_unc_paths() {
        assert!(super::open_mbtiles("relative.mbtiles").is_err());
        assert!(super::open_mbtiles("/etc/passwd").is_err());
        assert!(super::open_mbtiles(r"\\evil\share\tiles.mbtiles").is_err());
        assert!(super::open_mbtiles("/tmp/../etc/tiles.mbtiles").is_err());
    }

    #[test]
    fn read_mbtiles_tile_rejects_excessive_zoom() {
        let err =
            super::read_mbtiles_tile_blocking("/tmp/nonexistent.mbtiles".to_string(), 63, 0, 0)
                .expect_err("zoom 63 must be rejected");
        assert!(err.contains("zoom level is too large"));
    }

    #[test]
    fn decompress_tile_data_caps_decompressed_size() {
        use flate2::{write::GzEncoder, Compression};
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::best());
        let chunk = vec![0u8; 1024 * 1024];
        for _ in 0..33 {
            encoder.write_all(&chunk).unwrap();
        }
        let bomb = encoder.finish().unwrap();
        let err = super::decompress_tile_data(bomb).expect_err("oversized gzip tile must fail");
        assert!(err.contains("exceeds the size limit"));
    }
}
