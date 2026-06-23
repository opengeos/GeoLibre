# Portable zip packaging (`build-portable.ps1`)

[`build-portable.ps1`](build-portable.ps1) packages GeoLibre Desktop as a
**portable Windows zip** from a finished Windows Tauri release build. The user
unzips the folder anywhere and runs `geolibre-desktop.exe` directly: no
installer, no admin rights, no registry changes.

Unlike the NSIS / MSI / MSIX targets, this is not an installer. It stages the
plain release binary, any sidecar DLLs next to it, and the Python sidecar under
`backend\geolibre_server\`, then zips the lot with `Compress-Archive`. It
**requires Windows** (it reads the Windows release binary), but needs no Windows
SDK tooling.

## Build

```powershell
npm run portable:build
# or: pwsh ./packaging/portable/build-portable.ps1
```

Run a Windows Tauri release build first (the CI release workflow does this via
`tauri-action`), otherwise the script throws because
`target\release\geolibre-desktop.exe` does not exist.

The zip is written to
`apps/geolibre-desktop/src-tauri/target/release/bundle/portable/` and named
`geolibre-desktop-<version>-x64-portable.zip`.

## Layout

The staged folder mirrors what the binary probes at runtime. `resource_dir()`
resolves to the executable's own directory for an unbundled run, so the sidecar
must sit at `backend\geolibre_server\` next to the exe, the first location
`sidecar_project_dir()` checks (`apps/geolibre-desktop/src-tauri/src/lib.rs`).

```text
geolibre-desktop-<version>-x64/
  geolibre-desktop.exe
  *.dll                       # e.g. WebView2Loader, if the build emits it
  README.txt
  backend/geolibre_server/    # Python sidecar (tests / caches stripped)
```

## Requirements for the end user

- **Microsoft Edge WebView2 Runtime** — preinstalled on Windows 11 and current
  Windows 10. The portable build relies on the system Evergreen runtime rather
  than bundling a fixed-version copy; if the app does not launch, the user
  installs it from the Microsoft WebView2 page.
- **Python** for the optional sidecar features (Whitebox, raster, conversion),
  exactly as in the installed build. Vector tools and everything client-side
  run without it.

The portable build has no auto-updater; upgrading means downloading a newer zip.
