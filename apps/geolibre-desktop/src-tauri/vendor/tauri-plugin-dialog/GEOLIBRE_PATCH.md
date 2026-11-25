# GeoLibre vendor patch

This directory is based on `tauri-plugin-dialog` 2.8.3 from crates.io.
GeoLibre vendors it because the upstream Android file picker launches
`ACTION_GET_CONTENT`, whose read grant ends with the app process. A project the
user picked could then not be read on the next launch, and the startup restore
fell back to a stale stored copy (GeoLibre#3216).

The GeoLibre-specific changes preserve document grants and adapt data-file picks
to the local paths used by GeoLibre's readers:

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
- `parseFiltersOption`: for the file picker (not the save dialog), a filter
  that has both mapped extensions and ones with no `MimeTypeMap` entry
  (`geojson`, `gpkg`, `fgb`, ...) also lists `application/octet-stream`. The
  document provider types such files as `octet-stream` from the same table, so
  they were greyed out ("BIN file") whenever another extension in the filter
  mapped (GeoLibre#3325). A filter of only unmapped extensions still yields no
  MIME types, which leaves the picker unfiltered as upstream does.

- Explicit `fileAccessMode: "copy"` data picks on Android stream the selected
  documents into `files/picked-documents/<selection>/data/`, using the provider's
  display names rather than interpreting opaque document IDs as filenames.
  `DocumentCopyBatch.kt` keeps a selection's companions together, replaces path
  separators and control characters in provider labels with underscores, rejects
  empty/dot/oversized names and collisions after sanitization, and removes the
  entire selection when copying fails. The manifest keeps both the actual local
  filename and the original provider label.
  Copying runs off the UI thread with a bounded buffer. A sibling `source.json`
  retains each original URI, filename, byte count and SHA-256 fingerprint.
  The app can therefore reopen the local data offline while retaining its source
  reference for the offline catalog and conflict-aware sync work in #3530.
  Explicit copies use the document picker even for images, retaining persistable
  grants where the provider allows them. Project picks do not request this mode
  and retain their existing URI behavior.
- An identical selection from the same provider URIs reuses its existing folder.
  Selection order does not matter. Matching uses the names and source identities
  plus SHA-256 fingerprints; existing files are rehashed before reuse so local
  edits are never overwritten or mistaken for the original document. Distinct
  provider documents retain separate copies even when their bytes match. A
  bounded set of locks serializes identical selections without one global queue
  for every import.
  Temporary duplicates are removed before paths are returned.
- Imports first stream into private `.pending-<selection>` folders. Files,
  manifests, and directory entries are synced before the folder is renamed to
  its published UUID; the storage root and its existing parent are synced before
  any path is returned. Android uses `Os.open`, `Os.fsync`, and `Os.close` for
  directory synchronization. A post-rename failure rolls back while holding the
  selection's commit lock, so another import cannot reuse a folder that cleanup
  then deletes.
- The app process tracks active stages under a lifecycle lock. A new import
  removes abandoned staging folders left by an interrupted previous process,
  while retaining current imports and all published/legacy folders. Staging
  paths are never returned to callers, so this cleanup cannot invalidate a
  saved project's source path.
- Published copies are durable project data, not an evictable cache. Removing a
  layer or closing a project does not delete them, because another saved project
  can reference the same path. Modified copies and new source versions therefore
  remain separate. They currently live until the app's stored data is removed;
  reference-aware storage management belongs to the offline catalog work in
  #3530. Failed and uncommitted selections are removed immediately.
- Explicit data-copy failures use a result-bearing mobile bridge rather than
  the upstream callback-only picker API, which collapses errors into a cancelled
  selection. Cancellation still returns no selection; provider and storage
  failures reach the caller as errors. `src/models.rs` tests that distinction.
- `src/commands.rs` decodes copy-mode file URLs to local paths, including iOS
  document-picker copies. It leaves scoped project URLs and Android content URIs
  intact. Scope grants still come from the selected file before it is returned.
- On iOS, explicit data copies use Files even when an image MIME type would
  otherwise open Photos. `FilePickerPolicy.swift` retains the existing media
  behavior for ordinary gallery requests. Its standalone Swift tests run before
  the iOS build with the selected Xcode toolchain.
- The iOS result-bearing data bridge persists UIKit import files through
  `src/ios_data_copy.rs` before returning paths. It streams into app-local
  `picked-documents/.pending-<selection>/data/`, hashes each file, stores a
  manifest, syncs files and directory entries, then atomically publishes the
  complete UUID folder. Case-conflicting names, symlinks, and invalid file names
  are rejected. Failed selections roll back, and serialized imports recover
  abandoned stages without touching published copies. Each pick retains its own
  identity because a UIKit temporary URL is not an original provider identity.
  Ordinary scoped picks use the existing upstream flow. Physical iOS device
  verification remains outstanding.

`android/src/test/java/DocumentCopyBatchTest.kt` checks streaming, fingerprints,
companion placement, rollback, unsafe names and collision handling. The Rust
`geolibre_copy_tests` cover copy-mode file URLs and unchanged source URIs.
The Rust check job also runs `tests/native-document-copy`, which imports the
production iOS copy store and executes its unit tests on Linux without UIKit.
The iOS workflow compiles and executes the real picker policy
against its standalone scenarios before building the app.

Known limitation: every document pick persists, data files as well as
projects, so after more distinct picks than the cap the least recently picked
project can lose its grant. The app then reopens its stored copy and warns that
it may be out of date.

When upgrading, compare the new upstream release against this directory,
reapply and test the file above, update the version noted here, and rebuild an
Android APK. Because Cargo sees a path dependency, Dependabot will not propose
upstream version updates automatically.
