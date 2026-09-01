# GeoLibre vendor patch

This directory is based on `tauri-plugin-geolocation` 2.3.2 from crates.io.
GeoLibre vendors it because the upstream Android bridge does not expose the
number of GNSS satellites used in a location fix.

The GeoLibre-specific delta is intentionally limited to:

- `android/src/main/java/Geolocation.kt`: observe `GnssStatusCompat`, timestamp
  the observation so stale metadata is not paired with a fused fix, and notify
  one-shot callers when a satellite count becomes available.
- `android/src/main/java/GeolocationPlugin.kt`: include `satellites` in native
  coordinates, briefly race GNSS metadata against a timeout, and unregister
  one-shot GNSS monitoring after completion when no continuous watch is active;
  suppress speed at or below Android's reported speed uncertainty and omit unavailable
  speed/bearing values instead of serializing Android's zero-value placeholders.
- `src/models.rs`: preserve the optional value through Rust deserialization.

When upgrading, compare the new upstream release against this directory,
reapply and test the files above, update the version noted here, and rebuild an
Android APK. Because Cargo sees a path dependency, Dependabot will not propose
upstream version updates automatically.
