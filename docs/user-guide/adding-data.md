# Adding Data

The **Add Data** menu is the main way to bring layers into GeoLibre. It groups sources into Files, Web services, Cloud formats, 3D layers, and Databases. You can also drag files straight onto the map.

![Add Data menu](https://data.geolibre.app/images/geolibre-add-data-menu.webp)

## Files

| Item | Notes |
| --- | --- |
| **Vector Layer** | Opens the Add Vector panel (backed by `maplibre-gl-vector`). Loads GeoJSON, GeoParquet, FlatGeobuf, zipped Shapefile, GeoPackage, KML/KMZ, GML, and other vector formats from a file or URL. |
| **Raster Layer** | Opens the Add Raster panel (backed by `maplibre-gl-raster`). Loads GeoTIFF and Cloud-Optimized GeoTIFF (COG) from a file or URL. |
| **Delimited Text Layer** | Loads CSV/TSV from a file or URL, using longitude and latitude columns to build point features, or by geocoding one or more address columns (see [Geocoding](data-integrations.md#geocoding)). |
| **Google Drive** | Opens vector data stored in Google Drive — see [Google Drive](#google-drive) below. |
| **GPX Layer** | Loads a GPX file or URL and splits it into separate waypoint, track, and route layers. |
| **MBTiles Layer** | Loads a local MBTiles tile archive (desktop app). |

Vector files are reprojected to EPSG:4326 on load. In the browser, vector import relies on DuckDB-WASM Spatial, with direct handling for GeoJSON, zipped Shapefiles, and KMZ archives.

!!! tip "KML and KMZ"
    KML is read by an in-house parser that keeps the file's own symbology, so styled KML renders the way it does in Google Earth. A file that parser cannot handle falls back to the DuckDB Spatial reader, which loads the geometry without the styling.

    KML imports also render `GroundOverlay` images as map overlays (which animate through the Time Slider when they are time-tagged) and show embedded Collada `.dae` models. **Super-Overlays** — the tiled, `NetworkLink`-driven KML that large imagery exports use — are supported too: GeoLibre serves the archive's tiles to the map instead of trying to load the whole pyramid at once.

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

## Google Drive

**Add Data → Google Drive** opens vector data straight out of Drive: a zipped shapefile, a loose `.shp` with its `.dbf`/`.shx`/`.prj`, GeoJSON, GeoPackage, GeoParquet, FlatGeobuf, KML/KMZ, GPX, or CSV. Files are downloaded and then read by exactly the same pipeline as a drag-and-drop, so format detection, shapefile unpacking, and the large-dataset prompt all behave identically.

There are two ways in:

| Mode | Use it for | Requirements |
| --- | --- | --- |
| **Share link or file ID** | A file someone sent you. | The file must be shared with **Anyone with the link**. On the desktop app that is all you need; the browser build also needs an API key (below). |
| **Browse Google Drive** | Your own files, including private ones. | Sign in with Google and pick files in Google's own picker. Needs an API key. Not available in the Mac App Store / iOS builds. |

Paste either a **file** link or a **folder** link. A folder link lists what is inside so you can tick the layers you want — this is how an unzipped shapefile is added, since selecting the `.shp` automatically pulls in its `.dbf`, `.shx`, `.prj`, and `.cpg`. In the picker, select those sidecar files yourself alongside the `.shp`.

!!! note "Why sign-in only ever sees the files you pick"
    GeoLibre requests Google's non-sensitive `drive.file` scope, which grants access to individual files **as the user picks them** and nothing else. It never asks for the restricted `drive.readonly` scope, so the app has no ability to list or read your Drive on its own. That is also why sign-in and choosing files are a single action: a `drive.file` token by itself reaches nothing.

### API key

A Google API key ("developer key") is needed to read Drive from the browser build and to open the picker on any build. Create one in the [Google Cloud console](https://console.cloud.google.com/) with the **Google Drive API** and **Google Picker API** enabled, then paste it into the field in the dialog — it is stored in that browser only.

Deployments can supply one for all users at build time instead, via `VITE_GOOGLE_API_KEY` (or a bare `GOOGLE_API_KEY` in the environment or a `.env` file); the field is then hidden. `VITE_GOOGLE_OAUTH_CLIENT_ID` likewise overrides the OAuth client, which otherwise falls back to GeoLibre's own.

The desktop app needs neither: it reads Drive's public download host through its native HTTP client, so a shared link works with no configuration at all.

## Drag and drop

Drag a vector file (GeoJSON, zipped Shapefile, KMZ, and similar) or a GeoTIFF/COG raster directly onto the map to add it as a layer. GPX files dropped on the map are split into named waypoint, track, and route layers.

## Basemaps

The basemap sits at the bottom of the [Layers panel](layers.md) as the **Background** entry. Activate the **Basemaps** plugin from the [Plugins menu](plugins.md) to switch between OpenFreeMap styles (Liberty, Positron, Bright, Dark, Fiord, 3D), a blank background, or a custom style URL. You can toggle basemap visibility and adjust its opacity from the Layers panel.

### Other celestial bodies

GeoLibre can map worlds beyond Earth. The **Change basemap** dialog and the **New project** dialog group planetary basemaps into sections for **The Moon**, **Mars**, and a collapsible **Other celestial bodies** section covering **Mercury, Venus, the Galilean moons** (Io, Europa, Ganymede, Callisto), **Titan, Pluto,** and **Charon**. The Moon and Mars mosaics come from [OpenPlanetaryMap](https://www.openplanetary.org/opm); the other bodies come from [USGS Astrogeology](https://astrogeology.usgs.gov/) and are reprojected to Web Mercator on the fly so MapLibre can render them.

For quick switching, use the **planet switcher** (the orbit icon) in the Layers panel header. Selecting a body sets the project's **ellipsoid**, so distance, area, and scale-bar measurements use that body's radius instead of Earth's.

## More data sources

Additional catalogs and providers are available as panels and plugins rather than Add Data items, including Planetary Computer, Earth Engine, Overture Maps, and several federal Web Services. See [Data Integrations](data-integrations.md).

Three of them, grouped under **Plugins → Web Services**, search public dataset catalogs by keyword and add a result to the map in one click:

| Panel | What it searches |
| --- | --- |
| **ArcGIS Hub** | Public datasets published to ArcGIS Hub. Search by keyword or restrict the search to the current map area, page through results, add a supported layer to the map, zoom to it, or download the data. Datasets with several layers download only the first, and the panel says so. |
| **Socrata** | Public Socrata open-data catalogs, adding their GeoJSON datasets. |
| **CKAN** | The Humanitarian Data Exchange CKAN catalog, adding its available GeoJSON resources. |

Each panel shows how many of the total results you are looking at and offers **Load more** to page further.

!!! note "Browser vs desktop"
    URL-based sources work in both the browser and the desktop app. Local file dialogs, local MBTiles, local raster reads, and PostgreSQL require the desktop app. See [Getting Started](../getting-started.md).
