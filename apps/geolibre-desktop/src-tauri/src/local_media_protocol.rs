//! Pooled local tile and COG streaming over Tauri custom URI schemes
//! (`mbtiles://`, `pmtiles://`, and `local-cog://`) with HTTP `Range` support.
//!
//! Replacing per-tile SQLite open/close and JSON `Vec<u8>` IPC with bounded
//! LRU connection/file pools and binary HTTP responses eliminates connection
//! churn and base64/JSON serialization overhead on local tile and raster reads.

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::FsExt;

/// Maximum number of simultaneously open read-only MBTiles SQLite connections.
const MAX_POOLED_MBTILES: usize = 16;
/// Maximum number of simultaneously open read-only PMTiles/COG file handles.
const MAX_POOLED_FILES: usize = 24;
/// Maximum response body size for a non-Range `200 OK` request (64 MiB).
const MAX_UNRANGED_MEDIA_BYTES: u64 = 64 * 1024 * 1024;
/// Maximum byte length served by a single HTTP `Range` request (32 MiB).
const MAX_RANGE_CHUNK_BYTES: u64 = 32 * 1024 * 1024;

/// A pooled read-only MBTiles SQLite connection with its cached tile scheme.
pub(crate) struct PooledMbtiles {
    pub(crate) scheme: String,
    pub(crate) connection: Mutex<Connection>,
}

struct MbtilesPoolEntry {
    handle: Arc<PooledMbtiles>,
    last_used: u64,
    file_len: u64,
    modified: Option<SystemTime>,
}

/// Bounded LRU pool of open read-only MBTiles SQLite connections keyed by
/// canonical filesystem path.
pub(crate) struct MbtilesConnectionPool {
    capacity: usize,
    tick: AtomicU64,
    entries: Mutex<HashMap<PathBuf, MbtilesPoolEntry>>,
}

impl Default for MbtilesConnectionPool {
    fn default() -> Self {
        Self::with_capacity(MAX_POOLED_MBTILES)
    }
}

impl MbtilesConnectionPool {
    pub(crate) fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            tick: AtomicU64::new(1),
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn get_or_open(&self, path: &str) -> Result<Arc<PooledMbtiles>, String> {
        let canonical = canonicalize_allowed_mbtiles(path)?;
        let metadata = fs::metadata(&canonical)
            .map_err(|error| format!("Could not inspect MBTiles file: {error}"))?;
        let file_len = metadata.len();
        let modified = metadata.modified().ok();

        let now = self.tick.fetch_add(1, Ordering::Relaxed);
        {
            let mut guard = self
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(entry) = guard.get_mut(&canonical) {
                if entry.file_len == file_len && entry.modified == modified {
                    entry.last_used = now;
                    return Ok(Arc::clone(&entry.handle));
                }
                guard.remove(&canonical);
            }
        }

        let connection = Connection::open_with_flags(&canonical, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| format!("Could not open MBTiles file: {error}"))?;
        let scheme = crate::read_metadata_value(&connection, "scheme")?
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_else(|| "tms".to_string());
        let handle = Arc::new(PooledMbtiles {
            scheme,
            connection: Mutex::new(connection),
        });

        let mut guard = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.len() >= self.capacity && !guard.contains_key(&canonical) {
            if let Some(lru_key) = guard
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| key.clone())
            {
                guard.remove(&lru_key);
            }
        }
        guard.insert(
            canonical,
            MbtilesPoolEntry {
                handle: Arc::clone(&handle),
                last_used: now,
                file_len,
                modified,
            },
        );
        Ok(handle)
    }

    pub(crate) fn read_tile(&self, path: &str, z: u32, x: u32, y: u32) -> Result<Vec<u8>, String> {
        if z > crate::MAX_MBTILES_ZOOM {
            return Err("Tile zoom level is too large".to_string());
        }
        let pooled = self.get_or_open(path)?;
        let tile_row = if pooled.scheme == "xyz" {
            i64::from(y)
        } else {
            let row_count = 1_i64
                .checked_shl(z)
                .ok_or_else(|| "Tile zoom level is too large".to_string())?;
            row_count - 1 - i64::from(y)
        };
        if tile_row < 0 {
            return Ok(Vec::new());
        }

        let tile_data = {
            let connection = pooled
                .connection
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            connection
                .query_row(
                    "SELECT tile_data FROM tiles WHERE zoom_level = ?1 AND tile_column = ?2 AND tile_row = ?3",
                    params![i64::from(z), i64::from(x), tile_row],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .optional()
                .map_err(|error| format!("Could not read MBTiles tile: {error}"))?
        };

        Ok(tile_data
            .map(crate::decompress_tile_data)
            .transpose()?
            .unwrap_or_default())
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }
}

struct PooledFileHandle {
    file: Mutex<File>,
    len: u64,
    modified: Option<SystemTime>,
}

struct FilePoolEntry {
    handle: Arc<PooledFileHandle>,
    last_used: u64,
}

/// Bounded LRU pool of open read-only local files for byte-range streaming
/// (`pmtiles://` and `local-cog://`).
pub(crate) struct LocalFilePool {
    capacity: usize,
    tick: AtomicU64,
    entries: Mutex<HashMap<PathBuf, FilePoolEntry>>,
}

impl Default for LocalFilePool {
    fn default() -> Self {
        Self::with_capacity(MAX_POOLED_FILES)
    }
}

/// Parsed inclusive byte range `[start, end]` within a file of `total_len` bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ByteRange {
    pub(crate) start: u64,
    pub(crate) end: u64,
}

/// Result of serving a full or partial byte-range read from [`LocalFilePool`].
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct RangeReadResponse {
    pub(crate) status: StatusCode,
    pub(crate) bytes: Vec<u8>,
    pub(crate) content_range: Option<String>,
    pub(crate) total_len: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RangeParseResult {
    None,
    Satisfiable(ByteRange),
    Unsatisfiable,
}

/// Parse an RFC 9110 single byte-range header (`bytes=start-end`, `bytes=start-`,
/// or `bytes=-suffix`) against a resource of `total_len` bytes.
pub(crate) fn parse_http_byte_range(header_value: Option<&str>, total_len: u64) -> RangeParseResult {
    let Some(raw) = header_value.map(str::trim).filter(|value| !value.is_empty()) else {
        return RangeParseResult::None;
    };
    let Some(spec) = raw
        .strip_prefix("bytes=")
        .or_else(|| raw.strip_prefix("BYTES="))
    else {
        return RangeParseResult::Unsatisfiable;
    };
    // Multi-range requests are not supported; reject cleanly with 416.
    if spec.contains(',') || total_len == 0 {
        return RangeParseResult::Unsatisfiable;
    }
    let Some((start_str, end_str)) = spec.split_once('-') else {
        return RangeParseResult::Unsatisfiable;
    };
    let start_str = start_str.trim();
    let end_str = end_str.trim();

    if start_str.is_empty() {
        // Suffix byte range: `bytes=-N` means the last N bytes.
        let Ok(suffix) = end_str.parse::<u64>() else {
            return RangeParseResult::Unsatisfiable;
        };
        if suffix == 0 {
            return RangeParseResult::Unsatisfiable;
        }
        let start = total_len.saturating_sub(suffix);
        return RangeParseResult::Satisfiable(ByteRange {
            start,
            end: total_len - 1,
        });
    }

    let Ok(start) = start_str.parse::<u64>() else {
        return RangeParseResult::Unsatisfiable;
    };
    if start >= total_len {
        return RangeParseResult::Unsatisfiable;
    }
    let end = if end_str.is_empty() {
        total_len - 1
    } else {
        let Ok(parsed_end) = end_str.parse::<u64>() else {
            return RangeParseResult::Unsatisfiable;
        };
        if parsed_end < start {
            return RangeParseResult::Unsatisfiable;
        }
        parsed_end.min(total_len - 1)
    };
    RangeParseResult::Satisfiable(ByteRange { start, end })
}

impl LocalFilePool {
    pub(crate) fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            tick: AtomicU64::new(1),
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn get_or_open(&self, canonical: &Path) -> Result<Arc<PooledFileHandle>, String> {
        let metadata = fs::metadata(canonical)
            .map_err(|error| format!("Could not inspect local media file: {error}"))?;
        if !metadata.is_file() {
            return Err("Local media path is not a regular file".to_string());
        }
        let len = metadata.len();
        let modified = metadata.modified().ok();
        let now = self.tick.fetch_add(1, Ordering::Relaxed);

        {
            let mut guard = self
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(entry) = guard.get_mut(canonical) {
                if entry.handle.len == len && entry.handle.modified == modified {
                    entry.last_used = now;
                    return Ok(Arc::clone(&entry.handle));
                }
                guard.remove(canonical);
            }
        }

        let file = File::open(canonical)
            .map_err(|error| format!("Could not open local media file: {error}"))?;
        let handle = Arc::new(PooledFileHandle {
            file: Mutex::new(file),
            len,
            modified,
        });

        let mut guard = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.len() >= self.capacity && !guard.contains_key(canonical) {
            if let Some(lru_key) = guard
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| key.clone())
            {
                guard.remove(&lru_key);
            }
        }
        guard.insert(
            canonical.to_path_buf(),
            FilePoolEntry {
                handle: Arc::clone(&handle),
                last_used: now,
            },
        );
        Ok(handle)
    }

    pub(crate) fn read_range(
        &self,
        canonical: &Path,
        range_header: Option<&str>,
    ) -> Result<RangeReadResponse, String> {
        let handle = self.get_or_open(canonical)?;
        let total_len = handle.len;

        match parse_http_byte_range(range_header, total_len) {
            RangeParseResult::Unsatisfiable => Ok(RangeReadResponse {
                status: StatusCode::RANGE_NOT_SATISFIABLE,
                bytes: Vec::new(),
                content_range: Some(format!("bytes */{total_len}")),
                total_len,
            }),
            RangeParseResult::Satisfiable(range) => {
                let requested_len = range.end - range.start + 1;
                let clamped_len = requested_len.min(MAX_RANGE_CHUNK_BYTES);
                let actual_end = range.start + clamped_len - 1;
                let bytes = read_file_slice(&handle.file, range.start, clamped_len)?;
                let final_end = if bytes.is_empty() {
                    range.start
                } else {
                    range.start + (bytes.len() as u64) - 1
                };
                Ok(RangeReadResponse {
                    status: StatusCode::PARTIAL_CONTENT,
                    bytes,
                    content_range: Some(format!(
                        "bytes {}-{}/{total_len}",
                        range.start,
                        final_end.min(actual_end)
                    )),
                    total_len,
                })
            }
            RangeParseResult::None => {
                if total_len > MAX_UNRANGED_MEDIA_BYTES {
                    return Ok(RangeReadResponse {
                        status: StatusCode::RANGE_NOT_SATISFIABLE,
                        bytes: Vec::new(),
                        content_range: Some(format!("bytes */{total_len}")),
                        total_len,
                    });
                }
                let bytes = read_file_slice(&handle.file, 0, total_len)?;
                Ok(RangeReadResponse {
                    status: StatusCode::OK,
                    bytes,
                    content_range: None,
                    total_len,
                })
            }
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }
}

fn read_file_slice(file_lock: &Mutex<File>, start: u64, len: u64) -> Result<Vec<u8>, String> {
    let mut file = file_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    file.seek(SeekFrom::Start(start))
        .map_err(|error| format!("Could not seek local media file: {error}"))?;
    let mut buf = Vec::with_capacity(len.min(1024 * 1024) as usize);
    file.by_ref()
        .take(len)
        .read_to_end(&mut buf)
        .map_err(|error| format!("Could not read local media slice: {error}"))?;
    Ok(buf)
}

/// Managed Tauri state holding pooled local media readers.
#[derive(Default)]
pub(crate) struct LocalMediaPools {
    pub(crate) mbtiles: MbtilesConnectionPool,
    pub(crate) files: LocalFilePool,
}

fn canonicalize_allowed_mbtiles(path: &str) -> Result<PathBuf, String> {
    if !crate::is_safe_absolute_path(path) || !path.to_ascii_lowercase().ends_with(".mbtiles") {
        return Err(format!(
            "Refusing to open \"{path}\": not an absolute local MBTiles file path"
        ));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|_| "The selected MBTiles file does not exist".to_string())?;
    let resolved = canonical.to_string_lossy();
    if crate::is_unc_resolved_path(&resolved) {
        return Err(format!(
            "Refusing to open \"{path}\": resolves to a network path"
        ));
    }
    if !resolved.to_ascii_lowercase().ends_with(".mbtiles") || !canonical.is_file() {
        return Err(format!(
            "Refusing to open \"{path}\": resolves to a non-MBTiles file"
        ));
    }
    Ok(canonical)
}

fn canonicalize_scoped_media_path(
    app: &AppHandle,
    path: &str,
    allowed_extensions: &[&str],
) -> Result<PathBuf, String> {
    if !crate::is_safe_absolute_path(path) {
        return Err(format!("Refusing to stream \"{path}\": unsafe path"));
    }
    let lower = path.to_ascii_lowercase();
    if !allowed_extensions.iter().any(|ext| lower.ends_with(ext)) {
        return Err(format!(
            "Refusing to stream \"{path}\": unsupported file extension"
        ));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Could not resolve local media file: {error}"))?;
    let resolved = canonical.to_string_lossy().to_ascii_lowercase();
    if crate::is_unc_resolved_path(&resolved) {
        return Err(format!(
            "Refusing to stream \"{path}\": resolves to a network path"
        ));
    }
    if !allowed_extensions.iter().any(|ext| resolved.ends_with(ext)) || !canonical.is_file() {
        return Err(format!(
            "Refusing to stream \"{path}\": resolves to a disallowed file"
        ));
    }
    let in_fs_scope = app.fs_scope().is_allowed(path) || app.fs_scope().is_allowed(&canonical);
    let in_asset_scope = app.asset_protocol_scope().is_allowed(path)
        || app.asset_protocol_scope().is_allowed(&canonical);
    if !in_fs_scope && !in_asset_scope {
        return Err(format!(
            "Refusing to stream \"{path}\": file has not been authorized by user selection"
        ));
    }
    Ok(canonical)
}

fn query_param_path(url: &tauri::Url) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == "path")
        .map(|(_, value)| value.into_owned())
}

fn parse_mbtiles_uri(uri: &str) -> Result<(String, u32, u32, u32), String> {
    let url = tauri::Url::parse(uri).map_err(|error| format!("Invalid mbtiles URI: {error}"))?;
    let path = query_param_path(&url).ok_or_else(|| "Missing path query parameter".to_string())?;
    let segments: Vec<&str> = url
        .path_segments()
        .map(|segments| segments.filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    if segments.len() != 3 {
        return Err("Expected mbtiles://tile/{z}/{x}/{y}?path=...".to_string());
    }
    let z = segments[0]
        .parse::<u32>()
        .map_err(|_| "Invalid z coordinate".to_string())?;
    let x = segments[1]
        .parse::<u32>()
        .map_err(|_| "Invalid x coordinate".to_string())?;
    let y = segments[2]
        .parse::<u32>()
        .map_err(|_| "Invalid y coordinate".to_string())?;
    Ok((path, z, x, y))
}

fn sniff_tile_content_type(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

fn error_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn cors_preflight_response() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range, Content-Type")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Accept-Ranges, Content-Range, Content-Length",
        )
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Handle a `mbtiles://` custom protocol request asynchronously on the blocking pool.
pub(crate) fn handle_mbtiles_protocol(
    app: AppHandle,
    request: Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    if request.method() == tauri::http::Method::OPTIONS {
        responder.respond(cors_preflight_response());
        return;
    }
    let uri = request.uri().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let response = match parse_mbtiles_uri(&uri) {
            Ok((path, z, x, y)) => {
                let pools = app.state::<LocalMediaPools>();
                match pools.mbtiles.read_tile(&path, z, x, y) {
                    Ok(bytes) if bytes.is_empty() => Response::builder()
                        .status(StatusCode::NO_CONTENT)
                        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                        .body(Vec::new())
                        .unwrap_or_else(|_| Response::new(Vec::new())),
                    Ok(bytes) => {
                        let content_type = sniff_tile_content_type(&bytes);
                        Response::builder()
                            .status(StatusCode::OK)
                            .header(header::CONTENT_TYPE, content_type)
                            .header(header::CACHE_CONTROL, "private, max-age=300")
                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                            .body(bytes)
                            .unwrap_or_else(|_| Response::new(Vec::new()))
                    }
                    Err(error) => error_response(StatusCode::BAD_REQUEST, &error),
                }
            }
            Err(error) => error_response(StatusCode::BAD_REQUEST, &error),
        };
        responder.respond(response);
    });
}

/// Handle a `pmtiles://` or `local-cog://` HTTP byte-range streaming request.
pub(crate) fn handle_range_media_protocol(
    app: AppHandle,
    request: Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
    allowed_extensions: &'static [&'static str],
    content_type: &'static str,
) {
    if request.method() == tauri::http::Method::OPTIONS {
        responder.respond(cors_preflight_response());
        return;
    }
    let is_head = request.method() == tauri::http::Method::HEAD;
    let uri = request.uri().to_string();
    let range_header = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    tauri::async_runtime::spawn_blocking(move || {
        let url = match tauri::Url::parse(&uri) {
            Ok(url) => url,
            Err(error) => {
                responder.respond(error_response(
                    StatusCode::BAD_REQUEST,
                    &format!("Invalid media URI: {error}"),
                ));
                return;
            }
        };
        let Some(path) = query_param_path(&url) else {
            responder.respond(error_response(
                StatusCode::BAD_REQUEST,
                "Missing path query parameter",
            ));
            return;
        };
        let canonical = match canonicalize_scoped_media_path(&app, &path, allowed_extensions) {
            Ok(canonical) => canonical,
            Err(error) => {
                responder.respond(error_response(StatusCode::FORBIDDEN, &error));
                return;
            }
        };
        let pools = app.state::<LocalMediaPools>();
        if is_head {
            match fs::metadata(&canonical) {
                Ok(meta) => {
                    let resp = Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, content_type)
                        .header(header::ACCEPT_RANGES, "bytes")
                        .header(header::CONTENT_LENGTH, meta.len().to_string())
                        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                        .header(
                            header::ACCESS_CONTROL_EXPOSE_HEADERS,
                            "Accept-Ranges, Content-Range, Content-Length",
                        )
                        .body(Vec::new())
                        .unwrap_or_else(|_| Response::new(Vec::new()));
                    responder.respond(resp);
                }
                Err(error) => responder.respond(error_response(
                    StatusCode::NOT_FOUND,
                    &format!("Could not inspect local media file: {error}"),
                )),
            }
            return;
        }

        let response = match pools.files.read_range(&canonical, range_header.as_deref()) {
            Ok(read) => {
                let mut builder = Response::builder()
                    .status(read.status)
                    .header(header::CONTENT_TYPE, content_type)
                    .header(header::ACCEPT_RANGES, "bytes")
                    .header(header::CONTENT_LENGTH, read.bytes.len().to_string())
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .header(
                        header::ACCESS_CONTROL_EXPOSE_HEADERS,
                        "Accept-Ranges, Content-Range, Content-Length",
                    );
                if let Some(content_range) = read.content_range {
                    builder = builder.header(header::CONTENT_RANGE, content_range);
                }
                builder
                    .body(read.bytes)
                    .unwrap_or_else(|_| Response::new(Vec::new()))
            }
            Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &error),
        };
        responder.respond(response);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "geolibre-local-media-{}-{nanos}-{name}",
            std::process::id()
        ))
    }

    #[test]
    fn parse_http_byte_range_handles_standard_and_edge_cases() {
        assert_eq!(parse_http_byte_range(None, 100), RangeParseResult::None);
        assert_eq!(
            parse_http_byte_range(Some("bytes=0-9"), 100),
            RangeParseResult::Satisfiable(ByteRange { start: 0, end: 9 })
        );
        assert_eq!(
            parse_http_byte_range(Some("bytes=90-200"), 100),
            RangeParseResult::Satisfiable(ByteRange { start: 90, end: 99 })
        );
        assert_eq!(
            parse_http_byte_range(Some("bytes=95-"), 100),
            RangeParseResult::Satisfiable(ByteRange { start: 95, end: 99 })
        );
        assert_eq!(
            parse_http_byte_range(Some("bytes=-10"), 100),
            RangeParseResult::Satisfiable(ByteRange { start: 90, end: 99 })
        );
        assert_eq!(
            parse_http_byte_range(Some("bytes=100-105"), 100),
            RangeParseResult::Unsatisfiable
        );
        assert_eq!(
            parse_http_byte_range(Some("bytes=50-40"), 100),
            RangeParseResult::Unsatisfiable
        );
        assert_eq!(
            parse_http_byte_range(Some("bytes=0-1, 2-3"), 100),
            RangeParseResult::Unsatisfiable
        );
        assert_eq!(
            parse_http_byte_range(Some("items=0-5"), 100),
            RangeParseResult::Unsatisfiable
        );
        assert_eq!(
            parse_http_byte_range(Some("bytes=0-0"), 0),
            RangeParseResult::Unsatisfiable
        );
    }

    #[test]
    fn local_file_pool_serves_byte_ranges_and_evicts_lru() {
        let p1 = unique_temp_path("a.pmtiles");
        let p2 = unique_temp_path("b.pmtiles");
        fs::write(&p1, b"0123456789abcdef").unwrap();
        fs::write(&p2, b"ABCDEFGHIJKLMNOP").unwrap();

        let pool = LocalFilePool::with_capacity(1);
        let partial = pool.read_range(&p1, Some("bytes=4-7")).unwrap();
        assert_eq!(partial.status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(partial.bytes, b"4567");
        assert_eq!(partial.content_range.as_deref(), Some("bytes 4-7/16"));
        assert_eq!(pool.len(), 1);

        let full = pool.read_range(&p2, None).unwrap();
        assert_eq!(full.status, StatusCode::OK);
        assert_eq!(full.bytes, b"ABCDEFGHIJKLMNOP");
        // Capacity 1 evicted p1 when p2 was opened.
        assert_eq!(pool.len(), 1);

        let oob = pool.read_range(&p2, Some("bytes=99-120")).unwrap();
        assert_eq!(oob.status, StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(oob.content_range.as_deref(), Some("bytes */16"));

        let _ = fs::remove_file(&p1);
        let _ = fs::remove_file(&p2);
    }

    #[test]
    fn mbtiles_pool_reads_tiles_and_respects_lru_capacity() {
        let p1 = unique_temp_path("one.mbtiles");
        let p2 = unique_temp_path("two.mbtiles");

        for (path, payload) in [(&p1, b"tile-one".as_slice()), (&p2, b"tile-two".as_slice())] {
            let conn = Connection::open(path).unwrap();
            conn.execute_batch(
                "CREATE TABLE metadata (name TEXT, value TEXT);
                 CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
                 INSERT INTO metadata (name, value) VALUES ('scheme', 'xyz');",
            )
            .unwrap();
            let mut encoder =
                flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(payload).unwrap();
            let gz = encoder.finish().unwrap();
            conn.execute(
                "INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (2, 1, 3, ?1)",
                params![gz],
            )
            .unwrap();
        }

        let pool = MbtilesConnectionPool::with_capacity(1);
        assert_eq!(
            pool.read_tile(p1.to_str().unwrap(), 2, 1, 3).unwrap(),
            b"tile-one"
        );
        assert_eq!(pool.len(), 1);
        assert_eq!(
            pool.read_tile(p2.to_str().unwrap(), 2, 1, 3).unwrap(),
            b"tile-two"
        );
        assert_eq!(pool.len(), 1);

        let _ = fs::remove_file(&p1);
        let _ = fs::remove_file(&p2);
    }

    #[test]
    fn parse_mbtiles_uri_validates_coords_and_path() {
        let (path, z, x, y) =
            parse_mbtiles_uri("mbtiles://tile/10/512/341?path=%2Ftmp%2Ftest.mbtiles").unwrap();
        assert_eq!(path, "/tmp/test.mbtiles");
        assert_eq!((z, x, y), (10, 512, 341));
        assert!(parse_mbtiles_uri("mbtiles://tile/10/512").is_err());
        assert!(parse_mbtiles_uri("mbtiles://tile/10/512/341").is_err());
    }
}
