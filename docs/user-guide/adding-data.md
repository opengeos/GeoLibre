# Adding Data

The **Add Data** menu is the main way to bring layers into GeoLibre. It groups sources into Files, Web services, Cloud formats, 3D layers, and Databases. You can also drag files straight onto the map.

![Add Data menu](https://data.geolibre.app/images/geolibre-add-data-menu.webp)

## Files

| Item | Notes |
| --- | --- |
| **Vector Layer** | Opens the Add Vector panel (backed by `maplibre-gl-vector`). Loads GeoJSON, GeoParquet, FlatGeobuf, zipped Shapefile, GeoPackage, KML/KMZ, GML, and other vector formats from a file or URL. |
| **Raster Layer** | Opens the Add Raster panel (backed by `maplibre-gl-raster`). Loads GeoTIFF and Cloud-Optimized GeoTIFF (COG) from a file or URL. |
| **Delimited Text Layer** | Loads CSV/TSV from a file or URL, using longitude and latitude columns to build point features. |
| **GPX Layer** | Loads a GPX file or URL and splits it into separate waypoint, track, and route layers. |
| **MBTiles Layer** | Loads a local MBTiles tile archive (desktop app). |

Vector files are reprojected to EPSG:4326 on load. In the browser, vector import relies on DuckDB-WASM Spatial, with direct handling for GeoJSON, zipped Shapefiles, and KMZ archives.

## Web services

| Item | Notes |
| --- | --- |
| **XYZ Layer** | A raster or vector tile service using a `{z}/{x}/{y}` URL template. |
| **WMS Layer** | A Web Map Service layer, with click-to-identify through GetFeatureInfo where supported. |
| **WFS Layer** | A Web Feature Service layer, with optional automatic refresh. |
| **WMTS Layer** | A Web Map Tile Service layer. |
| **ArcGIS Layer** | An ArcGIS FeatureServer or VectorTileServer layer. |
| **STAC Layer** | Searches a STAC catalog and adds the matching raster items. |

## Cloud formats

| Item | Notes |
| --- | --- |
| **GeoParquet Layer** | Cloud-native columnar vector format. Opens the same Add Vector panel as **Vector Layer**. Can be streamed in place with HTTP range requests for large remote files. |
| **FlatGeobuf Layer** | Cloud-optimized vector format with spatial indexing. |
| **PMTiles Layer** | A single-file vector or raster tile archive. |
| **Zarr Layer** | Chunked, cloud-native multidimensional arrays. |

## 3D layers

| Item | Notes |
| --- | --- |
| **LiDAR Layer** | Point-cloud visualization, rendered with deck.gl. |
| **Splatting Layer** | Gaussian splat scenes. |
| **3D Tiles Layer** | OGC 3D Tiles, restored when reopening a project. Includes a Google Photorealistic 3D Tiles sample that reads `VITE_GOOGLE_MAPS_API_KEY` or `GOOGLE_MAPS_API_KEY` from the runtime environment. |

## Databases

| Item | Notes |
| --- | --- |
| **DuckDB Layer** | Query a DuckDB or DuckDB Spatial source and add the result as a layer, with identify, selection, and attribute table support. |
| **PostgreSQL Layer** | Add a layer from a PostgreSQL/PostGIS connection (desktop app, served through a local tile server). |

## Drag and drop

Drag a vector file (GeoJSON, zipped Shapefile, KMZ, and similar) or a GeoTIFF/COG raster directly onto the map to add it as a layer. GPX files dropped on the map are split into named waypoint, track, and route layers.

## Basemaps

The basemap sits at the bottom of the [Layers panel](layers.md) as the **Background** entry. Activate the **Basemaps** plugin from the [Plugins menu](plugins.md) to switch between OpenFreeMap styles (Liberty, Positron, Bright, Dark, Fiord, 3D), a blank background, or a custom style URL. You can toggle basemap visibility and adjust its opacity from the Layers panel.

### Other celestial bodies

GeoLibre can map worlds beyond Earth. The **Change basemap** dialog and the **New project** dialog group planetary basemaps into sections for **The Moon**, **Mars**, and a collapsible **Other celestial bodies** section covering **Mercury, Venus, the Galilean moons** (Io, Europa, Ganymede, Callisto), **Titan, Pluto,** and **Charon**. The Moon and Mars mosaics come from [OpenPlanetaryMap](https://www.openplanetary.org/opm); the other bodies come from [USGS Astrogeology](https://astrogeology.usgs.gov/) and are reprojected to Web Mercator on the fly so MapLibre can render them.

For quick switching, use the **planet switcher** (the orbit icon) in the Layers panel header. Selecting a body sets the project's **ellipsoid**, so distance, area, and scale-bar measurements use that body's radius instead of Earth's.

## More data sources

Additional catalogs and providers are available as panels and plugins rather than Add Data items, including Planetary Computer, Earth Engine, Overture Maps, and several federal Web Services. See [Data Integrations](data-integrations.md).

!!! note "Browser vs desktop"
    URL-based sources work in both the browser and the desktop app. Local file dialogs, local MBTiles, local raster reads, and PostgreSQL require the desktop app. See [Getting Started](../getting-started.md).
