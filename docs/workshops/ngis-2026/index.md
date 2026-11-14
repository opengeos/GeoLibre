# NGIS 2026: Cloud-Native GIS with GeoLibre

**Building Modern Geospatial Workflows**, a full-day preconference workshop at
the [Nevada Geographic Information Society (NGIS) 2026 conference](https://ngis.org/preconference-training).

| | |
| --- | --- |
| **Date** | Tuesday, November 17, 2026, 8:00 a.m. to 5:00 p.m. |
| **Location** | MIKC 221 "Knowledge Nook", Mathewson-IGT Knowledge Center (second floor), University of Nevada, Reno |
| **Instructor** | Dr. Qiusheng Wu, University of Tennessee, Knoxville |
| **Format** | Eight one-hour sections: about 50 minutes of lecture and hands-on exercises, then a 10-minute break |
| **What to bring** | A laptop with an up-to-date Chrome, Edge, or Firefox. No installation is required |

GeoLibre is a free and open-source, cloud-native GIS platform for visualizing,
analyzing, and sharing geospatial data. It runs entirely in a web browser at
[web.geolibre.app](https://web.geolibre.app), and the same app ships as a
desktop application. In this workshop you will use it to read cloud-hosted
data in place, without downloading or converting it first, and to build maps
that anyone can reopen from a single link.

## Schedule

| Time | Section | Topics |
| --- | --- | --- |
| 8:00 - 9:00 | [1. Getting started with GeoLibre and cloud-native GIS](01-getting-started.md) | The cloud-native model, the interface, your first map, saving and reopening projects |
| 9:00 - 10:00 | [2. Bringing in cloud-hosted data](02-bringing-in-data.md) | Vector files by URL, COG, PMTiles, Zarr, OGC and ArcGIS services, STAC catalogs, managing layers |
| 10:00 - 11:00 | [3. Visualization and styling](03-visualization-styling.md) | Graduated and categorized symbology, labels, popups, raster styling, legends, print layouts |
| 11:00 - 12:00 | [4. Attributes, editing, and spatial SQL](04-attributes-editing-sql.md) | The attribute table, expressions and selections, DuckDB spatial SQL, feature editing |
| **12:00 - 1:00** | **Lunch** | |
| 1:00 - 2:00 | [5. Analysis and processing](05-analysis-processing.md) | Vector and terrain tools, the geoprocessing toolbox, imagery, routing, discrete global grids |
| 2:00 - 3:00 | [6. Rendering engines, 3D, and time](06-3d-and-time.md) | The Cesium globe, terrain and 3D buildings, USGS 3DEP LiDAR, the Time Slider |
| 3:00 - 4:00 | [7. Communicating and collaborating](07-communicating-collaborating.md) | Story maps, dashboards, share links, embedding, HTML export, live collaboration |
| 4:00 - 5:00 | [8. AI and automation](08-ai-automation.md) | The AI Assistant, MCP agents, GeoLibre in Python and R, wrap-up |

Each section page lists its learning goals, a lecture outline, step-by-step
exercises, and a link to the finished project so you can check your work or
catch up after a break.

## Before you start

1. Open [web.geolibre.app](https://web.geolibre.app) in Chrome, Edge, or
   Firefox. If a welcome wizard appears, close it. Everything in this workshop
   runs in the browser. Your data leaves your machine only when you share or
   export it, or when you use the AI Assistant with a remote provider. Place
   searches go to a geocoding service, and catalog searches send the map
   extent to the catalog.
2. Optional: install the [desktop app](../../downloads.md). It adds local file
   access and a Python sidecar for extra processing tools, but no exercise
   requires it.
3. Optional, for Section 7: a free account at
   [share.geolibre.app](https://share.geolibre.app) if you want to publish a
   public link to your map.
4. Optional, for Section 8: an API key for an AI provider (Google Gemini,
   Anthropic, OpenAI, or OpenRouter), or a local [Ollama](https://ollama.com)
   install, if you want to try the AI Assistant yourself.

!!! tip "Falling behind is fine"
    Every section ends with an **Open the finished project** link. It opens the
    exact map the exercise builds, so you can pick up the next section from a
    clean state at any time.

## Workshop data

The core workshop data is real, public-domain data for the Reno, Lake Tahoe,
and Nevada area, with national county and state layers for comparison. It is
hosted as plain files on [Source Cooperative](https://source.coop/opengeos/data),
a public object store, under
`https://data.source.coop/opengeos/data/workshops/ngis-2026/`. You never need to
download it: every exercise reads it by URL. Some exercises also read public
services on other hosts (listed below the table), so make sure the venue
network does not block them.

| Dataset | File | Format | Source |
| --- | --- | --- | --- |
| Nevada counties (17) | [`nv_counties.geojson`](https://data.source.coop/opengeos/data/workshops/ngis-2026/nv_counties.geojson) | GeoJSON | US Census Bureau, 2023 cartographic boundaries |
| US states (56) | [`us_states.geojson`](https://data.source.coop/opengeos/data/workshops/ngis-2026/us_states.geojson) | GeoJSON | US Census Bureau |
| US counties (3,235) | [`us_counties.fgb`](https://data.source.coop/opengeos/data/workshops/ngis-2026/us_counties.fgb), [`.parquet`](https://data.source.coop/opengeos/data/workshops/ngis-2026/us_counties.parquet), [`.pmtiles`](https://data.source.coop/opengeos/data/workshops/ngis-2026/us_counties.pmtiles) | FlatGeobuf, GeoParquet, PMTiles | US Census Bureau |
| Earthquakes, M2.5+, 2016-2025 (8,031) | [`nv_earthquakes.csv`](https://data.source.coop/opengeos/data/workshops/ngis-2026/nv_earthquakes.csv), [`.parquet`](https://data.source.coop/opengeos/data/workshops/ngis-2026/nv_earthquakes.parquet) | CSV, GeoParquet | USGS ANSS Comprehensive Catalog |
| Reno-Tahoe elevation | [`reno_tahoe_dem.tif`](https://data.source.coop/opengeos/data/workshops/ngis-2026/reno_tahoe_dem.tif) | Cloud-Optimized GeoTIFF, about 30 m | USGS 3DEP 1/3 arc-second DEM, resampled |
| Reno-Tahoe hillshade | [`reno_tahoe_hillshade.tif`](https://data.source.coop/opengeos/data/workshops/ngis-2026/reno_tahoe_hillshade.tif) | Cloud-Optimized GeoTIFF | Derived from the DEM |
| Reno-Tahoe landmarks (8) | [`reno_sites.geojson`](https://data.source.coop/opengeos/data/workshops/ngis-2026/reno_sites.geojson) | GeoJSON | Hand-digitized, approximate locations |

The earthquake extract covers latitude 35 to 42.1 and longitude -120.1 to -114,
so it includes events just outside Nevada, mostly in eastern California.
Section 4 keeps only the events inside Nevada counties with a spatial join
(Exercise 4.7).

Other sections also read large public datasets in place: Sentinel-2 imagery
from [Earth Search](https://earth-search.aws.element84.com/v1), the USGS
National Map and Water Data services, NOAA sea surface temperature as Zarr, and
the USGS 3DEP Reno-Carson LiDAR point cloud.

## Finished projects

Each link opens the project a section builds, straight in the browser.

| Section | Project file |
| --- | --- |
| 1. Getting started | [Open in GeoLibre](https://web.geolibre.app/?url=https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/01-getting-started.geolibre.json) · [`01-getting-started.geolibre.json`](https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/01-getting-started.geolibre.json) |
| 2. Bringing in data | [Open in GeoLibre](https://web.geolibre.app/?url=https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/02-bringing-in-data.geolibre.json) · [`02-bringing-in-data.geolibre.json`](https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/02-bringing-in-data.geolibre.json) |
| 3. Visualization and styling | [Open in GeoLibre](https://web.geolibre.app/?url=https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/03-visualization-styling.geolibre.json) · [`03-visualization-styling.geolibre.json`](https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/03-visualization-styling.geolibre.json) |
| 4. Attributes, editing, and SQL | [Open in GeoLibre](https://web.geolibre.app/?url=https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/04-attributes-editing-sql.geolibre.json) · [`04-attributes-editing-sql.geolibre.json`](https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/04-attributes-editing-sql.geolibre.json) |
| 5. Analysis and processing | [Open in GeoLibre](https://web.geolibre.app/?url=https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/05-analysis-processing.geolibre.json) · [`05-analysis-processing.geolibre.json`](https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/05-analysis-processing.geolibre.json) |
| 6. Engines, 3D, and time | [Open in GeoLibre](https://web.geolibre.app/?url=https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/06-3d-and-time.geolibre.json) · [`06-3d-and-time.geolibre.json`](https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/06-3d-and-time.geolibre.json) |
| 7. Communicating and collaborating | [Open in GeoLibre](https://web.geolibre.app/?url=https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/07-communicating-collaborating.geolibre.json) · [`07-communicating-collaborating.geolibre.json`](https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/07-communicating-collaborating.geolibre.json) |
| 8. AI and automation | [Open in GeoLibre](https://web.geolibre.app/?url=https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/08-ai-automation.geolibre.json) · [`08-ai-automation.geolibre.json`](https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/08-ai-automation.geolibre.json) |

## Conventions in these pages

- **Menu paths** are written as **Add data → Vector layer**: open the **Add
  data** menu in the top toolbar, then choose **Vector layer**.
- **Layer actions** is the **⋯** button on a layer's row in the Layers panel.
- The **Style panel** is on the right. Click the palette icon on a layer row
  to open it for that layer.
- Labels follow the current web app. If a label moves in a later release, the
  [User Guide](../../user-guide/interface.md) has the up-to-date reference.
