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

| Parameter | Default | Why override for the Store |
| --- | --- | --- |
| `-Name` | Tauri identifier (`org.geolibre.desktop`) | Must be the reserved `Package/Identity/Name` |
| `-Publisher` | `CN=GeoLibre` | Must be your seller `CN=<GUID>` |
| `-PublisherDisplayName` | `GeoLibre` | Must match your publisher display name |
| `-DisplayName` | Tauri `productName` (`GeoLibre Desktop`) | `Properties/DisplayName` must be a **reserved** name |
| `-Language` | `en-us` | Every MSIX must declare a language |

The package family name is derived automatically from `-Name` + `-Publisher`, so
it will match once those are correct.

`-DisplayName` sets only the package display name (`Properties/DisplayName`, used
for the Store listing). The Start-menu / taskbar name
(`Applications/.../VisualElements/@DisplayName`) deliberately stays the Tauri
product name ("GeoLibre Desktop"); the two are allowed to differ, and a Store
submission with this split passed validation.

## `runFullTrust`

The manifest declares the `runFullTrust` restricted capability, which a packaged
Win32 (Tauri) desktop app requires. The Store flags it as a **warning**, not an
error; it is reviewed and granted during certification. Do not remove it.
