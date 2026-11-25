//! Scaffolding shared by the unit tests of several modules.

use std::path::PathBuf;

// A throwaway directory tree under the system temp dir that removes itself
// on drop, so scratch dirs are cleaned up even when an assertion panics.
// Uses the process id (no rand dependency) and clears any leftover from a
// prior run at construction.
pub(crate) struct ScratchDir(PathBuf);

impl ScratchDir {
    pub(crate) fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("geolibre-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    pub(crate) fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
