# GeoLibre vendor patch

This directory is based on `tauri-plugin-dialog` 2.7.2 from crates.io.
GeoLibre vendors it because the upstream Android open dialog uses
`ACTION_GET_CONTENT`, which provides a temporary read-only `content://` grant.
GeoLibre later saves an opened project back to that URI, so Android denies the
write.

The GeoLibre-specific runtime delta is intentionally limited to
`android/src/main/java/DialogPlugin.kt`:

- honor the existing `fileAccessMode: "scoped"` option on Android;
- use `ACTION_OPEN_DOCUMENT` for scoped open dialogs;
- request read, write, and persistable URI grants for scoped dialogs; and
- retain the read/write grants returned by the document provider.

`src/lib.rs` also documents that the option is supported by this Android patch.

When upgrading, compare the new upstream release against this directory,
reapply and test the Android picker changes above, update the version noted
here, and rebuild an Android APK. Because Cargo sees a path dependency,
Dependabot will not propose upstream version updates automatically.
