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

    For very large data, converting first still pays: **Processing → Conversion
    → Vector to PMTiles** writes a tiled format the map loads one tile at a
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
| **Share link or file ID** | A file someone sent you. | The file must be shared with **Anyone with the link**. On the desktop app that is all you need; the browser build needs an API key (below) for any Drive file. A *folder* link needs a key on either build. |
| **Browse Google Drive** | Your own files, including private ones. | Sign in with Google and pick files in Google's own picker. Needs a deployment configured with its own Google Cloud project (below). Not available in the Mac App Store / iOS builds. |

Paste either a **file** link or a **folder** link. A folder link lists what is inside so you can tick the layers you want — this is how an unzipped shapefile is added, since selecting the `.shp` automatically pulls in its `.dbf`, `.shx`, `.prj`, and `.cpg`. In the picker, select those sidecar files yourself alongside the `.shp`.

!!! note "Why sign-in only ever sees the files you pick"
    GeoLibre requests Google's non-sensitive `drive.file` scope, which grants access to individual files **as the user picks them** and nothing else. It never asks for the restricted `drive.readonly` scope, so the app has no ability to list or read your Drive on its own. That is also why sign-in and choosing files are a single action: a `drive.file` token by itself reaches nothing.

### API key, and when you actually need one

The **desktop app** opens a link to a file shared with **Anyone with the link** with no key: it reads Drive's credential-free download host through its native HTTP client.

The **browser build** needs a key for every Drive file, and this cannot be worked around in the app. Google enforces [Fetch Metadata](https://developer.mozilla.org/docs/Glossary/Fetch_metadata_request_header) on that host: a request carrying `Sec-Fetch-Site: cross-site` is answered `403`, and that response omits `Access-Control-Allow-Origin`, so the browser surfaces it as a missing-CORS-header error. Those headers are set by the browser and cannot be changed by script, so only a non-browser client can use the endpoint. Checking the host with `curl` shows a healthy `200` precisely because curl sends no `Sec-Fetch-*` headers.

A key is also needed on **either** build to:

- **List a folder**, which only the Drive REST API can do.
- **Reach a private file** — though the picker is usually the better route there, since it grants access per file.

Create one in the [Google Cloud console](https://console.cloud.google.com/) with the **Google Drive API** enabled, then paste it into the field in the dialog — it is stored in that browser only. Deployments can supply one for all users at build time via `VITE_GOOGLE_API_KEY` (or a bare `GOOGLE_API_KEY` in the environment or a `.env` file); the field is then hidden.

### Enabling "Browse Google Drive"

The picker needs **both** halves of a Google Cloud project, and pasting only an API key is not enough — Google's picker checks that the key and the app's OAuth client belong to the same project, and GeoLibre ships no client of its own for a key to match. Where that is not configured the button is disabled and says so, rather than failing with Google's own "The API developer key is invalid", which names neither the client nor the mismatch.

To enable it, create both credentials in **one** project and set both variables:

```env
GOOGLE_OAUTH_CLIENT_ID=<client-id>.apps.googleusercontent.com
GOOGLE_API_KEY=<api-key>
```

Those bare names work in a `.env` file or the shell; `vite.config.ts` surfaces them under the `VITE_`-prefixed names the app reads, so `VITE_GOOGLE_OAUTH_CLIENT_ID` and `VITE_GOOGLE_API_KEY` are equally valid.

In that project, enable the **Google Drive API** and the **Google Picker API**, and create the OAuth client as a **Web application** whose authorized JavaScript origins include the URL the app is served from (`http://localhost:5173` for the dev server). The desktop app runs the picker from `http://localhost:5173` in the system browser, so that origin covers it too.

Opening a share link keeps working regardless of any of this.

#### Three things that block the picker after it looks configured

Each of these fails with a message that does not name its own cause, so they are worth checking in this order.

**"Access blocked: … has not completed the Google verification process" (Error 403: `access_denied`)** — the OAuth consent screen is in *Testing*, which admits only listed testers, **including the project owner's own account**. Add the account under **APIs & Services → OAuth consent screen → Test users**. Publishing the app instead also works and needs no verification review, because `drive.file` is a non-sensitive scope — the one benefit of GeoLibre using the picker rather than the restricted `drive.readonly` scope.

**"The API developer key is invalid"** — usually the **Google Picker API** is not enabled in the project. It is a separate API from the Drive API, and enabling only the latter is the common mistake. It is also what you see when the key and the OAuth client come from different projects.

**A key that used to work stops working** — check the key's **API restrictions**. A key can only be restricted to APIs already enabled in its project, so restricting it before enabling the Picker API silently locks the Picker out. This surfaces from the Drive API as `PERMISSION_DENIED` with "Requests to this API drive method … are blocked", which names the method but not the restriction. Either add both APIs to the allowed list or clear the restriction.

An API key in a web build is never secret — it is compiled into the JavaScript every visitor downloads. Restricting it (to specific referrers and to these two APIs) is the protection; keeping it hidden is not available.

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
