# Flatpak / Flathub packaging (`app.geolibre.GeoLibre`)

This packages GeoLibre Desktop as a [Flatpak](https://flatpak.org/) for
[Flathub](https://flathub.org/), the default app store on most Linux desktops
(GNOME Software, KDE Discover, Steam Deck, and Ubuntu when Flathub is enabled).

Like the AUR and COPR packages, it is a **binary repackage of the official
Tauri-built `.deb`**, which is the approach in
[Tauri's Flatpak guide](https://v2.tauri.app/distribute/flatpak/): GTK3 and
`webkit2gtk-4.1` come from the GNOME runtime, so there is no from-source build.
The GNOME 50 Platform ships `libwebkit2gtk-4.1.so.0` (the API Tauri v2 needs),
which is the runtime this manifest targets.

The Flathub **app-id is `app.geolibre.GeoLibre`** (reverse-domain of the
reachable `geolibre.app`, which Flathub can verify; the id must not end in
`.desktop`). The app's internal Tauri identifier stays `org.geolibre.desktop`,
so user settings and data are unaffected; only the public Flathub identity and
its metainfo/desktop use the new id.

## Files

- [`app.geolibre.GeoLibre.yml`](app.geolibre.GeoLibre.yml) is the Flatpak
  manifest (unpacks the release `.deb`, relocates the binary/resources under
  `/app`, installs the app-id-named desktop entry, metainfo, and icons).
- [`app.geolibre.GeoLibre.desktop`](app.geolibre.GeoLibre.desktop) is the
  desktop entry (with menu categories the upstream bundle leaves empty).
- [`app.geolibre.GeoLibre.metainfo.xml`](app.geolibre.GeoLibre.metainfo.xml) is
  the AppStream metainfo, generated with the Flatpak app-id via
  `APPID=app.geolibre.GeoLibre scripts/render-linux-metainfo.sh`.

## Build and test locally

The Flathub-blessed toolchain is the `org.flatpak.Builder` flatpak (it bundles
`flatpak-builder` and `flatpak-builder-lint`, the linter Flathub gates on):

```bash
flatpak install -y flathub org.flatpak.Builder org.gnome.Platform//50 org.gnome.Sdk//50

cd packaging/flatpak
# Build + install. Add --mirror-screenshots-url=https://dl.flathub.org/media/
# to mirror screenshots the way Flathub's build service does.
flatpak run org.flatpak.Builder --force-clean --user --install \
  --install-deps-from=flathub --repo=repo build-dir app.geolibre.GeoLibre.yml

# Lint the way Flathub does:
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest app.geolibre.GeoLibre.yml
flatpak run --command=flatpak-builder-lint org.flatpak.Builder repo repo

flatpak run app.geolibre.GeoLibre
```

## Submit to Flathub (one-time)

Flathub hosting differs from AUR/COPR: once accepted, **Flathub builds and hosts
the app itself** from a per-app repo, so there is no publish-from-CI step.

1. Fork <https://github.com/flathub/flathub> and create a branch named
   `app.geolibre.GeoLibre`.
2. Add the manifest, the `.desktop`, and the metainfo to the branch root.
3. Open a PR against `flathub/flathub`. Flathub's build bot and a human reviewer
   check it; once merged they create the `flathub/app.geolibre.GeoLibre` repo and
   publish the app.
4. Future updates are PRs to that per-app repo (bump the `.deb` `url`/`sha256`,
   and `runtime-version` when adopting a newer runtime). Flathub's
   `flatpak-external-data-checker` can automate the version bumps.

## Known linter items (expected; handled in review/build)

`flatpak-builder-lint` reports these on a local build; they are not packaging
bugs:

- **`finish-args-home-filesystem-access`**: GeoLibre opens arbitrary local
  geospatial datasets (and their sidecar files), so it needs real filesystem
  access, like other GIS apps on Flathub (QGIS uses `--filesystem=host`). This
  is granted via a Flathub filesystem exception, justified during review. Narrow
  it (for example to portals + `xdg-documents`) if reviewers prefer.
- **`appstream-external-screenshot-url` / `...-not-mirrored`**: Flathub's build
  service mirrors screenshots and icons to `dl.flathub.org` and rewrites the
  catalog; a local build can't satisfy this because those assets are not on
  Flathub yet. A PNG screenshot is preferred over the current WebP if reviewers
  ask.

## Maintenance notes

- **Per release:** update the `.deb` `url` and `sha256` in the manifest, and
  regenerate the metainfo (`VERSION`/`DATE`, `APPID=app.geolibre.GeoLibre`).
- **Runtime:** keep `runtime-version` on a supported GNOME runtime that still
  ships `libwebkit2gtk-4.1` (50 is verified; older runtimes go end-of-life and
  Flathub rejects them).
- **Source build:** Flathub generally prefers building open-source apps from
  source. A Tauri source build needs offline Cargo + npm vendoring
  (`flatpak-cargo-generator` + `flatpak-node-generator`); the `.deb` repackage
  here is the pragmatic path Tauri documents, but be ready to discuss it in review.
