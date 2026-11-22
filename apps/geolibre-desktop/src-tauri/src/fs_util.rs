//! Shared atomic file-write helper for desktop backend modules.
//!
//! Writes through a uniquely named temporary file created with `create_new(true)`
//! in the target directory (refusing symlinks planted at predictable names),
//! closes the handle before renaming (Windows requirement), and cleans up the
//! temp file on any error.

use std::ffi::OsString;
use std::fs::{self, OpenOptions, Permissions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::app_error::AppError;

static ATOMIC_WRITE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Default)]
pub(crate) struct AtomicWriteOptions {
    /// Create parent directories if they do not exist.
    pub(crate) create_parents: bool,
    /// Create the temporary file with `0o600` on Unix.
    pub(crate) owner_only_unix: bool,
    /// Call `sync_all()` before closing and renaming.
    pub(crate) sync: bool,
    /// Apply explicit permissions to the temporary file before renaming.
    pub(crate) preserve_permissions: Option<Permissions>,
}

fn random_suffix() -> String {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_ok() {
        let mut hex = String::with_capacity(16);
        for byte in bytes {
            use std::fmt::Write;
            let _ = write!(&mut hex, "{byte:02x}");
        }
        return hex;
    }
    format!(
        "{}-{}",
        std::process::id(),
        ATOMIC_WRITE_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/// Atomically write `contents` to `path` via a unique sibling temporary file.
pub(crate) fn write_file_atomic(
    path: &Path,
    contents: &[u8],
    options: AtomicWriteOptions,
) -> Result<(), AppError> {
    if options.create_parents {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)
                    .map_err(|err| AppError::io("Could not create parent directory", err))?;
            }
        }
    }

    let file_name = path.file_name().ok_or_else(|| {
        AppError::InvalidInput(format!("Path has no file name: {}", path.display()))
    })?;

    let mut temp_path = None;
    let mut temp_file = None;
    for _ in 0..16 {
        let mut temp_name = OsString::from(".");
        temp_name.push(file_name);
        temp_name.push(format!(
            ".geolibre-{}-{}.tmp",
            random_suffix(),
            ATOMIC_WRITE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let candidate = path.with_file_name(temp_name);
        let mut open = OpenOptions::new();
        open.write(true).create_new(true);
        #[cfg(unix)]
        if options.owner_only_unix {
            std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
        }
        match open.open(&candidate) {
            Ok(file) => {
                temp_path = Some(candidate);
                temp_file = Some(file);
                break;
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(AppError::io("Could not create temporary file", err)),
        }
    }

    let (temp_path, mut temp_file) = match (temp_path, temp_file) {
        (Some(p), Some(f)) => (p, f),
        _ => {
            return Err(AppError::Internal(
                "Could not allocate a unique temporary file.".into(),
            ))
        }
    };

    let write_result = (|| -> std::io::Result<()> {
        temp_file.write_all(contents)?;
        if options.sync {
            temp_file.sync_all()?;
        }
        Ok(())
    })();
    // Close handle before set_permissions/rename/unlink (required on Windows).
    drop(temp_file);

    let finish_result = write_result
        .and_then(|()| {
            if let Some(perms) = options.preserve_permissions {
                fs::set_permissions(&temp_path, perms)?;
            }
            Ok(())
        })
        .and_then(|()| fs::rename(&temp_path, path));

    if let Err(err) = finish_result {
        let _ = fs::remove_file(&temp_path);
        return Err(AppError::io("Could not replace target file", err));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_replaces_atomically() {
        let dir = std::env::temp_dir().join(format!("geolibre-fs-util-{}", random_suffix()));
        let target = dir.join("nested").join("sample.json");
        write_file_atomic(
            &target,
            b"{\"v\":1}",
            AtomicWriteOptions {
                create_parents: true,
                owner_only_unix: true,
                sync: true,
                preserve_permissions: None,
            },
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\"v\":1}");

        write_file_atomic(
            &target,
            b"{\"v\":2}",
            AtomicWriteOptions {
                create_parents: false,
                owner_only_unix: true,
                sync: true,
                preserve_permissions: None,
            },
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\"v\":2}");
        let _ = fs::remove_dir_all(&dir);
    }
}
