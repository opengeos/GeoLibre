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
| 8:00 - 9:00 | [1. Introduction to GeoLibre and cloud-native GIS](01-introduction.md) | The cloud-native ecosystem, the GeoLibre interface, your first map, projects |
| 9:00 - 10:00 | [2. Accessing cloud-hosted vector data](02-vector-data.md) | Loading data by URL, CSV points, styling, labels, legends, the attribute table |
| 10:00 - 11:00 | [3. Cloud-native formats: COG, GeoParquet, PMTiles, and Zarr](03-cloud-native-formats.md) | How each format reads only the bytes it needs, and when to use which |
| 11:00 - 12:00 | [4. STAC catalogs and OGC web services](04-stac-and-ogc-services.md) | Searching Sentinel-2 with STAC, WMS, OGC API - Features |
| **12:00 - 1:00** | **Lunch** | |
| 1:00 - 2:00 | [5. Spatial analysis with SQL and processing tools](05-spatial-analysis.md) | DuckDB spatial SQL, spatial joins, buffers, terrain analysis |
| 2:00 - 3:00 | [6. LiDAR, terrain, and 3D](06-lidar-3d.md) | Streaming USGS 3DEP point clouds, 3D terrain, camera control |
| 3:00 - 4:00 | [7. Extending GeoLibre with plugins and AI](07-plugins-ai.md) | Time slider, historical imagery, web-service catalogs, the AI Assistant |
| 4:00 - 5:00 | [8. Sharing maps and reproducible projects](08-sharing-reproducibility.md) | Story maps, share links, embedding, HTML export, the Python package, wrap-up |

Each section page lists its learning goals, a lecture outline, step-by-step
exercises, and a link to the finished project so you can check your work or
catch up after a break.

## Before you start

1. Open [web.geolibre.app](https://web.geolibre.app) in Chrome, Edge, or
   Firefox. If a welcome wizard appears, close it. Everything in this workshop
   runs in the browser, and your data stays on your machine unless you choose
   to share it.
2. Optional: install the [desktop app](../../downloads.md). It adds local file
   access and a Python sidecar for extra processing tools, but no exercise
   requires it.
3. Optional, for Section 8: a free account at
   [share.geolibre.app](https://share.geolibre.app) if you want to publish a
   public link to your map.
4. Optional, for Section 7: an API key for an AI provider (Google Gemini,
   Anthropic, OpenAI, or OpenRouter), or a local [Ollama](https://ollama.com)
   install, if you want to try the AI Assistant yourself.

!!! tip "Falling behind is fine"
    Every section ends with an **Open the finished project** link. It opens the
    exact map the exercise builds, so you can pick up the next section from a
    clean state at any time.

## Workshop data

All workshop data is real, public-domain data for the Reno, Lake Tahoe, and
Nevada area, hosted as plain files on
`https://assets.geolibre.app/data/workshops/ngis-2026/`. You never need to
download it: every exercise reads it by URL.

| Dataset | File | Format | Source |
| --- | --- | --- | --- |
| Nevada counties (17) | [`nv_counties.geojson`](https://assets.geolibre.app/data/workshops/ngis-2026/nv_counties.geojson) | GeoJSON | US Census Bureau, 2023 cartographic boundaries |
| US states (56) | [`us_states.geojson`](https://assets.geolibre.app/data/workshops/ngis-2026/us_states.geojson) | GeoJSON | US Census Bureau |
| US counties (3,235) | [`us_counties.fgb`](https://assets.geolibre.app/data/workshops/ngis-2026/us_counties.fgb), [`.parquet`](https://assets.geolibre.app/data/workshops/ngis-2026/us_counties.parquet), [`.pmtiles`](https://assets.geolibre.app/data/workshops/ngis-2026/us_counties.pmtiles) | FlatGeobuf, GeoParquet, PMTiles | US Census Bureau |
| Earthquakes, M2.5+, 2016-2025 (8,031) | [`nv_earthquakes.csv`](https://assets.geolibre.app/data/workshops/ngis-2026/nv_earthquakes.csv), [`.parquet`](https://assets.geolibre.app/data/workshops/ngis-2026/nv_earthquakes.parquet) | CSV, GeoParquet | USGS ANSS Comprehensive Catalog |
| Reno-Tahoe elevation | [`reno_tahoe_dem.tif`](https://assets.geolibre.app/data/workshops/ngis-2026/reno_tahoe_dem.tif) | Cloud-Optimized GeoTIFF, about 30 m | USGS 3DEP 1/3 arc-second DEM, resampled |
| Reno-Tahoe hillshade | [`reno_tahoe_hillshade.tif`](https://assets.geolibre.app/data/workshops/ngis-2026/reno_tahoe_hillshade.tif) | Cloud-Optimized GeoTIFF | Derived from the DEM |
| Reno-Tahoe landmarks (8) | [`reno_sites.geojson`](https://assets.geolibre.app/data/workshops/ngis-2026/reno_sites.geojson) | GeoJSON | Hand-digitized, approximate locations |

The earthquake extract covers latitude 35 to 42.1 and longitude -120.1 to -114,
so it includes events just outside Nevada, mostly in eastern California.
Section 5 clips it to Nevada with a spatial join.

Other sections also read large public datasets in place: Sentinel-2 imagery
from [Earth Search](https://earth-search.aws.element84.com/v1), the USGS
National Map and Water Data services, NOAA sea surface temperature as Zarr, and
the USGS 3DEP Reno-Carson LiDAR point cloud.

## Finished projects

Each link opens the project a section builds, straight in the browser.

| Section | Project file |
| --- | --- |
| 1. Introduction | [Open in GeoLibre](https://web.geolibre.app/?url=https://assets.geolibre.app/projects/workshops/ngis-2026/01-first-map.geolibre.json) · [`01-first-map.geolibre.json`](https://assets.geolibre.app/projects/workshops/ngis-2026/01-first-map.geolibre.json) |
| 2. Vector data | [Open in GeoLibre](https://web.geolibre.app/?url=https://assets.geolibre.app/projects/workshops/ngis-2026/02-vector-styling.geolibre.json) · [`02-vector-styling.geolibre.json`](https://assets.geolibre.app/projects/workshops/ngis-2026/02-vector-styling.geolibre.json) |
| 3. Cloud-native formats | [Open in GeoLibre](https://web.geolibre.app/?url=https://assets.geolibre.app/projects/workshops/ngis-2026/03-cloud-formats.geolibre.json) · [`03-cloud-formats.geolibre.json`](https://assets.geolibre.app/projects/workshops/ngis-2026/03-cloud-formats.geolibre.json) |
| 4. STAC and OGC services | [Open in GeoLibre](https://web.geolibre.app/?url=https://assets.geolibre.app/projects/workshops/ngis-2026/04-stac-services.geolibre.json) · [`04-stac-services.geolibre.json`](https://assets.geolibre.app/projects/workshops/ngis-2026/04-stac-services.geolibre.json) |
| 5. Spatial analysis | [Open in GeoLibre](https://web.geolibre.app/?url=https://assets.geolibre.app/projects/workshops/ngis-2026/05-spatial-analysis.geolibre.json) · [`05-spatial-analysis.geolibre.json`](https://assets.geolibre.app/projects/workshops/ngis-2026/05-spatial-analysis.geolibre.json) |
| 6. LiDAR and 3D | [Open in GeoLibre](https://web.geolibre.app/?url=https://assets.geolibre.app/projects/workshops/ngis-2026/06-lidar-3d.geolibre.json) · [`06-lidar-3d.geolibre.json`](https://assets.geolibre.app/projects/workshops/ngis-2026/06-lidar-3d.geolibre.json) |
| 7. Plugins and AI | [Open in GeoLibre](https://web.geolibre.app/?url=https://assets.geolibre.app/projects/workshops/ngis-2026/07-plugins-ai.geolibre.json) · [`07-plugins-ai.geolibre.json`](https://assets.geolibre.app/projects/workshops/ngis-2026/07-plugins-ai.geolibre.json) |
| 8. Sharing | [Open in GeoLibre](https://web.geolibre.app/?url=https://assets.geolibre.app/projects/workshops/ngis-2026/08-story-map.geolibre.json) · [`08-story-map.geolibre.json`](https://assets.geolibre.app/projects/workshops/ngis-2026/08-story-map.geolibre.json) |

## Conventions in these pages

- **Menu paths** are written as **Add data → Vector layer**: open the **Add
  data** menu in the top toolbar, then choose **Vector layer**.
- **Layer actions** is the **⋯** button on a layer's row in the Layers panel.
- The **Style panel** is on the right. Click the palette icon on a layer row
  to open it for that layer.
- Labels follow the current web app. If a label moves in a later release, the
  [User Guide](../../user-guide/interface.md) has the up-to-date reference.
