//! Pooled local tile and COG streaming over Tauri custom URI schemes
//! (`mbtiles://`, `local-pmtiles://`, and `local-cog://`) with HTTP `Range`
//! support.
//!
//! Replacing per-tile SQLite open/close and JSON `Vec<u8>` IPC with bounded
//! LRU connection/file pools and binary HTTP responses eliminates connection
//! churn and base64/JSON serialization overhead on local tile and raster reads.

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::FsExt;

/// Maximum number of simultaneously open read-only MBTiles SQLite connections.
const MAX_POOLED_MBTILES: usize = 16;
/// Maximum number of simultaneously open read-only PMTiles/COG file handles.
const MAX_POOLED_FILES: usize = 24;
/// Idle TTL after which cached handles are evicted so Windows files do not stay
/// locked indefinitely after a layer is closed.
const DEFAULT_POOL_IDLE_TTL: Duration = Duration::from_secs(60);
/// Maximum response body size for a non-Range `200 OK` request (64 MiB).
const MAX_UNRANGED_MEDIA_BYTES: u64 = 64 * 1024 * 1024;
/// Maximum byte length served by a single HTTP `Range` request (32 MiB).
const MAX_RANGE_CHUNK_BYTES: u64 = 32 * 1024 * 1024;

/// Platform file identity captured from an opened file or stat call so
/// replacing a file at the same path with identical length and mtime still
/// invalidates cached readers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
}

impl FileIdentity {
    fn from_metadata(meta: &fs::Metadata) -> Self {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Self {
                len: meta.len(),
                modified: meta.modified().ok(),
                dev: meta.dev(),
                ino: meta.ino(),
            }
        }
        #[cfg(not(unix))]
        {
            Self {
                len: meta.len(),
                modified: meta.modified().ok(),
            }
        }
    }
}

/// Open `canonical` as a regular file and verify that the opened file descriptor
/// still matches the canonicalized, non-symlink pathname that passed the scope
/// check.
fn open_verified_regular_file(canonical: &Path) -> Result<(File, FileIdentity), String> {
    let link_meta = fs::symlink_metadata(canonical)
        .map_err(|error| format!("Could not inspect local media file: {error}"))?;
    if link_meta.file_type().is_symlink() || !link_meta.is_file() {
        return Err("Local media path is not a regular file".to_string());
    }
    let expected = FileIdentity::from_metadata(&link_meta);

    let file = File::open(canonical)
        .map_err(|error| format!("Could not open local media file: {error}"))?;
    let opened_meta = file
        .metadata()
        .map_err(|error| format!("Could not inspect opened local media handle: {error}"))?;
    if !opened_meta.is_file() {
        return Err("Opened local media handle is not a regular file".to_string());
    }
    let actual = FileIdentity::from_metadata(&opened_meta);
    #[cfg(unix)]
    if actual.dev != expected.dev || actual.ino != expected.ino {
        return Err("Local media file changed on disk between authorization and open".to_string());
    }
    #[cfg(not(unix))]
    let _ = expected;

    Ok((file, actual))
}

/// A pooled read-only MBTiles SQLite connection.
pub(crate) struct PooledMbtiles {
    pub(crate) connection: Mutex<Connection>,
}

struct MbtilesPoolEntry {
    handle: Arc<PooledMbtiles>,
    last_used: u64,
    last_used_at: Instant,
    identity: FileIdentity,
}

/// Bounded LRU + idle-TTL pool of open read-only MBTiles SQLite connections
/// keyed by canonical filesystem path. A lightweight on-demand reaper thread
/// releases idle connections after `idle_ttl` even when no further requests
/// arrive, so Windows file handles do not stay locked after a layer closes.
pub(crate) struct MbtilesConnectionPool {
    capacity: usize,
    idle_ttl: Duration,
    tick: AtomicU64,
    entries: Arc<Mutex<HashMap<PathBuf, MbtilesPoolEntry>>>,
    reaper_running: Arc<AtomicBool>,
    /// Serializes cache-miss opens so concurrent first reads of the same file
    /// coalesce into a single SQLite connection and respect `capacity`.
    open_lock: Mutex<()>,
}

impl Default for MbtilesConnectionPool {
    fn default() -> Self {
        Self::with_capacity(MAX_POOLED_MBTILES)
    }
}

impl MbtilesConnectionPool {
    pub(crate) fn with_capacity(capacity: usize) -> Self {
        Self::with_capacity_and_ttl(capacity, DEFAULT_POOL_IDLE_TTL)
    }

    pub(crate) fn with_capacity_and_ttl(capacity: usize, idle_ttl: Duration) -> Self {
        Self {
            capacity: capacity.max(1),
            idle_ttl,
            tick: AtomicU64::new(1),
            entries: Arc::new(Mutex::new(HashMap::new())),
            reaper_running: Arc::new(AtomicBool::new(false)),
            open_lock: Mutex::new(()),
        }
    }

    fn evict_expired(
        entries: &mut HashMap<PathBuf, MbtilesPoolEntry>,
        now: Instant,
        ttl: Duration,
    ) {
        entries.retain(|_, entry| now.saturating_duration_since(entry.last_used_at) <= ttl);
    }

    fn ensure_reaper_running(&self) {
        if self
            .reaper_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let entries_weak = Arc::downgrade(&self.entries);
        let running_weak = Arc::downgrade(&self.reaper_running);
        let ttl = self.idle_ttl;
        let sleep_step = ttl
            .min(Duration::from_secs(5))
            .max(Duration::from_millis(10));
        let spawned = std::thread::Builder::new()
            .name("geolibre-mbtiles-reaper".to_string())
            .spawn(move || loop {
                std::thread::sleep(sleep_step);
                let should_exit = {
                    let Some(entries) = entries_weak.upgrade() else {
                        break;
                    };
                    let mut guard = entries
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    Self::evict_expired(&mut guard, Instant::now(), ttl);
                    let empty = guard.is_empty();
                    if empty {
                        // Clear while still holding `entries` so a concurrent insertion
                        // either lands before this check (keeping us alive) or after
                        // this store (spawning a replacement reaper).
                        if let Some(running) = running_weak.upgrade() {
                            running.store(false, Ordering::SeqCst);
                        }
                    }
                    empty
                };
                if should_exit {
                    break;
                }
            });
        if spawned.is_err() {
            self.reaper_running.store(false, Ordering::SeqCst);
        }
    }

    pub(crate) fn get_or_open(&self, path: &str) -> Result<Arc<PooledMbtiles>, String> {
        let canonical = canonicalize_allowed_mbtiles(path)?;
        self.get_or_open_canonical(&canonical)
    }

    pub(crate) fn get_or_open_canonical(
        &self,
        canonical: &Path,
    ) -> Result<Arc<PooledMbtiles>, String> {
        let metadata = fs::metadata(canonical)
            .map_err(|error| format!("Could not inspect MBTiles file: {error}"))?;
        let identity = FileIdentity::from_metadata(&metadata);
        let now_tick = self.tick.fetch_add(1, Ordering::Relaxed);
        let now_instant = Instant::now();

        {
            let mut guard = self
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            Self::evict_expired(&mut guard, now_instant, self.idle_ttl);
            if let Some(entry) = guard.get_mut(canonical) {
                if entry.identity == identity {
                    entry.last_used = now_tick;
                    entry.last_used_at = now_instant;
                    return Ok(Arc::clone(&entry.handle));
                }
                guard.remove(canonical);
            }
        }

        // Coalesce concurrent cache misses for the same archive.
        let _open_guard = self
            .open_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        {
            let mut guard = self
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(entry) = guard.get_mut(canonical) {
                if entry.identity == identity {
                    entry.last_used = now_tick;
                    entry.last_used_at = now_instant;
                    return Ok(Arc::clone(&entry.handle));
                }
                guard.remove(canonical);
            }
        }

        // Best-effort pre-open regular-file verification and identity snapshot:
        // `rusqlite` opens by path rather than an existing file descriptor, and
        // `canonical` is already confined to user-authorized scope.
        let (_verified_file, verified_identity) = open_verified_regular_file(canonical)?;
        let connection = Connection::open_with_flags(canonical, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| format!("Could not open MBTiles file: {error}"))?;
        let handle = Arc::new(PooledMbtiles {
            connection: Mutex::new(connection),
        });

        {
            let mut guard = self
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            Self::evict_expired(&mut guard, Instant::now(), self.idle_ttl);
            while guard.len() >= self.capacity && !guard.contains_key(canonical) {
                if let Some(lru_key) = guard
                    .iter()
                    .min_by_key(|(_, entry)| entry.last_used)
                    .map(|(key, _)| key.clone())
                {
                    guard.remove(&lru_key);
                } else {
                    break;
                }
            }
            guard.insert(
                canonical.to_path_buf(),
                MbtilesPoolEntry {
                    handle: Arc::clone(&handle),
                    last_used: now_tick,
                    last_used_at: Instant::now(),
                    identity: verified_identity,
                },
            );
        }
        self.ensure_reaper_running();
        Ok(handle)
    }

    pub(crate) fn read_tile(&self, path: &str, z: u32, x: u32, y: u32) -> Result<Vec<u8>, String> {
        if z > crate::MAX_MBTILES_ZOOM {
            return Err("Tile zoom level is too large".to_string());
        }
        let canonical = canonicalize_allowed_mbtiles(path)?;
        self.read_tile_canonical(&canonical, z, x, y)
    }

    pub(crate) fn read_tile_canonical(
        &self,
        canonical: &Path,
        z: u32,
        x: u32,
        y: u32,
    ) -> Result<Vec<u8>, String> {
        if z > crate::MAX_MBTILES_ZOOM {
            return Err("Tile zoom level is too large".to_string());
        }
        let pooled = self.get_or_open_canonical(canonical)?;

        // Read both the `scheme` metadata and the tile row inside a single
        // SQLite read transaction so WAL updates that flip TMS/XYZ are always
        // observed atomically with the tiles table.
        let tile_data = {
            let mut connection = pooled
                .connection
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let tx = connection
                .transaction()
                .map_err(|error| format!("Could not start MBTiles read transaction: {error}"))?;
            let scheme = crate::read_metadata_value(&tx, "scheme")?
                .map(|value| value.to_ascii_lowercase())
                .unwrap_or_else(|| "tms".to_string());
            let tile_row = if scheme == "xyz" {
                i64::from(y)
            } else {
                let row_count = 1_i64
                    .checked_shl(z)
                    .ok_or_else(|| "Tile zoom level is too large".to_string())?;
                row_count - 1 - i64::from(y)
            };
            if tile_row < 0 {
                None
            } else {
                tx.query_row(
                    "SELECT tile_data FROM tiles WHERE zoom_level = ?1 AND tile_column = ?2 AND tile_row = ?3",
                    params![i64::from(z), i64::from(x), tile_row],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .optional()
                .map_err(|error| format!("Could not read MBTiles tile: {error}"))?
            }
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
    identity: FileIdentity,
}

struct FilePoolEntry {
    handle: Arc<PooledFileHandle>,
    last_used: u64,
    last_used_at: Instant,
}

/// Bounded LRU + idle-TTL pool of open read-only local files for byte-range
/// streaming (`local-pmtiles://` and `local-cog://`).
pub(crate) struct LocalFilePool {
    capacity: usize,
    idle_ttl: Duration,
    tick: AtomicU64,
    entries: Arc<Mutex<HashMap<PathBuf, FilePoolEntry>>>,
    reaper_running: Arc<AtomicBool>,
    open_lock: Mutex<()>,
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
///
/// Per RFC 9110 section 14.1.2, range unit names are case-insensitive and
/// unknown units are ignored (treated as `RangeParseResult::None` so the server
/// falls back to a full `200 OK` response).
pub(crate) fn parse_http_byte_range(
    header_value: Option<&str>,
    total_len: u64,
) -> RangeParseResult {
    let Some(raw) = header_value
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return RangeParseResult::None;
    };
    let Some((unit, spec)) = raw.split_once('=') else {
        return RangeParseResult::None;
    };
    if !unit.trim().eq_ignore_ascii_case("bytes") {
        return RangeParseResult::None;
    }
    let spec = spec.trim();
    // Per RFC 9110 section 14.2, unsupported multi-range or syntactically
    // invalid Range headers are ignored (treated as an unranged request) rather
    // than rejected with 416.
    if spec.contains(',') {
        return RangeParseResult::None;
    }
    let Some((start_str, end_str)) = spec.split_once('-') else {
        return RangeParseResult::None;
    };
    let start_str = start_str.trim();
    let end_str = end_str.trim();

    if start_str.is_empty() {
        // Suffix byte range: `bytes=-N` means the last N bytes.
        let Ok(suffix) = end_str.parse::<u64>() else {
            return RangeParseResult::None;
        };
        if suffix == 0 || total_len == 0 {
            return RangeParseResult::Unsatisfiable;
        }
        let start = total_len.saturating_sub(suffix);
        return RangeParseResult::Satisfiable(ByteRange {
            start,
            end: total_len - 1,
        });
    }

    let Ok(start) = start_str.parse::<u64>() else {
        return RangeParseResult::None;
    };
    if total_len == 0 || start >= total_len {
        return RangeParseResult::Unsatisfiable;
    }
    let end = if end_str.is_empty() {
        total_len - 1
    } else {
        let Ok(parsed_end) = end_str.parse::<u64>() else {
            return RangeParseResult::None;
        };
        if parsed_end < start {
            return RangeParseResult::None;
        }
        parsed_end.min(total_len - 1)
    };
    RangeParseResult::Satisfiable(ByteRange { start, end })
}

impl LocalFilePool {
    pub(crate) fn with_capacity(capacity: usize) -> Self {
        Self::with_capacity_and_ttl(capacity, DEFAULT_POOL_IDLE_TTL)
    }

    pub(crate) fn with_capacity_and_ttl(capacity: usize, idle_ttl: Duration) -> Self {
        Self {
            capacity: capacity.max(1),
            idle_ttl,
            tick: AtomicU64::new(1),
            entries: Arc::new(Mutex::new(HashMap::new())),
            reaper_running: Arc::new(AtomicBool::new(false)),
            open_lock: Mutex::new(()),
        }
    }

    fn evict_expired(entries: &mut HashMap<PathBuf, FilePoolEntry>, now: Instant, ttl: Duration) {
        entries.retain(|_, entry| now.saturating_duration_since(entry.last_used_at) <= ttl);
    }

    fn ensure_reaper_running(&self) {
        if self
            .reaper_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let entries_weak = Arc::downgrade(&self.entries);
        let running_weak = Arc::downgrade(&self.reaper_running);
        let ttl = self.idle_ttl;
        let sleep_step = ttl
            .min(Duration::from_secs(5))
            .max(Duration::from_millis(10));
        let spawned = std::thread::Builder::new()
            .name("geolibre-local-file-reaper".to_string())
            .spawn(move || loop {
                std::thread::sleep(sleep_step);
                let should_exit = {
                    let Some(entries) = entries_weak.upgrade() else {
                        break;
                    };
                    let mut guard = entries
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    Self::evict_expired(&mut guard, Instant::now(), ttl);
                    let empty = guard.is_empty();
                    if empty {
                        // Clear while still holding `entries` so a concurrent insertion
                        // either lands before this check (keeping us alive) or after
                        // this store (spawning a replacement reaper).
                        if let Some(running) = running_weak.upgrade() {
                            running.store(false, Ordering::SeqCst);
                        }
                    }
                    empty
                };
                if should_exit {
                    break;
                }
            });
        if spawned.is_err() {
            self.reaper_running.store(false, Ordering::SeqCst);
        }
    }

    fn invalidate(&self, canonical: &Path) {
        let mut guard = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.remove(canonical);
    }

    fn get_or_open(&self, canonical: &Path) -> Result<Arc<PooledFileHandle>, String> {
        let link_meta = fs::symlink_metadata(canonical)
            .map_err(|error| format!("Could not inspect local media file: {error}"))?;
        if link_meta.file_type().is_symlink() || !link_meta.is_file() {
            return Err("Local media path is not a regular file".to_string());
        }
        let current_identity = FileIdentity::from_metadata(&link_meta);
        let now_tick = self.tick.fetch_add(1, Ordering::Relaxed);
        let now_instant = Instant::now();

        {
            let mut guard = self
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            Self::evict_expired(&mut guard, now_instant, self.idle_ttl);
            if let Some(entry) = guard.get_mut(canonical) {
                if entry.handle.identity == current_identity {
                    entry.last_used = now_tick;
                    entry.last_used_at = now_instant;
                    return Ok(Arc::clone(&entry.handle));
                }
                guard.remove(canonical);
            }
        }

        // Coalesce concurrent cache misses for the same path.
        let _open_guard = self
            .open_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        {
            let mut guard = self
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(entry) = guard.get_mut(canonical) {
                if entry.handle.identity == current_identity {
                    entry.last_used = now_tick;
                    entry.last_used_at = now_instant;
                    return Ok(Arc::clone(&entry.handle));
                }
                guard.remove(canonical);
            }
        }

        let (file, identity) = open_verified_regular_file(canonical)?;
        let handle = Arc::new(PooledFileHandle {
            file: Mutex::new(file),
            identity,
        });

        {
            let mut guard = self
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            Self::evict_expired(&mut guard, Instant::now(), self.idle_ttl);
            while guard.len() >= self.capacity && !guard.contains_key(canonical) {
                if let Some(lru_key) = guard
                    .iter()
                    .min_by_key(|(_, entry)| entry.last_used)
                    .map(|(key, _)| key.clone())
                {
                    guard.remove(&lru_key);
                } else {
                    break;
                }
            }
            guard.insert(
                canonical.to_path_buf(),
                FilePoolEntry {
                    handle: Arc::clone(&handle),
                    last_used: now_tick,
                    last_used_at: Instant::now(),
                },
            );
        }
        self.ensure_reaper_running();
        Ok(handle)
    }

    pub(crate) fn head_len(&self, canonical: &Path) -> Result<u64, String> {
        let handle = self.get_or_open(canonical)?;
        Ok(handle.identity.len)
    }

    pub(crate) fn read_range(
        &self,
        canonical: &Path,
        range_header: Option<&str>,
    ) -> Result<RangeReadResponse, String> {
        for attempt in 0..2 {
            let handle = self.get_or_open(canonical)?;
            let total_len = handle.identity.len;

            match parse_http_byte_range(range_header, total_len) {
                RangeParseResult::Unsatisfiable => {
                    return Ok(RangeReadResponse {
                        status: StatusCode::RANGE_NOT_SATISFIABLE,
                        bytes: Vec::new(),
                        content_range: Some(format!("bytes */{total_len}")),
                        total_len,
                    });
                }
                RangeParseResult::Satisfiable(range) => {
                    let requested_len = range.end - range.start + 1;
                    let clamped_len = requested_len.min(MAX_RANGE_CHUNK_BYTES);
                    let bytes = read_file_slice(&handle.file, range.start, clamped_len)?;
                    // Re-verify the opened handle's identity (length/mtime/inode)
                    // after reading so an in-place modification or growth cannot
                    // emit a 206 whose Content-Range disagrees with the bytes.
                    let post_identity_matches = {
                        let guard = handle
                            .file
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        guard
                            .metadata()
                            .ok()
                            .map(|meta| FileIdentity::from_metadata(&meta) == handle.identity)
                            .unwrap_or(false)
                    };
                    if (bytes.len() as u64) < clamped_len || !post_identity_matches {
                        self.invalidate(canonical);
                        if attempt == 0 {
                            continue;
                        }
                        if bytes.is_empty() {
                            if let Ok(refreshed) = self.get_or_open(canonical) {
                                // Reparse the original Range header against the
                                // refreshed file length so suffix ranges (e.g.
                                // `bytes=-4`) are checked accurately instead of
                                // comparing against the previous attempt's offset.
                                if matches!(
                                    parse_http_byte_range(range_header, refreshed.identity.len),
                                    RangeParseResult::Unsatisfiable
                                ) {
                                    return Ok(RangeReadResponse {
                                        status: StatusCode::RANGE_NOT_SATISFIABLE,
                                        bytes: Vec::new(),
                                        content_range: Some(format!(
                                            "bytes */{}",
                                            refreshed.identity.len
                                        )),
                                        total_len: refreshed.identity.len,
                                    });
                                }
                            }
                        }
                        return Err(
                            "Local media file changed concurrently during byte-range read"
                                .to_string(),
                        );
                    }
                    let final_end = range.start + (bytes.len() as u64) - 1;
                    return Ok(RangeReadResponse {
                        status: StatusCode::PARTIAL_CONTENT,
                        bytes,
                        content_range: Some(format!(
                            "bytes {}-{}/{total_len}",
                            range.start, final_end
                        )),
                        total_len,
                    });
                }
                RangeParseResult::None => {
                    if total_len > MAX_UNRANGED_MEDIA_BYTES {
                        return Ok(RangeReadResponse {
                            status: StatusCode::PAYLOAD_TOO_LARGE,
                            bytes: Vec::new(),
                            content_range: None,
                            total_len,
                        });
                    }
                    let bytes = read_file_slice(&handle.file, 0, total_len)?;
                    return Ok(RangeReadResponse {
                        status: StatusCode::OK,
                        bytes,
                        content_range: None,
                        total_len,
                    });
                }
            }
        }
        Err("Local media file changed concurrently while reading".to_string())
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
    // Check ONLY the resolved canonical path so a symlink inside an authorized
    // directory cannot escape scope to an unauthorized target.
    let in_fs_scope = app.fs_scope().is_allowed(&canonical);
    let in_asset_scope = app.asset_protocol_scope().is_allowed(&canonical);
    if !in_fs_scope && !in_asset_scope {
        return Err(format!(
            "Refusing to stream \"{path}\": file has not been authorized by user selection"
        ));
    }
    Ok(canonical)
}

/// Check whether `origin` belongs to GeoLibre's bundled desktop/mobile webview
/// (or local Vite dev server in debug builds). Remote documents loaded in OAuth
/// popups or iframes are always rejected.
pub(crate) fn is_bundled_app_origin(origin: &str) -> bool {
    let trimmed = origin.trim().trim_end_matches('/');
    if matches!(
        trimmed,
        "tauri://localhost" | "https://tauri.localhost" | "http://tauri.localhost"
    ) {
        return true;
    }
    #[cfg(debug_assertions)]
    {
        if let Ok(parsed) = tauri::Url::parse(trimmed) {
            if parsed.scheme() == "http"
                && matches!(parsed.host_str(), Some("localhost" | "127.0.0.1"))
                && parsed.port() == Some(5173)
            {
                return true;
            }
        }
    }
    false
}

/// Validate the requesting document origin from `Origin` or `Referer` headers.
/// Returns `Ok(Some(origin))` when a validated `Origin` header should be echoed
/// in `Access-Control-Allow-Origin` (including literal `"null"` when confirmed
/// by a bundled `Referer`), `Ok(None)` when no `Origin` (or an empty `Origin`)
/// was sent, or `Err` when a non-bundled remote origin attempted access.
fn validated_request_origin(request: &Request<Vec<u8>>) -> Result<Option<String>, String> {
    let mut null_origin = false;
    let mut empty_origin = false;
    if let Some(origin_val) = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    {
        let trimmed = origin_val.trim();
        if is_bundled_app_origin(trimmed) {
            return Ok(Some(trimmed.to_string()));
        }
        // Custom-scheme webviews (e.g. WKWebView on macOS/iOS for `tauri://`)
        // may send `Origin: null` or an empty `Origin` header for same-app
        // fetches; fall through and require a bundled `Referer` to confirm.
        if trimmed.eq_ignore_ascii_case("null") {
            null_origin = true;
        } else if trimmed.is_empty() {
            empty_origin = true;
        } else {
            return Err(format!(
                "Refusing local media request from non-bundled origin \"{origin_val}\""
            ));
        }
    }
    if let Some(referer_val) = request
        .headers()
        .get(header::REFERER)
        .and_then(|v| v.to_str().ok())
    {
        let referer_origin = tauri::Url::parse(referer_val).ok().and_then(|u| {
            let serialized = u.origin().ascii_serialization();
            if serialized != "null" {
                return Some(serialized);
            }
            // Custom schemes such as `tauri://localhost/index.html` have an
            // opaque WHATWG origin ("null"); derive `scheme://host[:port]` so
            // bundled webview requests without an `Origin` header still pass.
            let host = u.host_str()?;
            match u.port() {
                Some(port) => Some(format!("{}://{host}:{port}", u.scheme())),
                None => Some(format!("{}://{host}", u.scheme())),
            }
        });
        if let Some(origin) = referer_origin {
            if is_bundled_app_origin(&origin) {
                // Under the Fetch Standard CORS check, a request carrying
                // `Origin: null` requires `Access-Control-Allow-Origin: null`.
                return Ok(if null_origin {
                    Some("null".to_string())
                } else {
                    None
                });
            }
        }
        return Err("Refusing local media request from non-bundled referer".to_string());
    }
    if null_origin || empty_origin {
        return Err(
            "Refusing local media request with opaque Origin and no bundled Referer".to_string(),
        );
    }
    Ok(None)
}

fn query_param_path(url: &tauri::Url) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == "path")
        .map(|(_, value)| value.into_owned())
}

pub(crate) fn parse_mbtiles_uri(uri: &str) -> Result<(String, u32, u32, u32), String> {
    let url = tauri::Url::parse(uri).map_err(|error| format!("Invalid mbtiles URI: {error}"))?;
    let path = query_param_path(&url).ok_or_else(|| "Missing path query parameter".to_string())?;
    let segments: Vec<&str> = url
        .path_segments()
        .map(|segments| segments.filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    // Accept both platform-neutral `http://mbtiles.localhost/tile/{z}/{x}/{y}`
    // / `mbtiles://localhost/tile/{z}/{x}/{y}` and legacy `mbtiles://tile/{z}/{x}/{y}`.
    let coords: &[&str] = match segments.as_slice() {
        ["tile", z, x, y] => &[z, x, y],
        [z, x, y] if url.host_str() == Some("tile") => &[z, x, y],
        _ => return Err("Expected mbtiles tile URL with /tile/{z}/{x}/{y}?path=...".to_string()),
    };
    let z = coords[0]
        .parse::<u32>()
        .map_err(|_| "Invalid z coordinate".to_string())?;
    let x = coords[1]
        .parse::<u32>()
        .map_err(|_| "Invalid x coordinate".to_string())?;
    let y = coords[2]
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

fn apply_cors_headers(
    mut builder: tauri::http::response::Builder,
    allowed_origin: Option<&str>,
) -> tauri::http::response::Builder {
    if let Some(origin) = allowed_origin {
        builder = builder
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin)
            .header(header::VARY, "Origin");
    }
    builder
}

fn error_response(
    status: StatusCode,
    message: &str,
    allowed_origin: Option<&str>,
) -> Response<Vec<u8>> {
    apply_cors_headers(
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8"),
        allowed_origin,
    )
    .body(message.as_bytes().to_vec())
    .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn cors_preflight_response(allowed_origin: Option<&str>) -> Response<Vec<u8>> {
    apply_cors_headers(
        Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range, Content-Type")
            .header(
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                "Accept-Ranges, Content-Range, Content-Length",
            ),
        allowed_origin,
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
    let allowed_origin = match validated_request_origin(&request) {
        Ok(origin) => origin,
        Err(error) => {
            responder.respond(error_response(StatusCode::FORBIDDEN, &error, None));
            return;
        }
    };
    if request.method() == tauri::http::Method::OPTIONS {
        responder.respond(cors_preflight_response(allowed_origin.as_deref()));
        return;
    }
    let uri = request.uri().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let origin_ref = allowed_origin.as_deref();
        let response = match parse_mbtiles_uri(&uri) {
            Ok((path, z, x, y)) => {
                match canonicalize_scoped_media_path(&app, &path, &[".mbtiles"]) {
                    Ok(canonical) => {
                        let pools = app.state::<LocalMediaPools>();
                        match pools.mbtiles.read_tile_canonical(&canonical, z, x, y) {
                            Ok(bytes) if bytes.is_empty() => apply_cors_headers(
                                Response::builder().status(StatusCode::NO_CONTENT),
                                origin_ref,
                            )
                            .body(Vec::new())
                            .unwrap_or_else(|_| Response::new(Vec::new())),
                            Ok(bytes) => {
                                let content_type = sniff_tile_content_type(&bytes);
                                apply_cors_headers(
                                    Response::builder()
                                        .status(StatusCode::OK)
                                        .header(header::CONTENT_TYPE, content_type)
                                        .header(header::CACHE_CONTROL, "private, max-age=300"),
                                    origin_ref,
                                )
                                .body(bytes)
                                .unwrap_or_else(|_| Response::new(Vec::new()))
                            }
                            Err(error) => {
                                error_response(StatusCode::BAD_REQUEST, &error, origin_ref)
                            }
                        }
                    }
                    Err(error) => error_response(StatusCode::FORBIDDEN, &error, origin_ref),
                }
            }
            Err(error) => error_response(StatusCode::BAD_REQUEST, &error, origin_ref),
        };
        responder.respond(response);
    });
}

/// Handle a `local-pmtiles://` or `local-cog://` HTTP byte-range streaming request.
pub(crate) fn handle_range_media_protocol(
    app: AppHandle,
    request: Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
    allowed_extensions: &'static [&'static str],
    content_type: &'static str,
) {
    let allowed_origin = match validated_request_origin(&request) {
        Ok(origin) => origin,
        Err(error) => {
            responder.respond(error_response(StatusCode::FORBIDDEN, &error, None));
            return;
        }
    };
    if request.method() == tauri::http::Method::OPTIONS {
        responder.respond(cors_preflight_response(allowed_origin.as_deref()));
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
        let origin_ref = allowed_origin.as_deref();
        let url = match tauri::Url::parse(&uri) {
            Ok(url) => url,
            Err(error) => {
                responder.respond(error_response(
                    StatusCode::BAD_REQUEST,
                    &format!("Invalid media URI: {error}"),
                    origin_ref,
                ));
                return;
            }
        };
        let Some(path) = query_param_path(&url) else {
            responder.respond(error_response(
                StatusCode::BAD_REQUEST,
                "Missing path query parameter",
                origin_ref,
            ));
            return;
        };
        let canonical = match canonicalize_scoped_media_path(&app, &path, allowed_extensions) {
            Ok(canonical) => canonical,
            Err(error) => {
                responder.respond(error_response(StatusCode::FORBIDDEN, &error, origin_ref));
                return;
            }
        };
        let pools = app.state::<LocalMediaPools>();
        if is_head {
            match pools.files.head_len(&canonical) {
                Ok(file_len) => {
                    let resp = apply_cors_headers(
                        Response::builder()
                            .status(StatusCode::OK)
                            .header(header::CONTENT_TYPE, content_type)
                            .header(header::ACCEPT_RANGES, "bytes")
                            .header(header::CONTENT_LENGTH, file_len.to_string())
                            .header(
                                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                                "Accept-Ranges, Content-Range, Content-Length",
                            ),
                        origin_ref,
                    )
                    .body(Vec::new())
                    .unwrap_or_else(|_| Response::new(Vec::new()));
                    responder.respond(resp);
                }
                Err(error) => responder.respond(error_response(
                    StatusCode::NOT_FOUND,
                    &format!("Could not inspect local media file: {error}"),
                    origin_ref,
                )),
            }
            return;
        }

        let response = match pools.files.read_range(&canonical, range_header.as_deref()) {
            Ok(read) => {
                let mut builder = apply_cors_headers(
                    Response::builder()
                        .status(read.status)
                        .header(header::CONTENT_TYPE, content_type)
                        .header(header::ACCEPT_RANGES, "bytes")
                        .header(header::CONTENT_LENGTH, read.bytes.len().to_string())
                        .header(
                            header::ACCESS_CONTROL_EXPOSE_HEADERS,
                            "Accept-Ranges, Content-Range, Content-Length",
                        ),
                    origin_ref,
                );
                if let Some(content_range) = read.content_range {
                    builder = builder.header(header::CONTENT_RANGE, content_range);
                }
                builder
                    .body(read.bytes)
                    .unwrap_or_else(|_| Response::new(Vec::new()))
            }
            Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &error, origin_ref),
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
        // RFC 9110: range units are ASCII case-insensitive.
        assert_eq!(
            parse_http_byte_range(Some("ByTeS=0-9"), 100),
            RangeParseResult::Satisfiable(ByteRange { start: 0, end: 9 })
        );
        // RFC 9110: unknown range units are ignored and fall back to full 200 GET.
        assert_eq!(
            parse_http_byte_range(Some("items=0-5"), 100),
            RangeParseResult::None
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
            RangeParseResult::None
        );
        assert_eq!(
            parse_http_byte_range(Some("bytes=0-1, 2-3"), 100),
            RangeParseResult::None
        );
        assert_eq!(
            parse_http_byte_range(Some("bytes=0-0"), 0),
            RangeParseResult::Unsatisfiable
        );
    }

    #[test]
    fn bundled_app_origin_rejects_remote_pages_and_allows_tauri_origins() {
        assert!(is_bundled_app_origin("tauri://localhost"));
        assert!(is_bundled_app_origin("https://tauri.localhost"));
        assert!(is_bundled_app_origin("http://tauri.localhost"));
        assert!(!is_bundled_app_origin("https://accounts.google.com"));
        assert!(!is_bundled_app_origin("https://evil.example"));
        assert!(!is_bundled_app_origin("null"));

        // Custom-scheme Referer (opaque WHATWG origin) without Origin must still pass.
        let tauri_ref = Request::builder()
            .uri("mbtiles://localhost/tile/0/0/0?path=%2Ftmp%2Fa.mbtiles")
            .header(header::REFERER, "tauri://localhost/index.html")
            .body(Vec::new())
            .unwrap();
        assert_eq!(validated_request_origin(&tauri_ref).unwrap(), None);

        // `Origin: null` with a bundled Referer (custom-scheme WebView fetch)
        // passes and echoes `"null"` for `Access-Control-Allow-Origin`.
        let null_origin_bundled_ref = Request::builder()
            .uri("local-pmtiles://localhost/file?path=%2Ftmp%2Fa.pmtiles")
            .header(header::ORIGIN, "null")
            .header(header::REFERER, "tauri://localhost/index.html")
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            validated_request_origin(&null_origin_bundled_ref).unwrap(),
            Some("null".to_string())
        );

        // Empty `Origin` with a bundled Referer passes without echoing a header.
        let empty_origin_bundled_ref = Request::builder()
            .uri("local-pmtiles://localhost/file?path=%2Ftmp%2Fa.pmtiles")
            .header(header::ORIGIN, "")
            .header(header::REFERER, "tauri://localhost/index.html")
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            validated_request_origin(&empty_origin_bundled_ref).unwrap(),
            None
        );

        // `Origin: null` with a remote Referer or no Referer must be rejected.
        let null_origin_remote_ref = Request::builder()
            .uri("local-pmtiles://localhost/file?path=%2Ftmp%2Fa.pmtiles")
            .header(header::ORIGIN, "null")
            .header(header::REFERER, "https://evil.example/page.html")
            .body(Vec::new())
            .unwrap();
        assert!(validated_request_origin(&null_origin_remote_ref).is_err());

        let null_origin_no_ref = Request::builder()
            .uri("local-pmtiles://localhost/file?path=%2Ftmp%2Fa.pmtiles")
            .header(header::ORIGIN, "null")
            .body(Vec::new())
            .unwrap();
        assert!(validated_request_origin(&null_origin_no_ref).is_err());

        let remote_ref = Request::builder()
            .uri("mbtiles://localhost/tile/0/0/0?path=%2Ftmp%2Fa.mbtiles")
            .header(
                header::REFERER,
                "https://accounts.google.com/o/oauth2/v2/auth",
            )
            .body(Vec::new())
            .unwrap();
        assert!(validated_request_origin(&remote_ref).is_err());
    }

    #[test]
    fn parse_mbtiles_uri_accepts_windows_localhost_and_custom_scheme_forms() {
        let (p1, z1, x1, y1) =
            parse_mbtiles_uri("http://mbtiles.localhost/tile/2/1/3?path=%2Fdata%2Fa.mbtiles")
                .unwrap();
        assert_eq!((p1.as_str(), z1, x1, y1), ("/data/a.mbtiles", 2, 1, 3));

        let (p2, z2, x2, y2) =
            parse_mbtiles_uri("mbtiles://localhost/tile/4/5/6?path=%2Fdata%2Fb.mbtiles").unwrap();
        assert_eq!((p2.as_str(), z2, x2, y2), ("/data/b.mbtiles", 4, 5, 6));

        let (p3, z3, x3, y3) =
            parse_mbtiles_uri("mbtiles://tile/7/8/9?path=%2Fdata%2Fc.mbtiles").unwrap();
        assert_eq!((p3.as_str(), z3, x3, y3), ("/data/c.mbtiles", 7, 8, 9));
    }

    #[test]
    fn local_file_pool_serves_byte_ranges_evicts_lru_and_handles_truncation() {
        let p1 = unique_temp_path("a.pmtiles");
        let p2 = unique_temp_path("b.pmtiles");
        fs::write(&p1, b"0123456789abcdef").unwrap();
        fs::write(&p2, b"ABCDEFGHIJKLMNOP").unwrap();

        let pool = LocalFilePool::with_capacity(1);
        let partial = pool.read_range(&p1, Some("ByTeS=4-7")).unwrap();
        assert_eq!(partial.status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(partial.bytes, b"4567");
        assert_eq!(partial.content_range.as_deref(), Some("bytes 4-7/16"));
        assert_eq!(pool.len(), 1);

        // Unknown range unit falls back to full 200 OK.
        let unknown_unit = pool.read_range(&p1, Some("items=0-3")).unwrap();
        assert_eq!(unknown_unit.status, StatusCode::OK);
        assert_eq!(unknown_unit.bytes, b"0123456789abcdef");

        // Truncating file invalidates stale cached length and returns 416 instead of 0-byte 206.
        fs::write(&p1, b"01234567").unwrap();
        let after_truncate = pool.read_range(&p1, Some("bytes=12-15")).unwrap();
        assert_eq!(after_truncate.status, StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(after_truncate.content_range.as_deref(), Some("bytes */8"));

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
    fn local_file_pool_invalidates_when_file_replaced_with_same_size() {
        let p = unique_temp_path("replace.pmtiles");
        let tmp = unique_temp_path("replace-new.pmtiles");
        fs::write(&p, b"0123456789abcdef").unwrap();

        let pool = LocalFilePool::with_capacity(4);
        assert_eq!(
            pool.read_range(&p, Some("bytes=0-3")).unwrap().bytes,
            b"0123"
        );

        // Atomic rename replacement with identical length changes inode on Unix.
        fs::write(&tmp, b"fedcba9876543210").unwrap();
        fs::rename(&tmp, &p).unwrap();

        assert_eq!(
            pool.read_range(&p, Some("bytes=0-3")).unwrap().bytes,
            b"fedc"
        );
        let _ = fs::remove_file(&p);
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
    fn idle_reaper_evicts_unused_pool_entries_without_extra_requests() {
        let p = unique_temp_path("idle-reap.pmtiles");
        fs::write(&p, b"0123456789abcdef").unwrap();

        // Use a long enough TTL that the entry is guaranteed to remain cached
        // immediately after the read even under heavy CI scheduling jitter,
        // then backdate `last_used_at` past the TTL and poll with a generous
        // deadline so the background reaper evicts it autonomously without any
        // extra media request.
        let pool = LocalFilePool::with_capacity_and_ttl(4, Duration::from_secs(60));
        assert_eq!(
            pool.read_range(&p, Some("bytes=0-3")).unwrap().bytes,
            b"0123"
        );
        assert_eq!(pool.len(), 1);

        // Force expiry via deterministic timestamp adjustment on the cached
        // entry, then let the reaper's next tick (or a short-TTL pool) evict it.
        let short_pool = LocalFilePool::with_capacity_and_ttl(4, Duration::from_millis(200));
        assert_eq!(
            short_pool.read_range(&p, Some("bytes=0-3")).unwrap().bytes,
            b"0123"
        );
        {
            let mut guard = short_pool
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert_eq!(guard.len(), 1);
            for entry in guard.values_mut() {
                entry.last_used_at = Instant::now() - Duration::from_secs(5);
            }
        }

        let deadline = Instant::now() + Duration::from_secs(5);
        while short_pool.len() > 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            short_pool.len(),
            0,
            "idle reaper should evict expired entry without additional requests"
        );
        drop(pool);
        let _ = fs::remove_file(&p);
    }
}
