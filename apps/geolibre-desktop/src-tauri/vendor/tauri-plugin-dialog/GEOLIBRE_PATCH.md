# GeoLibre vendor patch

This directory is based on `tauri-plugin-dialog` 2.8.3 from crates.io.
GeoLibre vendors it because the upstream Android file picker launches
`ACTION_GET_CONTENT`, whose read grant ends with the app process. A project the
user picked could then not be read on the next launch, and the startup restore
fell back to a stale stored copy (GeoLibre#3216).

The GeoLibre-specific delta is intentionally limited to
`android/src/main/java/DialogPlugin.kt`:

- `showFilePicker`: launch `ACTION_OPEN_DOCUMENT` with read, write and
  persistable grant flags, except for the `image`/`video`/`media` picker modes,
  which keep `ACTION_GET_CONTENT` for the gallery apps it offers.
- `takePersistableGrants`: after an open or save pick, call
  `ContentResolver.takePersistableUriPermission` for each returned URI when the
  result marks its grant persistable, releasing the oldest persisted grants
  first to stay under Android's per-app cap. A refusal is logged and leaves the
  session grant in place.

When upgrading, compare the new upstream release against this directory,
reapply and test the file above, update the version noted here, and rebuild an
Android APK. Because Cargo sees a path dependency, Dependabot will not propose
upstream version updates automatically.
