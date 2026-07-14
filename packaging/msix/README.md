# MSIX packaging (`build-msix.ps1`)

[`build-msix.ps1`](build-msix.ps1) builds an MSIX package for GeoLibre Desktop
from a finished Windows Tauri release build. It generates the `AppxManifest.xml`,
copies the binary + Python sidecar + logo assets, and runs `MakeAppx.exe`. It
**requires Windows** and the Windows SDK MSIX packaging tools.

There are two distinct targets, both produced by this one script:

1. The **self-signed / winget MSIX** attached to each GitHub release (the
   `release.yml` "Build MSIX package" step runs the script with its defaults:
   `Publisher = CN=GeoLibre`, identity from the Tauri config).
2. A **Microsoft Store** MSIX, built manually with your Partner Center identity
   (see below). The Store re-signs the package, so you do not sign it yourself.

## Build (defaults, for winget / direct download)

```powershell
npm run msix:build
# or: pwsh ./packaging/msix/build-msix.ps1
```

## Build for the Microsoft Store

> [!IMPORTANT]
> The Store rejects apps that update themselves outside the Store (policy
> 10.2.5). The in-app "Check for updates" flow (Help menu, command palette, About
> dialog, and the automated startup check) is compiled **out** of the frontend
> only when the `GEOLIBRE_STORE_BUILD=1` environment variable is set during the
> Tauri build. `build-msix.ps1` repackages the *already-built* binary, so this
> variable must be exported before `npm run tauri:build`, not passed to this
> script. The [`msix-store.yml`](../../.github/workflows/msix-store.yml) workflow
> sets it automatically; when building a Store package locally, set it yourself:
>
> ```powershell
> $env:GEOLIBRE_STORE_BUILD = "1"
> npm run tauri:build -- --no-sign
> ```
>
> Leave it unset for the winget / sideload MSIX (`release.yml`) — those keep the
> updater and are never submitted to the Store.

The Store validates the package identity against the values reserved for the app
in Partner Center (**Product management -> Product Identity**). Pass them as
parameters; the Store-required fields differ from the defaults:

```powershell
pwsh ./packaging/msix/build-msix.ps1 `
  -Name "OpenGeospatialSolutions.GeoLibre" `        # Package/Identity/Name
  -Publisher "CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" `  # Package/Identity/Publisher (your seller GUID)
  -PublisherDisplayName "Open Geospatial Solutions" `     # your publisher display name
  -DisplayName "GeoLibre"                            # a name reserved in Partner Center
```

The defaults are the opengeos Partner Center identity, so a bare
`./build-msix.ps1` produces a Store-ready package. Override them for a
self-signed sideload build or a different publisher.

| Parameter | Default (Store identity) | Notes |
| --- | --- | --- |
| `-Name` | `OpenGeospatialSolutions.GeoLibre` | Reserved `Package/Identity/Name`; the Store rejects the Tauri identifier. Pass `""` to fall back to `org.geolibre.desktop` for a non-Store build |
| `-Publisher` | `CN=E6AE8172-DC4F-4F79-844B-9D84204BF95A` | Seller `CN=<GUID>` from Partner Center; must match the account publisher ID |
| `-PublisherDisplayName` | `Open Geospatial Solutions` | Must match your publisher display name exactly; the Store does not remap it |
| `-DisplayName` | `GeoLibre` | Reserved `Properties/DisplayName`; differs from the Tauri `productName` (`GeoLibre Desktop`). Pass `""` to fall back to the productName |
| `-Language` | `en-us` | Every MSIX must declare a language |

The package family name is derived automatically from `-Name` + `-Publisher`, so
it matches (`OpenGeospatialSolutions.GeoLibre_wby2ff7ejknn4`) once those are correct.

`-DisplayName` sets only the package display name (`Properties/DisplayName`, used
for the Store listing). The Start-menu / taskbar name
(`Applications/.../VisualElements/@DisplayName`) deliberately stays the Tauri
product name ("GeoLibre Desktop"); the two are allowed to differ, and a Store
submission with this split passed validation.

## `runFullTrust`

The manifest declares the `runFullTrust` restricted capability, which a packaged
Win32 (Tauri) desktop app requires. The Store flags it as a **warning**, not an
error; it is reviewed and granted during certification. Do not remove it.
