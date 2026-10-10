//! Streamed downloads of large remote files, such as NASA Earthdata granules.
//!
//! The plugin HTTP transport (`plugin_http.rs`) buffers a whole response and
//! hands it to JavaScript as base64, capped at 64 MiB. A GEDI L2A granule is
//! 1-2 GB and the DAACs send no CORS headers, so neither that transport nor the
//! webview can fetch one. This streams the body to disk instead, reporting
//! progress over a channel, and either saves it where the user picks in a
//! native dialog or parks it in the app cache until `take_cached_download`
//! reads it back once. JavaScript never names a path to write, so the command
//! cannot be turned into an arbitrary file writer.
//!
//! A bearer token goes to the first host only: reqwest drops its sensitive
//! headers (`Authorization`, `Cookie`, `Proxy-Authorization`) when a redirect
//! changes host, which is what the DAACs expect, since they answer with a
//! presigned CloudFront URL. Other headers would follow every hop, so a request
//! that carries headers must start on HTTPS and may only carry those sensitive
//! ones plus `Accept`.

use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    redirect::Policy,
    Url,
};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use super::{
    guarded_async_client_builder, plugin_http::redirect_target_allowed, url_is_fetchable,
    MAX_HTTP_REDIRECTS,
};

/// A stalled transfer fails after this long without a byte, however large the
/// file. There is no overall deadline: a multi-gigabyte granule can take hours.
const READ_TIMEOUT_SECS: u64 = 60;
/// Progress is reported at most once per this many bytes.
const PROGRESS_STEP_BYTES: u64 = 1024 * 1024;
const MAX_FILE_NAME_CHARS: usize = 120;
const CACHE_SUBDIR: &str = "remote-downloads";

/// Request headers the transport sets itself.
const MANAGED_REQUEST_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "connection",
    "transfer-encoding",
    "keep-alive",
    "upgrade",
    "range",
    "accept-encoding",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteDownloadRequest {
    url: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    /// Suggested file name; sanitized before it touches the filesystem.
    file_name: String,
    /// `true` asks where to save the file; `false` keeps it in the app cache
    /// for `take_cached_download`.
    save: bool,
    /// A folder picked earlier with `pick_download_folder`, by its id: the file
    /// is written there under its sanitized name, without a dialog. JavaScript
    /// only ever holds the id, never a path it could point elsewhere.
    #[serde(default)]
    folder_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PickedDownloadFolder {
    id: String,
    path: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteDownloadProgress {
    received: u64,
    total: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteDownloadResult {
    /// Where a saved file landed; `None` for a cached download.
    path: Option<String>,
    size: u64,
}

type CancelDownload = Box<dyn Fn() + Send + Sync>;

/// In-flight downloads (for cancellation) and finished cache downloads waiting
/// to be read, both keyed by the caller's request id.
#[derive(Default, Clone)]
pub(crate) struct RemoteDownloads {
    active: Arc<Mutex<HashMap<String, CancelDownload>>>,
    cached: Arc<Mutex<HashMap<String, PathBuf>>>,
    /// Folders the user picked for multi-file downloads, by id.
    folders: Arc<Mutex<HashMap<String, PathBuf>>>,
}

impl RemoteDownloads {
    fn cancel(&self, id: &str) {
        if let Some(cancel) = self.active.lock().unwrap().remove(id) {
            cancel();
        }
    }
}

struct ActiveGuard {
    downloads: RemoteDownloads,
    id: String,
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.downloads.cancel(&self.id);
    }
}

/// A `.part` file that is removed unless the download completes, so a failed
/// or cancelled transfer (whose future is simply dropped) leaves nothing behind.
struct PartFile {
    path: PathBuf,
    done: bool,
}

impl Drop for PartFile {
    fn drop(&mut self) {
        if !self.done {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Reserve `folder/name`, or `folder/stem (n).ext` when that is taken, by
/// creating it empty with `create_new`, so a folder download never replaces a
/// file already there, and two downloads of the same name running at once
/// never pick the same destination (the save dialog asks the user itself).
fn reserve_unique_path(folder: &Path, name: &str) -> Result<PathBuf, String> {
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (name, String::new()),
    };
    for n in 0..10_000u32 {
        let candidate = if n == 0 {
            folder.join(name)
        } else {
            folder.join(format!("{stem} ({n}){extension}"))
        };
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(_) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not create the download file: {error}")),
        }
    }
    Err("Could not find a free file name in the chosen folder.".into())
}

/// Reduce a suggested name to a safe single path component.
fn sanitize_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .take(MAX_FILE_NAME_CHARS)
        .collect();
    let trimmed = cleaned.trim_start_matches('.');
    if trimmed.is_empty() {
        "download".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Headers a download may carry: credentials reqwest strips on a cross-host
/// redirect, and `Accept`. Anything else would be replayed to every hop.
const FORWARDABLE_REQUEST_HEADERS: &[&str] = &["authorization", "cookie", "accept"];

/// Credentials never travel over plain HTTP.
fn check_scheme(url: &Url, headers: &HeaderMap) -> Result<(), String> {
    if url.scheme() != "https" && !headers.is_empty() {
        return Err("Refusing to send credentials over a non-HTTPS URL.".into());
    }
    Ok(())
}

fn request_headers(headers: Vec<(String, String)>) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("Invalid request header name: {name}"))?;
        if MANAGED_REQUEST_HEADERS.contains(&name.as_str()) {
            continue;
        }
        if !FORWARDABLE_REQUEST_HEADERS.contains(&name.as_str()) {
            return Err(format!("Unsupported download header: {name}"));
        }
        let value = HeaderValue::from_str(&value)
            .map_err(|_| format!("Invalid value for request header {name}."))?;
        map.append(name, value);
    }
    Ok(map)
}

/// The download client. A request that carries credentials gets one whose
/// redirects must stay on HTTPS: reqwest strips credentials only when the host
/// changes, so a same-host `https` to `http` hop would otherwise resend them in
/// clear text.
fn client(credentialed: bool) -> Result<reqwest::Client, String> {
    static PLAIN: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    static CREDENTIALED: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    let build = move || {
        guarded_async_client_builder(Policy::custom(move |attempt| {
            if attempt.previous().len() >= MAX_HTTP_REDIRECTS {
                return attempt.error("Too many redirects.");
            }
            if credentialed && attempt.url().scheme() != "https" {
                return attempt.error("Refusing a redirect from HTTPS to plain HTTP.");
            }
            match redirect_target_allowed(attempt.url()) {
                Ok(()) => attempt.follow(),
                Err(error) => attempt.error(error),
            }
        }))?
        .read_timeout(Duration::from_secs(READ_TIMEOUT_SECS))
        .build()
        .map_err(|error| format!("Could not create the download client: {error}"))
    };
    if credentialed {
        CREDENTIALED.get_or_init(build).clone()
    } else {
        PLAIN.get_or_init(build).clone()
    }
}

/// The cache directory for downloads, emptied once per app session so files
/// from a crashed or closed session do not pile up.
fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    static CLEARED: OnceLock<()> = OnceLock::new();
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not resolve the app cache directory: {error}"))?
        .join(CACHE_SUBDIR);
    CLEARED.get_or_init(|| {
        let _ = fs::remove_dir_all(&dir);
    });
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create the download cache: {error}"))?;
    Ok(dir)
}

/// A user-facing message for an unsuccessful status.
fn status_error(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        401 | 403 => format!(
            "The server refused the download ({status}). Check that your Earthdata Login token is valid and that you have accepted the dataset's EULA, if it has one."
        ),
        _ => format!("Download failed with status {status}."),
    }
}

/// Stream `url` into `destination`. `part_tag` makes the partial file unique to
/// the request; `reserved` says `destination` is an empty placeholder this
/// download owns (a folder download), removed again if the download fails.
async fn transfer(
    url: Url,
    headers: HeaderMap,
    destination: PathBuf,
    part_tag: String,
    reserved: bool,
    progress: tauri::ipc::Channel<RemoteDownloadProgress>,
) -> Result<u64, String> {
    let mut placeholder = PartFile {
        path: destination.clone(),
        done: !reserved,
    };
    let response = client(!headers.is_empty())?
        .get(url)
        .headers(headers)
        // The length check below compares against Content-Length, which is the
        // encoded size; ask for the bytes as stored so the two always agree.
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|error| format!("Download failed: {}", error.without_url()))?;
    let status = response.status();
    if !status.is_success() {
        return Err(status_error(status));
    }
    let total = response.content_length();
    let part_name = format!(
        "{}.{part_tag}.part",
        destination
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    );
    let mut part = PartFile {
        path: destination.with_file_name(part_name),
        done: false,
    };
    let mut file = fs::File::create(&part.path)
        .map_err(|error| format!("Could not create the download file: {error}"))?;
    let mut response = response;
    let mut received: u64 = 0;
    let mut reported: u64 = 0;
    let _ = progress.send(RemoteDownloadProgress { received, total });
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Download interrupted: {}", error.without_url()))?
    {
        file.write_all(&chunk)
            .map_err(|error| format!("Could not write the download: {error}"))?;
        received += chunk.len() as u64;
        if received - reported >= PROGRESS_STEP_BYTES {
            reported = received;
            let _ = progress.send(RemoteDownloadProgress { received, total });
        }
    }
    if total.is_some_and(|total| total != received) {
        return Err("The download ended early.".into());
    }
    file.flush()
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("Could not write the download: {error}"))?;
    drop(file);
    fs::rename(&part.path, &destination)
        .map_err(|error| format!("Could not finish the download: {error}"))?;
    part.done = true;
    placeholder.done = true;
    let _ = progress.send(RemoteDownloadProgress { received, total });
    Ok(received)
}

/// Ask where to save `file_name`; `None` when the user cancels.
async fn pick_save_path(
    app: &tauri::AppHandle,
    file_name: &str,
) -> Result<Option<PathBuf>, String> {
    let dialog_app = app.clone();
    let name = file_name.to_string();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_file_name(&name)
            .blocking_save_file()
    })
    .await
    .map_err(|error| format!("Could not open the save dialog: {error}"))?;
    picked
        .map(|path| {
            path.into_path()
                .map_err(|error| format!("Could not resolve the save path: {error}"))
        })
        .transpose()
}

/// Download a remote file to disk, natively and without CORS. Returns `None`
/// when the user cancels the save dialog.
#[tauri::command]
pub(crate) async fn download_remote_file(
    app: tauri::AppHandle,
    request: RemoteDownloadRequest,
    request_id: String,
    progress: tauri::ipc::Channel<RemoteDownloadProgress>,
    downloads: tauri::State<'_, RemoteDownloads>,
) -> Result<Option<RemoteDownloadResult>, String> {
    let url = Url::parse(&request.url).map_err(|_| "Invalid download URL.".to_string())?;
    let headers = request_headers(request.headers)?;
    check_scheme(&url, &headers)?;
    let checked = url.clone();
    tauri::async_runtime::spawn_blocking(move || url_is_fetchable(&checked))
        .await
        .map_err(|error| format!("URL validation failed: {error}"))??;
    // Reject a reused ID before the save dialog opens, and never let a new
    // cache entry orphan an earlier one's file.
    if downloads.active.lock().unwrap().contains_key(&request_id)
        || downloads.cached.lock().unwrap().contains_key(&request_id)
    {
        return Err("Duplicate request ID.".into());
    }
    let file_name = sanitize_file_name(&request.file_name);
    let folder = match &request.folder_id {
        Some(id) => Some(
            downloads
                .folders
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or_else(|| "Unknown download folder.".to_string())?,
        ),
        None => None,
    };
    let is_folder = folder.is_some();
    let saves_to_disk = request.save || is_folder;
    let destination = if let Some(folder) = folder {
        reserve_unique_path(&folder, &file_name)?
    } else if request.save {
        match pick_save_path(&app, &file_name).await? {
            Some(path) => path,
            None => return Ok(None),
        }
    } else {
        cache_dir(&app)?.join(format!("{}-{file_name}", sanitize_file_name(&request_id)))
    };

    let task = {
        let mut active = downloads.active.lock().unwrap();
        if active.contains_key(&request_id) {
            return Err("Duplicate request ID.".into());
        }
        let task = tauri::async_runtime::spawn(transfer(
            url,
            headers,
            destination.clone(),
            sanitize_file_name(&request_id),
            is_folder,
            progress,
        ));
        let abort = task.inner().abort_handle();
        active.insert(request_id.clone(), Box::new(move || abort.abort()));
        task
    };
    let _guard = ActiveGuard {
        downloads: downloads.inner().clone(),
        id: request_id.clone(),
    };
    let size = task
        .await
        .map_err(|_| "Download cancelled.".to_string())??;
    if saves_to_disk {
        Ok(Some(RemoteDownloadResult {
            path: Some(destination.to_string_lossy().into_owned()),
            size,
        }))
    } else {
        downloads
            .cached
            .lock()
            .unwrap()
            .insert(request_id, destination);
        Ok(Some(RemoteDownloadResult { path: None, size }))
    }
}

/// Ask for a folder to save several downloads into; `None` when the user
/// cancels. The folder is remembered for the app session under the returned id,
/// which [`download_remote_file`] accepts as `folderId`.
#[tauri::command]
pub(crate) async fn pick_download_folder(
    app: tauri::AppHandle,
    downloads: tauri::State<'_, RemoteDownloads>,
) -> Result<Option<PickedDownloadFolder>, String> {
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|error| format!("Could not open the folder picker: {error}"))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|error| format!("Could not resolve the folder: {error}"))?;
    if !path.is_dir() {
        return Err("The chosen folder does not exist.".into());
    }
    static NEXT_FOLDER_ID: AtomicU64 = AtomicU64::new(1);
    let id = format!("folder-{}", NEXT_FOLDER_ID.fetch_add(1, Ordering::Relaxed));
    let shown = path.to_string_lossy().into_owned();
    downloads.folders.lock().unwrap().insert(id.clone(), path);
    Ok(Some(PickedDownloadFolder { id, path: shown }))
}

/// Abort an in-flight [`download_remote_file`].
#[tauri::command]
pub(crate) fn cancel_remote_download(
    request_id: String,
    downloads: tauri::State<'_, RemoteDownloads>,
) {
    downloads.cancel(&request_id);
}

/// Read a cached download's bytes once, then delete the file.
#[tauri::command]
pub(crate) fn take_cached_download(
    request_id: String,
    downloads: tauri::State<'_, RemoteDownloads>,
) -> Result<tauri::ipc::Response, String> {
    let path = downloads
        .cached
        .lock()
        .unwrap()
        .remove(&request_id)
        .ok_or_else(|| "No cached download with that ID.".to_string())?;
    let bytes = read_and_remove(&path);
    bytes.map(tauri::ipc::Response::new)
}

fn read_and_remove(path: &Path) -> Result<Vec<u8>, String> {
    let bytes = fs::read(path).map_err(|error| format!("Could not read the download: {error}"));
    let _ = fs::remove_file(path);
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_file_names_to_one_component() {
        assert_eq!(
            sanitize_file_name("ATL08_20230629230240_01492006_007_01.h5"),
            "ATL08_20230629230240_01492006_007_01.h5"
        );
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name("C:\\dir\\a b.h5"), "a_b.h5");
        assert_eq!(sanitize_file_name("..."), "download");
        assert_eq!(sanitize_file_name(".hidden"), "hidden");
        assert_eq!(sanitize_file_name(""), "download");
        assert_eq!(
            sanitize_file_name(&"x".repeat(500)).len(),
            MAX_FILE_NAME_CHARS
        );
    }

    #[test]
    fn drops_transport_managed_headers() {
        let headers = request_headers(vec![
            ("Authorization".into(), "Bearer abc".into()),
            ("Host".into(), "evil.example".into()),
            ("Range".into(), "bytes=0-1".into()),
        ])
        .unwrap();
        assert_eq!(headers.len(), 1);
        assert_eq!(headers["authorization"], "Bearer abc");
        assert!(request_headers(vec![("bad name".into(), "x".into())]).is_err());
        assert!(request_headers(vec![("X-Api-Key".into(), "k".into())]).is_err());
    }

    #[test]
    fn credentials_require_https() {
        let auth = request_headers(vec![("Authorization".into(), "Bearer t".into())]).unwrap();
        let http = Url::parse("http://example.com/a.h5").unwrap();
        let https = Url::parse("https://example.com/a.h5").unwrap();
        assert!(check_scheme(&http, &auth).is_err());
        assert!(check_scheme(&https, &auth).is_ok());
        assert!(check_scheme(&http, &HeaderMap::new()).is_ok());
    }

    #[test]
    fn folder_downloads_reserve_distinct_names() {
        let dir = std::env::temp_dir().join(format!("geolibre-unique-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        // Each reservation creates its file, so back-to-back (or concurrent)
        // downloads of one name get distinct destinations.
        assert_eq!(
            reserve_unique_path(&dir, "B04.tif").unwrap(),
            dir.join("B04.tif")
        );
        assert_eq!(
            reserve_unique_path(&dir, "B04.tif").unwrap(),
            dir.join("B04 (1).tif")
        );
        assert_eq!(
            reserve_unique_path(&dir, "B04.tif").unwrap(),
            dir.join("B04 (2).tif")
        );
        fs::write(dir.join("README"), b"keep").unwrap();
        assert_eq!(
            reserve_unique_path(&dir, "README").unwrap(),
            dir.join("README (1)")
        );
        assert_eq!(fs::read(dir.join("README")).unwrap(), b"keep");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn part_file_is_removed_unless_done() {
        let dir = std::env::temp_dir().join(format!("geolibre-part-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.h5.part");
        fs::write(&path, b"x").unwrap();
        drop(PartFile {
            path: path.clone(),
            done: false,
        });
        assert!(!path.exists());
        fs::write(&path, b"x").unwrap();
        drop(PartFile {
            path: path.clone(),
            done: true,
        });
        assert!(path.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
