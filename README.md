# GeoLibre

[![Launch GeoLibre Web](https://img.shields.io/badge/Launch-GeoLibre%20Web-green.svg)](https://web.geolibre.app/)
[![GeoLibre shared project](https://img.shields.io/badge/GeoLibre-share-green.svg)](https://share.geolibre.app)
[![GeoLibre plugins](https://img.shields.io/badge/GeoLibre-plugins-green.svg)](https://plugins.geolibre.app)
[![image](https://img.shields.io/pypi/v/geolibre.svg)](https://pypi.python.org/pypi/geolibre)
[![R package](https://img.shields.io/badge/R-package-276DC3?logo=r&logoColor=white)](https://r.geolibre.app/)
[![image](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/opengeos/GeoLibre/blob/main/python/examples/getting-started.ipynb)
[![image](https://img.shields.io/conda/vn/conda-forge/geolibre.svg)](https://anaconda.org/conda-forge/geolibre)
[![Conda Recipe](https://img.shields.io/badge/recipe-geolibre-green.svg)](https://github.com/conda-forge/geolibre-feedstock)
[![Microsoft Store](https://img.shields.io/badge/Microsoft%20Store-GeoLibre-0078D4?logo=windows)](https://apps.microsoft.com/detail/9nwt67rv531x)
[![Mac App Store](https://img.shields.io/badge/Mac%20App%20Store-GeoLibre-000000?logo=apple&logoColor=white)](https://apps.apple.com/app/geolibre-desktop/id6796848769)
[![Google Play](https://img.shields.io/badge/Google%20Play-GeoLibre-01875F?logo=googleplay&logoColor=white)](https://play.google.com/store/apps/details?id=org.geolibre.app)
[![AUR version](https://img.shields.io/aur/version/geolibre-bin?logo=archlinux&label=AUR)](https://aur.archlinux.org/packages/geolibre-bin)
[![FlatPark](https://img.shields.io/badge/FlatPark-GeoLibre-4A90D9?logo=flatpak)](https://flatpark.org/apps/app.geolibre.GeoLibre/)
[![image](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20785400.svg)](https://doi.org/10.5281/zenodo.20785400)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/opengeos/GeoLibre)

A free and open-source, lightweight, cloud-native GIS platform for visualizing, exploring, and analyzing geospatial data. It runs everywhere you do, in the web browser, on the desktop, on mobile, and inside Jupyter notebooks, all while keeping your data local and private.

It also ships **1,000+ geoprocessing tools** that run *entirely in your browser* on WebAssembly — terrain, hydrology, LiDAR, remote sensing, and vector analysis with no server, no install, and no data ever leaving your machine.

GeoLibre is built with **Tauri v2**, **React**, **TypeScript**, **MapLibre GL JS**, **DuckDB-WASM Spatial**, and **deck.gl**. The same workspace runs as a native desktop app, a native Android app, in any modern web browser, and adapts responsively to mobile and small screens.

- **[Launch GeoLibre Web](https://web.geolibre.app/)** — the full app in your browser, nothing to install
- **[Download the desktop app](https://geolibre.app/downloads/)** — Windows, macOS, and Linux installers
- **[Get it on the Mac App Store](https://apps.apple.com/app/geolibre-desktop/id6796848769)** — the sandboxed macOS build
- **[Get it on Google Play](https://play.google.com/store/apps/details?id=org.geolibre.app)** — the native Android app
- **[Use the Python package](https://geolibre.app/python/)** — embed and control the full app in Jupyter notebooks
- **[Use the R package](https://r.geolibre.app/)** — build interactive maps in RStudio, Quarto, R Markdown, and Shiny
- **[1,000+ geoprocessing tools](https://geolibre.app/user-guide/processing/#geoprocessing-toolbox)** — the full toolbox, in the browser
- **[Get started](https://geolibre.app/getting-started/)** — install, run from source, and configure
- **[Features](https://geolibre.app/features/)** — the complete feature list

## Demos

**Click any screenshot to open it at full resolution, or any animation to play the full-quality video.**

### 3D Tiles

[![GeoLibre demo showing 3D Tiles rendered on a MapLibre map](https://assets.geolibre.app/images/GeoLibre-demo.webp)](https://assets.geolibre.app/images/GeoLibre-demo.webp)

[Open the live project](https://share.geolibre.app/giswqs/3d-tiles)

### NYC buildings and subways

Manhattan building footprints extruded in 3D and colored by construction era, with the MTA subway lines and stations on top and a legend generated automatically from the layers' symbology.

[![Manhattan buildings extruded in 3D and colored by construction era, with MTA subway lines and stations and an auto-generated legend](https://assets.geolibre.app/images/nyc-buildings.webp)](https://assets.geolibre.app/images/nyc-buildings.webp)

The animation below runs the Time Slider along the buildings' construction year, from 1850 to 2025, so Manhattan fills in era by era. Click it to play the full-quality video.

[![Animation of Manhattan buildings appearing by construction year as the Time Slider advances from 1850 to 2025](https://assets.geolibre.app/demos/nyc-buildings-gif.gif)](https://assets.geolibre.app/demos/nyc-buildings.webm)

[Open the live project](https://share.geolibre.app/giswqs/nyc-buildings-and-subways)

### Planetary basemaps

GeoLibre is not limited to Earth. Planetary basemaps from OpenPlanetaryMap and USGS Astrogeology cover the Moon, Mars, Mercury, Venus, the Galilean moons (Io, Europa, Ganymede, Callisto), Titan, Pluto, and Charon, with a per-project ellipsoid so distance, area, and scale measurements match the body you are mapping. The deep-space starfield behind each globe comes from the Atmosphere Effects plugin.

<table>
  <tr>
    <td width="33%"><a href="https://assets.geolibre.app/images/earth.webp"><img src="https://assets.geolibre.app/images/earth.webp" alt="GeoLibre globe view of Earth over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://assets.geolibre.app/images/moon.webp"><img src="https://assets.geolibre.app/images/moon.webp" alt="GeoLibre globe view of the Moon over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://assets.geolibre.app/images/mars.webp"><img src="https://assets.geolibre.app/images/mars.webp" alt="GeoLibre globe view of Mars over a starfield backdrop"></a></td>
  </tr>
  <tr>
    <td align="center"><b>Earth</b></td>
    <td align="center"><b>Moon</b></td>
    <td align="center"><b>Mars</b></td>
  </tr>
  <tr>
    <td width="33%"><a href="https://assets.geolibre.app/images/mercury.webp"><img src="https://assets.geolibre.app/images/mercury.webp" alt="GeoLibre globe view of Mercury over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://assets.geolibre.app/images/pluto.webp"><img src="https://assets.geolibre.app/images/pluto.webp" alt="GeoLibre globe view of Pluto over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://assets.geolibre.app/images/venus.webp"><img src="https://assets.geolibre.app/images/venus.webp" alt="GeoLibre globe view of Venus over a starfield backdrop"></a></td>
  </tr>
  <tr>
    <td align="center"><b>Mercury</b></td>
    <td align="center"><b>Pluto</b></td>
    <td align="center"><b>Venus</b></td>
  </tr>
  <tr>
    <td width="33%"><a href="https://assets.geolibre.app/images/europa.webp"><img src="https://assets.geolibre.app/images/europa.webp" alt="GeoLibre globe view of Europa over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://assets.geolibre.app/images/callisto.webp"><img src="https://assets.geolibre.app/images/callisto.webp" alt="GeoLibre globe view of Callisto over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://assets.geolibre.app/images/charon.webp"><img src="https://assets.geolibre.app/images/charon.webp" alt="GeoLibre globe view of Charon over a starfield backdrop"></a></td>
  </tr>
  <tr>
    <td align="center"><b>Europa</b></td>
    <td align="center"><b>Callisto</b></td>
    <td align="center"><b>Charon</b></td>
  </tr>
</table>

Switch bodies from the planet switcher in the Layers panel. See [Demos](https://geolibre.app/demos/) for more.

### Video tutorials

- [GeoLibre 1.0: A Free, Open-Source Cloud-Native GIS That Runs Anywhere (Browser, Desktop & Jupyter)](https://youtu.be/87Cm0QagtxI)
- [Geoprocessing in the Browser: 700+ Free GIS Tools in GeoLibre, Zero Install](https://youtu.be/W32bIQO_nG8)

## Geoprocessing: 1,000+ tools, zero install

[![The GeoLibre Whitebox toolbox running locally with WebAssembly, listing the full catalog of 1,000+ tools with the Regularize Building Footprints tool selected](https://assets.geolibre.app/images/whitebox.webp)](https://assets.geolibre.app/images/whitebox.webp)

**Processing → Whitebox** opens a toolbox of **1,000+ geoprocessing tools** that
execute in the browser through a WebAssembly runtime with native raster and
vector I/O. There is no Python sidecar to install and no server to call — the
tools, your data, and the results all stay on your machine, so the full toolbox
is available on [GeoLibre Web](https://web.geolibre.app/), on the desktop app,
and on Android alike.

The tools come from the [Whitebox Next Gen](https://github.com/opengeos/Whitebox-Next-Gen-ArcGIS)
suite plus GeoLibre's own WASM tools, and are browsable by category straight from
the Processing menu:

| Category | Tools | Examples |
| --- | --- | --- |
| **Vector** | 280 | overlays, buffers, joins, cleaning, topology, generalization |
| **Raster** | 232 | algebra, filters, reclassification, zonal and focal statistics |
| **Remote sensing** | 154 | spectral indices, band math, classification, change detection |
| **Hydrology** | 100 | flow accumulation, watersheds, stream networks, depression filling |
| **Terrain** | 99 | slope, aspect, hillshade, curvature, ruggedness, viewsheds |
| **LiDAR** | 65 | point-cloud filtering, ground classification, DEM/DSM generation |
| **Conversion** | 49 | format translation to cloud-native GeoParquet, PMTiles, and COG |
| **Network** | 26 | connectivity, cost distance, and routing analysis |
| **Projection** | 4 | reprojection for raster and vector data |

Any tool is deep-linkable with a `?tool=` URL parameter that preselects it and
pre-fills its form. See the [Processing Tools guide](https://geolibre.app/user-guide/processing/#geoprocessing-toolbox)
for details, and [Geoprocessing in the Browser](https://youtu.be/W32bIQO_nG8) for
a video walkthrough.

## Documentation

Full documentation, including the User Guide and Tutorials, is published at
**[geolibre.app](https://geolibre.app)**.

- **[Getting Started](https://geolibre.app/getting-started/)** - use GeoLibre on the web, desktop, Android, or in Jupyter; run it from source; run it with Docker; and configure optional credentials.
- **[Features](https://geolibre.app/features/)** - the complete, feature-by-feature list of what GeoLibre can do today.
- **[Demos](https://geolibre.app/demos/)** - a visual tour: 3D Tiles, 3D city data, planetary basemaps, the SQL Workspace, and embeds.
- **[Downloads](https://geolibre.app/downloads/)** - installers and package managers for Windows, macOS, and Linux.
- **[User Guide](https://geolibre.app/user-guide/interface/)** - a feature-by-feature reference for the interface, adding data, layers, styling, the attribute table, map controls, processing, the SQL Workspace, data integrations, plugins, settings, and embedding.
- **[Tutorials](https://geolibre.app/tutorials/)** - hands-on, end-to-end workflows: your first map, cloud-native data, vector analysis, terrain analysis, spatial SQL, and sharing and embedding.
- **Reference**
  - [Architecture](docs/architecture.md)
  - [Android](docs/android.md)
  - [iOS](docs/ios.md)
  - [Project format](docs/project-format.md)
  - [Plugin API](docs/plugin-api.md)
  - [UI Profiles](docs/ui-profiles.md)
  - [Internationalization](docs/i18n.md)
  - [Python package (Jupyter)](docs/python.md)
  - [R package (RStudio, Quarto, and Shiny)](docs/r.md)
  - [Notebook Panel](docs/notebook.md)
  - [Roadmap](docs/roadmap.md)
  - [Contributing](docs/contributing.md)
  - [How to Cite](docs/citation.md)
  - [Become a Sponsor](docs/sponsor.md)

Contributions are welcome. See the [Contributing](docs/contributing.md) guide
for the development setup, repository layout, and quality gate.

## Sponsor

GeoLibre is free and open source, and stays that way. If it is useful to you or your team, sponsorship is the most direct way to keep development, hosting, and cross-platform distribution going.

- [**GitHub Sponsors**](https://github.com/sponsors/giswqs) - monthly or one-time, billed through your GitHub account.
- [**Buy Me a Coffee**](https://buymeacoffee.com/giswqs) - a quick one-off contribution, no account required.

See the [Become a Sponsor](https://geolibre.app/sponsor/) page for what sponsorship supports and for other, free ways to help.

## Acknowledgements

GeoLibre is built on the free and open-source geospatial and web communities — including MapLibre GL JS, deck.gl, DuckDB-WASM Spatial, Turf.js, Tauri, React, and many more. See the full [Acknowledgements](https://geolibre.app/acknowledgements/) page for the complete list of projects and community contributors.

- The **Atmosphere Effects** plugin (deep-space backdrop, parallax starfield, comets, and the globe atmosphere halo) adapts the technique and visual design from [Leonel Dias](https://leoneljdias.github.io/)'s article [*Globe atmosphere, halo, and comets*](https://leoneljdias.github.io/posts/globe-atmosphere-halo-comets/) — the layered Canvas 2D approach, the halo gradient and "screen" blend, the limb-sampling that keeps the halo aligned under pitch, and the starfield/comet parameters.
- **Community contributors** — thanks to [**Ryanphoenix**](https://github.com/Ryanphoenix) for many valued contributions, including issue reports, feedback, and improvements.
- **Beta testers** — thanks to [**René van der Velde**](https://github.com/renevandervelde) (Netherlands) for early testing, detailed bug reports, and feature requests.

## Citation

If you use GeoLibre in your work, please cite it. GeoLibre is archived on [Zenodo](https://zenodo.org/), which mints a DOI for every release. The concept DOI below always resolves to the latest version.

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20785400.svg)](https://doi.org/10.5281/zenodo.20785400)

> Wu, Q. (2026). GeoLibre: A lightweight, cloud-native GIS platform for visualizing, exploring, and analyzing geospatial data. Zenodo. <https://doi.org/10.5281/zenodo.20785400>

You can also use GitHub's **"Cite this repository"** button (which reads [`CITATION.cff`](CITATION.cff)) to copy a ready-made APA or BibTeX entry. See the [How to Cite](https://geolibre.app/citation/) page for more formats.

## License

[MIT](LICENSE)
