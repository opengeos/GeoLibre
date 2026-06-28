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

#[derive(Clone)]
struct NativeVectorOptions {
    path: String,
    extension: String,
    layer: Option<String>,
    override_source_crs: Option<String>,
    spatial_extension_path: Option<String>,
}

#[derive(Debug)]
struct DetectedGeometry {
    column: String,
    is_wkb: bool,
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
    spatial_extension_path: Option<String>,
) -> Result<usize, String> {
    let options = native_options(path, layer, None, spatial_extension_path)?;
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
    spatial_extension_path: Option<String>,
) -> Result<serde_json::Value, String> {
    let options = native_options(path, layer, override_source_crs, spatial_extension_path)?;
    tauri::async_runtime::spawn_blocking(move || load_native_vector_file_blocking(options))
        .await
        .map_err(|error| format!("Native DuckDB load task failed: {error}"))?
}

fn native_options(
    path: String,
    layer: Option<String>,
    override_source_crs: Option<String>,
    spatial_extension_path: Option<String>,
) -> Result<NativeVectorOptions, String> {
    if !crate::is_allowed_local_vector_path(&path) {
        return Err(format!(
            "Refusing to read \"{path}\": not an absolute local vector file path"
        ));
    }
    Ok(NativeVectorOptions {
        extension: vector_extension(&path),
        path,
        layer: blank_to_none(layer),
        override_source_crs: blank_to_none(override_source_crs),
        spatial_extension_path: blank_to_none(spatial_extension_path),
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

fn count_native_vector_file_features_blocking(
    options: NativeVectorOptions,
) -> Result<usize, String> {
    let conn = open_native_duckdb(&options)?;
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
    let conn = open_native_duckdb(&options)?;
    let sql = source_sql(&options);
    let columns = describe_source_columns(&conn, &sql)?;
    let detected = detect_geometry_column(&columns)?;
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

fn open_native_duckdb(options: &NativeVectorOptions) -> Result<Connection, String> {
    let conn = Connection::open_in_memory()
        .map_err(|error| format!("Could not open native DuckDB: {error}"))?;
    let _ = conn.execute_batch("LOAD parquet;");
    ensure_spatial_extension(&conn, options.spatial_extension_path.as_deref())?;
    Ok(conn)
}

fn ensure_spatial_extension(
    conn: &Connection,
    spatial_extension_path: Option<&str>,
) -> Result<(), String> {
    if let Some(path) = spatial_extension_path {
        conn.execute_batch(&format!(
            "LOAD {}",
            quote_sql_string(&path.replace('\\', "/"))
        ))
        .map_err(|error| {
            format!("Could not load DuckDB spatial extension from \"{path}\": {error}")
        })?;
        return Ok(());
    }

    conn.execute_batch("INSTALL spatial; LOAD spatial;")
        .map_err(|error| format!("Could not install/load DuckDB spatial extension: {error}"))
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

fn detect_geometry_column(columns: &[DescribedColumn]) -> Result<DetectedGeometry, String> {
    let mut wkb_candidate = None;
    for column in columns {
        if column
            .column_type
            .to_ascii_uppercase()
            .starts_with("GEOMETRY")
        {
            return Ok(DetectedGeometry {
                column: column.name.clone(),
                is_wkb: false,
            });
        }
        let lower_name = column.name.to_ascii_lowercase();
        let upper_type = column.column_type.to_ascii_uppercase();
        if (upper_type.starts_with("BLOB")
            || upper_type.starts_with("BINARY")
            || upper_type.starts_with("VARBINARY"))
            && WKB_GEOMETRY_COLUMN_NAMES.contains(&lower_name.as_str())
        {
            wkb_candidate = Some(column.name.clone());
        }
    }

    if let Some(column) = wkb_candidate {
        return Ok(DetectedGeometry {
            column,
            is_wkb: true,
        });
    }

    Err("DuckDB did not find a geometry column in this file.".to_string())
}

fn read_source_crs(conn: &Connection, options: &NativeVectorOptions) -> Option<String> {
    if is_parquet_extension(&options.extension) {
        return None;
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

fn geometry_expr(detected: &DetectedGeometry) -> String {
    let column = quote_identifier(&detected.column);
    if detected.is_wkb {
        format!("ST_GeomFromWKB({column})")
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
        Value::TinyInt(value) => json!(value),
        Value::SmallInt(value) => json!(value),
        Value::Int(value) => json!(value),
        Value::BigInt(value) => json_number_or_string_i128(*value as i128),
        Value::HugeInt(value) => json_number_or_string_i128(*value),
        Value::UTinyInt(value) => json!(value),
        Value::USmallInt(value) => json!(value),
        Value::UInt(value) => json!(value),
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
    if value >= i64::MIN as i128 && value <= i64::MAX as i128 {
        json!(value as i64)
    } else {
        json!(value.to_string())
    }
}

fn json_number_or_string_u128(value: u128) -> serde_json::Value {
    if value <= u64::MAX as u128 {
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
    NaiveTime::from_num_seconds_from_midnight_opt(seconds as u32, nanos)
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
        ensure_spatial_extension(&conn, None).expect("load spatial");
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

    #[test]
    fn native_loader_reads_real_geoparquet_as_geojson() {
        let path = temp_geoparquet_path();
        create_real_geoparquet(&path);

        let options = native_options(path.clone(), None, None, None).expect("native options");
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
}
