param(
  [string] $AppDir = "apps/geolibre-desktop",
  [string] $Configuration = "release",
  [ValidateSet("x64", "x86", "arm64")]
  [string] $Architecture = "x64"
)

$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
  throw "Portable packaging targets Windows and reads the Windows Tauri release binary."
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$appRoot = Resolve-Path (Join-Path $repoRoot $AppDir)
$tauriDir = Join-Path $appRoot "src-tauri"
$targetDir = Join-Path $tauriDir "target\$Configuration"
$bundleDir = Join-Path $targetDir "bundle\portable"
$configPath = Join-Path $tauriDir "tauri.conf.json"
$cargoPath = Join-Path $tauriDir "Cargo.toml"
$backendDir = Join-Path $repoRoot "backend\geolibre_server"

$config = Get-Content -Raw $configPath | ConvertFrom-Json
$version = [string] $config.version

$cargo = Get-Content -Raw $cargoPath
$binaryNameMatch = [regex]::Match($cargo, '(?ms)\[package\].*?^name\s*=\s*"([^"]+)"')
if (-not $binaryNameMatch.Success) {
  throw "Could not determine the Tauri binary name from $cargoPath."
}

$binaryName = $binaryNameMatch.Groups[1].Value
$binaryPath = Join-Path $targetDir "$binaryName.exe"
if (-not (Test-Path $binaryPath)) {
  throw "Could not find $binaryPath. Run a Windows Tauri release build before portable packaging."
}

# Stage the app exactly as the binary expects to find it at runtime: the
# Python sidecar lives in a `backend\geolibre_server` folder next to the exe,
# which is the first location sidecar_project_dir() probes via resource_dir()
# (see apps/geolibre-desktop/src-tauri/src/lib.rs). resource_dir() resolves to
# the executable's own directory for an unbundled (portable) run, so this
# layout works without an installer.
$stagingDir = Join-Path $targetDir "portable-package"
$payloadDir = Join-Path $stagingDir "$binaryName-$version-$Architecture"
$backendPackageDir = Join-Path $payloadDir "backend\geolibre_server"
$zipName = "$binaryName-$version-${Architecture}-portable.zip"
$zipPath = Join-Path $bundleDir $zipName

Remove-Item -Recurse -Force $stagingDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $payloadDir, $backendPackageDir, $bundleDir | Out-Null

Copy-Item -Force $binaryPath (Join-Path $payloadDir "$binaryName.exe")
# Ship any sidecar DLLs (e.g. WebView2Loader) the build emitted next to the exe.
Copy-Item -Force (Join-Path $targetDir "*.dll") $payloadDir -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force (Join-Path $backendDir "*") $backendPackageDir
Get-ChildItem -Recurse -Path $backendPackageDir -Include "__pycache__", "*.pyc", "*.pyo", "tests", "test_*.py" |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
# Strip developer-only artifacts so a locally built zip can never leak secrets
# or balloon with a checked-out venv. None of these exist in a clean CI
# checkout; the risk surface is `npm run portable:build` on a dev machine.
$devArtifacts = @(".env", ".env.*", "venv", ".venv", "env", "*.egg-info", "dist", "build")
Get-ChildItem -Recurse -Force -Path $backendPackageDir -Include $devArtifacts |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# Drop a short note alongside the binary so the zip is self-documenting.
$readme = @"
GeoLibre Desktop $version (portable, $Architecture)

Unzip this folder anywhere and run $binaryName.exe. No installation or admin
rights are required.

Requirements:
  - Microsoft Edge WebView2 Runtime. Preinstalled on Windows 11 and current
    Windows 10. If the app does not start, install the Evergreen runtime from
    https://developer.microsoft.com/microsoft-edge/webview2/
  - The optional Python sidecar (Whitebox, raster, and format-conversion tools)
    needs Python available on your system, exactly as in the installed build.
    Vector tools and everything else run without it.

This portable build does not auto-update; download a newer zip to upgrade.
"@
Set-Content -Path (Join-Path $payloadDir "README.txt") -Value $readme -Encoding utf8

Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
Compress-Archive -Path $payloadDir -DestinationPath $zipPath -CompressionLevel Optimal

Write-Host "Portable package created at $zipPath"

if ($env:GITHUB_OUTPUT) {
  "portable_path=$zipPath" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
}
