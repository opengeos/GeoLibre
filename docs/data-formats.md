# Supported Data Formats

This page lists GeoLibre's supported data formats, services, and database
sources, including how to open them and the main limitations. The tables
reflect the default MapLibre renderer; some specialized layers are unavailable
with other renderers. See [Adding Data](user-guide/adding-data.md) for the menu
workflow and [Projects](user-guide/projects.md) for saving and reopening data.

## Vector and tabular files

| Format | Extensions or source | How to add it | Notes |
| --- | --- | --- | --- |
| GeoJSON | `.geojson`, `.json`, GeoJSON URL | Vector Layer | Geometry and feature attributes; also supports drag and drop. |
| GeoParquet / Parquet | `.geoparquet`, `.parquet` | GeoParquet Layer or Vector Layer | Reads geometry and CRS metadata; supported coordinate-column tables can become points. |
| FlatGeobuf | `.fgb`, `.flatgeobuf` | FlatGeobuf Layer or Vector Layer | Spatially indexed vector files, including remote URLs. |
| GeoPackage | `.gpkg` | Vector Layer | Select feature tables from a multi-layer file. |
| Shapefile | `.shp` with companion files, or `.zip` | Vector Layer | Keep `.shx`, `.dbf`, and `.prj` companions together; use a ZIP for browser imports. |
| GML | `.gml` | Vector Layer | Imported through the vector reader. |
| MapInfo TAB | `.tab` and companion files | Vector Layer | Requires access to the dataset's companion files. |
| IMDF | `.zip` | Vector Layer, drag and drop, or the Browser panel | An Indoor Mapping Data Format archive opens as a group of floor-stacked layers linked to the floor picker; see [Adding data](user-guide/adding-data.md). |
| KML / KMZ | `.kml`, `.kmz` | KML / KMZ or Vector Layer | Supports folders, styles, placemark icons, ground overlays, embedded models, and Super-Overlays; behavior depends on the renderer. Remote icon URLs (such as Google Earth's built-in icons) are downloaded from their public host when the file is opened and saved inline with the layer. Icon URLs that name a loopback or private-network address are skipped, and redirects are not followed. |
| GPX | `.gpx` | GPX Layer | Waypoints, tracks, and routes can become separate layers. |
| IndoorGML | `.gml`, `.xml`, IndoorGML URL | IndoorGML Layer | OGC IndoorGML 1.0 cells extruded to their real heights plus the navigation network, linked to the floor picker; give the CRS when the file names none, or place a local model at the map centre. |
| LandXML | `.xml`, `.landxml`, LandXML URL | LandXML Layer | Imports TIN surfaces, horizontal alignments, vertical profile metadata, and survey points; projected data requires a source CRS. |
| Delimited text | CSV, TSV, and custom-delimited text | Delimited Text Layer | Map coordinate columns, specify their CRS, or geocode address columns. CSV without coordinates can also be loaded as a table. |
| Excel | Excel workbooks | Delimited Text Layer | Select a worksheet and coordinate columns to create point features. |
| AutoCAD | `.dxf`, `.dwg` | CAD (DXF/DWG) Layer | Select drawing layers and the source CRS. Coordinate Z values are kept and rendered in 3D unless you turn that off. |
| Esri File Geodatabase | `.gdb` folder | File Geodatabase (GDB) | Desktop folder access; select a feature class. |
| OpenStreetMap PBF | `.osm.pbf` | OSM PBF Layer | Reads an extract in the browser and adds the selected features. |
| ICESat-2 / GEDI | `.h5` granules of ICESat-2 ATL03/ATL06/ATL08 and GEDI L2A/L2B/L4A | ICESat-2 / GEDI | Read in the browser into a point layer. For ATL06, ATL08 and GEDI, choose beams and fields and apply the product's quality filter; for ATL03, pick the beams, surface type and minimum signal confidence (ATL03 uses a fixed set of photon properties). Limit the read to the current view and cap the point count; each footprint or photon carries its beam, acquisition time and along-track distance (for ATL03 photons, the time and distance come from the ~20 m geolocation segments rather than per-photon measurements, and the distance counts from the first photon along track on each beam that passed the view, confidence and height filters (before the point cap thins them), so it is not comparable across beams or separate reads). Download granules from NASA Earthdata to open locally, or load a sample granule from Source Cooperative; direct ATL03 URL streaming requires HTTP byte-range support, browser CORS access, and `Access-Control-Expose-Headers: Content-Range` (NASA granules stream through the Earthaccess relay). Large footprint and photon layers are stored inline in the project, which can pause autosave. |
| Encoded polyline | Encoded strings or text files | Encoded Polyline | Precision 5 and 6, including Google, OSRM, Valhalla, and Mapbox conventions. |

Vector import generally reprojects a known source CRS to EPSG:4326. Multi-file
formats need their companion files, and large feature collections may require
substantial memory. Additional formats depend on the bundled vector reader;
see [vector import details](user-guide/adding-data.md#files).

## Raster, tile archives, and multidimensional arrays

| Format | Extensions or source | How to add it | Notes |
| --- | --- | --- | --- |
| GeoTIFF / Cloud-Optimized GeoTIFF (COG) | `.tif`, `.tiff`, remote URL | Raster Layer | Numerical pixel inspection, styling, export, and raster analysis. COGs support partial remote reads. |
| PMTiles | `.pmtiles`, remote URL | PMTiles Layer | Vector and raster tile archives. Multiple vector source layers can be added separately. |
| MBTiles | `.mbtiles` | MBTiles Layer | Local raster or vector tile archives; requires desktop filesystem access. |
| Zarr | Remote store or local folder | Zarr Layer | Multidimensional arrays with variable and dimension selection; also supports Icechunk repositories. |
| NetCDF-4 / HDF5 | Local scientific data files | NetCDF / HDF | Select variables and their spatial, time, and vertical dimensions. |
| Cloud-Optimized NetCDF / HDF | Kerchunk references | NetCDF / HDF | Reads referenced chunks from remote data. |

## Web services and catalogs

| Service | How to add it | Data and limitations |
| --- | --- | --- |
| XYZ tiles | XYZ Layer | Raster or vector tiles from a `{z}/{x}/{y}` URL template. |
| WMS | WMS Layer | Rendered map images; discover layers and query GetFeatureInfo where supported. |
| [WCS 1.0.0 / 2.0.1](#wcs-raster-subsets) | WCS Layer | Numerical GeoTIFF subsets with chosen extent, pixel dimensions, and an EPSG:4326 or EPSG:3857 request CRS. |
| WFS | WFS Layer | Vector features with feature-type discovery and optional refresh. Loads GeoJSON, or GML (2, 3.1, 3.2) from servers that offer no GeoJSON output; GML in other EPSG coordinate systems is reprojected. |
| WMTS | WMTS Layer | Map tiles from a Web Map Tile Service. |
| [OGC API - Coverages](#ogc-api-coverages-numerical-snapshots) | OGC API - Coverages | Discover collections and import bounded numerical GeoTIFF or regular CoverageJSON snapshots. |
| OGC API - Features | OGC API - Features | Browse collections and load their features. |
| OGC API - Tiles | OGC Vector Tiles | Vector tile services. |
| [OGC API - Processes](#ogc-api-processes) | Processing > GeoLibre > OGC API - Processes | Discover remote processes, supply typed inputs, monitor jobs, and download or import their results. |
| ArcGIS FeatureServer | ArcGIS Layer: Feature layer | Features and attributes from a service URL or portal item. |
| ArcGIS VectorTileServer | ArcGIS Layer: Vector tile layer | Vector tiles and their styling. |
| ArcGIS MapServer | ArcGIS Layer: Map service | Cached tiles or rendered exports, with sublayer selection. |
| ArcGIS ImageServer | ArcGIS Layer: Image service | Rendered imagery with advertised raster functions or a custom rendering rule. Identify reads pixel values (of the rendering rule's output when one is set) through the service's `/identify`. A tile cache that stops short of the source rasters' resolution is passed over for `/exportImage`, so a mosaic draws its source rasters instead of overzoomed overviews. Use WCS when numerical raster subsets are needed and the service exposes WCS. |
| GeoRSS | GeoRSS Layer | Geographic features from a feed URL or file. |
| [geoBoundaries](https://www.geoboundaries.org) | Administrative Boundaries | Country, state, and district boundaries (ADM0 to ADM5, depending on the country) under open licenses, in simplified or full geometry. |
| STAC | STAC Layer | Search catalogs and load raster assets. |
| OGC CSW 2.0.2 | CSW Catalog | Search metadata records; open supported linked GeoJSON, WMS, WFS, and ArcGIS resources. |

Remote services must allow browser cross-origin requests (CORS) for the hosted
web app. Some services need credentials or impose their own request limits.
Provider-specific catalogs, including NASA, USGS, ArcGIS Hub, Socrata, and CKAN,
are described in [Web Services](user-guide/web-services.md) and
[Data Integrations](user-guide/data-integrations.md).

## 3D, time-dependent data, and media

| Source | How to add it | Notes |
| --- | --- | --- |
| LiDAR point clouds | LiDAR Layer | LAS/LAZ and cloud-optimized point-cloud data. The layer menu exports a cloud to LAS, LAZ or COPC, and Whitebox LiDAR tool outputs load as new point cloud layers. LAS, LAZ and COPC files can also be dropped on the map. |
| Gaussian splats | Gaussian Splatting | Point-based scene rendering. |
| OGC 3D Tiles | 3D Tiles Layer | Streamed 3D tilesets; authenticated tilesets can use request headers. |
| ArcGIS I3S | 3D Tiles Layer (SceneServer URL) | Integrated Mesh and 3D Object scene layers, and Building Scene Layers (BIM): draw the Overview or the full model, and choose its disciplines and categories in the Style panel. Scene layers must be in WGS84 to draw on the 2D map. |
| Cesium ion assets | Cesium Ion Asset | 3D Tiles tilesets or imagery hosted on Cesium ion; requires the Cesium renderer. |
| CZML | CZML Dynamic 3D Scene | Time-dependent scene descriptions; requires the Cesium renderer. |
| glTF / GLB | 3D Model (glTF) | Place a local or remote model at coordinates with scale, rotation, and altitude. |
| Georeferenced video | Video Layer | Video draped over four map corner coordinates. |
| Geotagged photos | Geotagged Photos | EXIF GPS locations with thumbnails; photos without coordinates can be placed manually. |
| Deck.gl visualization data | Deck.gl Layer | Supported visualization types from local files or URLs. |

## Databases and spatial query sources

| Source | Entry point | Notes |
| --- | --- | --- |
| DuckDB / DuckDB Spatial | DuckDB Layer or SQL Workspace | Query local files, remote data, or a database and add spatial results to the map. |
| PostgreSQL / PostGIS | PostgreSQL Layer or Browser panel | Desktop database connections use a local tile server. |
| SQL Server / Azure SQL | SQL Server Layer or Browser panel | Desktop only; spatial tables load as editable layers. |
| Apache Iceberg | Apache Iceberg Layer | Read spatial tables through DuckDB. |
| PostGIS via PGlite | SQL Workspace | In-browser spatial SQL engine. |
| Apache Sedona | SQL Workspace | An additional spatial query engine. |

## Project formats

| Format | Entry point | Notes |
| --- | --- | --- |
| GeoLibre project (`.geolibre.json`) | Project > Open From | Layers, styles, groups, and map state; remote sources and local file references still need to be accessible. |
| QGIS project (`.qgs`, `.qgz`) | Project > Import | Imports supported layers, settings and attribute forms; reports skipped sources. Local paths require desktop access. |
| ArcGIS Pro project or map (`.aprx`, `.mapx`) | Project > Import | Imports supported layers and settings; see the [project import guide](user-guide/projects.md#importing-an-arcgis-pro-project) for requirements. |

## WCS raster subsets

Use **Add Data > WCS Layer** to download numerical raster data from an OGC
Web Coverage Service. Unlike a rendered WMS image, the returned GeoTIFF retains
band values for pixel inspection, raster styling, export, and raster analysis.

1. Enter the service's WCS endpoint and click **Retrieve coverages**.
2. Select a coverage. Choose **Use view**, **Use coverage extent**, or enter
   west, south, east, and north in longitude/latitude degrees.
3. Pick a **Request CRS** (see below), set the output width and height in
   pixels, and click **Add layer**.
4. Use the layer's pixel inspector or raster tools. Export the raster as a
   GeoTIFF to keep a copy of the downloaded data.

The sample selector includes USGS 3DEP elevation and the Illinois statewide
LiDAR DEM. Each sample selects a small area near Elkhart, Illinois. A bare
ArcGIS ImageServer REST URL is also accepted and converted to its WCS endpoint.
This is a convenience; GeoServer and other WCS endpoints use the same protocol.

### Supported requests

GeoLibre supports **WCS 1.0.0 and 2.0.1** KVP `GetCapabilities`,
`DescribeCoverage`, and `GetCoverage`. Discovery prefers 2.0.1 and retries
1.0.0 when a service refuses the newer protocol. Services must advertise
GeoTIFF output. WCS 1.1 and 2.1 are not implemented.

WCS 2.0.1 requests use the coverage and grid axis names from
`DescribeCoverage`, repeated `SUBSET` parameters, and `SCALESIZE` to honor the
chosen width and height. Two-dimensional, axis-aligned rectified grids and
the WCS scaling extension are required; unsupported dimensions or rotated
grids are refused before downloading. Requesting a different CRS also needs
the service's CRS extension. Multipart responses such as USGS 3DEP's GML plus
TIFF are unpacked without decoding or changing the numerical TIFF bytes;
ambiguous, encoded, or truncated raster parts are refused.

The coverage is requested in **EPSG:4326** or **EPSG:3857** (Web Mercator).
The box is always entered in longitude/latitude and projected to the chosen
CRS. **Automatic** picks EPSG:4326 when the coverage advertises it, then
EPSG:3857, and otherwise still tries EPSG:4326: many services (for example
PDOK's AHN elevation service, which lists only EPSG:28992) serve CRSes they do
not advertise. If the server rejects a CRS it did not advertise, the error
names the advertised list so you can try the other option. Striped GeoTIFF
responses, which MapServer-based services return, are converted to a
Cloud-Optimized GeoTIFF in the browser before loading.

The selected extent and pixel dimensions determine output resolution. The
server may resample values; this is not a guarantee of native-resolution data.
Each dimension must be 1–4096 pixels, with a 128 MB download limit; coverage
listings and descriptions are capped at 32 MB. The server may impose smaller
limits. Areas crossing the antimeridian must be split into
two requests. Each load is a fixed subset; panning does not fetch more coverage.

Downloads become file-backed raster layers and follow the same persistence
rules as other imported GeoTIFFs. Export the raster before ending the session;
saving only the project does not retain the downloaded raster bytes.

Desktop requests use native HTTP. The hosted web app requires the service to
allow browser cross-origin requests (CORS). Development uses the existing
service proxy, so a successful development test alone does not establish CORS
support on the hosted site.

References: [OGC WCS 1.0.0 conformance tests](https://cite.opengeospatial.org/teamengine/about/wcs/1.0.0/site/testreq.html)
and [GeoServer WCS documentation](https://docs.geoserver.org/main/en/user/services/wcs/reference/).

## OGC API Coverages numerical snapshots

Use **Add data > OGC API - Coverages** to discover collections from a service landing page, a collections catalog or a collection URL. Select a coverage, enter a longitude/latitude bounding box and add the layer. **Use map view** and **Full extent** can fill the box. Optional date/time and axis subsets are passed to the service. Use axis subsets such as `height(10)` to select one slice from a multidimensional coverage. The service must support the requested subset parameters.

GeoLibre follows advertised coverage links and negotiates GeoTIFF or CoverageJSON. Regular CoverageJSON grids in CRS84, EPSG:4326 or EPSG:3857 become numerical GeoTIFFs with the original values preserved as Float64 and missing values represented as NoData. Latitude-first CRS axis order, reversed grid axes and row-major range dimension order are respected. EPSG:4979 horizontal coordinates are supported when the height axis is a single selected slice. Spatial axes with one cell require explicit cell bounds. Irregular grids, unsliced extra dimensions, other CRSes and nonnumeric range types are rejected. The optional CoverageJSON fields entry selects a comma-separated list of range names after download; it does not reduce the server response size.

Metadata is limited to 2 MiB per response. A coverage and all linked domain/range components share a 128 MiB download limit. The decoded raster is limited to 8 million samples across all bands. Importing requires working memory beyond the download size, including additional copies during desktop transfer and raster decoding. Striped TIFFs are converted to COGs before loading. Non-byte samples from both CoverageJSON and striped server GeoTIFFs are encoded as Float64 to preserve numerical precision; this uses more memory and uncompressed storage than Float32 or integer samples. Already tiled server GeoTIFFs retain their sample types. This is a fixed numerical snapshot: panning does not request more data. Export the GeoTIFF before ending the session to retain its bytes; saving only the project does not preserve imported raster files.

The sample preset uses the public pygeoapi GDPS temperature collection and a small bounding box near Toronto. It is sample weather data, not a current forecast. Desktop uses guarded native HTTP; the hosted web app requires CORS support from the service. A successful development-proxy request does not establish hosted-site CORS support.

This import path implements coverage discovery and supported representations. Remote execution is available separately through [OGC API Processes](#ogc-api-processes).

## OGC API Processes

Open **Processing > GeoLibre > OGC API - Processes**, or search for
**OGC API - Processes** in the command palette.

1. Enter a landing-page, process-list, or individual-process URL and click
   **Retrieve processes**.
2. Select a process. Its advertised schema supplies string, number, integer,
   Boolean, enumeration, and JSON inputs. Expand **Input schema** for details,
   or choose **Edit all inputs as JSON** for compound or referenced schemas.
   An eligible vector layer can be inserted into a JSON input as a GeoJSON
   FeatureCollection, feature array, or geometry array. FeatureCollections use
   the qualified `{ "value": …, "mediaType": "application/geo+json" }` input
   representation required for object values by OGC API Processes. Other JSON
   fields and raw input editing accept the service's inline or referenced input
   representation. Inputs and selected
   layer data are sent to the chosen service when you click **Run process**.
3. Choose synchronous or asynchronous execution when the service advertises
   it. Asynchronous execution displays job status and progress when available.
   **Stop waiting** and closing the dialog stop monitoring without deleting the
   remote job. Reopen the dialog and choose **Resume monitoring**, or paste an
   existing job status URL. **Dismiss job** explicitly requests remote job
   dismissal; the service determines whether this cancels running work or
   deletes a completed job.
4. Download an output, or use **Add to map** for supported GeoJSON and GeoTIFF
   results. Imported results are fixed snapshots. GeoJSON becomes a vector
   layer; GeoTIFF becomes a file-backed raster, whose bytes should be exported
   separately before ending the session. A saved project alone does not retain
   downloaded raster bytes.

Execution submits once and does not retry automatically. Individual HTTP
requests time out after 120 seconds; choose asynchronous execution for longer
work when the service supports it. Stopping or closing during submission keeps
the bounded request alive to retain an eventual accepted job URL, and prevents
another submission until that outcome arrives. Reopening shows the pending
state and recovery notice. A failed request can still leave work running remotely;
check the service before retrying, since a retry starts a new execution.
A successful execution with a monitor URL remains recoverable if its result
body cannot be read. Synchronous jobs retain their Resume and Dismiss controls
after switching processes, including when their response arrives after Stop.
The actual advertised execution endpoint is
shown before submission, including when it differs from the catalog host.
Input documents are
limited to 1 MiB and 127 nested JSON containers in the execution document,
matching the native parser limit. Input strings and property names must contain
valid Unicode characters; surrogate pairs are supported. Process descriptions
and status documents are limited to 2 MiB, and result downloads to 128 MiB each.
Decoding JSON and rasters requires additional working
memory. Native result transport uses base64 rather than JSON number arrays.
Modern hosts decode native results directly into bytes; older hosts use a
compatibility decoder with an intermediate string. Unusable output links are
retained as downloadable metadata with a warning, without discarding other
outputs. If a completed synchronous execution returns malformed result JSON
without a job URL, its original response remains downloadable with a warning
that running the process again starts another execution.
Standalone JSON values retain their original bytes for download, including
quoted strings and numeric representations. Resumed jobs use a process
description's output schemas only when its identifier matches a reported
process identifier.
Monitoring honors bounded `Retry-After` values and stops after 30
minutes; the job URL can be used to resume. Closing and reopening retains
dialog state in the current session. Changing projects clears inputs, job
status, and results and aborts pending observation and cancellable requests.
Already-dispatched native writes remain bounded by the host timeout; their late
results cannot enter a replacement project. Job history and input
credentials are not saved in projects.

Resumed jobs can return raw reference results as HTTP 204 with `Link` headers;
those output references remain available for download, including their media
types when advertised. Native requests use the host deadline after dispatch,
while cancelling observation still stops GET requests promptly.

Clearing an optional text input omits it from the request. Use raw JSON input
editing when an explicit empty string is needed.

Desktop uses guarded native HTTP. Development uses a guarded same-origin
proxy that permits public HTTP(S) hosts on their default ports; local/LAN services
and custom ports supported by desktop are unavailable through that development proxy.
Execution POSTs and job DELETEs do not follow redirects in any build: use the
final execution/job URL. Discovery and result GETs retain guarded redirects.
The hosted web app requires the remote service to permit cross-origin
GET, POST, and DELETE requests, the `Content-Type` and `Prefer` request headers,
and access to `Location`, `Link`, and `Retry-After` response headers. A successful
development test does not establish hosted-site CORS support. Credentials may
be supplied in the service URL query; they follow same-origin links only and
are redacted from imported-layer provenance.

For header-based job routing, configure the service response with
`Access-Control-Expose-Headers: Location, Link, Retry-After`; these headers are
not exposed to cross-origin browser scripts by default. See the
[response-header exposure reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Expose-Headers).
When routing headers are unavailable, the client can use JSON status/self links,
or a job identifier with an advertised job-list URL. An accepted response must
provide a recoverable job URL through at least one of those paths.

Advertised job and result links may use a different origin from the process
endpoint. Native HTTP permits supported local/LAN destinations under its
documented destination policy. Review the displayed **Job status URL** before
using **Dismiss job**: that explicit action sends DELETE to the displayed target.
