# Changelog

## \[2.7.2]

- [`40ae0a7f`](https://github.com/tauri-apps/plugins-workspace/commit/40ae0a7fa0ecc9b0cdbd952297f7a17f37308229) ([#3491](https://github.com/tauri-apps/plugins-workspace/pull/3491) by [@Legend-Master](https://github.com/tauri-apps/plugins-workspace/../../Legend-Master)) Use `com.google.android.material.dialog.MaterialAlertDialogBuilder` instead of `AlertDialog` so the dialog follows the app's theme

## \[2.7.1]

### Dependencies

- Upgraded to `fs-js@2.5.1`

## \[2.7.0]

- [`24154472`](https://github.com/tauri-apps/plugins-workspace/commit/24154472a6710a690173df0a121125d1f1b871e8) ([#3287](https://github.com/tauri-apps/plugins-workspace/pull/3287) by [@Legend-Master](https://github.com/tauri-apps/plugins-workspace/../../Legend-Master)) Re-use `message` command in Rust side for `ask` and `confirm` commands, `allow-ask` and `allow-confirm` permissions are now aliases to `allow-message`

### Dependencies

- Upgraded to `fs-js@2.5.0`

## \[2.6.0]

- [`d7a0bb32`](https://github.com/tauri-apps/plugins-workspace/commit/d7a0bb325dad919d6cc132eb3898c33540de77c4) ([#3136](https://github.com/tauri-apps/plugins-workspace/pull/3136) by [@onehumandev](https://github.com/tauri-apps/plugins-workspace/../../onehumandev)) Add `fileAccessMode` option to file picker.

## \[2.5.0]

- [`dff6fa98`](https://github.com/tauri-apps/plugins-workspace/commit/dff6fa986a9a05ba98b6ca660fea78ae97251fc2) ([#3034](https://github.com/tauri-apps/plugins-workspace/pull/3034) by [@onehumandev](https://github.com/tauri-apps/plugins-workspace/../../onehumandev)) Add `pickerMode` option to file picker (currently only used on iOS)

### Dependencies

- Upgraded to `fs-js@2.4.5`

### feat

- [`c23fa03f`](https://github.com/tauri-apps/plugins-workspace/commit/c23fa03f07d5c1c220bcf0bca482364513e3f754) ([#3098](https://github.com/tauri-apps/plugins-workspace/pull/3098) by [@Lepidopteran](https://github.com/tauri-apps/plugins-workspace/../../Lepidopteran)) Add `xdg-portal` as an optional feature for `rfd`

## \[2.4.2]

- [`93426f85`](https://github.com/tauri-apps/plugins-workspace/commit/93426f85120f49beb9f40222bff45185a32d54a9) Fixed an issue that caused docs.rs builds to fail. No user facing changes.

### Dependencies

- Upgraded to `fs-js@2.4.4`

## \[2.4.1]

- [`6c9b61fb`](https://github.com/tauri-apps/plugins-workspace/commit/6c9b61fb658145d13893626112fc489f7458aa17) ([#3039](https://github.com/tauri-apps/plugins-workspace/pull/3039) by [@FabianLars](https://github.com/tauri-apps/plugins-workspace/../../FabianLars)) On Android, updated compileSdk to 36.

### Dependencies

- Upgraded to `fs-js@2.4.3`

## \[2.4.0]

- [`509eba8d`](https://github.com/tauri-apps/plugins-workspace/commit/509eba8d441c4f6ecf0af77b572cb2afd69a752d) ([#2641](https://github.com/tauri-apps/plugins-workspace/pull/2641) by [@amrbashir](https://github.com/tauri-apps/plugins-workspace/../../amrbashir)) Add support for showing a message dialog with 3 buttons.

## \[2.3.3]

### Dependencies

- Upgraded to `fs-js@2.4.2`

## \[2.3.2]

- [`af08c66f`](https://github.com/tauri-apps/plugins-workspace/commit/af08c66faafe0dffc4b0a80aef030cd3f0f89a9c) ([#2871](https://github.com/tauri-apps/plugins-workspace/pull/2871) by [@FabianLars](https://github.com/tauri-apps/plugins-workspace/../../FabianLars)) Fixed an issue that caused the file picker not to open on Android when extension filters were set.

## \[2.3.1]

### Dependencies

- Upgraded to `fs-js@2.4.1`

## \[2.3.0]

- [`f209b2f2`](https://github.com/tauri-apps/plugins-workspace/commit/f209b2f23cb29133c97ad5961fb46ef794dbe063) ([#2804](https://github.com/tauri-apps/plugins-workspace/pull/2804) by [@renovate](https://github.com/tauri-apps/plugins-workspace/../../renovate)) Updated tauri to 2.6

### Dependencies

- Upgraded to `fs-js@2.4.0`

## \[2.2.2]

### Dependencies

- Upgraded to `fs-js@2.3.0`

## \[2.2.1]

### Dependencies

- Upgraded to `fs-js@2.2.1`

## \[2.2.0]

- [`3a79266b`](https://github.com/tauri-apps/plugins-workspace/commit/3a79266b8cf96a55b1ae6339d725567d45a44b1d) ([#2173](https://github.com/tauri-apps/plugins-workspace/pull/2173) by [@FabianLars](https://github.com/tauri-apps/plugins-workspace/../../FabianLars)) Bumped all plugins to `v2.2.0`. From now, the versions for the Rust and JavaScript packages of each plugin will be in sync with each other.

### Dependencies

- Upgraded to `fs-js@2.1.0`

## \[2.0.2]

### Dependencies

- Upgraded to `fs-js@2.0.4`

## \[2.0.4]

- [`76f99ce9`](https://github.com/tauri-apps/plugins-workspace/commit/76f99ce999a2ff9e40235c1675e3eb6570b5e1e2) ([#2108](https://github.com/tauri-apps/plugins-workspace/pull/2108) by [@FabianLars](https://github.com/tauri-apps/plugins-workspace/../../FabianLars)) The `Dialog` struct is now correctly exported, primarily to fix the documentation on `docs.rs`.

### Dependencies

- Upgraded to `fs@2.1.0`

## \[2.0.3]

### Dependencies

- Upgraded to `fs@2.0.3`

## \[2.0.1]

- [`2302c2db`](https://github.com/tauri-apps/plugins-workspace/commit/2302c2db1c49673e61dcbda8cdb01b2c57e9ba6f) ([#1910](https://github.com/tauri-apps/plugins-workspace/pull/1910) by [@Legend-Master](https://github.com/tauri-apps/plugins-workspace/../../Legend-Master)) Fix `ask` and `confirm` not using system button texts
- [`aee14ed4`](https://github.com/tauri-apps/plugins-workspace/commit/aee14ed4261cdedc4ed7cc2686f01f437859a5c7) ([#1892](https://github.com/tauri-apps/plugins-workspace/pull/1892) by [@nashaofu](https://github.com/tauri-apps/plugins-workspace/../../nashaofu)) Set `save` dialog mime type from the `filters` extensions on Android.

## \[2.0.1]

- [`a1a82208`](https://github.com/tauri-apps/plugins-workspace/commit/a1a82208ed4ab87f83310be0dc95428aec9ab241) ([#1873](https://github.com/tauri-apps/plugins-workspace/pull/1873) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Downgrade MSRV to 1.77.2 to support Windows 7.

### Dependencies

- Upgraded to `fs@2.0.1`

## \[2.0.0]

- [`e2c4dfb6`](https://github.com/tauri-apps/plugins-workspace/commit/e2c4dfb6af43e5dd8d9ceba232c315f5febd55c1) Update to tauri v2 stable release.

### Dependencies

- Upgraded to `fs@2.0.0`

## \[2.0.0-rc.8]

- [`6bf1bd8d`](https://github.com/tauri-apps/plugins-workspace/commit/6bf1bd8d44bb95618590aa066e638509b014e0f9) ([#1805](https://github.com/tauri-apps/plugins-workspace/pull/1805) by [@renovate](https://github.com/tauri-apps/plugins-workspace/../../renovate)) Update rfd to 0.15

### Dependencies

- Upgraded to `fs@2.0.0-rc.6`

### breaking

- [`04459afb`](https://github.com/tauri-apps/plugins-workspace/commit/04459afbb67aafa5cd57e6a148c2beb0a8d3e04a) ([#1842](https://github.com/tauri-apps/plugins-workspace/pull/1842) by [@Legend-Master](https://github.com/tauri-apps/plugins-workspace/../../Legend-Master)) Changed `MessageDialogBuilder::ok_button_label` and `MessageDialogBuilder::cancel_button_label` to `MessageDialogBuilder::buttons` which takes an enum now

## \[2.0.0-rc.7]

### Dependencies

- Upgraded to `fs@2.0.0-rc.5`

## \[2.0.0-rc.6]

- [`2b898f07`](https://github.com/tauri-apps/plugins-workspace/commit/2b898f078688c57309ca17962bf02e665c406514) ([#1769](https://github.com/tauri-apps/plugins-workspace/pull/1769) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Update Tauri scopes (asset protocol) when using the `open()` command to select directories.

### Dependencies

- Upgraded to `fs@2.0.0-rc.4`

## \[2.0.0-rc.5]

- [`a2fe5551`](https://github.com/tauri-apps/plugins-workspace/commit/a2fe55512f908dd11c814ce021d164f01677572a) ([#1727](https://github.com/tauri-apps/plugins-workspace/pull/1727) by [@amrbashir](https://github.com/tauri-apps/plugins-workspace/../../amrbashir)) Add utility methods on `FilePath` and `SafeFilePath` enums which are:

  - `path`
  - `simplified`
  - `into_path`
- [`a2fe5551`](https://github.com/tauri-apps/plugins-workspace/commit/a2fe55512f908dd11c814ce021d164f01677572a) ([#1727](https://github.com/tauri-apps/plugins-workspace/pull/1727) by [@amrbashir](https://github.com/tauri-apps/plugins-workspace/../../amrbashir)) Implement `Serialize`, `Deserialize`, `From`, `TryFrom` and `FromStr` traits for `FilePath` and `SafeFilePath` enums.
- [`a2fe5551`](https://github.com/tauri-apps/plugins-workspace/commit/a2fe55512f908dd11c814ce021d164f01677572a) ([#1727](https://github.com/tauri-apps/plugins-workspace/pull/1727) by [@amrbashir](https://github.com/tauri-apps/plugins-workspace/../../amrbashir)) Mark `Error` enum as `#[non_exhuastive]`.
- [`a2fe5551`](https://github.com/tauri-apps/plugins-workspace/commit/a2fe55512f908dd11c814ce021d164f01677572a) ([#1727](https://github.com/tauri-apps/plugins-workspace/pull/1727) by [@amrbashir](https://github.com/tauri-apps/plugins-workspace/../../amrbashir)) Add `SafeFilePath` enum.

### Dependencies

- Upgraded to `fs@2.0.0-rc.3`

## \[2.0.0-rc.4]

### Dependencies

- Upgraded to `fs@2.0.0-rc.2`

### breaking

- [`0cb99bda`](https://github.com/tauri-apps/plugins-workspace/commit/0cb99bdaf11b5a9bb66b80bdf40b085d87c3066d) ([#1706](https://github.com/tauri-apps/plugins-workspace/pull/1706) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) If no filters are specified, the file picker dialog now defaults to a file selection instead of photos.

### feat

- [`feb1e93f`](https://github.com/tauri-apps/plugins-workspace/commit/feb1e93fcb9a913c002daa29e3b709f24b97c664) ([#1707](https://github.com/tauri-apps/plugins-workspace/pull/1707) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Implement `save` API on iOS.

## \[2.0.0-rc.1]

- [`448846b8`](https://github.com/tauri-apps/plugins-workspace/commit/448846b834d23df6e7c5dc66c5dd9aa0cb01846d) ([#1658](https://github.com/tauri-apps/plugins-workspace/pull/1658) by [@mikoto2000](https://github.com/tauri-apps/plugins-workspace/../../mikoto2000)) The `open` function now returns a string representing either the file path or URI instead of an object.
  To read the file data, use the `fs` APIs.
- [`e2e97db5`](https://github.com/tauri-apps/plugins-workspace/commit/e2e97db51983267f5be84d4f6f0278d58834d1f5) ([#1701](https://github.com/tauri-apps/plugins-workspace/pull/1701) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Update to tauri 2.0.0-rc.8

## \[2.0.0-rc.2]

- [`b9147758`](https://github.com/tauri-apps/plugins-workspace/commit/b914775898c2bee7ceb20bd17ee595005cd17a64) ([#1679](https://github.com/tauri-apps/plugins-workspace/pull/1679) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Explicitly set a minimum macOS version for the Swift package.

## \[2.0.0-rc.1]

### feat

- [`bc7eecf4`](https://github.com/tauri-apps/plugins-workspace/commit/bc7eecf4202e7d23b987440c1cbd2da0f68c8bef) ([#1657](https://github.com/tauri-apps/plugins-workspace/pull/1657) by [@mikoto2000](https://github.com/tauri-apps/plugins-workspace/../../mikoto2000)) Implement `save` API on Android.

### changes

- [`6b079cfd`](https://github.com/tauri-apps/plugins-workspace/commit/6b079cfdd107c94abc2c7300f6af00bac3ff4040) ([#1649](https://github.com/tauri-apps/plugins-workspace/pull/1649) by [@ahqsoftwares](https://github.com/tauri-apps/plugins-workspace/../../ahqsoftwares)) Remove targetSdk from build.kts files as it is deprecated and will be removed from DSL v9.0

## \[2.0.0-rc.0]

- [`9887d1`](https://github.com/tauri-apps/plugins-workspace/commit/9887d14bd0e971c4c0f5c1188fc4005d3fc2e29e) Update to tauri RC.

## \[2.0.0-beta.8]

- [`99d6ac0f`](https://github.com/tauri-apps/plugins-workspace/commit/99d6ac0f9506a6a4a1aa59c728157190a7441af6) ([#1606](https://github.com/tauri-apps/plugins-workspace/pull/1606) by [@FabianLars](https://github.com/tauri-apps/plugins-workspace/../../FabianLars)) The JS packages now specify the *minimum* `@tauri-apps/api` version instead of a single exact version.
- [`6de87966`](https://github.com/tauri-apps/plugins-workspace/commit/6de87966ecc00ad9d91c25be452f1f46bd2b7e1f) ([#1597](https://github.com/tauri-apps/plugins-workspace/pull/1597) by [@Legend-Master](https://github.com/tauri-apps/plugins-workspace/../../Legend-Master)) Update to tauri beta.25.

## \[2.0.0-beta.7]

- [`22a17980`](https://github.com/tauri-apps/plugins-workspace/commit/22a17980ff4f6f8c40adb1b8f4ffc6dae2fe7e30) ([#1537](https://github.com/tauri-apps/plugins-workspace/pull/1537) by [@lucasfernog](https://github.com/tauri-apps/plugins-workspace/../../lucasfernog)) Update to tauri beta.24.

## \[2.0.0-beta.6]

- [`76daee7a`](https://github.com/tauri-apps/plugins-workspace/commit/76daee7aafece34de3092c86e531cf9eb1138989) ([#1512](https://github.com/tauri-apps/plugins-workspace/pull/1512) by [@renovate](https://github.com/tauri-apps/plugins-workspace/../../renovate)) Update to tauri beta.23.

## \[2.0.0-beta.5]

- [`9013854f`](https://github.com/tauri-apps/plugins-workspace/commit/9013854f42a49a230b9dbb9d02774765528a923f)([#1382](https://github.com/tauri-apps/plugins-workspace/pull/1382)) Update to tauri beta.22.

## \[2.0.0-beta.4]

- [`430bd6f4`](https://github.com/tauri-apps/plugins-workspace/commit/430bd6f4f379bee5d232ae6b098ae131db7f178a)([#1363](https://github.com/tauri-apps/plugins-workspace/pull/1363)) Update to tauri beta.20.

## \[2.0.0-beta.3]

- [`bd1ed590`](https://github.com/tauri-apps/plugins-workspace/commit/bd1ed5903ffcce5500310dac1e59e8c67674ef1e)([#1237](https://github.com/tauri-apps/plugins-workspace/pull/1237)) Update to tauri beta.17.

## \[2.0.0-beta.6]

- [`326df688`](https://github.com/tauri-apps/plugins-workspace/commit/326df6883998d416fc0837583ed972854628bb52)([#1236](https://github.com/tauri-apps/plugins-workspace/pull/1236)) Fixes command argument parsing on iOS.

### Dependencies

- Upgraded to `fs@2.0.0-beta.6`

## \[2.0.0-beta.5]

- [`bb51a41`](https://github.com/tauri-apps/plugins-workspace/commit/bb51a41d67ebf989e8aedf10c4b1a7f9514d1bdf)([#1168](https://github.com/tauri-apps/plugins-workspace/pull/1168)) **Breaking Change:** All apis that return paths to the frontend will now remove the `\\?\` UNC prefix on Windows.

### Dependencies

- Upgraded to `fs@2.0.0-beta.5`

## \[2.0.0-beta.4]

- [`4cd8112`](https://github.com/tauri-apps/plugins-workspace/commit/4cd81126fdf25e1847546f8fdbd924aa4bfeabb5)([#1056](https://github.com/tauri-apps/plugins-workspace/pull/1056)) Fixed an issue where dialogs on android would return the Content URI instead of the file path

### Dependencies

- Upgraded to `fs@2.0.0-beta.4`

## \[2.0.0-beta.3]

- [`35ea595`](https://github.com/tauri-apps/plugins-workspace/commit/35ea5956d060f0bdafd140f2541c607bb811805b)([#1073](https://github.com/tauri-apps/plugins-workspace/pull/1073)) Fixed an issue where the dialog apis panicked when they were called with no application windows open.
- [`a04ea2f`](https://github.com/tauri-apps/plugins-workspace/commit/a04ea2f38294d5a3987578283badc8eec87a7752)([#1071](https://github.com/tauri-apps/plugins-workspace/pull/1071)) The global API script is now only added to the binary when the `withGlobalTauri` config is true.

### Dependencies

- Upgraded to `fs@2.0.0-beta.3`

## \[2.0.0-beta.2]

- [`aa25c91`](https://github.com/tauri-apps/plugins-workspace/commit/aa25c91bb01e957872fb2b606a3acaf2f2c4ef3a)([#978](https://github.com/tauri-apps/plugins-workspace/pull/978)) Allow configuring `canCreateDirectories` for open and save dialogs on macOS, if not configured, it will be set to `true` by default.
- [`99bea25`](https://github.com/tauri-apps/plugins-workspace/commit/99bea2559c2c0648c2519c50a18cd124dacef57b)([#1005](https://github.com/tauri-apps/plugins-workspace/pull/1005)) Update to tauri beta.8.

## \[2.0.0-beta.1]

- [`569defb`](https://github.com/tauri-apps/plugins-workspace/commit/569defbe9492e38938554bb7bdc1be9151456d21) Update to tauri beta.4.

## \[2.0.0-beta.0]

- [`d198c01`](https://github.com/tauri-apps/plugins-workspace/commit/d198c014863ee260cb0de88a14b7fc4356ef7474)([#862](https://github.com/tauri-apps/plugins-workspace/pull/862)) Update to tauri beta.

## \[2.0.0-alpha.7]

### Dependencies

- Upgraded to `fs@2.0.0-alpha.7`

## \[2.0.0-alpha.5]

- [`387c2f9`](https://github.com/tauri-apps/plugins-workspace/commit/387c2f9e0ce4c75c07ffa3fd76391a25b58f5daf)([#802](https://github.com/tauri-apps/plugins-workspace/pull/802)) Update to @tauri-apps/api v2.0.0-alpha.13.

## \[2.0.0-alpha.4]

- [`387c2f9`](https://github.com/tauri-apps/plugins-workspace/commit/387c2f9e0ce4c75c07ffa3fd76391a25b58f5daf)([#802](https://github.com/tauri-apps/plugins-workspace/pull/802)) Update to @tauri-apps/api v2.0.0-alpha.12.
- [`2e2c0a1`](https://github.com/tauri-apps/plugins-workspace/commit/2e2c0a1b958fcbc7de855ef1d305b11855f2eb8e)([#769](https://github.com/tauri-apps/plugins-workspace/pull/769)) Fix incorrect result for dialog messages.

## \[2.0.0-alpha.3]

- [`e438e0a`](https://github.com/tauri-apps/plugins-workspace/commit/e438e0a62d4b430a5159f05f13ecd397dd891a0d)([#676](https://github.com/tauri-apps/plugins-workspace/pull/676)) Update to @tauri-apps/api v2.0.0-alpha.11.

## \[2.0.0-alpha.2]

- [`5c13736`](https://github.com/tauri-apps/plugins-workspace/commit/5c137365c60790e8d4037d449e8237aa3fffdab0)([#673](https://github.com/tauri-apps/plugins-workspace/pull/673)) Update to @tauri-apps/api v2.0.0-alpha.9.

## \[2.0.0-alpha.2]

- [`4e2cef9`](https://github.com/tauri-apps/plugins-workspace/commit/4e2cef9b702bbbb9cf4ee17de50791cb21f1b2a4)([#593](https://github.com/tauri-apps/plugins-workspace/pull/593)) Update to alpha.12.

### Dependencies

- Upgraded to `fs@2.0.0-alpha.2`

## \[2.0.0-alpha.1]

- [`d74fc0a`](https://github.com/tauri-apps/plugins-workspace/commit/d74fc0a097996e90a37be8f57d50b7d1f6ca616f)([#555](https://github.com/tauri-apps/plugins-workspace/pull/555)) Update to alpha.11.

## \[2.0.0-alpha.0]

- [`717ae67`](https://github.com/tauri-apps/plugins-workspace/commit/717ae670978feb4492fac1f295998b93f2b9347f)([#371](https://github.com/tauri-apps/plugins-workspace/pull/371)) First v2 alpha release!
  d6e80b)([#545](https://github.com/tauri-apps/plugins-workspace/pull/545)) Fixes docs.rs build by enabling the `tauri/dox` feature flag.
