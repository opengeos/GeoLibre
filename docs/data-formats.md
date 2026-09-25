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
| KML / KMZ | `.kml`, `.kmz` | KML / KMZ Layer or Vector Layer | Supports folders, styles, ground overlays, embedded models, and Super-Overlays; behavior depends on the renderer. |
| GPX | `.gpx` | GPX Layer | Waypoints, tracks, and routes can become separate layers. |
| LandXML | `.xml`, `.landxml`, LandXML URL | LandXML Layer | Imports TIN surfaces, horizontal alignments, vertical profile metadata, and survey points; projected data requires a source CRS. |
| Delimited text | CSV, TSV, and custom-delimited text | Delimited Text Layer | Map coordinate columns, specify their CRS, or geocode address columns. CSV without coordinates can also be loaded as a table. |
| Excel | Excel workbooks | File import | Select a worksheet and coordinate columns to create point features. |
| AutoCAD | `.dxf`, `.dwg` | CAD (DXF/DWG) Layer | Select drawing layers and the source CRS. Coordinate Z values are kept and rendered in 3D unless you turn that off. |
| Esri File Geodatabase | `.gdb` folder | File Geodatabase (GDB) | Desktop folder access; select a feature class. |
| OpenStreetMap PBF | `.osm.pbf` | OSM PBF Layer | Reads an extract in the browser and adds the selected features. |
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
| [WCS 1.0.0](#wcs-raster-subsets) | WCS Layer | Numerical GeoTIFF subsets with chosen extent, pixel dimensions, and an EPSG:4326 or EPSG:3857 request CRS. |
| WFS | WFS Layer | Vector features with feature-type discovery and optional refresh. |
| WMTS | WMTS Layer | Map tiles from a Web Map Tile Service. |
| OGC API - Features | OGC API - Features | Browse collections and load their features. |
| OGC API - Tiles | OGC Vector Tiles | Vector tile services. |
| ArcGIS FeatureServer | ArcGIS Layer: Feature layer | Features and attributes from a service URL or portal item. |
| ArcGIS VectorTileServer | ArcGIS Layer: Vector tile layer | Vector tiles and their styling. |
| ArcGIS MapServer | ArcGIS Layer: Map service | Cached tiles or rendered exports, with sublayer selection. |
| ArcGIS ImageServer | ArcGIS Layer: Image service | Rendered imagery with advertised raster functions or a custom rendering rule. Use WCS when numerical raster subsets are needed and the service exposes WCS. |
| GeoRSS | GeoRSS Layer | Geographic features from a feed URL or file. |
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
| LiDAR point clouds | LiDAR Layer | LAS/LAZ and cloud-optimized point-cloud data. |
| Gaussian splats | Gaussian Splatting | Point-based scene rendering. |
| OGC 3D Tiles | 3D Tiles Layer | Streamed 3D tilesets; authenticated tilesets can use request headers. |
| ArcGIS I3S | I3S integration | Integrated Mesh and 3D Object scene layers. |
| Cesium ion assets | Cesium ion | Assets hosted on Cesium ion; requires the Cesium renderer. |
| CZML | CZML Layer | Time-dependent scene descriptions; requires the Cesium renderer. |
| glTF / GLB | 3D Model (glTF) | Place a local or remote model at coordinates with scale, rotation, and altitude. |
| Georeferenced video | Video Layer | Video draped over four map corner coordinates. |
| Geotagged photos | Geotagged Photos | EXIF GPS locations with thumbnails; photos without coordinates can be placed manually. |
| Deck.gl visualization data | Deck.gl Layer | Supported visualization types from local files or URLs. |

## Databases and spatial query sources

| Source | Entry point | Notes |
| --- | --- | --- |
| DuckDB / DuckDB Spatial | DuckDB Layer or SQL Workspace | Query local files, remote data, or a database and add spatial results to the map. |
| PostgreSQL / PostGIS | PostgreSQL Layer or Browser panel | Desktop database connections use a local tile server. |
| Apache Iceberg | Apache Iceberg Layer | Read spatial tables through DuckDB. |
| PostGIS via PGlite | SQL Workspace | In-browser spatial SQL engine. |
| Apache Sedona | SQL Workspace | An additional spatial query engine. |

## Project formats

| Format | Entry point | Notes |
| --- | --- | --- |
| GeoLibre project (`.geolibre.json`) | Project > Open | Layers, styles, groups, and map state; remote sources and local file references still need to be accessible. |
| QGIS project (`.qgs`, `.qgz`) | Project > Import | Imports supported layers and settings; reports skipped sources. Local paths require desktop access. |
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

The initial implementation supports **WCS 1.0.0** KVP `GetCapabilities`,
`DescribeCoverage`, and `GetCoverage`. Services must advertise GeoTIFF output;
unsupported versions and formats produce an error before the coverage download.
WCS 1.1 and 2.x requests are not yet implemented.

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
