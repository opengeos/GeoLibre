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
    let detected = detect_geometry_column(&conn, &sql, &columns)?;
    let property_columns: Vec<String> = columns
        .iter()
        .filter(|column| column.name != detected.column)
        .map(|column| column.name.clone())
        .collect();
    let source_crs = match options.override_source_crs.clone() {
        Some(crs) => Some(crs),
        None => read_source_crs(&conn, &options),
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
) -> Result<DetectedGeometry, String> {
    let detected = detect_geometry_column_from_schema(columns)?;
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
            });
        }
    }
    Err("DuckDB did not find a geometry column in this file.".to_string())
}

fn detect_geometry_column_from_schema(
    columns: &[DescribedColumn],
) -> Result<DetectedGeometry, String> {
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
        if upper_type.starts_with("BLOB")
            || upper_type.starts_with("BINARY")
            || upper_type.starts_with("VARBINARY")
        {
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
        });
    }

    Err("DuckDB did not find a geometry column in this file.".to_string())
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

fn read_source_crs(conn: &Connection, options: &NativeVectorOptions) -> Option<String> {
    if is_parquet_extension(&options.extension) {
        return read_geoparquet_source_crs(conn, options);
    }
    let meta_sql = format!(
        "SELECT layers[1].geometry_fields[1].crs.auth_name AS auth_name, \
         layers[1].geometry_fields[1].crs.auth_code AS auth_code \
         FROM ST_Read_Meta({})",
        quote_sql_string(&options.path.replace('\\', "/"))
    );
    conn.query_row(&meta_sql, [], |row| {
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
    })
}

fn read_geoparquet_source_crs(conn: &Connection, options: &NativeVectorOptions) -> Option<String> {
    let metadata_sql = format!(
        "SELECT decode(value) FROM parquet_kv_metadata({}) WHERE decode(key) = 'geo' LIMIT 1",
        quote_sql_string(&options.path.replace('\\', "/"))
    );
    let metadata: String = conn.query_row(&metadata_sql, [], |row| row.get(0)).ok()?;
    geoparquet_crs_from_metadata(&metadata)
}

fn geoparquet_crs_from_metadata(metadata: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(metadata).ok()?;
    let primary_column = value
        .get("primary_column")
        .and_then(|value| value.as_str())
        .unwrap_or("geometry");
    let crs = value.get("columns")?.get(primary_column)?.get("crs")?;
    if crs.is_null() {
        return None;
    }
    crs_auth_code(crs)
}

fn crs_auth_code(crs: &serde_json::Value) -> Option<String> {
    let id = match crs.get("id")? {
        serde_json::Value::Array(ids) => ids.last()?,
        id => id,
    };
    let authority = id
        .get("authority")
        .or_else(|| id.get("auth_name"))?
        .as_str()?
        .trim()
        .to_ascii_uppercase();
    let code = id.get("code").or_else(|| id.get("auth_code"))?;
    let code = match code {
        serde_json::Value::String(value) => value.trim().to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        _ => return None,
    };
    if authority.is_empty() || code.is_empty() {
        None
    } else {
        Some(format!("{authority}:{code}"))
    }
}

fn geometry_expr(detected: &DetectedGeometry) -> String {
    assert!(
        !detected.requires_base64_wkb_validation,
        "base64 WKB geometry must be value-validated before SQL generation"
    );
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
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_geoparquet_path() -> String {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before Unix epoch")
            .as_nanos();
        std::env::temp_dir()
            .join(format!(
                "geolibre-native-duckdb-{suffix}-{}.geoparquet",
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
    fn wkb_detection_uses_preferred_column_name() {
        let detected = detect_geometry_column_from_schema(&[
            DescribedColumn {
                name: "wkb".to_string(),
                column_type: "BLOB".to_string(),
            },
            DescribedColumn {
                name: "geometry".to_string(),
                column_type: "BLOB".to_string(),
            },
        ])
        .expect("detect WKB geometry");
        assert_eq!(detected.column, "geometry");
        assert!(detected.is_wkb);
        assert!(!detected.is_base64_wkb);
        assert!(!detected.requires_base64_wkb_validation);
    }

    #[test]
    fn wkb_detection_marks_base64_string_geometry_candidates() {
        let detected = detect_geometry_column_from_schema(&[
            DescribedColumn {
                name: "id".to_string(),
                column_type: "BIGINT".to_string(),
            },
            DescribedColumn {
                name: "geometry".to_string(),
                column_type: "VARCHAR".to_string(),
            },
        ])
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
            geoparquet_crs_from_metadata(metadata),
            Some("EPSG:3857".to_string())
        );
    }
}
