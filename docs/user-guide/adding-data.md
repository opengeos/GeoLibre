# Adding Data

The **Add Data** menu is the main way to bring layers into GeoLibre. It groups sources into Files, Web services, Cloud formats, 3D layers, and Databases. You can also drag files straight onto the map.

To collect supported dataset links from a catalog or other webpage and open several at once, use the [GeoLibre Chrome extension](chrome-extension.md), available from the [Chrome Web Store](https://chromewebstore.google.com/detail/open-data-in-geolibre/joinecgbfoldanidcoakpjgkbaceaooj).

![Add Data menu](https://data.geolibre.app/images/geolibre-add-data-menu.webp)

## Files

| Item | Notes |
| --- | --- |
| **Vector Layer** | Opens the Add Vector panel (backed by `maplibre-gl-vector`). Loads GeoJSON, GeoParquet, FlatGeobuf, zipped Shapefile, GeoPackage, KML/KMZ, GML, and other vector formats from a file or URL. |
| **Raster Layer** | Opens the Add Raster panel (backed by `maplibre-gl-raster`). Loads GeoTIFF and Cloud-Optimized GeoTIFF (COG) from a file or URL. |
| **Delimited Text Layer** | Loads CSV/TSV from a file or URL, using longitude and latitude columns to build point features, or by geocoding one or more address columns (see [Geocoding](data-integrations.md#geocoding)). |
| **Encoded Polyline** | Loads Google (precision 5) or Valhalla/Mapbox (precision 6) encoded polyline strings from pasted text or uploaded text files. |
| **GPX Layer** | Loads a GPX file or URL and splits it into separate waypoint, track, and route layers. |
| **MBTiles Layer** | Loads a local MBTiles tile archive (desktop app). |

Vector files are reprojected to EPSG:4326 on load. In the browser, vector import relies on DuckDB-WASM Spatial, with direct handling for GeoJSON, zipped Shapefiles, and KMZ archives.

!!! warning "Large vector files"
    There is no fixed size limit. Files **under 100 MB** are read by the
    in-memory JavaScript readers, which are fastest for everyday data. At
    **100 MB or larger**, GeoLibre streams the file through DuckDB instead —
    off the main thread, so the interface keeps responding. For a zipped
    Shapefile the threshold applies to the *uncompressed* `.shp`, since
    shapefiles compress heavily and the archive's size says little about the
    parse cost. This happens automatically; nothing is asked of you.

    A separate check counts features once the source is open. Past
    **100,000 features**, GeoLibre asks before converting every one to GeoJSON
    in memory, because that is where memory rather than file size becomes the
    limit — a small GeoParquet can hold millions of rows.

    For very large data, converting first still pays: **Processing → GeoLibre
    Toolbox → Conversion → Vector to PMTiles** writes a tiled format the map loads one tile at a
    time instead of reading the whole file. Converting to **GeoParquet**
    instead gives a compact columnar format that reads far faster than text,
    though it is not tiled. GeoJSON is the most expensive option at any size —
    it expands several-fold in memory — so prefer a Shapefile, GeoParquet, or
    FlatGeobuf source when you have the choice.

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
| **ArcGIS Layer** | An ArcGIS FeatureServer, VectorTileServer, MapServer, or ImageServer layer. See [ArcGIS services](#arcgis-services). |
| **STAC Layer** | Searches a STAC catalog and adds the matching raster items. |

### ArcGIS services

Pick the **Layer type** that matches the service, then give it a service URL or a
portal item ID (with an access token for a secured service).

| Layer type | Service | How it loads |
| --- | --- | --- |
| **Feature layer** | FeatureServer | Downloaded page by page as a GeoJSON layer, so labels, the attribute table, identify, symbology, and export all work on it. |
| **Vector tile layer** | VectorTileServer | Rendered from the service's own style. |
| **Map service** | MapServer | A raster layer. Cached services are read as tiles; dynamic ones are drawn per tile through `/export`. |
| **Image service** | ImageServer | A raster layer drawn through `/exportImage` (or the service's tile cache). |

Map and image services become ordinary raster layers, so opacity, the Style
panel's brightness/contrast/saturation controls, reordering, and saving to a
project all work on them.

Two optional fields shape what the service draws:

- **Sublayers** (map service) takes the sublayer ids to draw, such as `0,2,5`.
  Leave it blank for the service's own default set. Pasting a URL that ends in a
  sublayer id (`.../MapServer/3`) selects that sublayer for you.
- **Rendering rule** (image service) takes an Esri raster function as JSON, such
  as `{"rasterFunction":"Hillshade"}`, applied by the server before the image is
  sent.

Either choice draws the service dynamically, because a cached service's tiles
were rendered before the choice existed and cannot honor it.

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

Three of them, grouped under **Plugins → Web Services**, search public dataset catalogs by keyword and add a result to the map in one click:

| Panel | What it searches |
| --- | --- |
| **ArcGIS Hub** | Public datasets published to ArcGIS Hub. Search by keyword or restrict the search to the current map area, page through results, add a supported layer to the map, zoom to it, or download the data. Datasets with several layers download only the first, and the panel says so. |
| **Socrata** | Public Socrata open-data catalogs, adding their GeoJSON datasets. |
| **CKAN** | The Humanitarian Data Exchange CKAN catalog, adding its available GeoJSON resources. |

Each panel shows how many of the total results you are looking at and offers **Load more** to page further.

!!! note "Browser vs desktop"
    URL-based sources work in both the browser and the desktop app. Local file dialogs, local MBTiles, local raster reads, and PostgreSQL require the desktop app. See [Getting Started](../getting-started.md).
