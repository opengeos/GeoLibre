# Demos

A visual tour of what GeoLibre looks like in use. **Click any screenshot to open
it at full resolution, or any animation to play the full-quality video.** For the
complete capability list, see [Features](features.md); for hands-on
walkthroughs, see the [Tutorials](tutorials/index.md).

## 3D Tiles

Photogrammetry and mesh datasets stream in as [3D Tiles](user-guide/adding-data.md)
and render on deck.gl over the MapLibre map, including authenticated tilesets via
custom request headers.

[![GeoLibre showing 3D Tiles rendered on a MapLibre map](https://assets.geolibre.app/images/GeoLibre-demo.webp)](https://assets.geolibre.app/images/GeoLibre-demo.webp)

[Open the live project](https://share.geolibre.app/giswqs/3d-tiles){ .md-button .md-button--primary }

## NYC buildings and subways

Manhattan building footprints extruded in 3D and colored by construction era,
with the MTA subway lines and stations on top. The legend is
[generated automatically](user-guide/styling.md) from the layers' symbology.

[![Manhattan buildings extruded in 3D and colored by construction era, with MTA subway lines and stations and an auto-generated legend](https://assets.geolibre.app/images/nyc-buildings.webp)](https://assets.geolibre.app/images/nyc-buildings.webp)

The animation below runs the [Time Slider](features.md#plugins) along the
buildings' construction year, from 1850 to 2025, so Manhattan fills in era by
era — the camera stays put and the data moves. Click it to play the
full-quality video.

[![Animation of Manhattan buildings appearing by construction year as the Time Slider advances from 1850 to 2025](https://assets.geolibre.app/demos/nyc-buildings-gif.gif)](https://assets.geolibre.app/demos/nyc-buildings.webm)

[Open the live project](https://share.geolibre.app/giswqs/manhattan-buildings-through-time){ .md-button .md-button--primary }

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
    <td width="33%"><a href="https://assets.geolibre.app/images/earth.webp"><img src="https://assets.geolibre.app/images/earth.webp" alt="GeoLibre globe view of Earth over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://assets.geolibre.app/images/moon.webp"><img src="https://assets.geolibre.app/images/moon.webp" alt="GeoLibre globe view of the Moon over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://assets.geolibre.app/images/mars.webp"><img src="https://assets.geolibre.app/images/mars.webp" alt="GeoLibre globe view of Mars over a starfield backdrop"></a></td>
  </tr>
  <tr>
    <td align="center"><b>Earth</b><br>Street, satellite, and cloudless imagery</td>
    <td align="center"><b>Moon</b><br>Hillshaded Albedo (NASA / LOLA / USGS)</td>
    <td align="center"><b>Mars</b><br>Colour MOLA Elevation (NASA / MOLA)</td>
  </tr>
  <tr>
    <td width="33%"><a href="https://assets.geolibre.app/images/mercury.webp"><img src="https://assets.geolibre.app/images/mercury.webp" alt="GeoLibre globe view of Mercury over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://assets.geolibre.app/images/pluto.webp"><img src="https://assets.geolibre.app/images/pluto.webp" alt="GeoLibre globe view of Pluto over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://assets.geolibre.app/images/venus.webp"><img src="https://assets.geolibre.app/images/venus.webp" alt="GeoLibre globe view of Venus over a starfield backdrop"></a></td>
  </tr>
  <tr>
    <td align="center"><b>Mercury</b><br>MESSENGER Colour Mosaic (NASA / JHU APL / CIW)</td>
    <td align="center"><b>Pluto</b><br>New Horizons Mosaic (NASA / JHU APL / SwRI)</td>
    <td align="center"><b>Venus</b><br>Magellan C3-MDIR Colour (NASA / JPL)</td>
  </tr>
  <tr>
    <td width="33%"><a href="https://assets.geolibre.app/images/europa.webp"><img src="https://assets.geolibre.app/images/europa.webp" alt="GeoLibre globe view of Europa over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://assets.geolibre.app/images/callisto.webp"><img src="https://assets.geolibre.app/images/callisto.webp" alt="GeoLibre globe view of Callisto over a starfield backdrop"></a></td>
    <td width="33%"><a href="https://assets.geolibre.app/images/charon.webp"><img src="https://assets.geolibre.app/images/charon.webp" alt="GeoLibre globe view of Charon over a starfield backdrop"></a></td>
  </tr>
  <tr>
    <td align="center"><b>Europa</b><br>Galileo / Voyager (NASA / JPL)</td>
    <td align="center"><b>Callisto</b><br>Galileo / Voyager (NASA / JPL)</td>
    <td align="center"><b>Charon</b><br>New Horizons Mosaic (NASA / JHU APL / SwRI)</td>
  </tr>
</table>

## Open data showcase

<!-- demo-gallery-teaser:start -->
105 interactive maps built from public open data, from air quality and
earthquakes to Roman roads and the aurora, each a single `.geolibre.json`
project you can open live, explore, and fork. A few highlights:

<table>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/manhattan-buildings-through-time"><img src="https://assets.geolibre.app/images/manhattan-buildings-through-time.webp" alt="GeoLibre map: Manhattan buildings through time" loading="lazy"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/the-global-flight-network"><img src="https://assets.geolibre.app/images/the-global-flight-network.webp" alt="GeoLibre map: The global flight network" loading="lazy"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/manhattan-buildings-through-time">Manhattan buildings through time</a></b><br>Urban growth · Buildings extruded at true height and replayed by construction year, 1850–2025, under the subway<br><small>Data: NYC Open Data, MTA</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/the-global-flight-network">The global flight network</a></b><br>Human mobility · The 4,000 busiest air corridors as great circles, hubs sized by routes<br><small>Data: OpenFlights</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/us-tornado-tracks-1950-2024"><img src="https://assets.geolibre.app/images/us-tornado-tracks-1950-2024.webp" alt="GeoLibre map: US tornado tracks, 1950–2024" loading="lazy"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/the-vanishing-aral-sea"><img src="https://assets.geolibre.app/images/the-vanishing-aral-sea.webp" alt="GeoLibre map: The vanishing Aral Sea" loading="lazy"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/us-tornado-tracks-1950-2024">US tornado tracks, 1950–2024</a></b><br>Natural hazards · (E)F1+ tracks by rating on a time slider that accumulates year by year<br><small>Data: NOAA Storm Prediction Center</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/the-vanishing-aral-sea">The vanishing Aral Sea</a></b><br>Environmental change · Swipe between water occurrence and 1984–2021 transitions<br><small>Data: EC JRC Global Surface Water</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/roads-of-the-roman-empire"><img src="https://assets.geolibre.app/images/roads-of-the-roman-empire.webp" alt="GeoLibre map: Roads of the Roman Empire" loading="lazy"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/aurora-forecast"><img src="https://assets.geolibre.app/images/aurora-forecast.webp" alt="GeoLibre map: Aurora forecast" loading="lazy"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/roads-of-the-roman-empire">Roads of the Roman Empire</a></b><br>History · About 300,000 km of Roman roads by how certain the route is<br><small>Data: Itiner-e</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/aurora-forecast">Aurora forecast</a></b><br>Space weather · The chance of seeing an aurora, a snapshot of the OVATION model<br><small>Data: NOAA SWPC</small></td>
  </tr>
</table>

[Browse the full gallery](gallery.md){ .md-button .md-button--primary }
[Official Demos collection](https://share.geolibre.app/giswqs/collections/official-demos){ .md-button }
<!-- demo-gallery-teaser:end -->

## SQL Workspace

Run DuckDB Spatial SQL against loaded layers, local files, and remote URLs
without leaving the map, then add the result as a layer or export it. PostGIS
(PGlite) and Apache Sedona engines are available from the same panel.

[![The SQL Workspace panel docked beside the map, running a spatial query](https://assets.geolibre.app/images/geolibre-sql-workspace.webp)](https://assets.geolibre.app/images/geolibre-sql-workspace.webp)

See [SQL Workspace](user-guide/sql-workspace.md) and the
[Spatial SQL tutorial](tutorials/spatial-sql.md).

## Chrome-free embeds

Any shared project can be embedded with `maponly` for a pure map with no
toolbar, panels, or status bar.

[![Chrome-free maponly embed of a 3D Tiles project](https://assets.geolibre.app/images/geolibre-embed-maponly.webp)](https://assets.geolibre.app/images/geolibre-embed-maponly.webp)

See [Embedding & Sharing](user-guide/embedding.md) for every URL parameter.

## Video tutorials

- [GeoLibre 1.0: A Free, Open-Source Cloud-Native GIS That Runs Anywhere (Browser, Desktop & Jupyter)](https://youtu.be/87Cm0QagtxI) — a tour of the browser, desktop, and Jupyter builds.
- [Geoprocessing in the Browser: 700+ Free GIS Tools in GeoLibre, Zero Install](https://youtu.be/W32bIQO_nG8) — the Whitebox toolbox running entirely on WebAssembly.
- [Access Free High-Resolution Disaster Satellite Imagery in Your Browser](https://youtu.be/QQ9i5CTNh84) — pre- and post-event imagery through the Vantor Open Data plugin.
- [Regularize Building Footprints in the Browser with GeoLibre](https://youtu.be/xjfPYxgEEEc) — squaring up AI-derived building polygons with the Rust engine.
- [GeoLibre + GeoLens: A Modern GIS Stack for Self-Hosting Geospatial Data](https://youtu.be/kQqgrxXGd4o) — pairing GeoLibre with GeoLens for a self-hosted geospatial data stack.
- [Create Reusable GIS Workflows with GeoLibre Model Builder and AI Assistant](https://youtu.be/dzjNKM6slgs) — graphical models, including ones the AI Assistant builds from a prompt.
- [Mapping the 2026 Nepal Floods with Free High-Resolution Satellite Imagery](https://youtu.be/UDO1BCwOAAc) — disaster imagery from Vantor, Planet, and OpenAerialMap in one before-and-after map.
- [Building Cloud-Native GIS Workflows with GeoLibre](https://youtu.be/RgNoKsvZ5Hk) — an hour-long webinar on the cloud-native stack behind GeoLibre.
- [Image Georeferencing Using GeoLibre in the Browser](https://youtu.be/lbioujkDSG0) — pinning a scanned campus map to the basemap with ground control points.
- [100 Interactive Maps from Open Data: Explore, Fork, and Build Your Own with GeoLibre](https://youtu.be/2r5OhvEa3AA) — a tour of the [open data gallery](gallery.md): exploring, forking, and building maps like these.

All of them, with chapters and summaries, are on
[Video Tutorials](tutorials/videos.md).

## Try it yourself

[Launch GeoLibre Web](https://web.geolibre.app/){ .md-button .md-button--primary }
[Download the app](downloads.md){ .md-button }
[Getting started](getting-started.md){ .md-button }
