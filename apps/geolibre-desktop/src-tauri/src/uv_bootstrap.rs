//! Pinned, checksum-verified uv bootstrap for the desktop sidecar.
//!
//! The desktop app installs uv (when it is neither configured nor on PATH) by
//! downloading the pinned release archive for this platform and checking its
//! SHA-256 before extracting anything. It never runs a remote install script.
//!
//! The source of truth for the pin is `UV_VERSION` / `UV_RELEASE_SHA256` in
//! `backend/geolibre_server/geolibre_server/app/runtime.py`; the constants here
//! mirror it, and `backend/geolibre_server/tests/test_runtime_uv_bootstrap.py`
//! fails if the two drift. Bump both together, copying the digests from the
//! release's official `<archive>.sha256` assets.

use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};

pub const UV_VERSION: &str = "0.13.9";

pub const UV_RELEASE_SHA256: &[(&str, &str)] = &[
    (
        "uv-aarch64-apple-darwin.tar.gz",
        "5aeca67f2283f75235de40d0bd9c0a5bbc5fce23b6d48b3bf9fa1b2db08382ca",
    ),
    (
        "uv-x86_64-apple-darwin.tar.gz",
        "617a3211261b0fc739562f0071aa34e9739797c510208ede8e2977c30903d041",
    ),
    (
        "uv-aarch64-unknown-linux-musl.tar.gz",
        "37fbb7c5bc66cf99c12aa881949d216181e201dec449772c4329e56487d61179",
    ),
    (
        "uv-x86_64-unknown-linux-musl.tar.gz",
        "58ccf5f1792b8a5a88d01bc910ea131a8b3db4a319a17ad5fad75e0845a3e271",
    ),
    (
        "uv-aarch64-pc-windows-msvc.zip",
        "72eed595983a4d7d22d79f21065b0f4479cc7e5c7a89104bb410c8f47559a878",
    ),
    (
        "uv-x86_64-pc-windows-msvc.zip",
        "edd61f7f5728a56cc62455386661860bdfc7bab65872f39b0c25bdcc1d8e1beb",
    ),
];

const UV_DOWNLOAD_BASE_URL: &str = "https://github.com/astral-sh/uv/releases/download";
const UV_MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;

/// The uv release archive for an `std::env::consts` OS/arch pair.
pub fn uv_release_archive(os: &str, arch: &str) -> Result<&'static str, String> {
    let target = match os {
        "macos" => "apple-darwin.tar.gz",
        // The static musl build runs on glibc and musl distributions alike.
        "linux" => "unknown-linux-musl.tar.gz",
        "windows" => "pc-windows-msvc.zip",
        _ => "",
    };
    let wanted = format!("uv-{arch}-{target}");
    UV_RELEASE_SHA256
        .iter()
        .find(|(name, _)| *name == wanted)
        .map(|(name, _)| *name)
        .ok_or_else(|| {
            format!(
                "No pinned uv {UV_VERSION} build for {os}/{arch}. Install uv and put it on \
                 PATH, or set GEOLIBRE_UV to its path."
            )
        })
}

fn pinned_sha256(archive_name: &str) -> Option<&'static str> {
    UV_RELEASE_SHA256
        .iter()
        .find(|(name, _)| *name == archive_name)
        .map(|(_, digest)| *digest)
}

/// Reject `bytes` unless their SHA-256 is `expected` (lowercase hex).
pub fn verify_sha256(bytes: &[u8], expected: &str) -> Result<(), String> {
    let actual: String = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "uv download failed SHA-256 verification (expected {expected}, got {actual}); \
             refusing to install it"
        ))
    }
}

fn uv_binary_names(windows: bool) -> &'static [&'static str] {
    if windows {
        &["uv.exe", "uvx.exe", "uvw.exe"]
    } else {
        &["uv", "uvx"]
    }
}

/// Copy uv's executables out of a verified archive into `install_dir`.
///
/// Only regular entries whose file name is a known uv executable are read, so
/// archive paths never decide where anything is written.
pub fn extract_uv_binaries(
    archive: &[u8],
    archive_name: &str,
    install_dir: &Path,
) -> Result<(), String> {
    let windows = archive_name.ends_with(".zip");
    let wanted = uv_binary_names(windows);
    let mut found: Vec<(&'static str, Vec<u8>)> = Vec::new();
    let pick = |name: &str| wanted.iter().copied().find(|candidate| *candidate == name);

    if windows {
        let mut zip = zip::ZipArchive::new(Cursor::new(archive))
            .map_err(|error| format!("Could not read the uv archive: {error}"))?;
        for index in 0..zip.len() {
            let mut file = zip
                .by_index(index)
                .map_err(|error| format!("Could not read the uv archive: {error}"))?;
            if file.is_dir() {
                continue;
            }
            let name = file
                .name()
                .map_err(|error| format!("Could not read the uv archive: {error}"))?
                .to_string();
            let Some(binary) = Path::new(&name)
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(pick)
            else {
                continue;
            };
            let mut data = Vec::new();
            file.read_to_end(&mut data)
                .map_err(|error| format!("Could not read the uv archive: {error}"))?;
            found.push((binary, data));
        }
    } else {
        let mut tar = tar::Archive::new(GzDecoder::new(Cursor::new(archive)));
        let entries = tar
            .entries()
            .map_err(|error| format!("Could not read the uv archive: {error}"))?;
        for entry in entries {
            let mut entry =
                entry.map_err(|error| format!("Could not read the uv archive: {error}"))?;
            if !entry.header().entry_type().is_file() {
                continue;
            }
            let path = entry
                .path()
                .map_err(|error| format!("Could not read the uv archive: {error}"))?
                .into_owned();
            let Some(binary) = path.file_name().and_then(|n| n.to_str()).and_then(pick) else {
                continue;
            };
            let mut data = Vec::new();
            entry
                .read_to_end(&mut data)
                .map_err(|error| format!("Could not read the uv archive: {error}"))?;
            found.push((binary, data));
        }
    }

    let primary = wanted[0];
    if !found.iter().any(|(name, _)| *name == primary) {
        return Err(format!("The uv archive does not contain {primary}"));
    }
    for (name, data) in found {
        let staging = install_dir.join(format!(".{name}.tmp"));
        fs::write(&staging, &data).map_err(|error| format!("Could not write {name}: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&staging, fs::Permissions::from_mode(0o755))
                .map_err(|error| format!("Could not mark {name} executable: {error}"))?;
        }
        fs::rename(&staging, install_dir.join(name))
            .map_err(|error| format!("Could not install {name}: {error}"))?;
    }
    Ok(())
}

/// Verify a downloaded archive against its pin, then extract it.
pub fn install_from_archive(
    archive: &[u8],
    archive_name: &str,
    install_dir: &Path,
) -> Result<(), String> {
    let expected = pinned_sha256(archive_name)
        .ok_or_else(|| format!("No pinned checksum for {archive_name}"))?;
    verify_sha256(archive, expected)?;
    extract_uv_binaries(archive, archive_name, install_dir)
}

fn download_archive(url: &str) -> Result<Vec<u8>, String> {
    let response = reqwest::blocking::Client::builder()
        .user_agent("GeoLibre Desktop uv-bootstrap")
        .build()
        .map_err(|error| format!("Could not create HTTP client: {error}"))?
        .get(url)
        .send()
        .map_err(|error| format!("Could not download uv from {url}: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "uv download from {url} failed with status {status}"
        ));
    }
    let mut data = Vec::new();
    response
        .take(UV_MAX_ARCHIVE_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|error| format!("Could not read uv download: {error}"))?;
    if data.len() as u64 > UV_MAX_ARCHIVE_BYTES {
        return Err(format!(
            "uv download from {url} exceeds {UV_MAX_ARCHIVE_BYTES} bytes"
        ));
    }
    Ok(data)
}

/// Download, verify, and install the pinned uv into `install_dir`.
///
/// Returns the path of the installed `uv` executable.
pub fn install_pinned_uv(install_dir: &Path) -> Result<PathBuf, String> {
    let archive_name = uv_release_archive(std::env::consts::OS, std::env::consts::ARCH)?;
    let url = format!("{UV_DOWNLOAD_BASE_URL}/{UV_VERSION}/{archive_name}");
    let archive = download_archive(&url)?;
    install_from_archive(&archive, archive_name, install_dir)?;
    let uv = install_dir.join(uv_binary_names(cfg!(target_os = "windows"))[0]);
    if !uv.is_file() {
        return Err(format!("uv install did not create {}", uv.display()));
    }
    Ok(uv)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tar_gz(members: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::default(),
        ));
        for (name, data) in members {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder.append_data(&mut header, name, *data).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn zip_bytes(members: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, data) in members {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "geolibre-uv-test-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn pins_cover_supported_platforms() {
        for (os, arch) in [
            ("linux", "x86_64"),
            ("linux", "aarch64"),
            ("macos", "x86_64"),
            ("macos", "aarch64"),
            ("windows", "x86_64"),
            ("windows", "aarch64"),
        ] {
            let archive = uv_release_archive(os, arch).unwrap();
            assert_eq!(pinned_sha256(archive).unwrap().len(), 64);
        }
        assert!(uv_release_archive("linux", "riscv64").is_err());
        assert!(uv_release_archive("freebsd", "x86_64").is_err());
    }

    #[test]
    fn verifies_and_extracts_tarball_binaries_only() {
        let dir = temp_dir("tar");
        let archive = tar_gz(&[
            ("uv-x86_64-unknown-linux-musl/uv", b"uv-binary"),
            ("uv-x86_64-unknown-linux-musl/uvx", b"uvx-binary"),
            ("uv-x86_64-unknown-linux-musl/README", b"readme"),
        ]);
        let digest: String = Sha256::digest(&archive)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        verify_sha256(&archive, &digest).unwrap();
        extract_uv_binaries(&archive, "uv-x86_64-unknown-linux-musl.tar.gz", &dir).unwrap();
        assert_eq!(fs::read(dir.join("uv")).unwrap(), b"uv-binary");
        assert_eq!(fs::read(dir.join("uvx")).unwrap(), b"uvx-binary");
        assert!(!dir.join("README").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.join("uv")).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111);
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn extracts_windows_zip() {
        let dir = temp_dir("zip");
        let archive = zip_bytes(&[
            ("uv.exe", b"uv-binary"),
            ("uvx.exe", b"uvx-binary"),
            ("other.txt", b"x"),
        ]);
        extract_uv_binaries(&archive, "uv-x86_64-pc-windows-msvc.zip", &dir).unwrap();
        assert_eq!(fs::read(dir.join("uv.exe")).unwrap(), b"uv-binary");
        assert!(!dir.join("other.txt").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn checksum_mismatch_is_rejected_before_extraction() {
        let dir = temp_dir("mismatch");
        let archive = tar_gz(&[("uv-x86_64-unknown-linux-musl/uv", b"tampered")]);
        let error = install_from_archive(&archive, "uv-x86_64-unknown-linux-musl.tar.gz", &dir)
            .unwrap_err();
        assert!(error.contains("SHA-256 verification"), "{error}");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn archive_without_uv_is_rejected() {
        let dir = temp_dir("missing");
        let archive = tar_gz(&[("d/other", b"x")]);
        let error =
            extract_uv_binaries(&archive, "uv-x86_64-unknown-linux-musl.tar.gz", &dir).unwrap_err();
        assert!(error.contains("does not contain uv"), "{error}");
        let _ = fs::remove_dir_all(dir);
    }
}
