//! Durable, atomic publication of iOS document-picker import copies.
//!
//! UIKit has already imported these files into the sandbox. Persist them before
//! returning paths to project readers; never mutate the picker/provider files.

use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

// A picker selection is published as one batch, including companion files.
// Serializing imports also lets recovery distinguish abandoned private stages
// from a selection still being copied in this app process.
// It protects no in-memory state: unwind cleanup and disk inspection let the
// next operation safely resume after a previous holder panics.
static COPY_LOCK: Mutex<()> = Mutex::new(());

struct Stage {
    path: PathBuf,
}

impl Drop for Stage {
    fn drop(&mut self) {
        // After publication this private path no longer exists. A failure before
        // publication removes only this selection, never a previous import.
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

fn safe_name(path: &Path) -> io::Result<String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| io::Error::other("The selected document has no UTF-8 file name"))?;
    let name: String = name
        .chars()
        .map(|character| {
            if character == '/' || character == '\\' || character.is_control() {
                '_'
            } else {
                character
            }
        })
        .collect();
    if name.trim().is_empty() || name == "." || name == ".." || name.len() > 255 {
        return Err(io::Error::other("Invalid document file name"));
    }
    Ok(name)
}

fn recover_stages(root: &Path) -> io::Result<()> {
    let mut removed = false;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(id) = name
            .to_str()
            .and_then(|name| name.strip_prefix(".pending-"))
        else {
            continue;
        };
        if Uuid::parse_str(id).is_ok() && entry.file_type()?.is_dir() {
            match fs::remove_dir_all(entry.path()) {
                Ok(()) => removed = true,
                Err(error) => eprintln!(
                    "[GeoLibre] Could not remove abandoned import stage {}: {error}",
                    entry.path().display()
                ),
            }
        }
    }
    if removed {
        sync_directory(root)?;
    }
    Ok(())
}

fn copy_file(source: &Path, destination: &Path) -> io::Result<(u64, String)> {
    // Import mode supplies ordinary local files, not open-in-place URLs. Do
    // not follow a directory or symbolic link into an unrelated sandbox path.
    if !source.is_absolute() || !fs::symlink_metadata(source)?.file_type().is_file() {
        return Err(io::Error::other(
            "The selected document is not a regular file",
        ));
    }
    let mut input = File::open(source)?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let mut digest = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let count = match input.read(&mut buffer) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if count == 0 {
            break;
        }
        output.write_all(&buffer[..count])?;
        digest.update(&buffer[..count]);
        bytes = bytes
            .checked_add(count as u64)
            .ok_or_else(|| io::Error::other("Document size overflow"))?;
    }
    output.sync_all()?;
    let sha256 = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((bytes, sha256))
}

fn prepare_root(root: &Path, anchor: &Path) -> io::Result<(PathBuf, Vec<PathBuf>)> {
    if !root.is_absolute() || !anchor.is_absolute() {
        return Err(io::Error::other(
            "Document storage must be an absolute path",
        ));
    }
    // The platform supplies an existing sandbox ancestor. Never synchronize
    // directories above it, which iOS may forbid the app from opening.
    let relative = root
        .strip_prefix(anchor)
        .map_err(|_| io::Error::other("Document storage is outside its anchor"))?;
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(io::Error::other("Document storage is outside its anchor"));
    }
    let anchor = fs::canonicalize(anchor)?;
    if !anchor.is_dir() {
        return Err(io::Error::other(
            "Document storage anchor is not a directory",
        ));
    }
    let root = anchor.join(relative);
    fs::create_dir_all(&root)?;
    // The storage root is app-owned, never a user-selected destination. Reject
    // a symlink at that root before sweeping or publishing private stages.
    if !fs::symlink_metadata(&root)?.file_type().is_dir() {
        return Err(io::Error::other("Document storage is not a directory"));
    }
    let root = fs::canonicalize(root)?;
    if !root.starts_with(&anchor) || root == anchor {
        return Err(io::Error::other("Document storage is outside its anchor"));
    }
    // Include existing ancestors on retries too: an earlier failed attempt
    // may have created them without making their parent entries durable.
    let mut storage_parents = Vec::new();
    for path in root.ancestors().skip(1) {
        storage_parents.push(path.to_path_buf());
        if path == anchor {
            break;
        }
    }
    Ok((root, storage_parents))
}

// A directory entry can outlive its file. Keep that failure local so later
// healthy companions from the same published selection remain available.
fn retained_data_files(
    canonical_data: &Path,
    entries: impl Iterator<Item = io::Result<fs::DirEntry>>,
) -> (Vec<PathBuf>, Vec<String>) {
    let mut files = Vec::new();
    let mut problems = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                problems.push(format!("{}: {error}", canonical_data.display()));
                continue;
            }
        };
        let path = entry.path();
        let inspect = || -> io::Result<Option<PathBuf>> {
            if !entry.file_type()?.is_file()
                || !safe_name(&path).is_ok_and(|name| name == entry.file_name().to_string_lossy())
            {
                return Ok(None);
            }
            let canonical = fs::canonicalize(&path)?;
            Ok((canonical.parent() == Some(canonical_data)).then_some(canonical))
        };
        match inspect() {
            Ok(Some(path)) => files.push(path),
            Ok(None) => {}
            Err(error) => problems.push(format!("{}: {error}", path.display())),
        }
    }
    (files, problems)
}

// A root enumeration error makes the inventory unavailable. Inspection errors
// for a selection that was obtained remain local to that selection.
fn inventory_selections(
    canonical_root: &Path,
    entries: impl Iterator<Item = io::Result<fs::DirEntry>>,
) -> io::Result<(Vec<PathBuf>, Vec<String>)> {
    let mut files = Vec::new();
    let mut problems = Vec::new();
    for entry in entries {
        let entry = entry?;
        let mut inspect = || -> io::Result<()> {
            if !entry.file_type()?.is_dir()
                || Uuid::parse_str(&entry.file_name().to_string_lossy()).is_err()
            {
                return Ok(());
            }
            let directory = entry.path();
            let manifest = directory.join("source.json");
            let data = directory.join("data");
            let ordinary = |path: &Path, directory: bool| -> io::Result<bool> {
                match fs::symlink_metadata(path) {
                    Ok(metadata) => Ok(if directory {
                        metadata.is_dir()
                    } else {
                        metadata.is_file()
                    }),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
                    Err(error) => Err(error),
                }
            };
            if !ordinary(&manifest, false)? || !ordinary(&data, true)? {
                return Ok(());
            }
            let canonical_data = fs::canonicalize(&data)?;
            if !canonical_data.starts_with(canonical_root) {
                return Ok(());
            }
            let (retained, warnings) = retained_data_files(&canonical_data, fs::read_dir(&data)?);
            files.extend(retained);
            problems.extend(warnings);
            Ok(())
        };
        if let Err(error) = inspect() {
            problems.push(error.to_string());
        }
    }
    Ok((files, problems))
}

/// Inventory only published regular data files for reauthorization at startup.
/// Stages, symlinks, manifests, and unrelated directories never enter the scope.
/// The trusted, existing sandbox `anchor` contains the storage root. Root-level
/// failures are fatal; unavailable individual imports enter `problems`.
/// Inventory sync warnings are native diagnostics, not unavailable-file errors.
pub fn retained_document_files(
    root: &Path,
    anchor: &Path,
) -> io::Result<(Vec<PathBuf>, Vec<String>)> {
    let _lock = COPY_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (root, parents) = prepare_root(root, anchor)?;
    let (files, problems) = inventory_selections(&root, fs::read_dir(&root)?)?;
    // Inventory is read recovery, not publication: a durability warning must
    // not discard grants for healthy files that were already published.
    for path in std::iter::once(&root).chain(parents.iter()) {
        if let Err(error) = sync_directory(path) {
            eprintln!(
                "[GeoLibre] Could not synchronize retained import directory {}: {error}",
                path.display()
            );
        }
    }
    Ok((files, problems))
}

/// Persist a complete UIKit import selection and return only published paths.
///
/// Each pick gets a separate identity: UIKit's temporary URLs do not identify
/// the original provider document reliably enough to deduplicate selections.
/// Synchronization includes every ancestor through the trusted, existing sandbox
/// `anchor`, including directories left by an earlier failed attempt.
pub(crate) fn persist_selection(
    root: &Path,
    anchor: &Path,
    sources: &[PathBuf],
) -> io::Result<Vec<PathBuf>> {
    if sources.is_empty() {
        return Err(io::Error::other("The picker returned no documents"));
    }
    let _lock = COPY_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (root, storage_parents) = prepare_root(root, anchor)?;
    if let Err(error) = recover_stages(&root) {
        eprintln!(
            "[GeoLibre] Could not finish import-stage recovery in {}: {error}",
            root.display()
        );
    }
    let id = Uuid::new_v4().to_string();
    let stage_path = root.join(format!(".pending-{id}"));
    fs::create_dir(&stage_path)?;
    let stage = Stage { path: stage_path };
    let data = stage.path.join("data");
    fs::create_dir(&data)?;
    let mut names = HashSet::new();
    let mut documents = Vec::with_capacity(sources.len());
    let mut published_paths = Vec::with_capacity(sources.len());
    let published = root.join(&id);
    for source in sources {
        let name = safe_name(source)?;
        if !names.insert(name.to_lowercase()) {
            return Err(io::Error::other(
                "Selected documents have conflicting file names",
            ));
        }
        let (bytes, sha256) = copy_file(source, &data.join(&name))?;
        documents.push(serde_json::json!({
            "name": name,
            "importPath": source,
            "bytes": bytes,
            "sha256": sha256,
        }));
        published_paths.push(published.join("data").join(&name));
    }
    let mut manifest = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(stage.path.join("source.json"))?;
    serde_json::to_writer(
        &mut manifest,
        &serde_json::json!({ "version": 1, "platform": "ios", "documents": documents }),
    )?;
    manifest.sync_all()?;
    sync_directory(&data)?;
    sync_directory(&stage.path)?;
    // The UUID directory is absent and the rename stays on the same volume.
    // No path is returned until the complete batch and manifest are durable.
    fs::rename(&stage.path, &published)?;
    let synchronized = sync_directory(&root).and_then(|_| {
        storage_parents
            .iter()
            .try_for_each(|path| sync_directory(path))
    });
    if let Err(error) = synchronized {
        let _ = fs::remove_dir_all(&published);
        let _ = sync_directory(&root);
        return Err(error);
    }
    Ok(published_paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!("ios-data-copy-{}", Uuid::new_v4()));
            fs::create_dir(&directory).unwrap();
            Self(directory)
        }

        fn source(&self, name: &str, contents: &[u8]) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, contents).unwrap();
            path
        }

        fn root(&self) -> PathBuf {
            self.0.join("picked-documents")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn root_iteration_errors_are_fatal_even_after_a_healthy_selection() {
        let fixture = Fixture::new();
        let source = fixture.source("roads.geojson", b"original");
        let copies = persist_selection(&fixture.root(), &fixture.0, &[source]).unwrap();
        let root = fs::canonicalize(fixture.root()).unwrap();
        let (files, problems) = inventory_selections(&root, fs::read_dir(&root).unwrap()).unwrap();
        assert_eq!(files, copies);
        assert!(problems.is_empty());
        for fail_first in [true, false] {
            let mut entries = fs::read_dir(&root)
                .unwrap()
                .collect::<io::Result<Vec<_>>>()
                .unwrap()
                .into_iter()
                .map(Ok)
                .collect::<Vec<_>>();
            let index = if fail_first { 0 } else { entries.len() };
            entries.insert(index, Err(io::Error::other("root iteration failed")));
            let error = inventory_selections(&root, entries.into_iter()).unwrap_err();
            assert_eq!(error.to_string(), "root iteration failed");
        }
        assert_eq!(fs::read(&copies[0]).unwrap(), b"original");
    }

    #[test]
    fn one_disappearing_file_does_not_hide_later_files_from_the_same_selection() {
        let fixture = Fixture::new();
        let a = fixture.source("a.geojson", b"first");
        let b = fixture.source("b.geojson", b"second");
        let c = fixture.source("c.geojson", b"third");
        let copies = persist_selection(&fixture.root(), &fixture.0, &[a.clone(), b, c]).unwrap();
        let data = copies[0].parent().unwrap();
        let mut entries = fs::read_dir(data)
            .unwrap()
            .collect::<io::Result<Vec<_>>>()
            .unwrap();
        entries.sort_by_key(|entry| entry.file_name());
        // Retain the real directory entry, then remove its file before the
        // metadata/canonicalization step, as a concurrent deletion would.
        fs::remove_file(&copies[0]).unwrap();
        let (files, problems) = retained_data_files(data, entries.into_iter().map(Ok));
        assert_eq!(files, copies[1..]);
        assert_eq!(problems.len(), 1);
        assert!(problems[0].contains("a.geojson"));
        assert_eq!(fs::read(&files[0]).unwrap(), b"second");
        assert_eq!(fs::read(&files[1]).unwrap(), b"third");
        assert_eq!(fs::read(a).unwrap(), b"first");
        let entries = std::iter::once(Err(io::Error::other("directory entry unavailable")))
            .chain(fs::read_dir(data).unwrap());
        let (mut files, problems) = retained_data_files(data, entries);
        files.sort();
        assert_eq!(files, copies[1..]);
        assert_eq!(problems.len(), 1);
        assert!(problems[0].contains("directory entry unavailable"));
    }

    #[test]
    fn retry_keeps_every_storage_ancestor_in_the_durability_plan() {
        let fixture = Fixture::new();
        let library = fixture.0.join("Library");
        let support = library.join("Application Support");
        let app = support.join("org.geolibre.app");
        let root = app.join("picked-documents");
        assert!(persist_selection(&root, &fixture.0, &[fixture.0.join("missing.tif")]).is_err());
        let (_, parents) = prepare_root(&root, &fixture.0).unwrap();
        assert_eq!(
            parents,
            vec![
                fs::canonicalize(app).unwrap(),
                fs::canonicalize(support).unwrap(),
                fs::canonicalize(library).unwrap(),
                fs::canonicalize(&fixture.0).unwrap(),
            ]
        );
        let source = fixture.source("roads.geojson", b"original");
        let copies = persist_selection(&root, &fixture.0, &[source]).unwrap();
        assert_eq!(fs::read(&copies[0]).unwrap(), b"original");
    }

    #[test]
    fn rejects_storage_outside_the_anchor_before_creating_directories() {
        let fixture = Fixture::new();
        let anchor = fixture.0.join("anchor");
        fs::create_dir(&anchor).unwrap();
        let outside = fixture.0.join("outside/picked-documents");
        assert!(prepare_root(&outside, &anchor).is_err());
        assert!(!outside.exists());
        let escaped = anchor.join("../escaped/picked-documents");
        assert!(prepare_root(&escaped, &anchor).is_err());
        assert!(!fixture.0.join("escaped").exists());
        assert!(prepare_root(&anchor, &anchor).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_storage_root_is_a_fatal_inventory_error() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let source = fixture.source("roads.geojson", b"original");
        let copies = persist_selection(&fixture.root(), &fixture.0, &[source]).unwrap();
        let permissions = fs::metadata(fixture.root()).unwrap().permissions();
        fs::set_permissions(fixture.root(), fs::Permissions::from_mode(0)).unwrap();
        let blocked = fs::read_dir(fixture.root()).is_err();
        let result = retained_document_files(&fixture.root(), &fixture.0);
        fs::set_permissions(fixture.root(), permissions).unwrap();
        assert!(
            blocked,
            "this denial-path test requires an unprivileged runner"
        );
        assert!(
            result.is_err(),
            "root failure must not become a partial inventory"
        );
        assert_eq!(fs::read(&copies[0]).unwrap(), b"original");
        let (files, problems) = retained_document_files(&fixture.root(), &fixture.0).unwrap();
        assert_eq!(files, copies);
        assert!(problems.is_empty());
    }

    #[test]
    fn inventory_and_import_recover_after_a_copy_holder_panics() {
        let fixture = Fixture::new();
        let source = fixture.source("roads.geojson", b"original");
        let earlier = persist_selection(&fixture.root(), &fixture.0, &[source.clone()]).unwrap();
        fs::write(&earlier[0], b"local edits").unwrap();
        let pending = fixture.root().join(format!(".pending-{}", Uuid::new_v4()));
        let abandoned = pending.clone();
        let panicked = std::thread::spawn(move || {
            let _lock = COPY_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            fs::create_dir(&abandoned).unwrap();
            let _stage = Stage {
                path: abandoned.clone(),
            };
            fs::write(abandoned.join("partial.geojson"), b"partial").unwrap();
            panic!("injected copy-holder panic");
        })
        .join();
        assert!(panicked.is_err());
        assert!(COPY_LOCK.is_poisoned());
        assert!(!pending.exists());
        let (files, problems) = retained_document_files(&fixture.root(), &fixture.0).unwrap();
        assert_eq!(files, earlier);
        assert!(problems.is_empty());
        let later = persist_selection(&fixture.root(), &fixture.0, &[source.clone()]).unwrap();
        assert_ne!(earlier, later);
        assert_eq!(fs::read(&earlier[0]).unwrap(), b"local edits");
        assert_eq!(fs::read(&later[0]).unwrap(), b"original");
        assert_eq!(fs::read(source).unwrap(), b"original");
        assert_eq!(fs::read_dir(fixture.root()).unwrap().count(), 2);
    }

    #[test]
    fn copies_survive_removal_of_picker_files_and_keep_companions_together() {
        let fixture = Fixture::new();
        let shp = fixture.source("Berkeley é.shp", b"geometry");
        let dbf = fixture.source("Berkeley é.dbf", b"attributes");
        let copies =
            persist_selection(&fixture.root(), &fixture.0, &[shp.clone(), dbf.clone()]).unwrap();
        assert_eq!(copies[0].parent(), copies[1].parent());
        fs::remove_file(shp).unwrap();
        fs::remove_file(dbf).unwrap();
        assert_eq!(fs::read(&copies[0]).unwrap(), b"geometry");
        assert_eq!(fs::read(&copies[1]).unwrap(), b"attributes");
        let manifest: serde_json::Value = serde_json::from_slice(
            &fs::read(
                copies[0]
                    .parent()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .join("source.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["documents"][0]["bytes"], 8);
        assert_eq!(
            manifest["documents"][0]["sha256"],
            "8148b7fefaf89ebf8e7951994d2601d731220c5460faecc64c69d12bb7ff3213"
        );
    }

    #[test]
    fn failed_batch_does_not_publish_partial_data_or_remove_earlier_copies() {
        let fixture = Fixture::new();
        let source = fixture.source("map.mbtiles", b"archive");
        let earlier = persist_selection(&fixture.root(), &fixture.0, &[source.clone()]).unwrap();
        let failed = persist_selection(
            &fixture.root(),
            &fixture.0,
            &[source.clone(), fixture.0.join("missing.tif")],
        );
        assert!(failed.is_err());
        assert_eq!(fs::read_dir(fixture.root()).unwrap().count(), 1);
        assert_eq!(fs::read(&earlier[0]).unwrap(), b"archive");
        assert_eq!(fs::read(source).unwrap(), b"archive");
    }

    #[test]
    fn rejects_case_collisions_without_overwriting_a_companion() {
        let fixture = Fixture::new();
        let a = fixture.source("roads.shp", b"a");
        let b = fixture.source("ROADS.SHP", b"b");
        assert!(persist_selection(&fixture.root(), &fixture.0, &[a, b]).is_err());
        assert_eq!(fs::read_dir(fixture.root()).unwrap().count(), 0);
    }

    #[test]
    fn distinct_picks_and_edited_copies_are_never_aliased() {
        let fixture = Fixture::new();
        let source = fixture.source("roads.geojson", b"original");
        let first = persist_selection(&fixture.root(), &fixture.0, &[source.clone()]).unwrap();
        fs::write(&first[0], b"edited").unwrap();
        let second = persist_selection(&fixture.root(), &fixture.0, &[source.clone()]).unwrap();
        assert_ne!(first[0], second[0]);
        assert_eq!(fs::read(&first[0]).unwrap(), b"edited");
        assert_eq!(fs::read(&second[0]).unwrap(), b"original");
        assert_eq!(fs::read(source).unwrap(), b"original");
    }

    #[test]
    fn recovers_only_abandoned_import_stages() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.root()).unwrap();
        let abandoned = fixture.root().join(format!(".pending-{}", Uuid::new_v4()));
        fs::create_dir(&abandoned).unwrap();
        fs::write(abandoned.join("partial.tif"), b"partial").unwrap();
        let unrelated = fixture.root().join(".pending-not-an-import");
        fs::create_dir(&unrelated).unwrap();
        let source = fixture.source("map.tif", b"raster");
        persist_selection(&fixture.root(), &fixture.0, &[source]).unwrap();
        assert!(!abandoned.exists());
        assert!(unrelated.is_dir());
    }

    #[test]
    fn sanitizes_names_without_changing_extensions() {
        let fixture = Fixture::new();
        let source = fixture.source("roads\\draft\n.geojson", b"data");
        let copies = persist_selection(&fixture.root(), &fixture.0, &[source]).unwrap();
        assert_eq!(copies[0].file_name().unwrap(), "roads_draft_.geojson");
    }

    #[test]
    fn an_empty_selection_creates_no_storage() {
        let fixture = Fixture::new();
        assert!(persist_selection(&fixture.root(), &fixture.0, &[]).is_err());
        assert!(!fixture.root().exists());
    }

    #[test]
    fn inventories_retained_data_after_the_container_moves() {
        let fixture = Fixture::new();
        let old = fixture.0.join("old-container");
        let root = old.join("Library/Application Support/org.geolibre.app/picked-documents");
        let source = fixture.source("roads.geojson", b"original");
        let copies = persist_selection(&root, &fixture.0, &[source]).unwrap();
        fs::write(&copies[0], b"local edits").unwrap();
        let new = fixture.0.join("new-container");
        fs::rename(&old, &new).unwrap();
        let unresolved = new.join("Library/Application Support/org.geolibre.app/picked-documents");
        let current = fs::canonicalize(&unresolved).unwrap();
        let (files, problems) = retained_document_files(&unresolved, &fixture.0).unwrap();
        assert!(problems.is_empty());
        assert_eq!(files.len(), 1);
        assert!(files[0].starts_with(&current));
        assert_eq!(fs::read(&files[0]).unwrap(), b"local edits");
        assert!(!copies[0].exists());
    }

    #[cfg(unix)]
    #[test]
    fn an_undeletable_abandoned_stage_does_not_block_new_imports() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let stage = fixture.root().join(format!(".pending-{}", Uuid::new_v4()));
        fs::create_dir_all(&stage).unwrap();
        fs::write(stage.join("partial"), b"unfinished").unwrap();
        fs::set_permissions(&stage, fs::Permissions::from_mode(0o500)).unwrap();
        let blocked = fs::remove_dir_all(&stage).is_err();
        let source = fixture.source("roads.geojson", b"new import");
        let result = persist_selection(&fixture.root(), &fixture.0, &[source]);
        let retained = stage.exists();
        if retained {
            fs::set_permissions(&stage, fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert!(
            blocked,
            "Permission-isolation tests require an unprivileged filesystem user"
        );
        assert!(retained);
        let copies = result.unwrap();
        assert_eq!(fs::read(&copies[0]).unwrap(), b"new import");
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_selection_does_not_hide_healthy_imports() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let source = fixture.source("roads.geojson", b"data");
        let broken = persist_selection(&fixture.root(), &fixture.0, &[source.clone()]).unwrap();
        let healthy = persist_selection(&fixture.root(), &fixture.0, &[source]).unwrap();
        let directory = broken[0].parent().unwrap();
        let permissions = fs::metadata(directory).unwrap().permissions();
        fs::set_permissions(directory, fs::Permissions::from_mode(0)).unwrap();
        let unreadable = fs::read_dir(directory).is_err();
        let result = retained_document_files(&fixture.root(), &fixture.0);
        fs::set_permissions(directory, permissions).unwrap();
        assert!(
            unreadable,
            "Permission-isolation tests require an unprivileged filesystem user"
        );
        let (files, problems) = result.unwrap();
        assert!(files.contains(&healthy[0]));
        assert!(!files.contains(&broken[0]));
        assert_eq!(problems.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn inventory_excludes_stages_and_links_outside_published_data() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let source = fixture.source("roads.geojson", b"data");
        let copies = persist_selection(&fixture.root(), &fixture.0, &[source.clone()]).unwrap();
        symlink(&source, copies[0].parent().unwrap().join("outside.geojson")).unwrap();
        let stage = fixture.root().join(format!(".pending-{}", Uuid::new_v4()));
        fs::create_dir_all(stage.join("data")).unwrap();
        fs::write(stage.join("data/staged.geojson"), b"partial").unwrap();
        let (files, problems) = retained_document_files(&fixture.root(), &fixture.0).unwrap();
        assert!(problems.is_empty());
        assert_eq!(files, copies);
        assert!(stage.exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_sources_and_storage_roots() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let source = fixture.source("map.tif", b"raster");
        let link = fixture.0.join("link.tif");
        symlink(&source, &link).unwrap();
        assert!(persist_selection(&fixture.root(), &fixture.0, &[link]).is_err());
        assert_eq!(fs::read_dir(fixture.root()).unwrap().count(), 0);
        let root_link = fixture.0.join("linked-root");
        symlink(fixture.root(), &root_link).unwrap();
        assert!(persist_selection(&root_link, &fixture.0, &[source]).is_err());
    }
}
