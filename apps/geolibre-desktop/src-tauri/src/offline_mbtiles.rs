//! Streaming area extraction from local MBTiles into a private staging file.
//! The caller owns publication, path authorization, and cleanup on failure.

use rusqlite::{limits::Limit, params, Connection, OpenFlags};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use crate::offline_packages::MAX_PACKAGE_BYTES;

const MAX_TILES: usize = 200_000;
const MAX_TILE_BYTES: usize = 32 * 1024 * 1024;
const MAX_METADATA_BYTES: usize = 1024 * 1024;
const MAX_MERCATOR_LAT: f64 = 85.051_128_779_806_6;

/// Preserve declared vector fields for the native source-style compatibility
/// check. Absent declarations remain unknown rather than implying no fields.
pub(crate) fn vector_source_layer_fields(json: Option<&str>) -> BTreeMap<String, Vec<String>> {
    let Some(value) = json.and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
    else {
        return BTreeMap::new();
    };
    value
        .get("vector_layers")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|layer| {
            let id = layer.get("id")?.as_str()?;
            let fields = layer.get("fields")?.as_object()?;
            Some((id.to_string(), fields.keys().cloned().collect()))
        })
        .collect()
}

/// Roads, places, and landcover styles classify features by `kind`. Geometry
/// layers such as earth and water can render without a classification field.
pub(crate) fn validate_source_fields(fields: &BTreeMap<String, Vec<String>>) -> Result<(), String> {
    if ["roads", "places", "landcover"].iter().any(|layer| {
        fields
            .get(*layer)
            .is_some_and(|fields| !fields.iter().any(|field| field == "kind"))
    }) {
        return Err(
            "The selected MBTiles source does not declare Protomaps classification fields".into(),
        );
    }
    Ok(())
}

/// Recheck the source schema on the extraction snapshot, since a selected
/// desktop file may have changed after the UI inspected it.
pub(crate) fn validate_source_style(
    tile_type: &str,
    source_layers: &[String],
    flavored: bool,
) -> Result<(), String> {
    if tile_type == "vector" && source_layers.is_empty() {
        return Err("Vector MBTiles requires source-layer metadata".into());
    }
    if flavored {
        let has = |name: &str| source_layers.iter().any(|layer| layer == name);
        let matches = ["earth", "water", "roads", "places", "landcover"]
            .iter()
            .filter(|name| has(name))
            .count();
        if tile_type != "vector" || (!has("earth") && !has("water")) || matches < 2 {
            return Err(
                "The selected MBTiles source no longer has a Protomaps-compatible schema".into(),
            );
        }
    }
    Ok(())
}

/// Open an already-authorized local source without allowing SQLite writes.
/// Query execution observes cancellation even before a view returns its first
/// row. Limits bound individual SQLite values and query complexity, not the
/// connection's entire heap. The native job owns the cancellation flag.
pub(crate) fn open_mbtiles_source(
    path: &Path,
    cancelled: Arc<AtomicBool>,
) -> Result<Connection, String> {
    let mut source = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Could not open MBTiles source: {error}"))?;
    for (limit, value) in [
        (
            Limit::SQLITE_LIMIT_LENGTH,
            (MAX_TILE_BYTES + MAX_METADATA_BYTES) as i32,
        ),
        (Limit::SQLITE_LIMIT_SQL_LENGTH, 64 * 1024),
        (Limit::SQLITE_LIMIT_COLUMN, 64),
        (Limit::SQLITE_LIMIT_EXPR_DEPTH, 64),
        (Limit::SQLITE_LIMIT_COMPOUND_SELECT, 16),
        (Limit::SQLITE_LIMIT_VDBE_OP, 100_000),
        (Limit::SQLITE_LIMIT_ATTACHED, 0),
        (Limit::SQLITE_LIMIT_TRIGGER_DEPTH, 0),
        (Limit::SQLITE_LIMIT_WORKER_THREADS, 0),
    ] {
        source
            .set_limit(limit, value)
            .map_err(|error| error.to_string())?;
    }
    source.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE;")
        .map_err(|error| error.to_string())?;
    source
        .progress_handler(1000, Some(move || cancelled.load(Ordering::Relaxed)))
        .map_err(|error| error.to_string())?;
    Ok(source)
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MbtilesAreaOptions {
    pub bbox: [f64; 4],
    pub min_zoom: u8,
    pub max_zoom: u8,
}

#[derive(Debug)]
pub(crate) struct MbtilesAreaResult {
    pub bbox: [f64; 4],
    pub view_center: Option<[f64; 3]>,
    pub tile_count: usize,
    pub payload_bytes: u64,
    pub min_zoom: u8,
    pub max_zoom: u8,
}

fn validate(options: &MbtilesAreaOptions) -> Result<(), String> {
    let [west, south, east, north] = options.bbox;
    if options.bbox.iter().any(|value| !value.is_finite())
        || west < -180.0
        || east > 180.0
        || west >= east
        || south < -90.0
        || north > 90.0
        || south >= north
        || options.min_zoom > options.max_zoom
        || options.max_zoom > 30
    {
        return Err("Invalid MBTiles extraction extent or zoom range".into());
    }
    Ok(())
}

/// Inclusive XYZ tile indices intersecting a non-wrapping geographic extent.
fn tile_window(bbox: [f64; 4], zoom: u8) -> (i64, i64, i64, i64) {
    let n = (1_u64 << zoom) as f64;
    let x = |longitude: f64| (longitude + 180.0) / 360.0 * n;
    let y = |latitude: f64| {
        let radians = latitude
            .clamp(-MAX_MERCATOR_LAT, MAX_MERCATOR_LAT)
            .to_radians();
        (1.0 - radians.tan().asinh() / std::f64::consts::PI) * 0.5 * n
    };
    let index = |value: f64| value.clamp(0.0, n - 1.0) as i64;
    (
        index(x(bbox[0]).floor()),
        index(x(bbox[2]).ceil() - 1.0),
        index(y(bbox[3]).floor()),
        index(y(bbox[1]).ceil() - 1.0),
    )
}

pub(crate) fn source_metadata(source: &Connection) -> Result<BTreeMap<String, String>, String> {
    // Check SQL lengths before transferring strings into Rust. Metadata is
    // untrusted, and one huge JSON value must not allocate unbounded memory.
    let mut statement = source
        .prepare(
            "SELECT CASE WHEN length(CAST(name AS BLOB)) <= 1024 THEN name END,
                CASE WHEN length(CAST(value AS BLOB)) <= 1048576 THEN value END
         FROM metadata LIMIT 1025",
        )
        .map_err(|error| format!("Could not read MBTiles metadata: {error}"))?;
    let mut rows = statement.query([]).map_err(|error| error.to_string())?;
    let mut result = BTreeMap::new();
    let mut total = 0_usize;
    let mut count = 0;
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
        count += 1;
        let key = row
            .get::<_, Option<String>>(0)
            .map_err(|error| error.to_string())?
            .ok_or("MBTiles metadata key is too large")?;
        let value = row
            .get::<_, Option<String>>(1)
            .map_err(|error| error.to_string())?
            .ok_or("MBTiles metadata value is too large")?;
        total = total.saturating_add(key.len()).saturating_add(value.len());
        if count > 1024 || total > MAX_METADATA_BYTES {
            return Err("MBTiles metadata exceeds the extraction limit".into());
        }
        if result.insert(key.to_ascii_lowercase(), value).is_some() {
            return Err("MBTiles metadata has duplicate keys".into());
        }
    }
    Ok(result)
}

/// Copy intersecting tiles, preserving their bytes and normalizing rows to TMS.
///
/// `destination` must be a fresh path inside the caller's private staging
/// directory. No published package is modified. Only one bounded tile buffer
/// is held at a time; the output payload, tile count, and metadata are bounded.
/// The caller must also interrupt long-running SQLite queries on cancellation.
#[cfg(test)]
pub(crate) fn extract_mbtiles_area(
    source: &Connection,
    destination: &Path,
    options: MbtilesAreaOptions,
    cancelled: impl Fn() -> bool,
) -> Result<MbtilesAreaResult, String> {
    extract_mbtiles_area_with_progress(source, destination, options, cancelled, |_, _| {})
}

/// The streaming extractor with per-tile progress for a throttled native UI.
pub(crate) fn extract_mbtiles_area_with_progress(
    source: &Connection,
    destination: &Path,
    options: MbtilesAreaOptions,
    cancelled: impl Fn() -> bool,
    mut progress: impl FnMut(usize, u64),
) -> Result<MbtilesAreaResult, String> {
    validate(&options)?;
    let mut options = options;
    options.bbox[1] = options.bbox[1].max(-MAX_MERCATOR_LAT);
    options.bbox[3] = options.bbox[3].min(MAX_MERCATOR_LAT);
    validate(&options)?;
    if cancelled() {
        return Err("MBTiles extraction canceled".into());
    }
    if destination.exists() {
        return Err("MBTiles extraction staging file already exists".into());
    }
    let mut metadata = source_metadata(source)?;
    let xyz = match metadata
        .get("scheme")
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        None | Some("tms") => false,
        Some("xyz") => true,
        _ => return Err("Unsupported MBTiles tile-row scheme".into()),
    };
    let mut output = Connection::open(destination).map_err(|error| error.to_string())?;
    output
        .execute_batch(
            "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
         PRAGMA cache_size=-2048; PRAGMA temp_store=FILE;
         CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE tiles (zoom_level INTEGER NOT NULL, tile_column INTEGER NOT NULL,
           tile_row INTEGER NOT NULL, tile_data BLOB NOT NULL,
           PRIMARY KEY (zoom_level, tile_column, tile_row));",
        )
        .map_err(|error| format!("Could not create MBTiles extract: {error}"))?;
    let transaction = output.transaction().map_err(|error| error.to_string())?;
    let mut result = MbtilesAreaResult {
        bbox: options.bbox,
        view_center: None,
        tile_count: 0,
        payload_bytes: 0,
        min_zoom: 30,
        max_zoom: 0,
    };
    let mut copied_by_zoom = BTreeMap::new();
    {
        let mut insert = transaction
            .prepare("INSERT INTO tiles VALUES (?1,?2,?3,?4)")
            .map_err(|error| error.to_string())?;
        // CASE prevents a giant blob allocation before the per-tile check.
        let mut select = source
            .prepare(
                "SELECT tile_column,tile_row,
                    CASE WHEN length(tile_data) <= ?6 AND typeof(tile_data)='blob'
                         THEN tile_data END
             FROM tiles WHERE zoom_level=?1 AND tile_column BETWEEN ?2 AND ?3
               AND tile_row BETWEEN ?4 AND ?5 LIMIT 200001",
            )
            .map_err(|error| format!("Could not query MBTiles tiles: {error}"))?;
        for zoom in options.min_zoom..=options.max_zoom {
            if cancelled() {
                return Err("MBTiles extraction canceled".into());
            }
            let n = 1_i64 << zoom;
            let (left, right, top, bottom) = tile_window(options.bbox, zoom);
            let (first, last) = if xyz {
                (top, bottom)
            } else {
                (n - 1 - bottom, n - 1 - top)
            };
            let mut rows = select
                .query(params![
                    zoom,
                    left,
                    right,
                    first,
                    last,
                    MAX_TILE_BYTES as i64
                ])
                .map_err(|error| error.to_string())?;
            while let Some(row) = rows.next().map_err(|error| error.to_string())? {
                if cancelled() {
                    return Err("MBTiles extraction canceled".into());
                }
                if result.tile_count >= MAX_TILES {
                    return Err("MBTiles extraction exceeds 200,000 tiles".into());
                }
                let column: i64 = row.get(0).map_err(|error| error.to_string())?;
                let source_row: i64 = row.get(1).map_err(|error| error.to_string())?;
                let bytes = row
                    .get::<_, Option<Vec<u8>>>(2)
                    .map_err(|error| error.to_string())?
                    .ok_or("MBTiles tile is missing, is not a blob, or exceeds 32 MiB")?;
                result.payload_bytes = result
                    .payload_bytes
                    .checked_add(bytes.len() as u64)
                    .ok_or("MBTiles extraction is too large")?;
                if result.payload_bytes > MAX_PACKAGE_BYTES as u64 {
                    return Err("MBTiles extraction exceeds 512 MiB".into());
                }
                let target_row = if xyz { n - 1 - source_row } else { source_row };
                insert
                    .execute(params![zoom, column, target_row, bytes])
                    .map_err(|error| error.to_string())?;
                *copied_by_zoom.entry(zoom).or_insert(0_u64) += 1;
                result.tile_count += 1;
                progress(result.tile_count, result.payload_bytes);
                result.min_zoom = result.min_zoom.min(zoom);
                result.max_zoom = result.max_zoom.max(zoom);
            }
        }
    }
    if result.tile_count == 0 {
        return Err("The selected MBTiles area has no tiles".into());
    }
    if cancelled() {
        return Err("MBTiles extraction canceled".into());
    }
    // Query only our bounded output, never the untrusted source. Prefer an
    // interior copied tile: edge raster tiles can be almost wholly transparent.
    // The nearest existing coordinate also handles holes in a sparse extent.
    let (focus_x, focus_y): (f64, f64) = transaction
        .query_row(
            "SELECT (min(tile_column)+max(tile_column))/2.0,
                (min(tile_row)+max(tile_row))/2.0 FROM tiles WHERE zoom_level=?1",
            [result.min_zoom],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| error.to_string())?;
    let (column, target_row): (i64, i64) = transaction
        .query_row(
            "SELECT tile_column,tile_row FROM tiles WHERE zoom_level=?1
         ORDER BY (tile_column-?2)*(tile_column-?2)+(tile_row-?3)*(tile_row-?3),
                  tile_column,tile_row LIMIT 1",
            params![result.min_zoom, focus_x, focus_y],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| error.to_string())?;
    let n = 1_i64 << result.min_zoom;
    let xyz_row = n - 1 - target_row;
    let longitude = |x: i64| x as f64 / n as f64 * 360.0 - 180.0;
    let latitude = |y: i64| {
        ((1.0 - 2.0 * y as f64 / n as f64) * std::f64::consts::PI)
            .sinh()
            .atan()
            .to_degrees()
    };
    let center = [
        (longitude(column).max(options.bbox[0]) + longitude(column + 1).min(options.bbox[2])) / 2.0,
        (latitude(xyz_row + 1).max(options.bbox[1]) + latitude(xyz_row).min(options.bbox[3])) / 2.0,
        result.min_zoom as f64,
    ];
    metadata.insert("scheme".into(), "tms".into());
    // Unique output coordinates make a count comparison sufficient to prove
    // complete coverage of the requested tile rectangle at every stored zoom.
    let complete = (result.min_zoom..=result.max_zoom).all(|zoom| {
        let (left, right, top, bottom) = tile_window(options.bbox, zoom);
        copied_by_zoom.get(&zoom).copied().unwrap_or(0)
            == ((right - left + 1) * (bottom - top + 1)) as u64
    });
    if complete {
        metadata.insert(
            "bounds".into(),
            options.bbox.map(|value| value.to_string()).join(","),
        );
    } else {
        metadata.remove("bounds");
        result.view_center = Some(center);
    }
    metadata.insert("minzoom".into(), result.min_zoom.to_string());
    metadata.insert("maxzoom".into(), result.max_zoom.to_string());
    metadata.insert(
        "center".into(),
        center.map(|value| value.to_string()).join(","),
    );
    if let Some(json) = metadata.get_mut("json") {
        if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(json) {
            if let Some(layers) = value
                .get_mut("vector_layers")
                .and_then(serde_json::Value::as_array_mut)
            {
                for layer in layers {
                    if let Some(layer) = layer.as_object_mut() {
                        layer.remove("minzoom");
                        layer.remove("maxzoom");
                    }
                }
                *json = serde_json::to_string(&value).map_err(|error| error.to_string())?;
            }
        }
    }
    {
        let mut insert = transaction
            .prepare("INSERT INTO metadata VALUES (?1,?2)")
            .map_err(|error| error.to_string())?;
        for (key, value) in metadata {
            insert
                .execute(params![key, value])
                .map_err(|error| error.to_string())?;
        }
    }
    if cancelled() {
        return Err("MBTiles extraction canceled".into());
    }
    transaction
        .commit()
        .map_err(|error| format!("Could not commit MBTiles extract: {error}"))?;
    output.close().map_err(|(_, error)| error.to_string())?;
    if std::fs::metadata(destination)
        .map_err(|error| error.to_string())?
        .len()
        > MAX_PACKAGE_BYTES as u64
    {
        return Err("MBTiles extraction exceeds 512 MiB".into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn source(scheme: &str) -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE metadata(name TEXT,value TEXT);
            CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB);").unwrap();
        connection
            .execute(
                "INSERT INTO metadata VALUES ('scheme',?1),('format','png'),('name','Berkeley')",
                [scheme],
            )
            .unwrap();
        let row = if scheme == "xyz" { 3 } else { 4 };
        connection
            .execute(
                "INSERT INTO tiles VALUES (3,1,?1,?2)",
                params![row, b"selected".to_vec()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO tiles VALUES (3,0,?1,?2)",
                params![row, b"outside".to_vec()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO tiles VALUES (2,0,2,?1)",
                [b"other zoom".to_vec()],
            )
            .unwrap();
        connection
    }

    struct TestDirectory(std::path::PathBuf);

    impl AsRef<Path> for TestDirectory {
        fn as_ref(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn destination() -> (TestDirectory, std::path::PathBuf) {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).unwrap();
        let root =
            std::env::temp_dir().join(format!("geolibre-mbtiles-{:x}", u64::from_le_bytes(random)));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("extract.mbtiles");
        (TestDirectory(root), path)
    }

    #[test]
    fn extracts_exact_area_and_zoom_preserving_bytes_for_tms_and_xyz() {
        for scheme in ["tms", "xyz"] {
            let source = source(scheme);
            let (root, path) = destination();
            let result = extract_mbtiles_area(
                &source,
                &path,
                MbtilesAreaOptions {
                    bbox: [-123., 37., -122., 38.],
                    min_zoom: 3,
                    max_zoom: 3,
                },
                || false,
            )
            .unwrap();
            assert_eq!(result.tile_count, 1);
            let output = Connection::open(&path).unwrap();
            let data: Vec<u8>=output.query_row("SELECT tile_data FROM tiles WHERE zoom_level=3 AND tile_column=1 AND tile_row=4",[],|row|row.get(0)).unwrap();
            assert_eq!(data, b"selected");
            assert_eq!(source_metadata(&output).unwrap()["scheme"], "tms");
            assert_eq!(
                source_metadata(&output).unwrap()["bounds"],
                "-123,37,-122,38"
            );
            assert_eq!(
                source
                    .query_row("SELECT count(*) FROM tiles", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                3
            );
            drop(output);
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn cancellation_rolls_back_tiles_without_modifying_source() {
        let source = source("tms");
        let (root, path) = destination();
        let calls = Cell::new(0);
        let result = extract_mbtiles_area(
            &source,
            &path,
            MbtilesAreaOptions {
                bbox: [-180., -85., 180., 85.],
                min_zoom: 2,
                max_zoom: 3,
            },
            || {
                calls.set(calls.get() + 1);
                calls.get() >= 4
            },
        );
        assert!(result.unwrap_err().contains("canceled"));
        let output = Connection::open(&path).unwrap();
        assert_eq!(
            output
                .query_row("SELECT count(*) FROM tiles", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            source
                .query_row("SELECT count(*) FROM tiles", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            3
        );
        drop(output);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_invalid_extents_and_does_not_include_adjacent_boundary_tiles() {
        assert_eq!(
            tile_window([-180., 0., 0., MAX_MERCATOR_LAT], 1),
            (0, 0, 0, 0)
        );
        assert!(validate(&MbtilesAreaOptions {
            bbox: [170., 0., -170., 10.],
            min_zoom: 0,
            max_zoom: 1
        })
        .is_err());
        assert!(validate(&MbtilesAreaOptions {
            bbox: [0., 0., 1., 1.],
            min_zoom: 3,
            max_zoom: 2
        })
        .is_err());
    }

    #[test]
    fn rejects_polar_extents_outside_the_tile_matrix_before_creating_output() {
        let source = source("tms");
        let (root, path) = destination();
        assert!(extract_mbtiles_area(
            &source,
            &path,
            MbtilesAreaOptions {
                bbox: [-123., 86., -122., 87.],
                min_zoom: 3,
                max_zoom: 3,
            },
            || false
        )
        .is_err());
        assert!(!path.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_oversized_tile_blobs_and_metadata_before_transferring_them() {
        let source = source("tms");
        let (root, path) = destination();
        source
            .execute(
                "UPDATE tiles SET tile_data=zeroblob(?1)",
                [MAX_TILE_BYTES as i64 + 1],
            )
            .unwrap();
        let options = MbtilesAreaOptions {
            bbox: [-123., 37., -122., 38.],
            min_zoom: 3,
            max_zoom: 3,
        };
        assert!(extract_mbtiles_area(&source, &path, options, || false)
            .unwrap_err()
            .contains("32 MiB"));
        std::fs::remove_file(&path).unwrap();
        source
            .execute(
                "INSERT INTO metadata VALUES ('json',zeroblob(?1))",
                [MAX_METADATA_BYTES as i64 + 1],
            )
            .unwrap();
        assert!(extract_mbtiles_area(&source, &path, options, || false)
            .unwrap_err()
            .contains("metadata value"));
        assert!(!path.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn source_is_read_only_and_interrupts_sql_before_any_result_row() {
        let (root, path) = destination();
        let writer = Connection::open(&path).unwrap();
        writer.execute_batch("CREATE TABLE metadata(name TEXT,value TEXT); INSERT INTO metadata VALUES ('name','Original');").unwrap();
        drop(writer);
        let cancelled = Arc::new(AtomicBool::new(false));
        let source = open_mbtiles_source(&path, cancelled.clone()).unwrap();
        assert!(source.execute("DELETE FROM metadata", []).is_err());
        let cancel = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(20));
            cancelled.store(true, Ordering::Relaxed);
        });
        let start = std::time::Instant::now();
        let error = source.query_row("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n", [], |row| row.get::<_, i64>(0)).unwrap_err();
        cancel.join().unwrap();
        assert_eq!(
            error.sqlite_error_code(),
            Some(rusqlite::ErrorCode::OperationInterrupted)
        );
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
        drop(source);
        let source = Connection::open(&path).unwrap();
        assert_eq!(
            source
                .query_row("SELECT value FROM metadata", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "Original"
        );
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_changed_or_missing_vector_schema_before_styled_extraction() {
        let layers = |names: &[&str]| {
            names
                .iter()
                .map(|name| name.to_string())
                .collect::<Vec<_>>()
        };
        assert!(validate_source_style("vector", &layers(&["earth", "water"]), true).is_ok());
        assert!(validate_source_style("vector", &layers(&["roads", "places"]), true).is_err());
        assert!(validate_source_style("vector", &layers(&["counties"]), false).is_ok());
        assert!(validate_source_style("vector", &[], false).is_err());
        assert!(validate_source_style("raster", &[], false).is_ok());
        assert!(validate_source_style("raster", &[], true).is_err());
    }

    #[test]
    fn sparse_extraction_uses_copied_tile_center_and_removes_false_bounds_and_layer_zooms() {
        let source = source("tms");
        source.execute("INSERT INTO metadata VALUES ('json',?1)", [
            r#"{"vector_layers":[{"id":"roads","fields":{"kind":"String"},"minzoom":0,"maxzoom":20}]}"#
        ]).unwrap();
        let (_root, path) = destination();
        let result = extract_mbtiles_area(
            &source,
            &path,
            MbtilesAreaOptions {
                bbox: [-180., -85., 180., 85.],
                min_zoom: 2,
                max_zoom: 3,
            },
            || false,
        )
        .unwrap();
        let center = result.view_center.unwrap();
        assert_eq!(center[2], 2.);
        let (left, right, top, bottom) = tile_window(
            [
                center[0] - 1e-8,
                center[1] - 1e-8,
                center[0] + 1e-8,
                center[1] + 1e-8,
            ],
            2,
        );
        assert_eq!((left, right, top, bottom), (0, 0, 1, 1));
        let output = Connection::open(&path).unwrap();
        let metadata = source_metadata(&output).unwrap();
        assert!(!metadata.contains_key("bounds"));
        assert_eq!(
            metadata["center"],
            center.map(|value| value.to_string()).join(",")
        );
        let json: serde_json::Value = serde_json::from_str(&metadata["json"]).unwrap();
        assert_eq!(
            json["vector_layers"][0],
            serde_json::json!({"id":"roads","fields":{"kind":"String"}})
        );
    }

    #[test]
    fn rejects_declared_non_protomaps_classification_but_allows_geometry_only_layers() {
        let fields = vector_source_layer_fields(Some(
            r#"{"vector_layers":[{"id":"water","fields":{}},{"id":"roads","fields":{"category":"String"}}]}"#,
        ));
        assert!(validate_source_fields(&fields).is_err());
        let compatible = vector_source_layer_fields(Some(
            r#"{"vector_layers":[{"id":"water","fields":{}},{"id":"roads","fields":{"kind":"String"}}]}"#,
        ));
        assert!(validate_source_fields(&compatible).is_ok());
        assert!(validate_source_fields(&BTreeMap::new()).is_ok());
    }

    #[test]
    fn sparse_default_view_prefers_an_interior_tile_over_the_first_edge_tile() {
        let source = source("tms");
        for x in [2, 3] {
            source
                .execute(
                    "INSERT INTO tiles VALUES (3,?1,4,?2)",
                    params![x, b"interior".to_vec()],
                )
                .unwrap();
        }
        let (_root, path) = destination();
        let result = extract_mbtiles_area(
            &source,
            &path,
            MbtilesAreaOptions {
                bbox: [-180., -85., 180., 85.],
                min_zoom: 3,
                max_zoom: 3,
            },
            || false,
        )
        .unwrap();
        let [longitude, latitude, zoom] = result.view_center.unwrap();
        let (left, right, top, bottom) = tile_window(
            [
                longitude - 1e-8,
                latitude - 1e-8,
                longitude + 1e-8,
                latitude + 1e-8,
            ],
            3,
        );
        assert_eq!(zoom, 3.);
        assert_eq!((left, right, top, bottom), (1, 1, 3, 3));
    }

    #[test]
    fn rejects_duplicate_metadata_keys_including_case_folded_collisions() {
        for keys in [["json", "json"], ["JSON", "json"]] {
            let source = Connection::open_in_memory().unwrap();
            source
                .execute_batch("CREATE TABLE metadata(name TEXT,value TEXT)")
                .unwrap();
            for key in keys {
                source
                    .execute("INSERT INTO metadata VALUES (?1,'{}')", [key])
                    .unwrap();
            }
            assert!(source_metadata(&source)
                .unwrap_err()
                .contains("duplicate keys"));
        }
    }

    #[test]
    fn rejects_utf8_metadata_by_bytes_before_transferring_strings() {
        for (key, value, error) in [
            (
                "name".to_string(),
                "🗺".repeat(MAX_METADATA_BYTES / 4 + 1),
                "metadata value is too large",
            ),
            (
                "🗺".repeat(257),
                "small".to_string(),
                "metadata key is too large",
            ),
        ] {
            let source = Connection::open_in_memory().unwrap();
            source
                .execute_batch("CREATE TABLE metadata(name TEXT,value TEXT)")
                .unwrap();
            source
                .execute("INSERT INTO metadata VALUES (?1,?2)", params![key, value])
                .unwrap();
            assert!(source_metadata(&source).unwrap_err().contains(error));
        }
    }
}
