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

Twelve projects built from public open data, spanning environmental health,
human mobility, and environmental change. Each is a single `.geolibre.json`
file authored with the [Python package](python.md): choropleths, heatmaps,
great-circle flows, 3D extrusions, before-and-after swipes, and a time slider,
with click popups, hover tooltips, and a legend derived from each layer's
symbology. **Click any map to open the live project.**

<table>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/us-adult-asthma-copd-by-county"><img src="https://assets.geolibre.app/images/us-adult-asthma-copd-by-county.webp" alt="GeoLibre map: US adult asthma &amp; COPD"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/ground-level-no2-1997-vs-2011"><img src="https://assets.geolibre.app/images/ground-level-no2-1997-vs-2011.webp" alt="GeoLibre map: Ground-level NO₂, 1997 vs 2011"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/us-adult-asthma-copd-by-county">US adult asthma &amp; COPD</a></b><br>Environmental health · County choropleth of age-adjusted adult asthma, with COPD one toggle away<br><small>Data: CDC PLACES</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/ground-level-no2-1997-vs-2011">Ground-level NO₂, 1997 vs 2011</a></b><br>Air pollution · Swipe between two periods of satellite-derived surface NO₂<br><small>Data: NASA SEDAC via GIBS</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/global-wildfires-last-7-days"><img src="https://assets.geolibre.app/images/global-wildfires-last-7-days.webp" alt="GeoLibre map: Global wildfires, last 7 days"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/the-global-flight-network"><img src="https://assets.geolibre.app/images/the-global-flight-network.webp" alt="GeoLibre map: The global flight network"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/global-wildfires-last-7-days">Global wildfires, last 7 days</a></b><br>Wildfires · Fire-radiative-power heatmap that resolves into 0.1° fire cells<br><small>Data: NASA FIRMS (VIIRS)</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/the-global-flight-network">The global flight network</a></b><br>Human mobility · The 4,000 busiest air corridors as great circles, hubs sized by routes<br><small>Data: OpenFlights</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/nyc-citi-bike-live-availability"><img src="https://assets.geolibre.app/images/nyc-citi-bike-live-availability.webp" alt="GeoLibre map: NYC Citi Bike availability"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/earth-at-night-2012-vs-2016"><img src="https://assets.geolibre.app/images/earth-at-night-2012-vs-2016.webp" alt="GeoLibre map: Earth at night, 2012 vs 2016"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/nyc-citi-bike-live-availability">NYC Citi Bike availability</a></b><br>Human mobility · Every station colored by fill level and sized by capacity<br><small>Data: Citi Bike GBFS feed</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/earth-at-night-2012-vs-2016">Earth at night, 2012 vs 2016</a></b><br>Human footprint · Swipe between two years of night lights<br><small>Data: NASA Black Marble</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/amazon-deforestation-frontier-rondonia"><img src="https://assets.geolibre.app/images/amazon-deforestation-frontier-rondonia.webp" alt="GeoLibre map: Amazon deforestation frontier"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/the-vanishing-aral-sea"><img src="https://assets.geolibre.app/images/the-vanishing-aral-sea.webp" alt="GeoLibre map: The vanishing Aral Sea"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/amazon-deforestation-frontier-rondonia">Amazon deforestation frontier</a></b><br>Environmental change · Tree-cover loss by year, 2001–2024, over Rondônia<br><small>Data: Hansen / UMD Global Forest Change</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/the-vanishing-aral-sea">The vanishing Aral Sea</a></b><br>Environmental change · Swipe between water occurrence and 1984–2021 transitions<br><small>Data: EC JRC Global Surface Water</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/co2-emissions-per-person-3d"><img src="https://assets.geolibre.app/images/co2-emissions-per-person-3d.webp" alt="GeoLibre map: CO₂ emissions per person"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/tropical-cyclones-ocean-heat"><img src="https://assets.geolibre.app/images/tropical-cyclones-ocean-heat.webp" alt="GeoLibre map: Tropical cyclones &amp; ocean heat"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/co2-emissions-per-person-3d">CO₂ emissions per person</a></b><br>Climate · Countries colored and extruded in 3D by per-capita emissions<br><small>Data: Our World in Data</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/tropical-cyclones-ocean-heat">Tropical cyclones &amp; ocean heat</a></b><br>Climate hazards · Three seasons of storm tracks by category over SST anomalies<br><small>Data: NOAA IBTrACS, NASA GHRSST</small></td>
  </tr>
  <tr>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/dengue-incidence-1990-2024"><img src="https://assets.geolibre.app/images/dengue-incidence-1990-2024.webp" alt="GeoLibre map: Dengue incidence, 1990–2024"></a></td>
    <td width="50%"><a href="https://share.geolibre.app/giswqs/manhattan-buildings-through-time"><img src="https://assets.geolibre.app/images/manhattan-buildings-through-time.webp" alt="GeoLibre map: Manhattan buildings through time"></a></td>
  </tr>
  <tr>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/dengue-incidence-1990-2024">Dengue incidence, 1990–2024</a></b><br>Environmental health · Time-slider 3D choropleth of reported dengue per 100k people<br><small>Data: OpenDengue</small></td>
    <td align="center"><b><a href="https://share.geolibre.app/giswqs/manhattan-buildings-through-time">Manhattan buildings through time</a></b><br>Urban growth · Buildings extruded at true height and replayed by construction year, 1850–2025, under the subway<br><small>Data: NYC Open Data, MTA</small></td>
  </tr>
</table>

[Browse the Official Demos collection](https://share.geolibre.app/giswqs/collections/official-demos){ .md-button .md-button--primary }

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

All of them, with chapters and summaries, are on
[Video Tutorials](tutorials/videos.md).

## Try it yourself

[Launch GeoLibre Web](https://web.geolibre.app/){ .md-button .md-button--primary }
[Download the app](downloads.md){ .md-button }
[Getting started](getting-started.md){ .md-button }
