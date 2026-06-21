# Fedora COPR packaging (`geolibre`)

GeoLibre ships to Fedora/RHEL users through [COPR](https://copr.fedorainfracloud.org/),
the community build service that is to Fedora roughly what the AUR is to Arch.
The `geolibre` package is a *binary* repackage: it unpacks the official
Tauri-built `.rpm` attached to each GitHub release (it does not rebuild from
source), adds an AppStream `metainfo.xml`, and renames the desktop entry to the
`org.geolibre.desktop` app-id with proper menu categories.

## Files

- [`geolibre.spec`](geolibre.spec) is a generated reference, pinned to the latest
  release. It is produced by [`scripts/render-copr-spec.sh`](../../scripts/render-copr-spec.sh)
  (the source of truth); do not hand-edit it, CI overwrites it.
- The AppStream metainfo is rendered by
  [`scripts/render-linux-metainfo.sh`](../../scripts/render-linux-metainfo.sh)
  into [`packaging/linux/org.geolibre.desktop.metainfo.xml`](../linux/org.geolibre.desktop.metainfo.xml).
- The `copr` job in [`.github/workflows/release.yml`](../../.github/workflows/release.yml)
  builds the SRPM and submits it to COPR on each non-prerelease release.

## One-time setup (maintainer)

1. Sign in at <https://copr.fedorainfracloud.org> (FAS/Fedora account) and create
   a project named **`geolibre`** under your user namespace (`giswqs/geolibre`).
   Enable the `fedora-*-x86_64` chroots you want to target. If you move it to a
   COPR group later, update `COPR_PROJECT` in `release.yml` to `@group/geolibre`.
2. Get an API token from <https://copr.fedorainfracloud.org/api/>. The page shows
   a ready-made config block:

   ```ini
   [copr-cli]
   login = ...
   username = ...
   token = ...
   copr_url = https://copr.fedorainfracloud.org
   ```

3. Add that **entire block** as the GitHub repo secret **`COPR_API_TOKEN`**
   (Settings -> Secrets and variables -> Actions). The release workflow writes it
   to `~/.config/copr` and submits builds with it. Without the secret the `copr`
   job skips itself, so forks are unaffected.

## How CI keeps it current

On every published, non-prerelease release, the `copr` job:

1. renders `geolibre.spec` and the metainfo for the release version/date,
2. validates the metainfo with `appstreamcli`,
3. downloads `GeoLibre.Desktop-<version>-1.x86_64.rpm` from the release into the
   SRPM sources,
4. builds the SRPM and submits it with `copr-cli build --nowait giswqs/geolibre`.

The job runs independently of the asset build and the AUR/Homebrew updates and is
marked `continue-on-error`, so a COPR hiccup never fails the release.

## Test the spec locally

The cleanest test mirrors COPR's mock with a Fedora container:

```bash
VERSION=1.5.0 DATE=2026-06-20 scripts/render-linux-metainfo.sh > /tmp/org.geolibre.desktop.metainfo.xml
VERSION=1.5.0 DATE=2026-06-20 scripts/render-copr-spec.sh   > /tmp/geolibre.spec
# fetch the release RPM the spec repackages
gh release download v1.5.0 -R opengeos/GeoLibre --pattern 'GeoLibre.Desktop-1.5.0-1.x86_64.rpm' --dir /tmp

podman run --rm -v /tmp:/build:Z fedora:latest bash -lc '
  dnf -y install rpm-build cpio desktop-file-utils appstream
  mkdir -p ~/rpmbuild/{SPECS,SOURCES}
  cp /build/geolibre.spec ~/rpmbuild/SPECS/
  cp /build/org.geolibre.desktop.metainfo.xml /build/GeoLibre.Desktop-1.5.0-1.x86_64.rpm ~/rpmbuild/SOURCES/
  rpmbuild -bb ~/rpmbuild/SPECS/geolibre.spec
'
```

The library `Requires` (`libwebkit2gtk-4.1.so.0`, `libgtk-3.so.0`, ...) are
generated automatically from the binary, so the spec lists no manual runtime
dependencies.
