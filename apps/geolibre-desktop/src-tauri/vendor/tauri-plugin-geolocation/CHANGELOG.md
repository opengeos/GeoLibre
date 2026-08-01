# Changelog

## \[2.3.2]

- [`93426f85`](https://github.com/tauri-apps/plugins-workspace/commit/93426f85120f49beb9f40222bff45185a32d54a9) Fixed an issue that caused docs.rs builds to fail. No user facing changes.

## \[2.3.1]

- [`6c9b61fb`](https://github.com/tauri-apps/plugins-workspace/commit/6c9b61fb658145d13893626112fc489f7458aa17) ([#3039](https://github.com/tauri-apps/plugins-workspace/pull/3039) by [@FabianLars](https://github.com/tauri-apps/plugins-workspace/../../FabianLars)) On Android, updated compileSdk to 36.
- [`e933acb0`](https://github.com/tauri-apps/plugins-workspace/commit/e933acb0044b4d49053eae6492b542351160e66a) ([#3010](https://github.com/tauri-apps/plugins-workspace/pull/3010) by [@FabianLars](https://github.com/tauri-apps/plugins-workspace/../../FabianLars)) On Android, use the `timeout` value for `setMinUpdateIntervalMillis`, `setMaxUpdateDelayMillis` and `setIntervalMillis` instead of just `minUpdateInterval`.

## \[2.3.0]

- [`f209b2f2`](https://github.com/tauri-apps/plugins-workspace/commit/f209b2f23cb29133c97ad5961fb46ef794dbe063) ([#2804](https://github.com/tauri-apps/plugins-workspace/pull/2804) by [@renovate](https://github.com/tauri-apps/plugins-workspace/../../renovate)) Updated tauri to 2.6

## \[2.2.5]

- [`f634e524`](https://github.com/tauri-apps/plugins-workspace/commit/f634e5248ebe428f8305a59f74c13fc15147fb8e) This is an "empty" release to update the plugins' source files on crates.io and docs.rs. This should fix docs.rs build failures for projects using tauri plugins as dependencies.

## \[2.2.4]

- [`a1b3fa27`](https://github.com/tauri-apps/plugins-workspace/commit/a1b3fa27f11022c9b6622b4fab12d93239eb05de) ([#2515](https://github.com/tauri-apps/plugins-workspace/pull/2515) by [@FabianLars](https://github.com/tauri-apps/plugins-workspace/../../FabianLars)) Re-exported the `Geolocation`, `Haptics`, `Notification`, and `Os` structs so that they show up on docs.rs.

## \[2.2.3]

- [`406e6f48`](https://github.com/tauri-apps/plugins-workspace/commit/406e6f484cdc13d35c50fb949f7489ca9eeccc44) ([#2323](https://github.com/tauri-apps/plugins-workspace/pull/2323) by [@FabianLars](https://github.com/tauri-apps/plugins-workspace/../../FabianLars)) Fixed an issue that caused build failures when the `haptics` or `geolocation` plugin was used without their `specta` feature flag enabled.

## \[2.2.2]

- [`c9c13a0f`](https://github.com/tauri-apps/plugins-workspace/commit/c9c13a0fe7cdaac223843f5ba33176252f8e22f5) ([#2316](https://github.com/tauri-apps/plugins-workspace/pull/2316) by [@FabianLars](https://github.com/tauri-apps/plugins-workspace/../../FabianLars)) **Breaking change:** `specta` integration is now behind a `specta` feature flag like in Tauri.
- [`c9c13a0f`](https://github.com/tauri-apps/plugins-workspace/commit/c9c13a0fe7cdaac223843f5ba33176252f8e22f5) ([#2316](https://github.com/tauri-apps/plugins-workspace/pull/2316) by [@FabianLars](https://github.com/tauri-apps/plugins-workspace/../../FabianLars)) Unlock and widen `specta` version range to match Tauri. No API changes.

## \[2.2.1]

- [`fb67ab2b`](https://github.com/tauri-apps/plugins-workspace/commit/fb67ab2b926502bfc20d6b43fbdd156691ea8526) ([#2281](https://github.com/tauri-apps/plugins-workspace/pull/2281) by [@FabianLars](https://github.com/tauri-apps/plugins-workspace/../../FabianLars)) Added `specta-util` to fix a "dependency not found" compilation error.

## \[2.2.0]

- [`3a79266b`](https://github.com/tauri-apps/plugins-workspace/commit/3a79266b8cf96a55b1ae6339d725567d45a44b1d) ([#2173](https://github.com/tauri-apps/plugins-workspace/pull/2173) by [@FabianLars](https://github.com/tauri-apps/plugins-workspace/../../FabianLars)) Bumped all plugins to `v2.2.0`. From now, the versions for the Rust and JavaScript packages of each plugin will be in sync with each other.

## \[2.0.1]

- [`a1a82208`](https://github.com/tauri-apps/plugins-workspace/commit/a1a82208ed4ab87f83310be0dc95428aec9ab241) ([#1873](https://github.com/tauri-apps/plugins-workspace/pull/1873) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Downgrade MSRV to 1.77.2 to support Windows 7.

## \[2.0.0]

- [`e2c4dfb6`](https://github.com/tauri-apps/plugins-workspace/commit/e2c4dfb6af43e5dd8d9ceba232c315f5febd55c1) Update to tauri v2 stable release.

## \[2.0.0-rc.2]

- [`60765694`](https://github.com/tauri-apps/plugins-workspace/commit/60765694f54875e22b8eb70b1d2e32dbf0c585c7) ([#1773](https://github.com/tauri-apps/plugins-workspace/pull/1773) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Update API to match other plugins.

## \[2.0.0-rc.1]

- [`e2e97db5`](https://github.com/tauri-apps/plugins-workspace/commit/e2e97db51983267f5be84d4f6f0278d58834d1f5) ([#1701](https://github.com/tauri-apps/plugins-workspace/pull/1701) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Use `PermissionState` from the `tauri` crate, which now also includes a "prompt with rationale" variant for Android (returned when your app must explain to the user why it needs the permission).
- [`e2e97db5`](https://github.com/tauri-apps/plugins-workspace/commit/e2e97db51983267f5be84d4f6f0278d58834d1f5) ([#1701](https://github.com/tauri-apps/plugins-workspace/pull/1701) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Update to tauri 2.0.0-rc.8

## \[2.0.0-rc.2]

- [`b9147758`](https://github.com/tauri-apps/plugins-workspace/commit/b914775898c2bee7ceb20bd17ee595005cd17a64) ([#1679](https://github.com/tauri-apps/plugins-workspace/pull/1679) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Explicitly set a minimum macOS version for the Swift package.

## \[2.0.0-rc.1]

- [`5d170a54`](https://github.com/tauri-apps/plugins-workspace/commit/5d170a5444982dcc14135f6f1fc3e5da359f0eb0) ([#1671](https://github.com/tauri-apps/plugins-workspace/pull/1671) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Update to tauri 2.0.0-rc.3.

### changes

- [`6b079cfd`](https://github.com/tauri-apps/plugins-workspace/commit/6b079cfdd107c94abc2c7300f6af00bac3ff4040) ([#1649](https://github.com/tauri-apps/plugins-workspace/pull/1649) by [@ahqsoftwares](https://github.com/tauri-apps/plugins-workspace/../../ahqsoftwares)) Remove targetSdk from build.kts files as it is deprecated and will be removed from DSL v9.0

## \[2.0.0-rc.0]

- [`9606089b`](https://github.com/tauri-apps/plugins-workspace/commit/9606089b2add4a17f80ed5a09d59ce94824bd672) ([#1599](https://github.com/tauri-apps/plugins-workspace/pull/1599)) Initial release.
- [`9887d1`](https://github.com/tauri-apps/plugins-workspace/commit/9887d14bd0e971c4c0f5c1188fc4005d3fc2e29e) Update to tauri RC.
  tauri-apps/plugins-workspace/commit/9887d14bd0e971c4c0f5c1188fc4005d3fc2e29e) Update to tauri RC.
