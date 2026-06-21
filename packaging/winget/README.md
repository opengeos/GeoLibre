# winget packaging (`OpenGeos.GeoLibre`)

GeoLibre is published to the [Windows Package Manager](https://learn.microsoft.com/windows/package-manager/)
(winget) as **`OpenGeos.GeoLibre`**, so Windows users can install it with:

```powershell
winget install OpenGeos.GeoLibre
```

The package wraps the official Tauri-built **NSIS** installer (winget type
`nullsoft`) from the GitHub release, x64, per-user scope (Tauri's NSIS default).
winget hosts no binaries itself: it stores YAML manifests in the community repo
[`microsoft/winget-pkgs`](https://github.com/microsoft/winget-pkgs) and downloads
the installer from the release URL.

## Files

The three manifests here are **reference copies** of what is submitted to
`winget-pkgs` (under `manifests/o/OpenGeos/GeoLibre/<version>/`), validated
against the v1.6.0 JSON schemas:

- `OpenGeos.GeoLibre.yaml` (version manifest)
- `OpenGeos.GeoLibre.installer.yaml` (installer: URL, sha256, `nullsoft`, x64)
- `OpenGeos.GeoLibre.locale.en-US.yaml` (name, publisher, description, license)

## One-time setup (maintainer)

The release workflow submits new versions automatically with
[`winget-releaser`](https://github.com/vedantmgoyal9/winget-releaser) (which uses
[`komac`](https://github.com/russellbanks/Komac)). It needs:

1. A fork of `microsoft/winget-pkgs` under your account (`giswqs/winget-pkgs`).
2. A **classic** Personal Access Token with the `public_repo` scope, added as the
   repo secret **`WINGET_TOKEN`** (Settings -> Secrets and variables -> Actions).
   The action uses it to push to your fork and open the PR to `winget-pkgs`.
   Without the secret the `winget` job skips itself, so forks are unaffected.

The very first submission (a new package) is done manually; subsequent versions
are automated by the `winget` job.

## How CI keeps it current

On every published, non-prerelease release, the isolated `winget` job in
[`.github/workflows/release.yml`](../../.github/workflows/release.yml) runs
`winget-releaser`, which downloads the release's `*_x64-setup.exe`, regenerates
the manifests for the new version, and opens a PR to `microsoft/winget-pkgs`. The
job is `continue-on-error` and independent of the asset build and the other
publish targets.

## Maintenance notes

- **Installer:** the `installers-regex` (`_x64-setup\.exe$`) selects the NSIS
  setup. To switch to the MSI, change the regex and set `InstallerType: wix`.
- **Scope:** `user` reflects Tauri's NSIS default (`currentUser`). If a future
  build switches to per-machine, update `Scope` to `machine`.
- **Schema:** validate edits with the official schemas, e.g.
  `winget validate --manifest <dir>` on Windows, or against
  `https://aka.ms/winget-manifest.installer.1.6.0.schema.json`.
