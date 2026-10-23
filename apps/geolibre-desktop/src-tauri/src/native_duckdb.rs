use chrono::{Duration, NaiveDate, NaiveTime, SecondsFormat, TimeZone, Utc};
use duckdb::{
    types::{TimeUnit, Value, ValueRef},
    Connection, Row,
};
use serde_json::{json, Map};
use std::path::Path;

const GEOMETRY_JSON_COLUMN: &str = "__geolibre_geometry_geojson";
const FEATURE_COUNT_COLUMN: &str = "__geolibre_feature_count";
const TARGET_CRS: &str = "EPSG:4326";
const WKB_GEOMETRY_COLUMN_NAMES: [&str; 6] = [
    "geometry",
    "geom",
    "wkb_geometry",
    "geometry_wkb",
    "geom_wkb",
    "wkb",
];
// Column names a longitude / latitude pair is recognised under when a Parquet
// file carries no geometry column at all. Mirrors `LONGITUDE_COLUMN_NAMES` /
// `LATITUDE_COLUMN_NAMES` in `duckdb-geometry.ts`.
const LONGITUDE_COLUMN_NAMES: [&str; 5] = ["lon", "longitude", "long", "lng", "x"];
const LATITUDE_COLUMN_NAMES: [&str; 3] = ["lat", "latitude", "y"];
// The column name reported for a geometry no column actually holds, so the
// lon/lat columns stay readable as properties and nothing references it in SQL.
const SYNTHESIZED_GEOMETRY_COLUMN: &str = "__geolibre_synthesized_geometry";
// OGC's geographic CRS identifiers, which name lon/lat axis order on a datum an
// EPSG code also names. PROJ resolves the EPSG spellings far more reliably, so
// they are what `ST_Transform` is handed.
const OGC_CRS_EPSG_CODES: [(&str, u64); 4] = [
    ("CRS84", 4326),
    ("84", 4326),
    ("CRS83", 4269),
    ("CRS27", 4267),
];

#[derive(Clone, Debug)]
struct NativeVectorOptions {
    path: String,
    extension: String,
    layer: Option<String>,
    override_source_crs: Option<String>,
}

#[derive(Debug)]
struct DetectedGeometry {
    column: String,
    is_wkb: bool,
    is_base64_wkb: bool,
    requires_base64_wkb_validation: bool,
    base64_wkb_candidates: Vec<String>,
    /// Set when there is no geometry column and points are synthesized from a
    /// longitude/latitude column pair; `column` is then
    /// [`SYNTHESIZED_GEOMETRY_COLUMN`], which no source column can be named.
    coordinate_columns: Option<CoordinateColumns>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CoordinateColumns {
    x: String,
    y: String,
}

#[derive(Debug)]
struct DescribedColumn {
    name: String,
    column_type: String,
}

#[tauri::command]
pub async fn count_native_vector_file_features(
    path: String,
    layer: Option<String>,
) -> Result<usize, String> {
    let options = native_options(path, layer, None)?;
    tauri::async_runtime::spawn_blocking(move || {
        count_native_vector_file_features_blocking(options)
    })
    .await
    .map_err(|error| format!("Native DuckDB count task failed: {error}"))?
}

#[tauri::command]
pub async fn load_native_vector_file(
    path: String,
    layer: Option<String>,
    override_source_crs: Option<String>,
) -> Result<serde_json::Value, String> {
    let options = native_options(path, layer, override_source_crs)?;
    tauri::async_runtime::spawn_blocking(move || load_native_vector_file_blocking(options))
        .await
        .map_err(|error| format!("Native DuckDB load task failed: {error}"))?
}

fn native_options(
    path: String,
    layer: Option<String>,
    override_source_crs: Option<String>,
) -> Result<NativeVectorOptions, String> {
    if !crate::is_allowed_local_vector_path(&path) {
        return Err(format!(
            "Refusing to read \"{path}\": not an absolute local vector file path"
        ));
    }
    if has_duckdb_glob_metacharacter(&path) {
        return Err(format!(
            "Refusing to read \"{path}\": glob paths are not allowed"
        ));
    }
    Ok(NativeVectorOptions {
        extension: vector_extension(&path),
        path,
        layer: blank_to_none(layer),
        override_source_crs: blank_to_none(override_source_crs),
    })
}

fn blank_to_none(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn vector_extension(path: &str) -> String {
    let name = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_ascii_lowercase();
    if name.ends_with(".geoparquet") {
        "geoparquet".to_string()
    } else {
        Path::new(&name)
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("")
            .to_string()
    }
}

fn has_duckdb_glob_metacharacter(path: &str) -> bool {
    path.contains('*')
        || path.contains('?')
        || (has_duckdb_bracket_glob(path) && !Path::new(path).is_file())
}

fn has_duckdb_bracket_glob(path: &str) -> bool {
    let bytes = path.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'[' {
            continue;
        }
        if bytes[index + 1..]
            .iter()
            .position(|candidate| *candidate == b']')
            .is_some_and(|closing_index| closing_index > 0)
        {
            return true;
        }
    }
    false
}

fn count_native_vector_file_features_blocking(
    options: NativeVectorOptions,
) -> Result<usize, String> {
    let conn = open_native_duckdb()?;
    let sql = source_sql(&options);
    let count_sql = format!(
        "SELECT count(*) AS {} FROM ({sql}) AS data",
        quote_identifier(FEATURE_COUNT_COLUMN)
    );
    conn.query_row(&count_sql, [], |row| row.get::<_, i64>(0))
        .map(|count| count.max(0) as usize)
        .map_err(|error| format!("Could not count vector features with native DuckDB: {error}"))
}

fn load_native_vector_file_blocking(
    options: NativeVectorOptions,
) -> Result<serde_json::Value, String> {
    let conn = open_native_duckdb()?;
    let sql = source_sql(&options);
    let columns = describe_source_columns(&conn, &sql)?;
    // A GeoParquet's own `geo` block names the geometry column, which beats
    // guessing from column names when a file carries several binary columns.
    // The document is read once here and reused for the CRS below.
    let is_parquet = is_parquet_extension(&options.extension);
    let geo_metadata = if is_parquet {
        read_geoparquet_metadata_json(&conn, &options.path)
            .as_deref()
            .and_then(parse_geoparquet_metadata)
    } else {
        None
    };
    let detected = detect_geometry_column(
        &conn,
        &sql,
        &columns,
        geo_metadata
            .as_ref()
            .and_then(|metadata| metadata.primary_column.as_deref()),
        // A Parquet table of lon/lat columns with no geometry at all is a very
        // common publishing shape; every other format either carries geometry
        // or has its own importer.
        is_parquet,
    )?;
    let property_columns: Vec<String> = columns
        .iter()
        .filter(|column| column.name != detected.column)
        // A *second* geometry column is not an attribute, and the DuckDB client
        // has no reader for the spatial extension's type: selecting one fails
        // the whole query rather than yielding a value. Drop it the way binary
        // values are dropped in `row_to_feature`. This is the ordinary shape of
        // a file that declares a `primary_column`, so it must load.
        .filter(|column| {
            !column
                .column_type
                .to_ascii_uppercase()
                .starts_with("GEOMETRY")
        })
        .map(|column| column.name.clone())
        .collect();
    let source_crs = match options.override_source_crs.clone() {
        Some(crs) => Some(crs),
        None => read_source_crs(&conn, &options, geo_metadata.as_ref(), &detected.column),
    };
    let geometry_json_sql = geometry_geojson_sql(&geometry_expr(&detected), source_crs.as_deref());
    let mut select_columns: Vec<String> = property_columns
        .iter()
        .map(|column| quote_identifier(column))
        .collect();
    select_columns.push(format!(
        "{geometry_json_sql} AS {}",
        quote_identifier(GEOMETRY_JSON_COLUMN)
    ));
    let load_sql = format!("SELECT {} FROM ({sql}) AS data", select_columns.join(", "));

    let mut stmt = conn
        .prepare(&load_sql)
        .map_err(|error| format!("Could not prepare native DuckDB vector query: {error}"))?;
    let mut column_names = property_columns;
    column_names.push(GEOMETRY_JSON_COLUMN.to_string());
    let mut rows = stmt
        .query([])
        .map_err(|error| format!("Could not read vector rows with native DuckDB: {error}"))?;
    let mut features = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("Could not read vector row with native DuckDB: {error}"))?
    {
        features.push(row_to_feature(row, &column_names)?);
    }
    Ok(json!({
        "type": "FeatureCollection",
        "features": features,
    }))
}

fn open_native_duckdb() -> Result<Connection, String> {
    let conn = Connection::open_in_memory()
        .map_err(|error| format!("Could not open native DuckDB: {error}"))?;
    ensure_spatial_extension(&conn)?;
    Ok(conn)
}

fn ensure_spatial_extension(conn: &Connection) -> Result<(), String> {
    if let Some(path) = trusted_spatial_extension_path()? {
        conn.execute_batch(&format!(
            "LOAD {}",
            quote_sql_string(&path.replace('\\', "/"))
        ))
        .map_err(|error| {
            format!("Could not load DuckDB spatial extension from \"{path}\": {error}")
        })?;
        return Ok(());
    }

    conn.execute_batch("LOAD spatial;")
        .map_err(|error| format!("Could not load DuckDB spatial extension: {error}"))
}

fn trusted_spatial_extension_path() -> Result<Option<String>, String> {
    let Some(path) = blank_to_none(std::env::var("GEOLIBRE_DUCKDB_SPATIAL_EXTENSION_PATH").ok())
    else {
        return Ok(None);
    };
    let canonical = Path::new(&path)
        .canonicalize()
        .map_err(|error| format!("Could not resolve DuckDB spatial extension path: {error}"))?;
    if !canonical.is_file() {
        return Err(format!(
            "DuckDB spatial extension path is not a file: {}",
            canonical.display()
        ));
    }
    canonical
        .to_str()
        .map(|path| Some(path.to_string()))
        .ok_or_else(|| "DuckDB spatial extension path was not valid UTF-8".to_string())
}

fn is_parquet_extension(extension: &str) -> bool {
    extension == "parquet" || extension == "geoparquet"
}

fn source_sql(options: &NativeVectorOptions) -> String {
    let quoted_path = quote_sql_string(&options.path.replace('\\', "/"));
    if is_parquet_extension(&options.extension) {
        return format!("SELECT * FROM read_parquet({quoted_path})");
    }
    let layer_arg = options
        .layer
        .as_ref()
        .map(|layer| format!(", layer={}", quote_sql_string(layer)))
        .unwrap_or_default();
    format!("SELECT * FROM ST_Read({quoted_path}{layer_arg})")
}

fn describe_source_columns(conn: &Connection, sql: &str) -> Result<Vec<DescribedColumn>, String> {
    let describe_sql = format!("DESCRIBE {sql}");
    let mut stmt = conn
        .prepare(&describe_sql)
        .map_err(|error| format!("Could not describe vector source with native DuckDB: {error}"))?;
    let mut rows = stmt
        .query([])
        .map_err(|error| format!("Could not inspect vector columns with native DuckDB: {error}"))?;
    let mut columns = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("Could not read vector column description: {error}"))?
    {
        let column_name: String = row
            .get(0)
            .map_err(|error| format!("Could not read described column name: {error}"))?;
        let column_type: String = row
            .get(1)
            .map_err(|error| format!("Could not read described column type: {error}"))?;
        columns.push(DescribedColumn {
            name: column_name,
            column_type,
        });
    }
    Ok(columns)
}

fn detect_geometry_column(
    conn: &Connection,
    source_sql: &str,
    columns: &[DescribedColumn],
    primary_column: Option<&str>,
    allow_coordinate_columns: bool,
) -> Result<DetectedGeometry, String> {
    let detected =
        detect_geometry_column_from_schema(columns, primary_column, allow_coordinate_columns)?;
    if !detected.requires_base64_wkb_validation {
        return Ok(detected);
    }
    for column in &detected.base64_wkb_candidates {
        if has_valid_base64_wkb_values(conn, source_sql, column)? {
            return Ok(DetectedGeometry {
                column: column.clone(),
                is_wkb: detected.is_wkb,
                is_base64_wkb: detected.is_base64_wkb,
                requires_base64_wkb_validation: false,
                base64_wkb_candidates: Vec::new(),
                coordinate_columns: None,
            });
        }
    }
    Err("DuckDB did not find a geometry column in this file.".to_string())
}

/// Find the geometry column in a `DESCRIBE` result, best evidence first:
///
/// 1. the column a GeoParquet `geo` block names as `primary_column`;
/// 2. a native GEOMETRY-typed column;
/// 3. a well-known WKB blob column name, then a base64 WKB string one;
/// 4. with `allow_coordinate_columns`, and only in a file carrying no GEOMETRY
///    and no binary column at all, a longitude/latitude pair of float columns.
///
/// Mirrors `detectGeometryColumn` in `duckdb-geometry.ts`; the two must agree,
/// because the desktop app tries this loader first and falls back to the
/// DuckDB-WASM one only on error.
fn detect_geometry_column_from_schema(
    columns: &[DescribedColumn],
    primary_column: Option<&str>,
    allow_coordinate_columns: bool,
) -> Result<DetectedGeometry, String> {
    if let Some(detected) = detect_declared_column(columns, primary_column) {
        return Ok(detected);
    }
    let mut wkb_candidate: Option<(usize, String)> = None;
    let mut base64_wkb_candidates: Vec<(usize, String)> = Vec::new();
    for column in columns {
        if column
            .column_type
            .to_ascii_uppercase()
            .starts_with("GEOMETRY")
        {
            return Ok(DetectedGeometry {
                column: column.name.clone(),
                is_wkb: false,
                is_base64_wkb: false,
                requires_base64_wkb_validation: false,
                base64_wkb_candidates: Vec::new(),
                coordinate_columns: None,
            });
        }
        let lower_name = column.name.to_ascii_lowercase();
        let upper_type = column.column_type.to_ascii_uppercase();
        if !WKB_GEOMETRY_COLUMN_NAMES.contains(&lower_name.as_str()) {
            continue;
        }
        let rank = WKB_GEOMETRY_COLUMN_NAMES
            .iter()
            .position(|candidate| *candidate == lower_name.as_str())
            .unwrap_or(WKB_GEOMETRY_COLUMN_NAMES.len());
        if is_binary_column_type(&upper_type) {
            if wkb_candidate
                .as_ref()
                .map(|(current_rank, _)| rank < *current_rank)
                .unwrap_or(true)
            {
                wkb_candidate = Some((rank, column.name.clone()));
            }
        } else if upper_type.starts_with("VARCHAR")
            || upper_type.starts_with("TEXT")
            || upper_type.starts_with("STRING")
        {
            base64_wkb_candidates.push((rank, column.name.clone()));
        }
    }

    if let Some((_, column)) = wkb_candidate {
        return Ok(DetectedGeometry {
            column,
            is_wkb: true,
            is_base64_wkb: false,
            requires_base64_wkb_validation: false,
            base64_wkb_candidates: Vec::new(),
            coordinate_columns: None,
        });
    }
    base64_wkb_candidates.sort_by_key(|(rank, _)| *rank);
    if let Some((_, column)) = base64_wkb_candidates.first() {
        return Ok(DetectedGeometry {
            column: column.clone(),
            is_wkb: true,
            is_base64_wkb: true,
            requires_base64_wkb_validation: true,
            base64_wkb_candidates: base64_wkb_candidates
                .into_iter()
                .map(|(_, column)| column)
                .collect(),
            coordinate_columns: None,
        });
    }

    // Only a schema holding nothing that could itself be geometry may fall back
    // to a coordinate pair. A WKB blob under a name this module does not know is
    // still geometry, and promoting an unrelated `x`/`y` pair beside it would
    // draw a layer of bogus points instead of reporting the column was not read.
    if allow_coordinate_columns && !has_geometry_candidate_column(columns) {
        if let Some(pair) = detect_coordinate_columns(columns) {
            return Ok(DetectedGeometry {
                column: SYNTHESIZED_GEOMETRY_COLUMN.to_string(),
                is_wkb: false,
                is_base64_wkb: false,
                requires_base64_wkb_validation: false,
                base64_wkb_candidates: Vec::new(),
                coordinate_columns: Some(pair),
            });
        }
    }

    Err("DuckDB did not find a geometry column in this file.".to_string())
}

/// Read the column a GeoParquet `geo` block declares as primary, classified by
/// how DuckDB typed it. A declared column DuckDB typed as something no geometry
/// reader accepts returns `None` so detection falls through to the name-based
/// candidates rather than failing the whole file on a metadata document that
/// disagrees with the schema.
fn detect_declared_column(
    columns: &[DescribedColumn],
    primary_column: Option<&str>,
) -> Option<DetectedGeometry> {
    let primary_column = primary_column?;
    let column = columns
        .iter()
        .find(|column| column.name == primary_column)?;
    let upper_type = column.column_type.to_ascii_uppercase();
    if upper_type.starts_with("GEOMETRY") {
        return Some(DetectedGeometry {
            column: primary_column.to_string(),
            is_wkb: false,
            is_base64_wkb: false,
            requires_base64_wkb_validation: false,
            base64_wkb_candidates: Vec::new(),
            coordinate_columns: None,
        });
    }
    if is_binary_column_type(&upper_type) {
        return Some(DetectedGeometry {
            column: primary_column.to_string(),
            is_wkb: true,
            is_base64_wkb: false,
            requires_base64_wkb_validation: false,
            base64_wkb_candidates: Vec::new(),
            coordinate_columns: None,
        });
    }
    if upper_type.starts_with("VARCHAR")
        || upper_type.starts_with("TEXT")
        || upper_type.starts_with("STRING")
    {
        // Still value-probed: a declared column is strong evidence of intent,
        // not proof that its strings decode as base64 WKB.
        return Some(DetectedGeometry {
            column: primary_column.to_string(),
            is_wkb: true,
            is_base64_wkb: true,
            requires_base64_wkb_validation: true,
            base64_wkb_candidates: vec![primary_column.to_string()],
            coordinate_columns: None,
        });
    }
    None
}

/// The DuckDB column types a WKB blob arrives as.
fn is_binary_column_type(upper_type: &str) -> bool {
    upper_type.starts_with("BLOB")
        || upper_type.starts_with("BINARY")
        || upper_type.starts_with("VARBINARY")
}

/// True when the schema holds a column that could itself be the geometry: a
/// native GEOMETRY type, or a binary column under *any* name.
fn has_geometry_candidate_column(columns: &[DescribedColumn]) -> bool {
    columns.iter().any(|column| {
        let upper_type = column.column_type.to_ascii_uppercase();
        upper_type.starts_with("GEOMETRY") || is_binary_column_type(&upper_type)
    })
}

/// A longitude/latitude pair of float columns, matched case-insensitively. The
/// two must be different columns: a single column cannot be both halves of a
/// point. An integer or string "lat" column is an identifier or a formatted
/// value far more often than it is a coordinate, so only the floating-point
/// types are accepted.
fn detect_coordinate_columns(columns: &[DescribedColumn]) -> Option<CoordinateColumns> {
    let find = |names: &[&str]| {
        columns
            .iter()
            .find(|column| {
                names.contains(&column.name.to_ascii_lowercase().as_str())
                    && matches!(
                        column.column_type.to_ascii_uppercase().as_str(),
                        "DOUBLE" | "FLOAT" | "REAL"
                    )
            })
            .map(|column| column.name.clone())
    };
    let x = find(&LONGITUDE_COLUMN_NAMES)?;
    let y = find(&LATITUDE_COLUMN_NAMES)?;
    if x == y {
        return None;
    }
    Some(CoordinateColumns { x, y })
}

fn has_valid_base64_wkb_values(
    conn: &Connection,
    source_sql: &str,
    column: &str,
) -> Result<bool, String> {
    let column_sql = quote_identifier(column);
    let sample_column = quote_identifier("__geolibre_base64_wkb_sample");
    let probe_sql = format!(
        "SELECT count(*) AS sample_count, \
         count(TRY(ST_GeomFromWKB(from_base64({sample_column})))) AS valid_count \
         FROM (SELECT {column_sql} AS {sample_column} FROM ({source_sql}) AS data \
         WHERE {column_sql} IS NOT NULL LIMIT 20) AS sample"
    );
    let (sample_count, valid_count): (i64, i64) = conn
        .query_row(&probe_sql, [], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|error| format!("Could not validate base64 WKB geometry values: {error}"))?;
    // Require every sampled non-null value to decode as WKB so a user attribute
    // named "geometry" or "wkb" is not promoted based on a partial match.
    Ok(sample_count > 0 && sample_count == valid_count)
}

fn read_source_crs(
    conn: &Connection,
    options: &NativeVectorOptions,
    geo_metadata: Option<&GeoParquetMetadata>,
    geometry_column: &str,
) -> Option<String> {
    if is_parquet_extension(&options.extension) {
        return read_parquet_source_crs(conn, options, geo_metadata, geometry_column);
    }
    let meta_sql = format!(
        "SELECT layers[1].geometry_fields[1].crs.auth_name AS auth_name, \
         layers[1].geometry_fields[1].crs.auth_code AS auth_code \
         FROM ST_Read_Meta({})",
        quote_sql_string(&options.path.replace('\\', "/"))
    );
    let auth_crs = conn
        .query_row(&meta_sql, [], |row| {
            let auth_name: Option<String> = row.get(0)?;
            let auth_code: Option<String> = row.get(1)?;
            Ok((auth_name, auth_code))
        })
        .ok()
        .and_then(|(auth_name, auth_code)| {
            let auth_name = auth_name?.trim().to_ascii_uppercase();
            let auth_code = auth_code?.trim().to_string();
            if auth_name.is_empty() || auth_code.is_empty() {
                None
            } else {
                Some(format!("{auth_name}:{auth_code}"))
            }
        });
    if auth_crs.is_some() {
        return auth_crs;
    }
    // ST_Read_Meta resolved no EPSG authority code (e.g. a custom ESRI `.prj`
    // without an AUTHORITY tag). Fall back to the shapefile's `.prj` sidecar
    // WKT, which ST_Transform accepts, mirroring the DuckDB-WASM loader so a
    // projected shapefile still reprojects instead of loading in source
    // coordinates (issue #1148).
    if options.extension == "shp" {
        return read_prj_sidecar_crs(&options.path);
    }
    None
}

/// The WKT text of a shapefile's `.prj` sidecar, or `None` when it is absent or
/// empty. Used as the CRS fallback when `ST_Read_Meta` reports no authority code.
fn read_prj_sidecar_crs(shp_path: &str) -> Option<String> {
    let path = Path::new(shp_path);
    // Fast path: the sidecar usually shares the `.shp`'s exact base name with a
    // `.prj` or `.PRJ` extension.
    for extension in ["prj", "PRJ"] {
        if let Some(crs) = read_nonempty_trimmed(&path.with_extension(extension)) {
            return Some(crs);
        }
    }
    // Fallback for mixed-case naming (e.g. `Foo.Prj`, or a `Foo.shp` whose
    // sidecar is `foo.PRJ`) on a case-sensitive filesystem: scan the directory
    // for a file whose stem and `prj` extension both match case-insensitively.
    let stem = path.file_stem()?.to_str()?;
    let dir = path.parent()?;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let entry_path = entry.path();
        let stem_matches = entry_path
            .file_stem()
            .and_then(|entry_stem| entry_stem.to_str())
            .is_some_and(|entry_stem| entry_stem.eq_ignore_ascii_case(stem));
        let is_prj = entry_path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("prj"));
        if stem_matches && is_prj {
            if let Some(crs) = read_nonempty_trimmed(&entry_path) {
                return Some(crs);
            }
        }
    }
    None
}

/// The trimmed contents of a file, or `None` when it cannot be read or is empty.
fn read_nonempty_trimmed(path: &Path) -> Option<String> {
    // Decode lossily rather than with `read_to_string` so a `.prj` carrying a
    // stray non-UTF-8 byte still yields its WKT instead of silently reverting to
    // the pre-fix "no reprojection" behavior.
    let bytes = std::fs::read(path).ok()?;
    let trimmed = String::from_utf8_lossy(&bytes).trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// A geometry column's declared CRS, in the states the GeoParquet specification
/// distinguishes. Mirrors `GeoParquetCrs` in `geoparquet-metadata.ts`.
///
/// The distinction that matters is between an **absent** `crs` member and an
/// explicit `"crs": null`. The first is the specification default, OGC:CRS84.
/// The second declares that the coordinates are in no known CRS at all: the data
/// is still drawn as it stands, but nothing may claim an EPSG code for it.
#[derive(Clone, Debug, PartialEq, Eq)]
enum GeoParquetCrs {
    /// No `crs` member at all: the specification default, OGC:CRS84.
    Default,
    /// An explicit `"crs": null`, or a logical-type `srid:0`: no known CRS.
    Undefined,
    /// An authority-identified CRS from the PROJJSON `id` member.
    Authority {
        authority: String,
        code: String,
        /// The equivalent EPSG code, when there is one.
        epsg: Option<u64>,
    },
    /// Id-less PROJJSON: the document itself is the CRS's identity.
    Projjson(String),
    /// A pre-1.0 draft's raw CRS string (WKT2, or an `AUTHORITY:CODE` spelling).
    Raw(String),
    /// A logical-type CRS string in no recognised form.
    Unknown,
}

/// One entry of the `geo` document's `columns` map, reduced to what the loader
/// reads from it.
#[derive(Debug)]
struct GeoParquetColumnMetadata {
    name: String,
    crs: GeoParquetCrs,
}

/// A parsed `geo` file-metadata document.
#[derive(Debug)]
struct GeoParquetMetadata {
    primary_column: Option<String>,
    columns: Vec<GeoParquetColumnMetadata>,
}

/// The `geo` file-metadata document of a Parquet file as text, or `None` when it
/// carries none or the read fails.
///
/// The key is matched as a BLOB via `encode` rather than by decoding every key,
/// so a file carrying a non-UTF-8 metadata key cannot fail the whole read.
fn read_geoparquet_metadata_json(conn: &Connection, path: &str) -> Option<String> {
    let metadata_sql = format!(
        "SELECT decode(value) FROM parquet_kv_metadata({}) WHERE key = encode('geo') LIMIT 1",
        quote_sql_string(&path.replace('\\', "/"))
    );
    conn.query_row(&metadata_sql, [], |row| row.get(0)).ok()
}

/// The CRS a Parquet file declares, or `None` when it declares none, declares
/// WGS84, or the metadata cannot be read.
///
/// The `geo` block is authoritative when there is one. A Parquet 2.0 file may
/// carry no `geo` block at all and record its CRS only on the geometry column's
/// GEOMETRY/GEOGRAPHY logical type, so that is read as a fallback — without it
/// such a file in a projected CRS loads in raw metres and draws nothing, the
/// same failure issue #2086 reported for 1.0 files.
///
/// `geometry_column` is the column the loader detected, so a file carrying
/// several geometry columns in different CRSs resolves the one actually being
/// read rather than whichever the document calls primary.
fn read_parquet_source_crs(
    conn: &Connection,
    options: &NativeVectorOptions,
    geo_metadata: Option<&GeoParquetMetadata>,
    geometry_column: &str,
) -> Option<String> {
    if let Some(metadata) = geo_metadata {
        let crs = geoparquet_column(metadata, geometry_column)
            .map(|column| &column.crs)
            .unwrap_or(&GeoParquetCrs::Default);
        return transform_crs(crs);
    }
    let native = read_native_geometry_logical_type(conn, &options.path, geometry_column)?;
    transform_crs(&parse_logical_type_crs(native.as_deref()))
}

/// Parse the `geo` file-metadata document. Returns `None` when the text is not
/// JSON or describes no geometry column, both of which mean "not a GeoParquet",
/// not "a broken one" — the file must still load.
fn parse_geoparquet_metadata(metadata_json: &str) -> Option<GeoParquetMetadata> {
    let document: serde_json::Value = serde_json::from_str(metadata_json).ok()?;
    let columns: Vec<GeoParquetColumnMetadata> = document
        .get("columns")?
        .as_object()?
        .iter()
        .filter(|(_, column)| column.is_object())
        .map(|(name, column)| GeoParquetColumnMetadata {
            name: name.clone(),
            crs: parse_column_crs(column),
        })
        .collect();
    if columns.is_empty() {
        return None;
    }
    Some(GeoParquetMetadata {
        primary_column: document
            .get("primary_column")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        columns,
    })
}

/// The metadata entry for the geometry column being read: the named column when
/// the document describes it, else the one `primary_column` names, else the
/// first column listed.
///
/// The named column comes first because a GeoParquet may hold several geometry
/// columns in different CRSs; transforming the column the loader read with the
/// primary column's CRS would place the layer somewhere else entirely. (The
/// last-resort fallback follows `serde_json`'s own map order, which is
/// alphabetical rather than the document's; it only applies to a document whose
/// `primary_column` names no described column.)
fn geoparquet_column<'a>(
    metadata: &'a GeoParquetMetadata,
    geometry_column: &str,
) -> Option<&'a GeoParquetColumnMetadata> {
    for wanted in [Some(geometry_column), metadata.primary_column.as_deref()]
        .into_iter()
        .flatten()
    {
        if let Some(found) = metadata.columns.iter().find(|column| column.name == wanted) {
            return Some(found);
        }
    }
    metadata.columns.first()
}

/// The `crs` member of one column entry, in its three specified states.
fn parse_column_crs(column: &serde_json::Value) -> GeoParquetCrs {
    match column.get("crs") {
        None => GeoParquetCrs::Default,
        Some(serde_json::Value::Null) => GeoParquetCrs::Undefined,
        Some(crs) => parse_crs_value(crs),
    }
}

/// A non-null `crs` value: PROJJSON, or a pre-1.0 draft's raw string.
fn parse_crs_value(crs: &serde_json::Value) -> GeoParquetCrs {
    match crs {
        serde_json::Value::String(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                GeoParquetCrs::Undefined
            } else {
                GeoParquetCrs::Raw(trimmed.to_string())
            }
        }
        serde_json::Value::Object(_) => match projjson_id(crs) {
            Some((authority, code)) => {
                if authority == "OGC" {
                    let upper_code = code.to_ascii_uppercase();
                    if let Some((_, mapped)) = OGC_CRS_EPSG_CODES
                        .iter()
                        .find(|(name, _)| *name == upper_code)
                    {
                        return GeoParquetCrs::Authority {
                            authority: "EPSG".to_string(),
                            code: mapped.to_string(),
                            epsg: Some(*mapped),
                        };
                    }
                }
                let epsg = if authority == "EPSG" {
                    code.parse::<u64>().ok()
                } else {
                    None
                };
                GeoParquetCrs::Authority {
                    authority,
                    code,
                    epsg,
                }
            }
            // Id-less PROJJSON (a custom projection, or a geographic CRS on a
            // datum with no authority code) is identified by the document
            // itself: PROJ parses PROJJSON wherever it parses WKT.
            None => GeoParquetCrs::Projjson(crs.to_string()),
        },
        _ => GeoParquetCrs::Undefined,
    }
}

/// The PROJJSON `id` member as an upper-cased authority and a textual code.
fn projjson_id(document: &serde_json::Value) -> Option<(String, String)> {
    let id = document.get("id")?;
    let authority = id.get("authority")?.as_str()?.trim().to_ascii_uppercase();
    // PROJJSON allows the code as a number or a string; both spellings are seen
    // in the wild for the same CRS.
    let code = match id.get("code")? {
        serde_json::Value::String(value) => value.trim().to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        _ => return None,
    };
    if authority.is_empty() || code.is_empty() {
        None
    } else {
        Some((authority, code))
    }
}

/// The free-form CRS string of the geometry column's Parquet 2.0
/// GEOMETRY/GEOGRAPHY logical type, or `None` when the file has no such column.
///
/// `parquet_schema` reports each schema element's own name rather than its
/// dotted path, so this resolves top-level geometry columns — the only place the
/// Parquet geospatial logical types are used in practice.
fn read_native_geometry_logical_type(
    conn: &Connection,
    path: &str,
    geometry_column: &str,
) -> Option<Option<String>> {
    let schema_sql = format!(
        "SELECT name, logical_type FROM parquet_schema({}) WHERE logical_type IS NOT NULL",
        quote_sql_string(&path.replace('\\', "/"))
    );
    // `parquet_schema` is available in every DuckDB build the app ships, but a
    // file it cannot parse must still load through the CRS84 assumption.
    let mut stmt = conn.prepare(&schema_sql).ok()?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .ok()?;
    let mut first: Option<Option<String>> = None;
    for row in rows.flatten() {
        let (name, logical_type) = row;
        let Some(crs) = parse_native_geometry_logical_type(&logical_type) else {
            continue;
        };
        if name == geometry_column {
            return Some(crs);
        }
        if first.is_none() {
            first = Some(crs);
        }
    }
    first
}

/// Parse the Parquet logical type DuckDB's `parquet_schema()` prints for a
/// geospatial column into its CRS string, or `None` for any other logical type.
///
/// DuckDB 1.5.4 renders these as `GeometryType(crs=<null>)` and
/// `GeographyType(crs=..., algorithm=...)`, with `<null>` standing for an absent
/// CRS. The rendering is not part of any specification, so the match is kept
/// deliberately loose: the type name decides, and a CRS that cannot be read
/// still leaves a usable "this column is native geospatial" answer (an outer
/// `Some` holding an inner `None`). Mirrors `parseNativeGeometryLogicalType`.
fn parse_native_geometry_logical_type(logical_type: &str) -> Option<Option<String>> {
    let trimmed = logical_type.trim();
    if !trimmed.ends_with(')') {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    let open = ["geometrytype(", "geographytype("]
        .iter()
        .find(|prefix| lower.starts_with(**prefix))
        .map(|prefix| prefix.len())?;
    Some(logical_type_crs_argument(&trimmed[open..trimmed.len() - 1]))
}

/// The `crs=` argument of a rendered logical type, or `None` when it is absent
/// or printed as `<null>`. The value runs to the next `name=` argument, so a
/// PROJJSON document (full of commas) is read whole.
fn logical_type_crs_argument(arguments: &str) -> Option<String> {
    // `to_ascii_lowercase` is byte-preserving, so indices into it are valid
    // indices into `arguments`.
    let lower = arguments.to_ascii_lowercase();
    let mut search = 0;
    let start = loop {
        let found = search + lower[search..].find("crs=")?;
        let preceding = arguments[..found].chars().next_back();
        if preceding.is_none_or(|character| {
            character == '(' || character == ',' || character.is_whitespace()
        }) {
            break found + "crs=".len();
        }
        search = found + "crs=".len();
    };
    let value = &arguments[start..];
    let end = next_argument_index(value).unwrap_or(value.len());
    let raw = value[..end].trim();
    if raw.is_empty() || raw == "<null>" {
        None
    } else {
        Some(raw.to_string())
    }
}

/// The index of the comma that starts the next `name=` argument, or `None` when
/// the rest of the string is all one value.
fn next_argument_index(value: &str) -> Option<usize> {
    let bytes = value.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b',' {
            continue;
        }
        let mut cursor = index + 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let name_start = cursor;
        while cursor < bytes.len() && (bytes[cursor].is_ascii_alphabetic() || bytes[cursor] == b'_')
        {
            cursor += 1;
        }
        if cursor > name_start && bytes.get(cursor) == Some(&b'=') {
            return Some(index);
        }
    }
    None
}

/// Parse the free-form CRS string a Parquet 2.0 GEOMETRY/GEOGRAPHY logical type
/// carries. The Parquet specification leaves it deliberately open, so writers
/// disagree: PROJJSON, a JSON-quoted string, `EPSG:nnnn`, the CRS84 spellings
/// and `srid:0` are all in circulation. Mirrors `parseLogicalTypeCrs`.
fn parse_logical_type_crs(crs: Option<&str>) -> GeoParquetCrs {
    // Absent means the Parquet default, which is OGC:CRS84 as in GeoParquet.
    let Some(crs) = crs else {
        return GeoParquetCrs::Default;
    };
    let trimmed = crs.trim();
    if trimmed.is_empty() {
        return GeoParquetCrs::Default;
    }
    let upper = trimmed.to_ascii_uppercase();
    if upper == "OGC:CRS84" || upper == "CRS84" || upper == "EPSG:4326" {
        return GeoParquetCrs::Default;
    }
    // `srid:0` is the "no SRID set" marker some writers emit, i.e. no known CRS.
    if upper == "SRID:0" {
        return GeoParquetCrs::Undefined;
    }
    if trimmed.starts_with('{') {
        if let Ok(document) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if document.is_object() {
                return parse_crs_value(&document);
            }
        }
    }
    if trimmed.starts_with('"') {
        // A JSON-quoted plain string: unwrap it and apply the same rules.
        if let Ok(inner) = serde_json::from_str::<String>(trimmed) {
            return parse_logical_type_crs(Some(&inner));
        }
    }
    if let Some(code) = upper.strip_prefix("EPSG:") {
        if !code.is_empty() && code.bytes().all(|byte| byte.is_ascii_digit()) {
            return GeoParquetCrs::Authority {
                authority: "EPSG".to_string(),
                code: code.to_string(),
                epsg: code.parse().ok(),
            };
        }
    }
    GeoParquetCrs::Unknown
}

/// The CRS to reproject from, or `None` when the data is already in GeoJSON's
/// coordinate convention — which covers the `Default` and `Undefined` states, an
/// identifier that is itself lon/lat, and an unparseable logical-type string.
/// Mirrors `geoParquetTransformCrs` over `geoParquetCrsIdentifier`.
fn transform_crs(crs: &GeoParquetCrs) -> Option<String> {
    let identifier = match crs {
        // The EPSG spelling when there is one: PROJ resolves it far more
        // reliably than OGC's or ESRI's own identifiers.
        GeoParquetCrs::Authority {
            authority,
            code,
            epsg,
        } => match epsg {
            Some(epsg) => format!("EPSG:{epsg}"),
            None => format!("{authority}:{code}"),
        },
        GeoParquetCrs::Projjson(document) => document.clone(),
        GeoParquetCrs::Raw(value) => value.clone(),
        GeoParquetCrs::Default | GeoParquetCrs::Undefined | GeoParquetCrs::Unknown => {
            return None;
        }
    };
    if is_geographic_crs(&identifier) {
        None
    } else {
        Some(identifier)
    }
}

/// True when `crs` denotes WGS84 longitude/latitude (or is blank), so the
/// coordinates need no reprojection. Mirrors `isGeographicCrs` in
/// `crs-utils.ts`, whitespace stripping included.
fn is_geographic_crs(crs: &str) -> bool {
    let value: String = crs
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>()
        .to_ascii_uppercase();
    if value.is_empty() {
        return true;
    }
    value.contains("CRS84") || contains_epsg_4326(&value)
}

/// True when an upper-cased, whitespace-stripped CRS names EPSG:4326, in either
/// the short (`EPSG:4326`) or URN (`EPSG::4326`) spelling, and not as the prefix
/// of a longer code.
fn contains_epsg_4326(value: &str) -> bool {
    let mut rest = value;
    while let Some(index) = rest.find("EPSG:") {
        let after = rest[index + "EPSG:".len()..].trim_start_matches(':');
        if let Some(tail) = after.strip_prefix("4326") {
            if !tail
                .chars()
                .next()
                .is_some_and(|character| character.is_alphanumeric() || character == '_')
            {
                return true;
            }
        }
        rest = &rest[index + "EPSG:".len()..];
    }
    false
}

fn geometry_expr(detected: &DetectedGeometry) -> String {
    assert!(
        !detected.requires_base64_wkb_validation,
        "base64 WKB geometry must be value-validated before SQL generation"
    );
    if let Some(pair) = &detected.coordinate_columns {
        return format!(
            "ST_Point({}, {})",
            quote_identifier(&pair.x),
            quote_identifier(&pair.y)
        );
    }
    let column = quote_identifier(&detected.column);
    if detected.is_wkb {
        let wkb = if detected.is_base64_wkb {
            format!("from_base64({column})")
        } else {
            column
        };
        format!("ST_GeomFromWKB({wkb})")
    } else {
        column
    }
}

fn geometry_geojson_sql(geometry_expression: &str, source_crs: Option<&str>) -> String {
    match source_crs {
        Some(source_crs) => format!(
            "ST_AsGeoJSON(ST_Transform({geometry_expression}, {}, {}, true))",
            quote_sql_string(source_crs),
            quote_sql_string(TARGET_CRS)
        ),
        None => format!("ST_AsGeoJSON({geometry_expression})"),
    }
}

fn row_to_feature(row: &Row<'_>, column_names: &[String]) -> Result<serde_json::Value, String> {
    let mut properties = Map::new();
    let mut geometry = serde_json::Value::Null;

    for (index, column_name) in column_names.iter().enumerate() {
        let value = row.get_ref(index).map_err(|error| {
            format!("Could not read native DuckDB column \"{column_name}\": {error}")
        })?;
        if column_name == GEOMETRY_JSON_COLUMN {
            geometry = match value {
                ValueRef::Null => serde_json::Value::Null,
                ValueRef::Text(bytes) => {
                    let text = std::str::from_utf8(bytes)
                        .map_err(|error| format!("Geometry GeoJSON was not UTF-8: {error}"))?;
                    serde_json::from_str(text)
                        .map_err(|error| format!("Geometry GeoJSON was invalid: {error}"))?
                }
                _ => serde_json::Value::Null,
            };
            continue;
        }
        if matches!(value, ValueRef::Blob(_)) {
            continue;
        }
        properties.insert(column_name.clone(), duckdb_value_to_json(&value.to_owned()));
    }

    Ok(json!({
        "type": "Feature",
        "geometry": geometry,
        "properties": properties,
    }))
}

fn duckdb_value_to_json(value: &Value) -> serde_json::Value {
    match value {
        Value::Null => serde_json::Value::Null,
        Value::Boolean(value) => json!(value),
        Value::TinyInt(value) => json_number_or_string_i128(*value as i128),
        Value::SmallInt(value) => json_number_or_string_i128(*value as i128),
        Value::Int(value) => json_number_or_string_i128(*value as i128),
        Value::BigInt(value) => json_number_or_string_i128(*value as i128),
        Value::HugeInt(value) => json_number_or_string_i128(*value),
        Value::UTinyInt(value) => json_number_or_string_u128(*value as u128),
        Value::USmallInt(value) => json_number_or_string_u128(*value as u128),
        Value::UInt(value) => json_number_or_string_u128(*value as u128),
        Value::UBigInt(value) => json_number_or_string_u128(*value as u128),
        Value::Float(value) => json!(value),
        Value::Double(value) => json!(value),
        Value::Decimal(value) => json!(value.to_string()),
        Value::Timestamp(unit, value) => json!(format_timestamp(*unit, *value)),
        Value::Text(value) => json!(value),
        Value::Blob(_) => serde_json::Value::Null,
        Value::Date32(value) => json!(format_date32(*value)),
        Value::Time64(unit, value) => json!(format_time(*unit, *value)),
        Value::Interval {
            months,
            days,
            nanos,
        } => json!(format!("{months} months {days} days {nanos} ns")),
        Value::List(values) | Value::Array(values) => {
            serde_json::Value::Array(values.iter().map(duckdb_value_to_json).collect())
        }
        Value::Enum(value) => json!(value),
        Value::Struct(values) => {
            let mut object = Map::new();
            for (key, value) in values.iter() {
                object.insert(key.clone(), duckdb_value_to_json(value));
            }
            serde_json::Value::Object(object)
        }
        Value::Map(values) => {
            let mut object = Map::new();
            for (key, value) in values.iter() {
                object.insert(value_json_key(key), duckdb_value_to_json(value));
            }
            serde_json::Value::Object(object)
        }
        Value::Union(value) => duckdb_value_to_json(value),
        // `Value` is #[non_exhaustive] as of duckdb 1.10505.0, so a variant
        // added by a future crate release lands here: a null property, like
        // Blob above, rather than a compile break or a failed feature read.
        _ => serde_json::Value::Null,
    }
}

fn json_number_or_string_i128(value: i128) -> serde_json::Value {
    const MIN_SAFE_INTEGER: i128 = -9_007_199_254_740_991;
    const MAX_SAFE_INTEGER: i128 = 9_007_199_254_740_991;
    if (MIN_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&value) {
        json!(value as i64)
    } else {
        json!(value.to_string())
    }
}

fn json_number_or_string_u128(value: u128) -> serde_json::Value {
    const MAX_SAFE_INTEGER: u128 = 9_007_199_254_740_991;
    if value <= MAX_SAFE_INTEGER {
        json!(value as u64)
    } else {
        json!(value.to_string())
    }
}

fn format_timestamp(unit: TimeUnit, value: i64) -> String {
    let micros = match unit {
        TimeUnit::Second => value.saturating_mul(1_000_000),
        TimeUnit::Millisecond => value.saturating_mul(1_000),
        TimeUnit::Microsecond => value,
        TimeUnit::Nanosecond => value / 1_000,
    };
    let seconds = micros.div_euclid(1_000_000);
    let nanos = (micros.rem_euclid(1_000_000) as u32).saturating_mul(1_000);
    Utc.timestamp_opt(seconds, nanos)
        .single()
        .map(|datetime| datetime.to_rfc3339_opts(SecondsFormat::Micros, true))
        .unwrap_or_else(|| format!("{micros}us since 1970-01-01T00:00:00Z"))
}

fn format_date32(value: i32) -> String {
    NaiveDate::from_ymd_opt(1970, 1, 1)
        .and_then(|epoch| epoch.checked_add_signed(Duration::days(value as i64)))
        .map(|date| date.to_string())
        .unwrap_or_else(|| value.to_string())
}

fn format_time(unit: TimeUnit, value: i64) -> String {
    let micros = match unit {
        TimeUnit::Second => value.saturating_mul(1_000_000),
        TimeUnit::Millisecond => value.saturating_mul(1_000),
        TimeUnit::Microsecond => value,
        TimeUnit::Nanosecond => value / 1_000,
    };
    let seconds = micros.div_euclid(1_000_000);
    let nanos = (micros.rem_euclid(1_000_000) as u32).saturating_mul(1_000);
    NaiveTime::from_num_seconds_from_midnight_opt(u32::try_from(seconds).unwrap_or(u32::MAX), nanos)
        .map(|time| time.format("%H:%M:%S%.6f").to_string())
        .unwrap_or_else(|| format!("{micros}us"))
}

fn value_json_key(value: &Value) -> String {
    match duckdb_value_to_json(value) {
        serde_json::Value::String(value) => value,
        other => other.to_string(),
    }
}

fn quote_sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Tests run in parallel and several write a fixture, so the clock alone is
    /// not a unique name: a counter keeps two of them off the same path.
    static TEMP_FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn temp_geoparquet_path() -> String {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before Unix epoch")
            .as_nanos();
        let sequence = TEMP_FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir()
            .join(format!(
                "geolibre-native-duckdb-{suffix}-{}-{sequence}.geoparquet",
                std::process::id()
            ))
            .to_string_lossy()
            .to_string()
    }

    fn create_real_geoparquet(path: &str) {
        let conn = Connection::open_in_memory().expect("open DuckDB");
        install_spatial_extension_for_tests(&conn).expect("load spatial");
        conn.execute_batch(&format!(
            "
            CREATE TABLE places AS
            SELECT 1 AS id, 'San Francisco' AS name, ST_Point(-122.4194, 37.7749) AS geometry
            UNION ALL
            SELECT 2 AS id, 'New York' AS name, ST_Point(-73.9857, 40.7484) AS geometry;
            COPY places TO {} (FORMAT PARQUET);
            ",
            quote_sql_string(path)
        ))
        .expect("write GeoParquet fixture");
    }

    fn create_base64_wkb_parquet(path: &str) {
        let conn = Connection::open_in_memory().expect("open DuckDB");
        conn.execute_batch(&format!(
            "
            CREATE TABLE places AS
            SELECT
              1 AS id,
              'Luxembourg' AS name,
              'AQMAAAABAAAABQAAAFCW6nIMPRdA3PVYDQjGSECxTV13Nj0XQHRYwfoLxkhA4MiF5+M8F0BWd0PCEcZIQPjdWB27PBdAIePTAA7GSEBQlupyDD0XQNz1WA0IxkhA' AS geometry;
            COPY places TO {} (FORMAT PARQUET);
            ",
            quote_sql_string(path)
        ))
        .expect("write base64 WKB Parquet fixture");
    }

    fn create_plain_string_geometry_parquet(path: &str) {
        let conn = Connection::open_in_memory().expect("open DuckDB");
        conn.execute_batch(&format!(
            "
            CREATE TABLE places AS
            SELECT 1 AS id, 'not WKB' AS geometry;
            COPY places TO {} (FORMAT PARQUET);
            ",
            quote_sql_string(path)
        ))
        .expect("write plain string geometry fixture");
    }

    fn create_ranked_base64_wkb_candidates_parquet(path: &str) {
        let conn = Connection::open_in_memory().expect("open DuckDB");
        conn.execute_batch(&format!(
            "
            CREATE TABLE places AS
            SELECT
              1 AS id,
              'not WKB' AS geometry,
              'AQMAAAABAAAABQAAAFCW6nIMPRdA3PVYDQjGSECxTV13Nj0XQHRYwfoLxkhA4MiF5+M8F0BWd0PCEcZIQPjdWB27PBdAIePTAA7GSEBQlupyDD0XQNz1WA0IxkhA' AS wkb;
            COPY places TO {} (FORMAT PARQUET);
            ",
            quote_sql_string(path)
        ))
        .expect("write ranked base64 WKB candidate fixture");
    }

    /// A table with no geometry column at all: a lon/lat pair of doubles, the
    /// shape a CSV export or a sensor dump arrives in.
    fn create_lon_lat_columns_parquet(path: &str) {
        let conn = Connection::open_in_memory().expect("open DuckDB");
        conn.execute_batch(&format!(
            "
            COPY (
              SELECT (-71.2 + 0.4 * (i % 20) / 20.0)::DOUBLE AS lon,
                     (42.2 + 0.3 * (i % 17) / 17.0)::DOUBLE AS lat,
                     i AS id,
                     'station_' || i AS name
              FROM range(200) t(i)
            ) TO {} (FORMAT PARQUET);
            ",
            quote_sql_string(path)
        ))
        .expect("write lon/lat columns fixture");
    }

    /// A local site grid in no known CRS: metres from an arbitrary origin, with
    /// the `geo` block saying `"crs": null`. Per the spec that means the CRS is
    /// undefined, NOT the OGC:CRS84 default. Written as a WKB blob so DuckDB
    /// emits no `geo` key of its own and `KV_METADATA` is the only one.
    fn create_null_crs_parquet(path: &str) {
        let conn = Connection::open_in_memory().expect("open DuckDB");
        install_spatial_extension_for_tests(&conn).expect("load spatial");
        let geo = r#"{"version":"1.1.0","primary_column":"geometry","columns":{
            "geometry":{"encoding":"WKB","geometry_types":["Point"],"crs":null,
            "bbox":[0.0,0.0,2400.0,500.0]}}}"#;
        conn.execute_batch(&format!(
            "
            COPY (
              SELECT ST_AsWKB(ST_Point(100.0 * (i % 25), 100.0 * (i // 25))) AS geometry,
                     i AS id
              FROM range(150) t(i)
            ) TO {} (FORMAT PARQUET, KV_METADATA {{geo: {}}});
            ",
            quote_sql_string(path),
            quote_sql_string(geo)
        ))
        .expect("write null CRS fixture");
    }

    /// Two geometry columns, both declared in the `geo` block, with the
    /// conventional name `geometry` written first and `primary_column` naming
    /// the other one. Only the document says which column holds the geometry.
    fn create_declared_primary_column_parquet(path: &str) {
        let conn = Connection::open_in_memory().expect("open DuckDB");
        install_spatial_extension_for_tests(&conn).expect("load spatial");
        let geo = r#"{"version":"1.1.0","primary_column":"geom_a","columns":{
            "geometry":{"encoding":"WKB","geometry_types":["Point"]},
            "geom_a":{"encoding":"WKB","geometry_types":["Point"]}}}"#;
        conn.execute_batch(&format!(
            "
            COPY (
              SELECT ST_AsWKB(ST_Point(1.0, 2.0)) AS geometry,
                     ST_AsWKB(ST_Point(3.0, 4.0)) AS geom_a,
                     1 AS id
            ) TO {} (FORMAT PARQUET, KV_METADATA {{geo: {}}});
            ",
            quote_sql_string(path),
            quote_sql_string(geo)
        ))
        .expect("write declared primary column fixture");
    }

    /// A Parquet 2.0 file with NO `geo` block at all, whose CRS lives only on
    /// the geometry column's GEOMETRY logical type — and is projected, so the
    /// coordinates are metres that must be reprojected to be drawable.
    fn create_native_projected_parquet(path: &str) {
        let conn = Connection::open_in_memory().expect("open DuckDB");
        install_spatial_extension_for_tests(&conn).expect("load spatial");
        conn.execute_batch(&format!(
            "
            COPY (
              SELECT ST_Point(220000, 890000)::GEOMETRY('EPSG:26986') AS geometry, 1 AS id
            ) TO {} (FORMAT PARQUET, GEOPARQUET_VERSION 'NONE');
            ",
            quote_sql_string(path)
        ))
        .expect("write native logical-type CRS fixture");
    }

    fn install_spatial_extension_for_tests(conn: &Connection) -> Result<(), String> {
        conn.execute_batch("INSTALL spatial; LOAD spatial;")
            .map_err(|error| format!("Could not install/load DuckDB spatial extension: {error}"))
    }

    #[test]
    fn native_loader_reads_real_geoparquet_as_geojson() {
        let path = temp_geoparquet_path();
        create_real_geoparquet(&path);

        let options = native_options(path.clone(), None, None).expect("native options");
        let feature_count =
            count_native_vector_file_features_blocking(options.clone()).expect("count features");
        assert_eq!(feature_count, 2);

        let collection = load_native_vector_file_blocking(options).expect("load vector file");
        assert_eq!(collection["type"], "FeatureCollection");
        let features = collection["features"].as_array().expect("features array");
        assert_eq!(features.len(), 2);
        assert_eq!(features[0]["properties"]["id"], 1);
        assert_eq!(features[0]["properties"]["name"], "San Francisco");
        assert_eq!(features[0]["geometry"]["type"], "Point");
        assert_eq!(features[0]["geometry"]["coordinates"][0], -122.4194);
        assert_eq!(features[0]["geometry"]["coordinates"][1], 37.7749);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn native_loader_reads_base64_wkb_geometry_column() {
        let path = temp_geoparquet_path();
        create_base64_wkb_parquet(&path);

        let options = native_options(path.clone(), None, None).expect("native options");
        let collection = load_native_vector_file_blocking(options).expect("load vector file");
        let features = collection["features"].as_array().expect("features array");
        assert_eq!(features.len(), 1);
        assert_eq!(features[0]["properties"]["id"], 1);
        assert_eq!(features[0]["properties"]["name"], "Luxembourg");
        assert_eq!(features[0]["geometry"]["type"], "Polygon");
        assert_eq!(
            features[0]["geometry"]["coordinates"][0][0][0],
            5.809617801254333
        );
        assert_eq!(
            features[0]["geometry"]["coordinates"][0][0][1],
            49.54712073177117
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn native_loader_rejects_plain_string_geometry_column() {
        let path = temp_geoparquet_path();
        create_plain_string_geometry_parquet(&path);

        let options = native_options(path.clone(), None, None).expect("native options");
        let error = load_native_vector_file_blocking(options).expect_err("reject plain string");
        assert!(error.contains("DuckDB did not find a geometry column"));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn native_loader_tries_ranked_base64_wkb_candidates() {
        let path = temp_geoparquet_path();
        create_ranked_base64_wkb_candidates_parquet(&path);

        let options = native_options(path.clone(), None, None).expect("native options");
        let collection = load_native_vector_file_blocking(options).expect("load vector file");
        let features = collection["features"].as_array().expect("features array");
        assert_eq!(features.len(), 1);
        assert_eq!(features[0]["properties"]["id"], 1);
        assert_eq!(features[0]["properties"]["geometry"], "not WKB");
        assert_eq!(features[0]["geometry"]["type"], "Polygon");
        assert_eq!(
            features[0]["geometry"]["coordinates"][0][0][0],
            5.809617801254333
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn native_options_rejects_duckdb_glob_paths() {
        let error = native_options("/tmp/*.parquet".to_string(), None, None)
            .expect_err("glob path should be rejected");
        assert!(error.contains("glob paths are not allowed"));

        let bracket_pattern = format!(
            "{}/geolibre-native-duckdb-[{}].parquet",
            std::env::temp_dir().display(),
            std::process::id()
        );
        let error = native_options(bracket_pattern, None, None)
            .expect_err("bracket glob should be rejected");
        assert!(error.contains("glob paths are not allowed"));
    }

    #[test]
    fn native_options_allows_literal_brackets_in_existing_paths() {
        let path = format!(
            "{}/geolibre-native-duckdb-[literal]-{}.parquet",
            std::env::temp_dir().display(),
            std::process::id()
        );
        std::fs::write(&path, []).expect("create literal bracket file");
        let options = native_options(path.clone(), None, None).expect("native options");
        assert_eq!(options.path, path);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_prj_sidecar_crs_returns_trimmed_wkt() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before Unix epoch")
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "geolibre-native-prj-{suffix}-{}",
            std::process::id()
        ));
        let shp_path = base.with_extension("shp");
        let prj_path = base.with_extension("prj");
        std::fs::write(
            &prj_path,
            "  PROJCS[\"British_National_Grid\",GEOGCS[\"GCS_OSGB_1936\"]]\n",
        )
        .expect("write prj sidecar");

        let crs =
            read_prj_sidecar_crs(&shp_path.to_string_lossy()).expect("prj sidecar resolves a CRS");
        assert_eq!(
            crs,
            "PROJCS[\"British_National_Grid\",GEOGCS[\"GCS_OSGB_1936\"]]"
        );

        let _ = std::fs::remove_file(&prj_path);
    }

    #[test]
    fn read_prj_sidecar_crs_is_none_when_absent_or_empty() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before Unix epoch")
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "geolibre-native-prj-missing-{suffix}-{}",
            std::process::id()
        ));
        let shp_path = base.with_extension("shp");

        assert!(read_prj_sidecar_crs(&shp_path.to_string_lossy()).is_none());

        let prj_path = base.with_extension("prj");
        std::fs::write(&prj_path, "   \n").expect("write empty prj sidecar");
        assert!(read_prj_sidecar_crs(&shp_path.to_string_lossy()).is_none());
        let _ = std::fs::remove_file(&prj_path);
    }

    #[test]
    fn read_prj_sidecar_crs_matches_mixed_case_extension() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before Unix epoch")
            .as_nanos();
        // A unique per-test subdirectory so the directory scan only sees this
        // file set, independent of other tests sharing the temp dir.
        let dir = std::env::temp_dir().join(format!(
            "geolibre-native-prj-case-{suffix}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create test dir");
        // A mixed-case sidecar extension AND basename (`hotspots.shp` vs
        // `Hotspots.PRJ`) that neither the `prj` nor `PRJ` fast path matches.
        let shp_path = dir.join("hotspots.shp");
        let prj_path = dir.join("Hotspots.PRJ");
        std::fs::write(&prj_path, "PROJCS[\"OSGB\"]\n").expect("write prj sidecar");

        let crs = read_prj_sidecar_crs(&shp_path.to_string_lossy())
            .expect("mixed-case prj sidecar resolves a CRS");
        assert_eq!(crs, "PROJCS[\"OSGB\"]");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wkb_detection_uses_preferred_column_name() {
        let detected = detect_geometry_column_from_schema(
            &[
                DescribedColumn {
                    name: "wkb".to_string(),
                    column_type: "BLOB".to_string(),
                },
                DescribedColumn {
                    name: "geometry".to_string(),
                    column_type: "BLOB".to_string(),
                },
            ],
            None,
            false,
        )
        .expect("detect WKB geometry");
        assert_eq!(detected.column, "geometry");
        assert!(detected.is_wkb);
        assert!(!detected.is_base64_wkb);
        assert!(!detected.requires_base64_wkb_validation);
    }

    #[test]
    fn wkb_detection_marks_base64_string_geometry_candidates() {
        let detected = detect_geometry_column_from_schema(
            &[
                DescribedColumn {
                    name: "id".to_string(),
                    column_type: "BIGINT".to_string(),
                },
                DescribedColumn {
                    name: "geometry".to_string(),
                    column_type: "VARCHAR".to_string(),
                },
            ],
            None,
            false,
        )
        .expect("detect base64 WKB geometry");
        assert_eq!(detected.column, "geometry");
        assert!(detected.is_wkb);
        assert!(detected.is_base64_wkb);
        assert!(detected.requires_base64_wkb_validation);
        assert_eq!(detected.base64_wkb_candidates, vec!["geometry".to_string()]);
    }

    #[test]
    fn integer_json_uses_javascript_safe_range() {
        assert_eq!(
            json_number_or_string_i128(9_007_199_254_740_991),
            json!(9_007_199_254_740_991_i64)
        );
        assert_eq!(
            json_number_or_string_i128(9_007_199_254_740_992),
            json!("9007199254740992")
        );
        assert_eq!(
            json_number_or_string_u128(9_007_199_254_740_992),
            json!("9007199254740992")
        );
    }

    #[test]
    fn out_of_range_time_falls_back_to_raw_microseconds() {
        let micros = (u32::MAX as i64 + 1) * 1_000_000;
        assert_eq!(
            format_time(TimeUnit::Microsecond, micros),
            format!("{micros}us")
        );
    }

    /// The reprojection source a `geo` document reduces to for one column.
    fn geo_source_crs(metadata_json: &str, geometry_column: &str) -> Option<String> {
        let metadata = parse_geoparquet_metadata(metadata_json)?;
        let crs = geoparquet_column(&metadata, geometry_column)
            .map(|column| &column.crs)
            .unwrap_or(&GeoParquetCrs::Default);
        transform_crs(crs)
    }

    #[test]
    fn geoparquet_crs_reads_primary_column_authority_code() {
        let metadata = r#"{
            "version": "1.1.0",
            "primary_column": "geom",
            "columns": {
                "geom": {
                    "encoding": "WKB",
                    "crs": {
                        "type": "ProjectedCRS",
                        "id": { "authority": "EPSG", "code": 3857 }
                    }
                }
            }
        }"#;
        assert_eq!(
            geo_source_crs(metadata, "geom"),
            Some("EPSG:3857".to_string())
        );
    }

    #[test]
    fn geoparquet_crs_resolves_the_column_being_read() {
        // A file may carry several geometry columns in different CRSs, and the
        // loader reads whichever one it detected. Resolving `primary_column`'s
        // CRS instead would land the layer somewhere else entirely.
        let metadata = r#"{
            "primary_column": "geom_4326",
            "columns": {
                "geom_2100": { "crs": { "id": { "authority": "EPSG", "code": 2100 } } },
                "geom_4326": { "crs": { "id": { "authority": "EPSG", "code": 4326 } } }
            }
        }"#;
        assert_eq!(
            geo_source_crs(metadata, "geom_2100"),
            Some("EPSG:2100".to_string())
        );
        assert_eq!(geo_source_crs(metadata, "geom_4326"), None);
        // A column the document does not describe falls back to the primary one.
        assert_eq!(geo_source_crs(metadata, "wkb_blob"), None);
    }

    #[test]
    fn geoparquet_crs_distinguishes_an_absent_crs_from_an_explicit_null() {
        // Absent means the spec default, OGC:CRS84; explicit null means the CRS
        // is undefined. Neither may be reprojected.
        let absent = r#"{"primary_column":"geometry","columns":{"geometry":{"encoding":"WKB"}}}"#;
        let null = r#"{"primary_column":"geometry","columns":{"geometry":{"crs":null}}}"#;
        assert_eq!(geo_source_crs(absent, "geometry"), None);
        assert_eq!(geo_source_crs(null, "geometry"), None);
        // The OGC identifiers resolve to the EPSG spellings PROJ prefers.
        let ogc = r#"{"columns":{"geometry":{"crs":{"id":{"authority":"OGC","code":"CRS83"}}}}}"#;
        assert_eq!(
            geoparquet_column(&parse_geoparquet_metadata(ogc).expect("parsed"), "geometry")
                .map(|column| column.crs.clone()),
            Some(GeoParquetCrs::Authority {
                authority: "EPSG".to_string(),
                code: "4269".to_string(),
                epsg: Some(4269),
            })
        );
        // Id-less PROJJSON is handed to PROJ as the document itself.
        let custom = r#"{"columns":{"geometry":{"crs":{"type":"ProjectedCRS","name":"Site"}}}}"#;
        assert_eq!(
            geo_source_crs(custom, "geometry"),
            Some(r#"{"name":"Site","type":"ProjectedCRS"}"#.to_string())
        );
    }

    #[test]
    fn logical_type_crs_reads_the_spellings_in_circulation() {
        let crs_of = |logical_type: &str| {
            parse_native_geometry_logical_type(logical_type)
                .map(|crs| transform_crs(&parse_logical_type_crs(crs.as_deref())))
        };
        // A non-geospatial logical type is not a geometry column at all.
        assert_eq!(crs_of("StringType()"), None);
        // Recognised, with nothing to transform from.
        assert_eq!(crs_of("GeometryType(crs=<null>)"), Some(None));
        assert_eq!(crs_of("GeometryType(crs=OGC:CRS84)"), Some(None));
        assert_eq!(crs_of("GeometryType(crs=srid:0)"), Some(None));
        // An unrecognised string is not guessed at.
        assert_eq!(crs_of("GeometryType(crs=my-site-grid)"), Some(None));
        // A GEOGRAPHY type's CRS stops at the next argument, and a JSON-quoted
        // string is unwrapped before the same rules apply.
        assert_eq!(
            crs_of(r#"GeographyType(crs="EPSG:2154", algorithm=SPHERICAL)"#),
            Some(Some("EPSG:2154".to_string()))
        );
        assert_eq!(
            crs_of("GeometryType(crs=EPSG:2154)"),
            Some(Some("EPSG:2154".to_string()))
        );
        // PROJJSON, commas and all, is read whole and reduced to its id.
        assert_eq!(
            crs_of(
                r#"GeometryType(crs={"type":"ProjectedCRS","name":"x","id":{"authority":"EPSG","code":26986}})"#
            ),
            Some(Some("EPSG:26986".to_string()))
        );
    }

    #[test]
    fn primary_column_beats_a_conventional_column_name() {
        let columns = [
            DescribedColumn {
                name: "geometry".to_string(),
                column_type: "BLOB".to_string(),
            },
            DescribedColumn {
                name: "geom_a".to_string(),
                column_type: "BLOB".to_string(),
            },
        ];
        let detected = detect_geometry_column_from_schema(&columns, Some("geom_a"), false)
            .expect("detect declared column");
        assert_eq!(detected.column, "geom_a");
        assert!(detected.is_wkb);
        // A document naming a column the file does not have, or one no geometry
        // reader accepts, must not fail the load.
        assert_eq!(
            detect_geometry_column_from_schema(&columns, Some("missing"), false)
                .expect("fall through")
                .column,
            "geometry"
        );
    }

    #[test]
    fn coordinate_columns_are_the_last_resort_and_only_without_geometry() {
        let lon_lat = [
            DescribedColumn {
                name: "lon".to_string(),
                column_type: "DOUBLE".to_string(),
            },
            DescribedColumn {
                name: "lat".to_string(),
                column_type: "DOUBLE".to_string(),
            },
        ];
        // Off unless the caller opts in.
        assert!(detect_geometry_column_from_schema(&lon_lat, None, false).is_err());
        let detected =
            detect_geometry_column_from_schema(&lon_lat, None, true).expect("synthesize points");
        assert_eq!(detected.column, SYNTHESIZED_GEOMETRY_COLUMN);
        assert_eq!(
            detected.coordinate_columns,
            Some(CoordinateColumns {
                x: "lon".to_string(),
                y: "lat".to_string()
            })
        );
        assert_eq!(
            geometry_expr(&detected),
            "ST_Point(\"lon\", \"lat\")".to_string()
        );

        // A WKB blob under a name this module does not know is still geometry,
        // so an `x`/`y` pair beside it must not be promoted into points.
        let with_binary = [
            DescribedColumn {
                name: "shape_bytes".to_string(),
                column_type: "BLOB".to_string(),
            },
            DescribedColumn {
                name: "x".to_string(),
                column_type: "DOUBLE".to_string(),
            },
            DescribedColumn {
                name: "y".to_string(),
                column_type: "DOUBLE".to_string(),
            },
        ];
        assert!(detect_geometry_column_from_schema(&with_binary, None, true).is_err());
    }

    #[test]
    fn native_loader_prefers_the_declared_primary_column() {
        let path = temp_geoparquet_path();
        create_declared_primary_column_parquet(&path);

        let options = native_options(path.clone(), None, None).expect("native options");
        let collection = load_native_vector_file_blocking(options).expect("load vector file");
        let features = collection["features"].as_array().expect("features array");
        assert_eq!(features.len(), 1);
        // Not the `geometry` column, which comes first and bears the
        // conventional name: the `geo` block names `geom_a` as primary.
        assert_eq!(features[0]["geometry"]["coordinates"][0], 3.0);
        assert_eq!(features[0]["geometry"]["coordinates"][1], 4.0);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn native_loader_reprojects_a_logical_type_crs_without_a_geo_block() {
        let path = temp_geoparquet_path();
        create_native_projected_parquet(&path);

        let options = native_options(path.clone(), None, None).expect("native options");
        let collection = load_native_vector_file_blocking(options).expect("load vector file");
        let features = collection["features"].as_array().expect("features array");
        let coordinates = &features[0]["geometry"]["coordinates"];
        let (lon, lat) = (
            coordinates[0].as_f64().expect("longitude"),
            coordinates[1].as_f64().expect("latitude"),
        );
        // Without reading the logical type's CRS these would still be the raw
        // metres (220000, 890000) and the layer would draw nowhere.
        assert!(
            (lon + 71.2576).abs() < 1e-3 && (lat - 42.2602).abs() < 1e-3,
            "reprojected to {lon}, {lat}"
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn native_loader_synthesizes_points_from_lon_lat_columns() {
        let path = temp_geoparquet_path();
        create_lon_lat_columns_parquet(&path);

        let options = native_options(path.clone(), None, None).expect("native options");
        let collection = load_native_vector_file_blocking(options).expect("load vector file");
        let features = collection["features"].as_array().expect("features array");
        assert_eq!(features.len(), 200);
        assert_eq!(features[0]["geometry"]["type"], "Point");
        assert_eq!(features[0]["geometry"]["coordinates"][0], -71.2);
        assert_eq!(features[0]["geometry"]["coordinates"][1], 42.2);
        // The coordinate columns stay readable as properties: no real column is
        // consumed by the synthesized geometry.
        assert_eq!(features[0]["properties"]["lon"], -71.2);
        assert_eq!(features[0]["properties"]["name"], "station_0");

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn native_loader_skips_reprojection_for_an_explicit_null_crs() {
        let path = temp_geoparquet_path();
        create_null_crs_parquet(&path);

        let options = native_options(path.clone(), None, None).expect("native options");
        let collection = load_native_vector_file_blocking(options).expect("load vector file");
        let features = collection["features"].as_array().expect("features array");
        assert_eq!(features.len(), 150);
        // A local site grid in no known CRS: drawn as it stands, never
        // reprojected as if the CRS84 default applied.
        assert_eq!(features[0]["geometry"]["coordinates"][0], 0.0);
        assert_eq!(features[0]["geometry"]["coordinates"][1], 0.0);
        assert_eq!(features[1]["geometry"]["coordinates"][0], 100.0);

        let _ = std::fs::remove_file(path);
    }
}
