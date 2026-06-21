# AUR packaging (`geolibre-bin`)

GeoLibre ships to the [Arch User Repository](https://aur.archlinux.org/) as
**`geolibre-bin`**, a *binary* package that repackages the Linux `.deb` already
attached to each GitHub release. It does not build from source, so installs are
fast and need no Rust/Node toolchain. The `.deb` carries the binary, the
`.desktop` entry, and the icons, so extracting it gives full desktop
integration.

## Files

- [`PKGBUILD`](PKGBUILD) is a generated reference copy, pinned to the latest
  release. It is produced by [`scripts/render-aur-pkgbuild.sh`](../../scripts/render-aur-pkgbuild.sh),
  which is the single source of truth. Do not hand-edit `PKGBUILD`; change the
  render script, since CI overwrites it on every release.
- `scripts/render-aur-pkgbuild.sh` emits a `PKGBUILD` for a given `VERSION`
  and `.deb` checksum.
- The `aur` job in [`.github/workflows/release.yml`](../../.github/workflows/release.yml)
  renders and republishes the package after each non-prerelease release.

## One-time setup (maintainer)

1. Create an account at <https://aur.archlinux.org> and, under **My Account**,
   add the SSH **public** key you will publish with.
2. Bootstrap the package once, manually, so the AUR repo exists:

   ```bash
   git clone ssh://aur@aur.archlinux.org/geolibre-bin.git
   cd geolibre-bin
   cp /path/to/GeoLibre/packaging/aur/PKGBUILD .
   makepkg --printsrcinfo > .SRCINFO          # needs an Arch system
   git add PKGBUILD .SRCINFO
   git commit -m "Initial import: geolibre-bin 1.5.0"
   git push
   ```

3. Add the matching SSH **private** key to the GitHub repo as the secret
   **`AUR_SSH_PRIVATE_KEY`** (Settings -> Secrets and variables -> Actions).
   The release workflow's `aur` job uses it to push updates. Without the secret
   the job skips itself, so forks are unaffected.

## How CI keeps it current

On every published, non-prerelease GitHub release, the `aur` job:

1. downloads `GeoLibre.Desktop_<version>_amd64.deb` from the release and
   computes its `sha256`,
2. renders a fresh `PKGBUILD` with `scripts/render-aur-pkgbuild.sh`,
3. pushes the new `PKGBUILD` + regenerated `.SRCINFO` to the AUR.

The job runs independently of the asset build and the Homebrew tap update, and
is marked `continue-on-error`, so an AUR hiccup never fails the release or
affects the other publish targets.

## Test the package locally

```bash
# from a checkout, after a release exists for the pinned version
cd packaging/aur
makepkg -si                                   # build + install, then launch GeoLibre
namcap PKGBUILD geolibre-bin-*.pkg.tar.zst    # lint; trim depends() if it flags extras
```

`depends` lists the libraries the bundle links against (`webkit2gtk-4.1`,
`gtk3`, `libayatana-appindicator`). If a future build links more or fewer,
`namcap` will say so; adjust the `depends`/`optdepends` arrays in the render
script accordingly.
