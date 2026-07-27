# Demos

A visual tour of what GeoLibre looks like in use. **Click any screenshot to open
it at full resolution, or any animation to play the full-quality video.** For the
complete capability list, see [Features](features.md); for hands-on
walkthroughs, see the [Tutorials](tutorials/index.md).

## 3D Tiles

Photogrammetry and mesh datasets stream in as [3D Tiles](user-guide/adding-data.md)
and render on deck.gl over the MapLibre map, including authenticated tilesets via
custom request headers.

[![GeoLibre showing 3D Tiles rendered on a MapLibre map](https://files.opengeos.org/GeoLibre-demo.webp)](https://files.opengeos.org/GeoLibre-demo.webp)

[Open the live project](https://share.geolibre.app/giswqs/3d-tiles){ .md-button .md-button--primary }

## NYC buildings and subways

Manhattan building footprints extruded in 3D and colored by construction era,
with the MTA subway lines and stations on top. The legend is
[generated automatically](user-guide/styling.md) from the layers' symbology.

[![Manhattan buildings extruded in 3D and colored by construction era, with MTA subway lines and stations and an auto-generated legend](https://files.opengeos.org/nyc-buildings.webp)](https://files.opengeos.org/nyc-buildings.webp)

The animation below runs the [Time Slider](features.md#plugins) along the
buildings' construction year, from 1850 to 2025, so Manhattan fills in era by
era — the camera stays put and the data moves. Click it to play the
full-quality video.

[![Animation of Manhattan buildings appearing by construction year as the Time Slider advances from 1850 to 2025](https://files.opengeos.org/nyc-buildings.gif)](https://files.opengeos.org/nyc-buildings.webm)

[Open the live project](https://share.geolibre.app/giswqs/nyc-buildings-and-subways){ .md-button .md-button--primary }

## Planetary basemaps

GeoLibre is not limited to Earth. Planetary basemaps from
[OpenPlanetaryMap](https://openplanetary.org/) and
[USGS Astrogeology](https://astrogeology.usgs.gov/) cover the Moon, Mars,
Mercury, Venus, the Galilean moons (Io, Europa, Ganymede, Callisto), Titan,
Pluto, and Charon. The USGS bodies are reprojected to Web Mercator by the tiles
Worker, and each project carries its own ellipsoid, so distance, area, and scale
measurements match the body you are mapping. Switch bodies from the planet
switcher in the Layers panel.

The deep-space starfield behind each globe comes from the
[Atmosphere Effects plugin](features.md#plugins).

<table>
  <tr>
    <td width="33%"><a href="https://files.opengeos.org/earth.webp"><img src="https://files.opengeos.org/earth.webp" alt="GeoLibre globe view of Earth over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://files.opengeos.org/moon.webp"><img src="https://files.opengeos.org/moon.webp" alt="GeoLibre globe view of the Moon over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://files.opengeos.org/mars.webp"><img src="https://files.opengeos.org/mars.webp" alt="GeoLibre globe view of Mars over a starfield backdrop"></a></td>
  </tr>
  <tr>
    <td align="center"><b>Earth</b><br>Street, satellite, and cloudless imagery</td>
    <td align="center"><b>Moon</b><br>Hillshaded Albedo (NASA / LOLA / USGS)</td>
    <td align="center"><b>Mars</b><br>Colour MOLA Elevation (NASA / MOLA)</td>
  </tr>
  <tr>
    <td width="33%"><a href="https://files.opengeos.org/mercury.webp"><img src="https://files.opengeos.org/mercury.webp" alt="GeoLibre globe view of Mercury over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://files.opengeos.org/pluto.webp"><img src="https://files.opengeos.org/pluto.webp" alt="GeoLibre globe view of Pluto over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://files.opengeos.org/venus.webp"><img src="https://files.opengeos.org/venus.webp" alt="GeoLibre globe view of Venus over a starfield backdrop"></a></td>
  </tr>
  <tr>
    <td align="center"><b>Mercury</b><br>MESSENGER Colour Mosaic (NASA / JHU APL / CIW)</td>
    <td align="center"><b>Pluto</b><br>New Horizons Mosaic (NASA / JHU APL / SwRI)</td>
    <td align="center"><b>Venus</b><br>Magellan C3-MDIR Colour (NASA / JPL)</td>
  </tr>
</table>

## SQL Workspace

Run DuckDB Spatial SQL against loaded layers, local files, and remote URLs
without leaving the map, then add the result as a layer or export it. PostGIS
(PGlite) and Apache Sedona engines are available from the same panel.

[![The SQL Workspace panel docked beside the map, running a spatial query](https://data.geolibre.app/images/geolibre-sql-workspace.webp)](https://data.geolibre.app/images/geolibre-sql-workspace.webp)

See [SQL Workspace](user-guide/sql-workspace.md) and the
[Spatial SQL tutorial](tutorials/spatial-sql.md).

## Chrome-free embeds

Any shared project can be embedded with `maponly` for a pure map with no
toolbar, panels, or status bar.

[![Chrome-free maponly embed of a 3D Tiles project](https://data.geolibre.app/images/geolibre-embed-maponly.webp)](https://data.geolibre.app/images/geolibre-embed-maponly.webp)

See [Embedding & Sharing](user-guide/embedding.md) for every URL parameter.

## Video tutorials

- [GeoLibre 1.0: A Free, Open-Source Cloud-Native GIS That Runs Anywhere (Browser, Desktop & Jupyter)](https://youtu.be/87Cm0QagtxI) — a tour of the browser, desktop, and Jupyter builds.
- [Geoprocessing in the Browser: 700+ Free GIS Tools in GeoLibre, Zero Install](https://youtu.be/W32bIQO_nG8) — the Whitebox toolbox running entirely on WebAssembly.

## Try it yourself

[Launch GeoLibre Web](https://web.geolibre.app/){ .md-button .md-button--primary }
[Download the app](downloads.md){ .md-button }
[Getting started](getting-started.md){ .md-button }
