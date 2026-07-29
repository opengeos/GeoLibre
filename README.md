# GeoLibre

[![Launch GeoLibre Web](https://img.shields.io/badge/Launch-GeoLibre%20Web-green.svg)](https://web.geolibre.app/)
[![GeoLibre shared project](https://img.shields.io/badge/GeoLibre-share-green.svg)](https://share.geolibre.app)
[![GeoLibre plugins](https://img.shields.io/badge/GeoLibre-plugins-green.svg)](https://plugins.geolibre.app)
[![image](https://img.shields.io/pypi/v/geolibre.svg)](https://pypi.python.org/pypi/geolibre)
[![image](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/opengeos/GeoLibre/blob/main/python/examples/getting-started.ipynb)
[![image](https://img.shields.io/conda/vn/conda-forge/geolibre.svg)](https://anaconda.org/conda-forge/geolibre)
[![Conda Recipe](https://img.shields.io/badge/recipe-geolibre-green.svg)](https://github.com/conda-forge/geolibre-feedstock)
[![Open in CodeSandbox](https://img.shields.io/badge/Open%20in-CodeSandbox-blue?logo=codesandbox)](https://codesandbox.io/p/github/opengeos/geolibre)
[![Microsoft Store](https://img.shields.io/badge/Microsoft%20Store-GeoLibre-0078D4?logo=windows)](https://apps.microsoft.com/detail/9nwt67rv531x)
[![Google Play](https://img.shields.io/badge/Google%20Play-GeoLibre-414141?logo=googleplay&logoColor=white)](https://play.google.com/store/apps/details?id=org.geolibre.app)
[![AUR version](https://img.shields.io/aur/version/geolibre-bin?logo=archlinux&label=AUR)](https://aur.archlinux.org/packages/geolibre-bin)
[![FlatPark](https://img.shields.io/badge/FlatPark-GeoLibre-4A90D9?logo=flatpak)](https://flatpark.org/apps/app.geolibre.GeoLibre/)
[![image](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20785400.svg)](https://doi.org/10.5281/zenodo.20785400)

A free and open-source, lightweight, cloud-native GIS platform for visualizing, exploring, and analyzing geospatial data. It runs everywhere you do, in the web browser, on the desktop, on mobile, and inside Jupyter notebooks, all while keeping your data local and private.

GeoLibre is built with **Tauri v2**, **React**, **TypeScript**, **MapLibre GL JS**, **DuckDB-WASM Spatial**, and **deck.gl**. The same workspace runs as a native desktop app, a native Android app, in any modern web browser, and adapts responsively to mobile and small screens.

- **[Launch GeoLibre Web](https://web.geolibre.app/)** — the full app in your browser, nothing to install
- **[Download the desktop app](https://geolibre.app/downloads/)** — Windows, macOS, and Linux installers
- **[Get it on Google Play](https://play.google.com/store/apps/details?id=org.geolibre.app)** — the native Android app
- **[Get started](https://geolibre.app/getting-started/)** — install, run from source, and configure
- **[Features](https://geolibre.app/features/)** — the complete feature list

## Demos

**Click any screenshot to open it at full resolution, or any animation to play the full-quality video.**

### 3D Tiles

[![GeoLibre demo showing 3D Tiles rendered on a MapLibre map](https://files.opengeos.org/GeoLibre-demo.webp)](https://files.opengeos.org/GeoLibre-demo.webp)

[Open the live project](https://share.geolibre.app/giswqs/3d-tiles)

### NYC buildings and subways

Manhattan building footprints extruded in 3D and colored by construction era, with the MTA subway lines and stations on top and a legend generated automatically from the layers' symbology.

[![Manhattan buildings extruded in 3D and colored by construction era, with MTA subway lines and stations and an auto-generated legend](https://files.opengeos.org/nyc-buildings.webp)](https://files.opengeos.org/nyc-buildings.webp)

The animation below runs the Time Slider along the buildings' construction year, from 1850 to 2025, so Manhattan fills in era by era. Click it to play the full-quality video.

[![Animation of Manhattan buildings appearing by construction year as the Time Slider advances from 1850 to 2025](https://files.opengeos.org/nyc-buildings-gif.gif)](https://files.opengeos.org/nyc-buildings.webm)

[Open the live project](https://share.geolibre.app/giswqs/nyc-buildings-and-subways)

### Planetary basemaps

GeoLibre is not limited to Earth. Planetary basemaps from OpenPlanetaryMap and USGS Astrogeology cover the Moon, Mars, Mercury, Venus, the Galilean moons (Io, Europa, Ganymede, Callisto), Titan, Pluto, and Charon, with a per-project ellipsoid so distance, area, and scale measurements match the body you are mapping. The deep-space starfield behind each globe comes from the Atmosphere Effects plugin.

<table>
  <tr>
    <td width="33%"><a href="https://files.opengeos.org/earth.webp"><img src="https://files.opengeos.org/earth.webp" alt="GeoLibre globe view of Earth over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://files.opengeos.org/moon.webp"><img src="https://files.opengeos.org/moon.webp" alt="GeoLibre globe view of the Moon over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://files.opengeos.org/mars.webp"><img src="https://files.opengeos.org/mars.webp" alt="GeoLibre globe view of Mars over a starfield backdrop"></a></td>
  </tr>
  <tr>
    <td align="center"><b>Earth</b></td>
    <td align="center"><b>Moon</b></td>
    <td align="center"><b>Mars</b></td>
  </tr>
  <tr>
    <td width="33%"><a href="https://files.opengeos.org/mercury.webp"><img src="https://files.opengeos.org/mercury.webp" alt="GeoLibre globe view of Mercury over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://files.opengeos.org/pluto.webp"><img src="https://files.opengeos.org/pluto.webp" alt="GeoLibre globe view of Pluto over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://files.opengeos.org/venus.webp"><img src="https://files.opengeos.org/venus.webp" alt="GeoLibre globe view of Venus over a starfield backdrop"></a></td>
  </tr>
  <tr>
    <td align="center"><b>Mercury</b></td>
    <td align="center"><b>Pluto</b></td>
    <td align="center"><b>Venus</b></td>
  </tr>
</table>

Switch bodies from the planet switcher in the Layers panel. See [Demos](https://geolibre.app/demos/) for more.

### Video tutorials

- [GeoLibre 1.0: A Free, Open-Source Cloud-Native GIS That Runs Anywhere (Browser, Desktop & Jupyter)](https://youtu.be/87Cm0QagtxI)
- [Geoprocessing in the Browser: 700+ Free GIS Tools in GeoLibre, Zero Install](https://youtu.be/W32bIQO_nG8)

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
  - [Notebook Panel](docs/notebook.md)
  - [Roadmap](docs/roadmap.md)
  - [Contributing](docs/contributing.md)
  - [How to Cite](docs/citation.md)

Contributions are welcome. See the [Contributing](docs/contributing.md) guide
for the development setup, repository layout, and quality gate.

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
