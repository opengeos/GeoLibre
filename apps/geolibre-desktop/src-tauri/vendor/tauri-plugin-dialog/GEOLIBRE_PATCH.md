# GeoLibre vendor patch

This directory is based on `tauri-plugin-dialog` 2.8.3 from crates.io.
GeoLibre vendors it because the upstream Android file picker launches
`ACTION_GET_CONTENT`, whose read grant ends with the app process. A project the
user picked could then not be read on the next launch, and the startup restore
fell back to a stale stored copy (GeoLibre#3216).

The GeoLibre-specific delta is intentionally limited to
`android/src/main/java/DialogPlugin.kt`:

- `showFilePicker`: launch `ACTION_OPEN_DOCUMENT` instead of
  `ACTION_GET_CONTENT`, except for the `image`/`video`/`media` picker modes,
  which keep `ACTION_GET_CONTENT` for the gallery apps it offers. The request
  carries no grant flags; the document picker returns read and persistable
  grants, plus write for a writable document. `ACTION_OPEN_DOCUMENT` lists
  document providers only, so apps that serve files solely through
  `ACTION_GET_CONTENT` no longer appear for document picks.
- `takePersistableGrants`: after an open or save pick, call
  `ContentResolver.takePersistableUriPermission` for each returned URI when the
  result marks its grant persistable, releasing the oldest persisted grants
  first to stay under Android's per-app cap (kept at 120 before Android 11 and
  500 from it, against limits of 128 and 512). Grants for documents in the
  current pick are never released. A refusal is logged and leaves the session
  grant in place.

Known limitation: every document pick persists, data files as well as
projects, so after more distinct picks than the cap the least recently picked
project can lose its grant. The app then reopens its stored copy and warns that
it may be out of date.

When upgrading, compare the new upstream release against this directory,
reapply and test the file above, update the version noted here, and rebuild an
Android APK. Because Cargo sees a path dependency, Dependabot will not propose
upstream version updates automatically.
