//! Device-owned offline archives. Catalog entries live beside immutable data,
//! so browser storage eviction does not lose the native package inventory.
//! Callers serialize operations for one root, including recovery of abandoned
//! stages. No operation accepts a user-controlled filesystem path.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::fs_util::{write_file_atomic, AtomicWriteOptions};

pub(crate) const MAX_PACKAGE_BYTES: usize = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 16 * 1024;

/// Tauri's postMessage transport converts a typed byte array to JSON on some
/// WebViews. Check the bound before allocating the decoded byte buffer.
/// Tauri has already parsed the JSON value; this does not bound parse memory.
pub(crate) fn decode_byte_array(
    value: &serde_json::Value,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let values = value
        .as_array()
        .ok_or("Offline package requires a byte array")?;
    if values.len() > limit {
        return Err("Offline package exceeds its size limit".into());
    }
    values
        .iter()
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u8::try_from(value).ok())
                .ok_or_else(|| "Offline package contains an invalid byte".to_string())
        })
        .collect()
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageDetails {
    pub name: String,
    pub bbox: [f64; 4],
    pub min_zoom: u8,
    pub max_zoom: u8,
    pub flavor: Option<String>,
    pub tile_type: String,
    pub archive_format: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u8,
    id: String,
    #[serde(flatten)]
    details: PackageDetails,
    bytes: u64,
    sha256: String,
    created_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfflinePackage {
    #[serde(flatten)]
    manifest: Manifest,
    pub saved_path: String,
    pub managed: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct PackageProblem {
    pub id: String,
    pub error: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct PackageInventory {
    pub packages: Vec<OfflinePackage>,
    pub problems: Vec<PackageProblem>,
}

fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.starts_with("pkg-")
        && id[4..]
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

fn random_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| format!("Could not allocate a package id: {e}"))?;
    Ok(format!("pkg-{}", hex(&bytes)))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(&mut result, "{byte:02x}");
    }
    result
}

fn validate_details(details: &PackageDetails) -> Result<(), String> {
    let [west, south, east, north] = details.bbox;
    let flavor_valid = details
        .flavor
        .as_deref()
        .is_none_or(|f| ["light", "dark", "white", "grayscale", "black"].contains(&f));
    if details.name.trim().is_empty()
        || details.name.len() > 512
        || details.name.chars().any(char::is_control)
        || !details.bbox.iter().all(|v| v.is_finite())
        || west < -180.0
        || east > 180.0
        || west > east
        || south < -90.0
        || north > 90.0
        || south > north
        || details.min_zoom > details.max_zoom
        || details.max_zoom > 30
        || !["vector", "raster"].contains(&details.tile_type.as_str())
        || !["pmtiles", "mbtiles"].contains(&details.archive_format.as_str())
        || !flavor_valid
        || (details.flavor.is_some()
            && (details.tile_type != "vector" || details.archive_format != "pmtiles"))
    {
        return Err("Invalid offline package metadata".into());
    }
    Ok(())
}

fn regular_file(path: &Path) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Offline package contains a non-regular file".into());
    }
    Ok(metadata)
}

fn sync_directory(path: &Path) -> Result<(), String> {
    // Windows does not support flushing directory handles through std::fs.
    // Archive and manifest file handles are still synced on every platform.
    #[cfg(unix)]
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|e| e.to_string())?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn create_directory_synced(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        return Ok(());
    }
    let parent = path.parent().ok_or("Package storage needs a parent")?;
    create_directory_synced(parent)?;
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && path.is_dir() => {}
        Err(error) => return Err(format!("Could not create package storage: {error}")),
    }
    sync_directory(parent)
}

pub(crate) struct PackageStore {
    root: PathBuf,
}

impl PackageStore {
    /// Open an app-owned root and synchronize newly created ancestors, recovering only this
    /// module's interrupted stages. The caller holds the root's operation lock.
    pub fn open(root: &Path) -> Result<Self, String> {
        create_directory_synced(root)?;
        let metadata = fs::symlink_metadata(root).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Offline package storage is not a directory".into());
        }
        let store = Self {
            root: fs::canonicalize(root).map_err(|e| e.to_string())?,
        };
        for entry in fs::read_dir(&store.root).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if (name.strip_prefix(".pending-").is_some_and(valid_id)
                || name.strip_prefix(".deleting-").is_some_and(valid_id))
                && entry.file_type().map_err(|e| e.to_string())?.is_dir()
            {
                if let Err(error) = fs::remove_dir_all(entry.path()) {
                    if name.starts_with(".deleting-") {
                        eprintln!("Offline package cleanup deferred: {error}");
                    } else {
                        return Err(error.to_string());
                    }
                }
            }
        }
        sync_directory(&store.root)?;
        Ok(store)
    }

    fn directory(&self, id: &str) -> Result<PathBuf, String> {
        if !valid_id(id) {
            return Err("Invalid offline package id".into());
        }
        let path = self.root.join(id);
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Invalid offline package directory".into());
        }
        Ok(path)
    }

    pub(crate) fn read(&self, id: &str) -> Result<OfflinePackage, String> {
        let directory = self.directory(id)?;
        let path = directory.join("manifest.json");
        if regular_file(&path)?.len() > MAX_MANIFEST_BYTES {
            return Err("Offline package manifest is too large".into());
        }
        let manifest: Manifest =
            serde_json::from_reader(File::open(path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("Invalid offline package manifest: {e}"))?;
        validate_details(&manifest.details)?;
        if manifest.version != 1 || manifest.id != id || manifest.sha256.len() != 64 {
            return Err("Invalid offline package manifest identity".into());
        }
        let archive = directory.join(format!("archive.{}", manifest.details.archive_format));
        if regular_file(&archive)?.len() != manifest.bytes {
            return Err("Offline package archive size has changed".into());
        }
        Ok(OfflinePackage {
            manifest,
            saved_path: archive.to_string_lossy().into_owned(),
            managed: true,
        })
    }

    /// Enumerate the durable inventory and report damaged entries separately,
    /// keeping healthy packages accessible and damaged packages deletable.
    pub fn list(&self) -> Result<PackageInventory, String> {
        let mut result = Vec::new();
        let mut problems = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let id = entry.file_name().to_string_lossy().into_owned();
            if valid_id(&id) {
                match self.read(&id) {
                    Ok(entry) => result.push(entry),
                    Err(error) => problems.push(PackageProblem { id, error }),
                }
            }
        }
        result.sort_by(|a, b| {
            b.manifest
                .created_at
                .cmp(&a.manifest.created_at)
                .then_with(|| a.manifest.id.cmp(&b.manifest.id))
        });
        Ok(PackageInventory {
            packages: result,
            problems,
        })
    }

    /// Publish a new immutable archive and its catalog entry together.
    pub fn save(&self, mut details: PackageDetails, data: &[u8]) -> Result<OfflinePackage, String> {
        validate_details(&details)?;
        if data.len() > MAX_PACKAGE_BYTES {
            return Err("Offline package exceeds 512 MiB".into());
        }
        let signature_valid = match details.archive_format.as_str() {
            "pmtiles" => data.len() >= 127 && data.starts_with(b"PMTiles\x03"),
            "mbtiles" => data.len() >= 100 && data.starts_with(b"SQLite format 3\0"),
            _ => false,
        };
        if !signature_valid {
            return Err("Invalid offline archive signature".into());
        }
        details.name = details.name.trim().to_string();
        let id = random_id()?;
        let stage = self.root.join(format!(".pending-{id}"));
        let published = self.root.join(&id);
        fs::create_dir(&stage).map_err(|e| e.to_string())?;
        let result = (|| {
            let archive = stage.join(format!("archive.{}", details.archive_format));
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(archive)
                .map_err(|e| e.to_string())?;
            file.write_all(data)
                .and_then(|()| file.sync_all())
                .map_err(|e| e.to_string())?;
            drop(file);
            let manifest = Manifest {
                version: 1,
                id: id.clone(),
                details,
                bytes: data.len() as u64,
                sha256: hex(&Sha256::digest(data)),
                created_at: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_millis() as u64,
            };
            self.write_manifest(&stage, &manifest)?;
            sync_directory(&stage)?;
            fs::rename(&stage, &published).map_err(|e| e.to_string())?;
            if let Err(error) = sync_directory(&self.root) {
                let _ = fs::remove_dir_all(&published);
                let _ = sync_directory(&self.root);
                return Err(error);
            }
            self.read(&id)
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(stage);
        }
        result
    }

    fn write_manifest(&self, directory: &Path, manifest: &Manifest) -> Result<(), String> {
        let bytes = serde_json::to_vec(manifest).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_MANIFEST_BYTES {
            return Err("Package metadata is too large".into());
        }
        write_file_atomic(
            &directory.join("manifest.json"),
            &bytes,
            AtomicWriteOptions {
                sync: true,
                owner_only_unix: true,
                ..Default::default()
            },
        )
        .map_err(String::from)?;
        sync_directory(directory)
    }

    pub fn update(
        &self,
        id: &str,
        name: Option<String>,
        flavor: Option<String>,
    ) -> Result<OfflinePackage, String> {
        let mut entry = self.read(id)?;
        if let Some(name) = name {
            entry.manifest.details.name = name.trim().into();
        }
        if let Some(flavor) = flavor {
            entry.manifest.details.flavor = Some(flavor);
        }
        validate_details(&entry.manifest.details)?;
        self.write_manifest(&self.directory(id)?, &entry.manifest)?;
        Ok(entry)
    }

    /// Removal is explicit. Saved projects referencing this package lose their
    /// offline archive; no package is automatically evicted on layer removal.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let directory = self.directory(id)?;
        let tombstone = self.root.join(format!(".deleting-{id}"));
        fs::rename(directory, &tombstone).map_err(|e| e.to_string())?;
        sync_directory(&self.root)?;
        // Once the tombstone is durable the package is logically deleted.
        // A reader handle may delay physical cleanup (notably on Windows);
        // recovery retries it on the next storage operation.
        if let Err(error) = fs::remove_dir_all(tombstone)
            .and_then(|_| sync_directory(&self.root).map_err(std::io::Error::other))
        {
            eprintln!("Offline package cleanup deferred: {error}");
        }
        Ok(())
    }

    pub fn archive_paths(&self, id: &str) -> Result<[PathBuf; 2], String> {
        let directory = self.directory(id)?;
        Ok([
            directory.join("archive.pmtiles"),
            directory.join("archive.mbtiles"),
        ])
    }

    /// Verify a package explicitly before use without hashing every archive
    /// while listing the inventory. Streaming bounds working memory.
    pub fn verify(&self, id: &str) -> Result<OfflinePackage, String> {
        let entry = self.read(id)?;
        let mut file = File::open(&entry.saved_path).map_err(|e| e.to_string())?;
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 128 * 1024];
        loop {
            let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        if hex(&digest.finalize()) != entry.manifest.sha256 {
            return Err("Offline package checksum does not match".into());
        }
        Ok(entry)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_android_postmessage_bytes_with_strict_bounds_and_value_validation() {
        assert_eq!(
            decode_byte_array(&serde_json::json!([0, 255, 1]), 3).unwrap(),
            vec![0, 255, 1]
        );
        assert!(decode_byte_array(&serde_json::json!([0, 255, 1]), 2).is_err());
        for value in [
            serde_json::json!([-1]),
            serde_json::json!([256]),
            serde_json::json!([1.2]),
            serde_json::json!(["1"]),
            serde_json::json!({"0":1}),
            serde_json::Value::Null,
        ] {
            assert!(decode_byte_array(&value, 3).is_err());
        }
    }

    struct TestRoot(PathBuf);
    impl TestRoot {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("geolibre-{}", random_id().unwrap()));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn store(&self) -> PackageStore {
            PackageStore::open(&self.0.join("packages")).unwrap()
        }
    }
    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn details() -> PackageDetails {
        PackageDetails {
            name: "Berkeley".into(),
            bbox: [-123.0, 37.0, -122.0, 38.0],
            min_zoom: 0,
            max_zoom: 14,
            flavor: Some("light".into()),
            tile_type: "vector".into(),
            archive_format: "pmtiles".into(),
        }
    }
    fn archive() -> Vec<u8> {
        let mut bytes = vec![0; 127];
        bytes[..8].copy_from_slice(b"PMTiles\x03");
        bytes
    }

    #[test]
    fn reopens_inventory_and_verifies_bytes_without_browser_storage() {
        let root = TestRoot::new();
        let entry = root.store().save(details(), &archive()).unwrap();
        let entries = root.store().list().unwrap().packages;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].manifest.id, entry.manifest.id);
        assert_eq!(fs::read(&entry.saved_path).unwrap(), archive());
        assert!(entry.managed);
        assert_eq!(
            root.store().verify(&entry.manifest.id).unwrap().saved_path,
            entry.saved_path
        );
    }

    #[test]
    fn rename_and_flavor_survive_reopen_without_rewriting_archive() {
        let root = TestRoot::new();
        let entry = root.store().save(details(), &archive()).unwrap();
        root.store()
            .update(&entry.manifest.id, None, Some("dark".into()))
            .unwrap();
        root.store()
            .update(&entry.manifest.id, Some(" New name ".into()), None)
            .unwrap();
        let fresh = root.store().verify(&entry.manifest.id).unwrap();
        assert_eq!(fresh.manifest.details.name, "New name");
        assert_eq!(fresh.manifest.details.flavor.as_deref(), Some("dark"));
        assert_eq!(fresh.manifest.sha256, entry.manifest.sha256);
        assert_eq!(fresh.manifest.created_at, entry.manifest.created_at);
    }

    #[test]
    fn creates_missing_app_data_ancestors_without_accepting_files_as_directories() {
        let root = TestRoot::new();
        let directory = root
            .0
            .join("app-data")
            .join("nested")
            .join("offline-packages");
        assert!(PackageStore::open(&directory)
            .unwrap()
            .list()
            .unwrap()
            .packages
            .is_empty());
        let blocker = root.0.join("file");
        fs::write(&blocker, b"retained").unwrap();
        assert!(PackageStore::open(&blocker.join("offline-packages")).is_err());
        assert_eq!(fs::read(blocker).unwrap(), b"retained");
    }

    #[test]
    fn same_size_corruption_is_visible_and_keeps_inventory() {
        let root = TestRoot::new();
        let entry = root.store().save(details(), &archive()).unwrap();
        let mut altered = archive();
        altered[126] = 42;
        fs::write(&entry.saved_path, altered).unwrap();
        assert_eq!(root.store().list().unwrap().packages.len(), 1);
        assert!(root
            .store()
            .verify(&entry.manifest.id)
            .unwrap_err()
            .contains("checksum"));
    }

    #[test]
    fn truncated_archive_is_a_visible_catalog_error() {
        let root = TestRoot::new();
        let entry = root.store().save(details(), &archive()).unwrap();
        let healthy = root.store().save(details(), &archive()).unwrap();
        fs::write(&entry.saved_path, b"truncated").unwrap();
        let inventory = root.store().list().unwrap();
        assert_eq!(inventory.problems.len(), 1);
        assert_eq!(inventory.packages[0].manifest.id, healthy.manifest.id);
        assert!(inventory.problems[0].error.contains("size"));
        root.store().delete(&entry.manifest.id).unwrap();
        assert!(root.store().list().unwrap().problems.is_empty());
    }

    #[test]
    #[cfg(unix)]
    fn durable_deletion_defers_locked_cleanup_without_blocking_healthy_inventory() {
        use std::os::unix::fs::PermissionsExt;
        let root = TestRoot::new();
        let store = root.store();
        let entry = store.save(details(), &archive()).unwrap();
        let healthy = store.save(details(), &archive()).unwrap();
        let locked = store.directory(&entry.manifest.id).unwrap().join("locked");
        fs::create_dir(&locked).unwrap();
        fs::write(locked.join("held"), b"pending cleanup").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
        store.delete(&entry.manifest.id).unwrap();
        let tombstone = store.root.join(format!(".deleting-{}", entry.manifest.id));
        assert!(tombstone.exists());
        assert_eq!(
            root.store().list().unwrap().packages[0].manifest.id,
            healthy.manifest.id
        );
        fs::set_permissions(tombstone.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(root.store().list().unwrap().packages.len(), 1);
        assert!(!tombstone.exists());
    }

    #[test]
    fn recovers_only_owned_interrupted_stages_and_deletions() {
        let root = TestRoot::new();
        let store = root.store();
        let retained = store.save(details(), &archive()).unwrap();
        for prefix in [".pending-", ".deleting-"] {
            let stage = store.root.join(format!("{prefix}{}", random_id().unwrap()));
            fs::create_dir(&stage).unwrap();
            fs::write(stage.join("partial"), b"partial").unwrap();
        }
        fs::create_dir(store.root.join("unrelated-folder")).unwrap();
        fs::create_dir(store.root.join(".pending-invalid")).unwrap();
        let reopened = root.store();
        assert_eq!(
            reopened.list().unwrap().packages[0].manifest.id,
            retained.manifest.id
        );
        let names: Vec<_> = fs::read_dir(&reopened.root)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 3);
        assert!(reopened.root.join(".pending-invalid").is_dir());
    }

    #[test]
    fn delete_removes_only_the_explicit_package() {
        let root = TestRoot::new();
        let one = root.store().save(details(), &archive()).unwrap();
        let two = root.store().save(details(), &archive()).unwrap();
        for id in ["../outside", "/tmp/something", "pkg-..", ""] {
            assert!(root.store().delete(id).is_err());
        }
        root.store().delete(&one.manifest.id).unwrap();
        assert!(!Path::new(&one.saved_path).exists());
        assert_eq!(
            root.store().list().unwrap().packages[0].manifest.id,
            two.manifest.id
        );
    }

    #[test]
    fn invalid_input_does_not_publish_or_leave_a_stage() {
        let root = TestRoot::new();
        assert!(root.store().save(details(), b"not an archive").is_err());
        let mut bad = details();
        bad.bbox[0] = f64::NAN;
        assert!(root.store().save(bad, &archive()).is_err());
        let mut bad = details();
        bad.flavor = Some("unknown".into());
        assert!(root.store().save(bad, &archive()).is_err());
        let mut bad = details();
        bad.archive_format = "../file".into();
        assert!(root.store().save(bad, &archive()).is_err());
        assert_eq!(fs::read_dir(root.store().root).unwrap().count(), 0);
    }

    #[test]
    fn stores_mbtiles_as_an_unstyled_package() {
        let root = TestRoot::new();
        let mut metadata = details();
        metadata.archive_format = "mbtiles".into();
        metadata.flavor = None;
        let mut sqlite = vec![0; 100];
        sqlite[..16].copy_from_slice(b"SQLite format 3\0");
        let entry = root.store().save(metadata, &sqlite).unwrap();
        assert!(entry.saved_path.ends_with("archive.mbtiles"));
        root.store().verify(&entry.manifest.id).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_roots_packages_and_archive_files() {
        use std::os::unix::fs::symlink;
        let root = TestRoot::new();
        let outside = root.0.join("outside");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, root.0.join("alias")).unwrap();
        assert!(PackageStore::open(&root.0.join("alias")).is_err());
        let store = root.store();
        let id = random_id().unwrap();
        symlink(&outside, store.root.join(&id)).unwrap();
        assert!(store.delete(&id).is_err());
        fs::remove_file(store.root.join(&id)).unwrap();
        let entry = store.save(details(), &archive()).unwrap();
        fs::remove_file(&entry.saved_path).unwrap();
        let target = outside.join("external.pmtiles");
        fs::write(&target, archive()).unwrap();
        symlink(&target, &entry.saved_path).unwrap();
        assert!(store.verify(&entry.manifest.id).is_err());
        assert!(target.exists());
    }
}
