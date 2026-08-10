# GeoLibre vendor patch

This directory is based on `tauri-plugin-dialog` 2.7.2 from crates.io.
GeoLibre vendors it because the upstream Android open dialog uses
`ACTION_GET_CONTENT`, which provides a temporary read-only `content://` grant.
GeoLibre later saves an opened project back to that URI, so Android denies the
write.

The GeoLibre-specific runtime delta is limited to these files:

- `android/src/main/java/DialogPlugin.kt` honors scoped Android open and save
  dialogs, retains and verifies grants, shows native permission errors, and
  removes a newly created document when Save As cannot retain access;
- `src/commands.rs` passes the access mode through save-dialog calls; and
- `src/mobile.rs` logs native picker failures before returning no selection.

Scoped project selection deliberately fails unless both grants can be retained.
GeoLibre does not expose a read-only project state, and accepting a temporary or
read-only URI would defer the failure until the user next saves the project.

The API documentation in `guest-js/index.ts` and `src/lib.rs` also describes
Android support.

Android limits how many URI grants an app may retain. GeoLibre requests scoped
access only for project documents whose paths remain in the recent-project
store. If a native release bridge is added later, removing a recent project
should also release its persisted URI permission.

When upgrading, compare the new upstream release against this directory,
reapply and test the Android picker changes above, update the version noted
here, and rebuild an Android APK. Because Cargo sees a path dependency,
Dependabot will not propose upstream version updates automatically. Keep the
exact `@tauri-apps/plugin-dialog` npm version aligned with this vendored crate.
