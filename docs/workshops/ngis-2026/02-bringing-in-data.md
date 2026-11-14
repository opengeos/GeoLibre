# 2. Bringing In Cloud-Hosted Data

!!! info "9:00 - 10:00 a.m."
    Lecture 15 min · Hands-on 35 min · Break 9:50 - 10:00

## Learning goals

By the end of this section you will be able to:

- Find any data source in the **Add data** menu and say which of its five
  groups (Files, Web services, Cloud formats, 3D layers, Databases) it belongs
  to.
- Load vector data by URL: GeoJSON, CSV with coordinate columns, GeoParquet
  (streamed in place), FlatGeobuf, and PMTiles.
- Load a Cloud-Optimized GeoTIFF and read its real georeferencing from the
  file header.
- Search a STAC catalog for Sentinel-2 imagery and add scenes to the map.
- Add an OGC API - Features layer and a WMS layer, and explain the difference
  between a map service and a feature service.
- Organize a growing layer stack with groups, and know what a saved project
  keeps for each kind of source.

## Lecture (15 min)

### One menu, five kinds of source

Almost all data enters GeoLibre through the **Add data** menu in the top
toolbar. It is grouped by where the data lives, not by file extension:

| Group | What it holds | Examples in this section |
| --- | --- | --- |
| **Files** | Files from your disk or a URL, read in the browser | Vector layer, Delimited text layer, Raster layer |
| **Web services** | Live services that answer requests | WMS, OGC API - Features, ArcGIS, STAC layer |
| **Cloud formats** | Single files built for partial reads over HTTP | GeoParquet, FlatGeobuf, PMTiles, Zarr |
| **3D layers** | Point clouds, 3D Tiles, glTF models, splats | Section 6 |
| **Databases** | DuckDB, PostgreSQL/PostGIS, SQL Server, Apache Iceberg | Section 4 |

Three other routes reach the same loaders: dragging a file onto the map, the
**Browser** panel on the left rail (saved services and databases as a tree),
and the catalog browsers under **Plugins → Web services** (STAC, Source
Cooperative, USGS National Map, NASA Earthdata, and about 30 more). Whatever
the route, the result is an ordinary layer in the Layers panel that you can
restyle, reorder, and save.

!!! tip "Coming from QGIS or ArcGIS Pro?"
    There is no driver list and no "choose a provider" step, and you do not
    save a connection before you can browse a service: paste a URL and the
    capabilities request happens inline. The **Browser** panel plays the role
    of the QGIS Browser or the ArcGIS Pro Catalog pane when you do want saved
    connections. If an **Add data** item mentioned here is missing, **Settings
    → Interface** may be set to a beginner experience level that hides it;
    switch to **Advanced**.

### Who reads your file

GeoLibre detects the format from the file itself, then hands it to the reader
that does that format best. Knowing which reader handled a file explains most
odd behavior:

| Format | Read by | Worth knowing |
| --- | --- | --- |
| GeoJSON | The browser's own JSON parser | Human-readable and universal, but read whole and several times larger in memory than on disk |
| CSV / TSV, Excel | Delimited text reader | Coordinate columns, a WKT column, or addresses geocoded on import |
| GeoParquet | DuckDB-WASM | Columnar and compressed; remote files can be **streamed** by range request |
| FlatGeobuf | DuckDB-WASM | Carries a spatial index, so features stream in order |
| GeoPackage | sql.js (SQLite in WebAssembly) | One file, many layers; a picker asks which to load |
| Shapefile (zipped) | shpjs, DuckDB fallback | The `.prj` sets the CRS; remote zips load in the browser too |
| KML / KMZ | GeoLibre's own parser | Keeps Google Earth styling; folders become layers in a group |
| COG / GeoTIFF | cog-tiler-wasm (WebAssembly) | Tiles and overviews are fetched for the current view only |
| PMTiles | PMTiles reader | One tile per request from a single archive |
| Zarr | Zarr reader | Chunked N-dimensional arrays (time × lat × lon) |

When a format has no reader in the browser, DuckDB-WASM Spatial converts it
to GeoJSON inside your tab (`INSTALL spatial; LOAD spatial; SELECT * FROM
ST_Read(...)`). Nothing is uploaded.

Every vector layer is **reprojected to WGS84 (EPSG:4326) on load**, using the
CRS stored in the file: a shapefile's `.prj`, a GeoParquet `geo` block, a
GeoPackage's metadata. A State Plane shapefile, a UTM GeoPackage, and a WGS84
GeoJSON therefore line up with nothing to configure. CSV files and CAD
drawings carry no CRS, so for those you tell GeoLibre which one to use.

### Cloud-native formats: a small index, read first

Section 1 introduced HTTP range requests. Every cloud-native format uses them
the same way: it keeps an **index** a client reads with one small request,
and it **chunks** the data so each later request returns a useful piece.

| Format | Data | Index | Chunk | Use it to |
| --- | --- | --- | --- | --- |
| **COG** | Raster | TIFF header with tile offsets, plus overviews | 256 or 512 px tile | Display imagery, elevation, land cover |
| **GeoParquet** | Vector table | Parquet footer: schema, row groups, column statistics, bounding boxes | Row group × column | Filter, aggregate, and join large tables |
| **FlatGeobuf** | Vector features | Packed Hilbert R-tree | Feature | Stream features by bounding box |
| **PMTiles** | Vector or raster tiles | Directory of tile offsets | One z/x/y tile | Pan a big layer quickly at every zoom |
| **Zarr** | N-dimensional arrays | `zarr.json` or `.zmetadata` | Array chunk | Slice climate, weather, and ocean model output |
| **COPC / EPT** | Point clouds | Octree hierarchy | Octree node | Stream LiDAR (Section 6) |

Rule of thumb: **COG** to display a raster, **GeoParquet** to analyze a table,
**PMTiles** to show a big vector layer fast (its geometry is simplified per
zoom, so it is for display, not analysis), **Zarr** to slice through time or
depth.

!!! warning "Two requirements that catch everyone"
    In a browser, the server must send **CORS** headers that allow the app's
    origin, and single-file formats (COG, GeoParquet, FlatGeobuf, PMTiles,
    COPC) need **HTTP `Range` support**. A URL that works with `curl` but fails
    in GeoLibre is almost always missing one of these. Object stores such as
    Amazon S3 and Source Cooperative support both, which is why the workshop
    data lives on `data.source.coop`.

### Large data: what happens automatically

GeoLibre picks a strategy by size so the tab keeps responding:

| Threshold | What changes |
| --- | --- |
| More than 50,000 features | The layer is tiled in the browser (vector tiles generated in a worker) instead of drawn as one GeoJSON source |
| More than 100,000 features | GeoLibre asks before converting every feature to GeoJSON in memory |
| Files of 100 MB or more | The file is streamed through DuckDB off the main thread |

When a file is genuinely too big, convert instead of fighting it: **Processing
→ GeoLibre toolbox → Conversion** has **Vector to GeoParquet**, **Vector to
PMTiles**, and **Raster to COG**, all running in the browser.

### Services and catalogs: maps versus features

| Service | Returns | You get |
| --- | --- | --- |
| **WMS** | Rendered images | A picture of the data; attributes only through GetFeatureInfo |
| **WMTS** / **XYZ** | Pre-rendered image tiles | Fast display |
| **WFS** | Features as GeoJSON or GML | Geometry and attributes |
| **OGC API - Features** | GeoJSON over a REST API, paged | Geometry and attributes |
| **WCS** | Raw raster values | Numbers you can analyze |
| **ArcGIS** FeatureServer / MapServer / ImageServer | Features, map images, or imagery | A real vector layer from a FeatureServer; raster layers from the others |
| **STAC API** | JSON describing items and their asset files (usually COGs) | A search engine that leads straight to cloud-native files |

Use a map service when you need a **reference picture**, and a feature or
coverage service when you need **data** to analyze. A STAC catalog groups
data into **collections** (`sentinel-2-l2a`), **items** (one scene: one
footprint at one time, with properties such as `eo:cloud_cover`), and
**assets** (the files of an item: a true-color COG, single bands, masks).

### What a saved project keeps

A project stores **where each layer comes from**, not a copy of the data, so a
URL-based layer reopens from its URL. Two exceptions matter today: points
built from a CSV are embedded in the project (so the file grows), and a
feature service result (OGC API, WFS) is saved as the features you fetched.
Zarr layers are not restored on the default MapLibre engine yet; add them
again from their source. Credentials (API keys, S3 keys, ArcGIS sign-ins) are
never written to a project.

## Hands-on (35 min)

Start a new project: **Project → New…**, set **Project name** to
`NGIS 2026 - 2 Bringing in data`, click the **Positron** basemap, and click
**Create**.

All workshop files are read in place from
`https://data.source.coop/opengeos/data/workshops/ngis-2026/`.

### Exercise 2.1: GeoJSON by URL (3 min)

1. Choose **Add data → Vector layer**. The **Add Vector Layer** panel opens
   over the map.
2. Paste this URL into the URL box and click **Load**:

    ```text
    https://data.source.coop/opengeos/data/workshops/ngis-2026/nv_counties.geojson
    ```

3. Paste a second URL and click **Load** again:

    ```text
    https://data.source.coop/opengeos/data/workshops/ngis-2026/reno_sites.geojson
    ```

4. **Expected result:** `nv_counties` (17 polygons) and `reno_sites` (8 points)
   appear in the Layers panel, and the map zooms to the last layer added, the
   Reno-Tahoe sites (zoom about 10).
5. Click **Close panel** (×) on the Add Vector Layer panel.

### Exercise 2.2: Earthquakes from a CSV (5 min)

The USGS earthquake catalog exports CSV with `latitude` and `longitude`
columns. This extract holds 8,031 M2.5+ earthquakes from 2016 through 2025.

1. Choose **Add data → Delimited text layer**.
2. Set **Layer name** to `Nevada earthquakes`. Keep **Source type** at
   **Delimited text URL** and paste:

    ```text
    https://data.source.coop/opengeos/data/workshops/ngis-2026/nv_earthquakes.csv
    ```

3. Click **Retrieve columns**. **Expected result:** the dialog reports
   **Retrieved 8 columns.** and sets **Longitude field** to `longitude` and
   **Latitude field** to `latitude`.
4. Leave **Import as** at **Coordinates** and **Coordinate system** blank (the
   coordinates are already WGS84), then click **Add layer**.
5. **Expected result:** a `Nevada earthquakes` point layer, and the map zooms
   out to the whole extract (zoom about 6).

!!! warning "Points in the Atlantic?"
    If a CSV holds projected eastings and northings instead of longitude and
    latitude, enter its EPSG code in **Coordinate system** (or pick one from
    **Common coordinate systems…**). Skip that step and the points land far
    from where they belong. **Import as → Addresses (geocode)** builds points
    from an address column instead, sending each address to a geocoding
    service.

### Exercise 2.3: Stream a GeoParquet file in place (5 min)

1. Choose **Add data → GeoParquet layer**. The same Add Vector Layer panel
   opens.
2. Tick **Stream GeoParquet (no copy)**, paste the 3,235 US counties, and
   click **Load**:

    ```text
    https://data.source.coop/opengeos/data/workshops/ngis-2026/us_counties.parquet
    ```

3. **Expected result:** the panel's layer list shows `us_counties` tagged
   `geoparquet · 3.2k ft · geojson · stream`, and the map zooms out to the
   file's full extent. US counties run from Guam to the Aleutians, so that is
   most of the globe.
4. Close the panel, hide `us_counties` with its eye icon, and click **Zoom to
   layer** (magnifier) on the `nv_counties` row to come back to Nevada.

!!! tip "Streaming or not?"
    Streaming queries the file where it sits instead of copying it into
    memory. It suits large, **spatially sorted** files: this one was written
    with `SORT_BY_BBOX` and 256-row groups (14 in all), so nearby counties
    share row groups and a reader can skip the rest. For small files, leave
    streaming off: the layer is handed to GeoLibre and gets the full Style
    panel and attribute table.

### Exercise 2.4: The same counties as PMTiles (5 min)

1. Choose **Add data → PMTiles layer**. The **PMTiles Layer** panel opens.
2. Paste the URL into **PMTiles URL**:

    ```text
    https://data.source.coop/opengeos/data/workshops/ngis-2026/us_counties.pmtiles
    ```

3. Click **Fetch**. **Expected result:** **Found 1 source layer(s)**, with the
   source layer `counties` ticked.
4. Tick **Enable feature picking (click to inspect)**, set **Layer Name** to
   `US counties (PMTiles)`, and click **Add Layer**. The panel confirms
   **PMTiles layer added (vector).**
5. The map jumps to the archive's own extent, a world view. Close the panel
   (×) and click **Zoom to layer** (magnifier) on the `nv_counties` row to come
   back to Nevada.
6. Click any Nevada county. **Expected result:** a **Counties** popup. For Nye
   County it reads `GEOID` 32023, `NAME` Nye, `ALAND` 47090939214.
7. Zoom in and out. Each zoom level fetches a handful of tiles from one file,
   with no tile server involved. Hide the PMTiles layer when you are done.

![The US counties PMTiles archive with feature picking, showing the attributes of Nye County](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s02-pmtiles-identify.webp)

!!! question "Discussion"
    You now have the same 3,235 counties as streamed GeoParquet and as
    PMTiles. Which would you use to compute each county's area in SQL, and
    which to show counties on a public web map? Why can't PMTiles answer the
    first question reliably?

### Exercise 2.5: A Cloud-Optimized GeoTIFF and its metadata (5 min)

1. Choose **Add data → Raster layer**. Leave **Rendering engine** at
   **cog-tiler-wasm (WASM)**.
2. Paste the Reno-Tahoe elevation model and click **Load**:

    ```text
    https://data.source.coop/opengeos/data/workshops/ngis-2026/reno_tahoe_dem.tif
    ```

3. **Expected result:** the map zooms to the Reno-Tahoe area (zoom about 9) and a
   grayscale elevation image appears, bright on the Carson Range and dark in
   the valleys. Close the **Add Raster Layer** panel.
4. Click the **Metadata** button (the ⓘ icon) on the `reno_tahoe_dem.tif` row.
   Under **Source details**, find what GeoLibre read from the GeoTIFF header:
   `EPSG:4326`, width 2520 × height 3240, `float32`, nodata `-9999`,
   `Deflate` compression, 512 × 512 tiles, and 3 overviews.
5. Close the dialog. The file is 22 MB, yet it appeared almost at once: the
   browser fetched the header and only the overview tiles this view needs.

!!! tip "Styling comes next"
    The gray ramp is the default. Section 3 gives the DEM a terrain color ramp
    and a stretch. **Inspect pixel values** on the layer row reads elevations
    now if you are curious.

### Exercise 2.6: Search Sentinel-2 with STAC (8 min)

1. Type `Lake Tahoe` in the search box at the bottom left and pick **Lake
   Tahoe, Placer County, California, United States**. Search results fly to
   zoom 12, so choose **View → Set view…**, set **Zoom** to `9`, and click
   **Go**. The whole lake and Reno are now in view.
2. Choose **Plugins → Web services → STAC catalogs**. The panel docks on the
   right.
3. In **STAC catalog or API URL**, enter Element 84's Earth Search and click
   **Connect**:

    ```text
    https://earth-search.aws.element84.com/v1
    ```

4. **Expected result:** the panel reads **Earth Search by Element 84 · STAC
   API** and lists nine collections. Click **Sentinel-2 Level-2A**.
5. Keep **Limit search to the current map extent** ticked. Set **Start date**
   to `07/01/2025` and **End date** to `08/31/2025`. Tick **Max cloud** and set
   it to `5` %. Set **Sort by date** to **Newest first**.
6. Click **Search items**. **Expected result:** **Showing 11 of 189 items**,
   newest first, starting with `S2B_10SFH_20250831_0_L2A`, and a `STAC search
   footprints` layer on the map.
7. Lake Tahoe straddles two Sentinel-2 tiles, `10SGJ` and `11SKD`. For
   `S2B_10SGJ_20250831_0_L2A` and then `S2B_11SKD_20250831_0_L2A`, open the
   **Assets** menu and pick **True color image — COG**. The panel confirms
   **Added True color image to the map.** each time, and the map recenters on
   the new scene.
8. Hide `STAC search footprints` and `reno_tahoe_dem.tif`, and close the STAC
   panel. Clear the search box (×) to remove the pin.

![Two Sentinel-2 true-color scenes from August 31, 2025 over Lake Tahoe, found and added through the STAC catalogs panel](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s02-stac-tahoe.webp)

!!! tip "Assets, bands, and indices"
    The **Assets** menu lists every file of an item; ones GeoLibre cannot draw
    are greyed out as *not addable* instead of failing. The **Bands** menu next
    to it builds composites and indices from the bands, such as **Color
    infrared (vegetation)** and **NDVI (vegetation)**. **Raster rendering
    options** at the bottom of the search form set bands, colormap, min/max,
    and nodata for assets you add next.

!!! question "Discussion"
    Raise **Max cloud** to 100 % and search again. How many more items match,
    and why does a summer date range over Lake Tahoe still return mostly clear
    scenes?

### Exercise 2.7: A feature service and a map service (6 min)

1. Choose **Add data → OGC API - Features**.
2. Set **Layer name** to `USGS monitoring locations (OGC API)` and paste the
   USGS Water Data API into **Service URL**:

    ```text
    https://api.waterdata.usgs.gov/ogcapi/v0
    ```

3. Click **Retrieve collections**. **Expected result:** **Select from 39
   collections**. Click **Monitoring locations (monitoring-locations)**; the
   **Collection** box fills in `monitoring-locations`.
4. Leave **Max features** at `1000`, click **Use view** to fill the
   **Bounding box** from the map, and click **Add layer**.
5. **Expected result:** stream gages, wells, and other sites appear as points
   around the lake. Open **Layer actions (⋯) → Open attribute table** on the
   new layer: the footer reads **1000 features**, with columns such as
   `agency_code`, `agency_name`, and the site name (for example `TRUCKEE RV
   ABV D...`). Close the table.
6. Now a map service from the **Browser** panel. Click **Browser** on the left
   rail, expand **Services → WMS** (three built-in services), and
   double-click **NLCD 2021 Land Cover (MRLC)**. Click **Layers** on the left
   rail to return.
7. **Expected result:** a `NLCD 2021 Land Cover (MRLC)` layer tagged **WMS**
   covers the map with land-cover colors: dark green forest, tan shrubland,
   red developed land around Reno. Drag its opacity to about 0.5, compare it
   with the imagery, then hide it.

![USGS monitoring locations from OGC API - Features over the Sentinel-2 scenes, with the attribute table reporting 1000 features](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s02-ogc-api-table.webp)

!!! question "Discussion"
    The attribute table shows exactly 1,000 features. Is that how many
    monitoring locations exist in the view, or something else? What would you
    change to get them all? And why can you sort and filter the monitoring
    locations, but not the NLCD land-cover classes?

### Exercise 2.8: Organize the stack with a group (3 min)

Eleven layers is already a long list. Groups are folders in the layer stack.

1. On the `S2B_10SGJ_20250831_0_L2A — True color image` row, open **Layer
   actions (⋯) → New group from layer**. A **Group 1** folder appears with the
   layer inside.
2. Double-click **Group 1**, type `Sentinel-2 (STAC)`, and press `Enter`.
3. On the `S2B_11SKD…` row, open **Layer actions → Move to group → Sentinel-2
   (STAC)**. Do the same for `STAC search footprints`.
4. **Expected result:** one collapsible `Sentinel-2 (STAC)` group holding three
   layers, with its own eye icon and opacity slider. Hide the group, then show
   it again.
5. Save the project with **Project → Save** (`Ctrl+S`, `Cmd+S` on macOS).

!!! note "Why this project file is larger"
    The saved project is about 3.8 MB: the CSV earthquakes and the 1,000
    monitoring locations are embedded as features, while every file-based
    layer (GeoJSON, GeoParquet, PMTiles, COG, Sentinel-2) is stored as a URL of
    a few hundred bytes.

### Bonus: if you finish early

- **FlatGeobuf.** **Add data → FlatGeobuf layer** opens a panel with **Format**
  already set to **FlatGeobuf**. Paste
  `https://data.source.coop/opengeos/data/workshops/ngis-2026/us_counties.fgb`
  into **Vector URL** and click **Add Layer**. The panel reports **Added 3235
  features (flatgeobuf).**, the layer arrives as `us_counties` tagged
  **FLATGEOBUF**, and the map zooms out to a world view. Compare the
  load time with the streamed GeoParquet copy, then remove it (trash icon,
  then **Remove**).
- **Zarr.** **Add data → Zarr layer**, then **Load sample data… → Sea surface
  temperature, monthly (NOAA)**. The form fills in the store URL, the variable
  `sst`, and a display range of -2 to 32 °C. Tick **Pickable (click to show
  pixel value)**, name the layer, and click **Add Layer** (**Zarr layer added
  successfully.**). Set **View → Set view…** zoom to 2 to see the globe.
  Change **Selector (JSON)** to `{"time": 12}` and add a second time step.
  The **Diagnostics** counter in the status bar goes to 1: the reader first
  checks for a Zarr v3 `zarr.json`, gets a harmless 404 from this v2 store,
  and falls back to `.zmetadata`. Remove the Zarr layers before saving: they
  do not restore on the MapLibre engine.
- **A deep link.** Open this URL in a new tab. GeoLibre starts with the
  earthquake GeoParquet already loaded and zooms to it, no menus involved:

    ```text
    https://web.geolibre.app/?data=https://data.source.coop/opengeos/data/workshops/ngis-2026/nv_earthquakes.parquet
    ```

- **Search your own data.** Type `Nevada` in the search box. Before the
  place results, GeoLibre lists matches from the attributes of loaded layers
  (for example the `place` field of the earthquakes), grouped by layer.

## Check your work

[Open the finished project](https://web.geolibre.app/?url=https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/02-bringing-in-data.geolibre.json){ .md-button .md-button--primary }

The finished project ([`02-bringing-in-data.geolibre.json`](https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/02-bringing-in-data.geolibre.json))
opens over Lake Tahoe with the Sentinel-2 group, the monitoring locations,
the earthquakes, and the Nevada layers visible. The DEM, the two US county
layers, and the NLCD WMS are saved hidden; toggle them on in the Layers panel.

## Going further

- **More catalogs.** **Plugins → Web services** has ready-made browsers for
  **Sentinel-2 explorer** (every Sentinel-2 scene, read from a STAC-GeoParquet
  index with no API), **NASA Earthdata**, **Earthdata GIS**, **JAXA Earth**,
  **Source Cooperative**, **US state GIS** (including Nevada's portal), **USGS
  National Map**, and **OSM downloader**. **Processing → Planetary Computer**
  searches Microsoft's catalog.
- **ArcGIS services.** **Add data → ArcGIS layer** reads FeatureServer layers
  as real, editable vector layers, and MapServer, ImageServer, and
  VectorTileServer URLs as map layers.
- **Live layers.** A GeoJSON feed such as the USGS "all earthquakes, past day"
  feed (`https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson`)
  can refresh on a schedule: **Layer actions → Auto refresh** works on WFS and
  GeoJSON URL layers, and the project remembers the cadence.
- **Private buckets.** **Settings → Cloud storage** adds S3 connections (and
  S3-compatible stores such as MinIO and R2). Layers keep the `s3://` URI and
  GeoLibre signs each request, so a saved project never contains a key.
  **Plugins → Web services → S3 browser** walks a bucket.
- **Reuse your work.** **Layer actions → Save to My Data** stores a fully
  configured layer (source, style, labels, filters) in the **Browser** panel's
  **My Data** section for any later project, and exports as JSON for a team.
- **Convert first.** **Processing → GeoLibre toolbox → Conversion** turns
  files into GeoParquet, FlatGeobuf, PMTiles, or COG in the browser.
- **Share a dataset as a link.** `?data=` takes GeoJSON, GeoParquet, PMTiles,
  a COG, or a LiDAR file, and `?stac=` opens the STAC panel on a catalog, for
  example
  `https://web.geolibre.app/?stac=https://earth-search.aws.element84.com/v1/collections/naip`.
- Read [Adding Data](../../user-guide/adding-data.md),
  [Web Services](../../user-guide/web-services.md),
  [Cloud-Native Data](../../tutorials/cloud-native-data.md), and
  [Supported Data Formats](../../data-formats.md).

---

**Break: 9:50 - 10:00.** Next: [3. Visualization and Styling](03-visualization-styling.md)
