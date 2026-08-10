# GeoLibre vendor patch

This directory is based on `tauri-plugin-dialog` 2.7.2 from crates.io.
GeoLibre vendors it because the upstream Android open dialog uses
`ACTION_GET_CONTENT`, which provides a temporary read-only `content://` grant.
GeoLibre later saves an opened project back to that URI, so Android denies the
write.

The GeoLibre-specific runtime delta is intentionally limited to
`android/src/main/java/DialogPlugin.kt`:

- honor `fileAccessMode: "scoped"` for Android open and save dialogs;
- use `ACTION_OPEN_DOCUMENT` for scoped open dialogs;
- request read, write, and persistable URI grants for scoped dialogs; and
- retain and verify the read/write grants returned by the document provider.

`src/commands.rs` passes the access mode through save-dialog calls. The API
documentation in `guest-js/index.ts` and `src/lib.rs` describes Android support,
and `src/mobile.rs` logs native picker failures before returning no selection.

Android limits how many URI grants an app may retain. GeoLibre requests scoped
access only for project documents whose paths remain in the recent-project
store. If a native release bridge is added later, removing a recent project
should also release its persisted URI permission.

When upgrading, compare the new upstream release against this directory,
reapply and test the Android picker changes above, update the version noted
here, and rebuild an Android APK. Because Cargo sees a path dependency,
Dependabot will not propose upstream version updates automatically.
