# GeoLibre Supported GIS Data Formats — Complete Reference

> **Abstract**: This article provides a comprehensive inventory of all GIS data formats natively supported by GeoLibre, covering vector, raster, and cloud-native geospatial formats, along with the internal parsing logic for each format. It serves as a complete technical reference for WebGIS developers.
>
> **Original source**: "GIS开发手记", original link: <https://mp.weixin.qq.com/s/GrtQzetCBgKtYruEhjsOAw>

## Preface

This article systematically catalogs every geospatial data format built into GeoLibre, distinguishing between vector, raster, and cloud-native geospatial formats, while documenting each format's corresponding parsing dependency, read priority, and applicable scenarios — a ready reference for WebGIS developers.

## 1. Runtime Configurations & Platform Overview

Before listing formats, it's important to clarify "where it runs," since many formats have platform-specific differences.

| Runtime | How | Notes |
|---|---|---|
| Browser | Open `web.geolibre.app` | No installation needed; works offline after initial load |
| Desktop | Tauri v2 native application | Windows / macOS / Linux; available via Microsoft Store, Homebrew, winget, AUR, Flatpak |
| Android | Google Play native app | ~40 MB per ABI |
| iOS | App Store native app | iPhone and iPad, same codebase via Tauri v2 mobile |
| Jupyter | `pip install geolibre` | The entire application embedded in a notebook cell |

> **No accounts, no servers, no fees for the core application.** Local files are read in place and stay on your machine, and once the app has loaded, local workflows keep working offline. The optional remote pieces are the exception: online catalogs (STAC, Source Cooperative, Overture, Planetary Computer), basemap and tile downloads from a CDN, and services such as Earth Engine or an authenticated ArcGIS endpoint all need network access, and some need their own credentials or OAuth sign-in.

---

## 2. Vector Data Format Support

Vector data is GeoLibre's most mature capability. The file picker has a built-in unified format allowlist, supports drag-and-drop auto-detection (no manual format selection needed), and covers 17 mainstream vector extensions.

```text
geojson, json, gpkg, geoparquet, parquet, fgb, flatgeobuf,
csv, tsv, kml, kmz, gml, gpx, dxf, tab, shp, zip
```

**Just drag and drop — no need to first select "which format to import."**

What's truly interesting is **which engine reads each format behind the scenes** — this determines actual performance:

| Format | Extension | Read Engine | Notable Details |
|---|---|---|---|
| **GeoJSON** | `.geojson` `.json` | Native `JSON.parse` | Files with legacy top-level `crs` members are automatically reprojected to WGS84 via DuckDB |
| **GeoParquet / Parquet** | `.parquet` `.geoparquet` | DuckDB `read_parquet` | Remote files use HTTP Range streaming reads; no full download needed |
| **FlatGeobuf** | `.fgb` `.flatgeobuf` | DuckDB `ST_Read` | — |
| **GeoPackage** | `.gpkg` | **sql.js (SQLite WASM), not GDAL** | Multi-layer files prompt a layer selector; auto-repairs `gpkg_ogr_contents` |
| **Shapefile (individual files)** | `.shp` | shpjs | Desktop auto-reads companion `.dbf/.shx/.prj/.cpg`; 3D MultiPatch falls back to DuckDB |
| **Shapefile (zip archive)** | `.zip` | fflate decompress → shpjs | `.prj` determines projection, `.cpg` determines DBF encoding (**Chinese attribute encoding issues resolved**); auto-skips macOS `__MACOSX` |
| **KML** | `.kml` | Custom parser | **Preserves embedded styling**; also extracts GroundOverlay images and `<Model>` 3D models |
| **KMZ** | `.kmz` | fflate decompress | Custom icons and formatted descriptions are preserved |
| **GML** | `.gml` | DuckDB `ST_Read` | — |
| **GPX** | `.gpx` | Pure JS | **Auto-splits into three layers**: waypoints / tracks / routes |
| **CSV / TSV** | `.csv` `.tsv` `.txt` `.dat` | Custom + DuckDB fallback | Auto-detects delimiter and lat/lon columns; WKT geometry columns go through DuckDB; dialog allows specifying source CRS |
| **CAD (DXF/DWG)** | `.dxf` `.dwg` | DuckDB `ST_Read` | Presents a layer list for selection; **CAD files lack coordinate systems — EPSG must be selected manually** |
| **MapInfo TAB** | `.tab` | `ST_Read` | — |
| **Esri File Geodatabase** | `.gdb` **folder** | Python sidecar | Desktop-only, requires sidecar; hidden in Mac App Store builds |
| **OSM PBF** | `.osm.pbf` `.pbf` | osmix, runs in Web Worker | Auto-splits into point/line/polygon layers; prompts confirmation above 50 MB; 5-minute timeout protection |
| **GeoRSS** | `.xml` `.rss` `.atom` | Pure JS | Supports RSS 2.0 / Atom / RDF, GeoRSS Simple + GML geometries |
| **Geotagged photos** | `.jpg` `.jpeg` `.png` `.tif` `.tiff` `.webp` `.heic` `.heif` | exifr | **Reads EXIF GPS data to directly generate a point layer** — very practical for UAV/drone photos |

_Explicitly unsupported: `.xlsx` / `.xls` (zero hits in a full-repo search), raw `.osm` XML (PBF only). If you need Excel data, save as CSV first._

!!! tip "KML `<Model>` 3D Models"
    The KML `<Model>` handling is worth noting: it loads embedded COLLADA `.dae` files with three.js, then exports them as GLB into the map. The project pulled in three.js just for this one edge case.

After loading, it's not just "can you see it" — symbology, graduated coloring, and legends all come along:

![A project with three vector layers stacked — subway stations, subway lines, and Manhattan building heights — with a legend auto-graduated by construction year](https://assets.geolibre.app/images/vector-layers-legend.webp)

![The same data on a timeline: buildings filtered year-by-year by construction date; vector layers carry a temporal dimension](https://assets.geolibre.app/demos/vector-data-demo.gif)

---

## 3. Raster & Imagery

The raster side is narrower than vector but covers the cloud-native mainline.

| Format | Extension | Engine | Platform |
|---|---|---|---|
| **GeoTIFF / COG** | `.tif` `.tiff` | Default `cog-tiler-wasm`; switchable to GPU engine | All platforms; desktop local files use Tauri asset protocol for Range reads |
| **MosaicJSON / STAC item** | `.json` | On-demand stitching at read time | All platforms |
| **Georeferenced images** | Any browser-decodable image + GCP `.csv`/`.txt` | Least-squares affine; export via gdal3.js | All platforms (gdal3.js loaded from CDN) |
| **KML GroundOverlay** | From `.kml` / `.kmz` | Four-corner coordinate image layer | Those with `<TimeSpan>` also support timeline animation |
| **Georeferenced video** | `.mp4` + `.webm` | MapLibre video source | URL only |
| **Conversion tool inputs (raster)** | `.tif .tiff .img .vrt .asc .nc .jp2 .hgt` | GDAL / rasterio sidecar | Desktop; browser only accepts `.tif/.tiff` |
| **Whitebox raster I/O** | `.tif .tiff .img .bil .flt .sdat .rdc .asc` | whitebox-wasm | All platforms |

![Google imagery basemap with raster style panel](https://assets.geolibre.app/images/raster-style-panel.webp)

_Note the asymmetry: `.img`, `.vrt`, `.asc`, `.jp2`, `.hgt` are only recognized in **conversion tools** — they cannot be directly dragged in as layers. Drag-and-drop only works for GeoTIFF._

---

## 4. Point Clouds & LiDAR

| Item | Support | Notes |
|---|---|---|
| **LiDAR layer** | COPC / LAZ (via URL) | Rendered through `maplibre-gl-lidar` + deck.gl |
| **USGS 3DEP** | Online point cloud streaming | Standalone plugin; comes with a 3DEP elevation index WMS overlay |
| **Whitebox LiDAR tools** | `.las .laz .zlidar .copc .e57 .ply`, output `.laz` | The only place in the entire repo where `.e57` / `.ply` appear |

_The LiDAR layer panel's extension allowlist is **not in this repository** — it's defined in upstream npm packages. The only direct evidence in the repo is a single `.copc.laz` example URL. LAS/LAZ/COPC/EPT are very likely supported but cannot be confirmed 100% from the source._

---

## 5. 3D Models, Tiles & Gaussian Splats

The opening scenario — "received some 3D Tiles, just want to take a quick look" — this section is the answer.

| Format | Input Method | Engine | Notes |
|---|---|---|---|
| **OGC 3D Tiles** | tileset URL | `maplibre-gl-3d-tiles` + deck.gl `Tile3DLayer` | **Supports custom request headers** — authenticated tilesets work |
| **Google Photorealistic 3D Tiles** | Built-in URL | Same as above | Requires Google Maps API key; passed via request headers, never stored to disk |
| **ArcGIS I3S Scene Layer** | `…/SceneServer` URL | deck.gl + loaders.gl `I3SLoader` | Both integrated mesh and 3D object layers are supported |
| **glTF / GLB** | **URL only** | deck.gl `ScenegraphLayer` | No local file picker — this is the most visible gap currently |
| **COLLADA `.dae`** | Only via KML `<Model>` embedding | three.js → GLB | — |
| **Gaussian Splats** | URL | `maplibre-gl-splat` | Storage layer type is `gaussian-splat` |

![3D Tiles loading panel: 3D-TILES, vectors, XYZ, glTF models, and Gaussian splats intermixed in the layer list on the left](https://assets.geolibre.app/images/3dtiles.webp)

This screenshot is quite telling: **in the layer panel on the left, 3D Tiles, vectors, XYZ, glTF models, and Gaussian splats are all stacked in the same list** — and the rendering result is right there on the right. "Loading 3D Tiles requires setting up a server and writing a page" becomes **paste a URL** here.

_What's absent: `.obj` is completely unsupported (zero hits). `.b3dm`/`.pnts`/`.cmpt` — these 3D Tiles internal formats also have zero hits in the repo; they're transparently handled by upstream loaders, so you don't need to worry about them. The Gaussian splat extension list is likewise in upstream packages._

---

## 6. Tiles & OGC Services

The storage layer type enum has 20 entries:

```text
geojson, raster, wms, wmts, xyz, vector-tiles, arcgis, pmtiles,
mbtiles, zarr, lidar, gaussian-splat, 3d-tiles, cog, flatgeobuf,
geoparquet, duckdb-query, deckgl-viz, video, image
```

What you can fill in under "Add Data → Web Services":

| Service | Details |
|---|---|
| **XYZ** | `{z}/{x}/{y}` template; raster or vector tiles both work |
| **WMS** | **GetCapabilities auto-populates the layer dropdown**; click features for GetFeatureInfo; dev mode includes a CORS proxy |
| **WMTS** | RESTful tile template |
| **WFS** | GetCapabilities fetches typeName; optional auto-refresh |
| **OGC API - Features** | Landing page / `/collections` / single collection / full `/items` URL are all recognized; auto-follows `next` links; defaults to 1,000 features |
| **OGC API - Tiles (Vector)** | TileJSON or MVT template; can optionally provide a Mapbox style URL to resolve `source-layer` names |
| **ArcGIS** | Only **two** in the dialog: FeatureServer (fetched as `f=geojson`) and VectorTileServer |
| **ArcGIS MapServer / ImageServer** | Not in the Add Data dialog; only accessible indirectly via plugins like NASA Earthdata GIS or EnviroAtlas |
| **MBTiles** | `.mbtiles` local file, custom protocol + Rust backend reads. **Desktop-only** |
| **PMTiles** | `.pmtiles`; vector or raster both work; auto-sniffs file header |
| **PostgreSQL / PostGIS** | Connect → select table → outputs MVT via built-in Martin service. **Desktop-only** |
| **deck.gl visualization layers** | 14 types: scatterplot, heatmap, hexagon, grid, screen grid, contour, arc, line, great circle, GeoJSON, icon, text, trips, scenegraph |

![OpenFreeMap 3D basemap with drawing tools](https://assets.geolibre.app/images/drawing-tools.webp)

---

## 7. Cloud-Native Formats & Data Catalogs

This section is where GeoLibre pulls ahead of traditional desktop GIS.

**Scientific data formats:**

| Format | Support Scope |
|---|---|
| **Zarr** | Remote store URL, or local folder. Variable and dimension selectors display real coordinate values. _Local folders in browser require File System Access API — unavailable in Firefox / Safari_ |
| **NetCDF / HDF** | Two paths: remote via **kerchunk reference JSON + HTTP Range** (cloud-optimized NetCDF); local supports `.nc .nc4 .cdf .h5 .hdf5` (NetCDF-3 via netcdfjs, NetCDF-4/HDF5 via h5wasm). **HDF4 `.hdf` is explicitly unsupported** |
| **COG** | See raster section |

**Online data catalogs (browsable directly):**

- **STAC** — Both static catalogs and STAC API supported; discover catalogs via STAC Index. Only visualizable assets (GeoTIFF / GeoJSON) can be directly added
- **Source Cooperative** — Bucket browser; recognizes `.pmtiles` `.parquet` `.geoparquet` `.tif` `.geojson` `.geojsonl` `.ndjson` `.fgb` `.gpkg` `.csv`
- **Natural Earth** — Essentially the Source Coop panel locked to `opengeos/natural-earth`
- **Hugging Face Hub** — Browse dataset repositories; can even create repos and upload
- **Overture Maps** — Thematic vector tiles; defaults to showing buildings only
- **Microsoft Planetary Computer** — STAC + TiTiler
- **Google Earth Engine** — OAuth login; desktop has native OAuth flow
- **NASA Earthdata GIS** — EOSDIS ImageServer / MapServer / FeatureServer / published web maps
- **OpenAerialMap** / **Esri Wayback** (historical imagery) / **Mapillary** / **Google Street View**
- **Federal data services** — FEMA flood maps, EPA EnviroAtlas, USGS National Map
- **Weather & time-lapse** — RainViewer real-time radar, NASA GIBS, EOX cloudless annual basemap

**Planetary data** (this exceeds expectations): **the Moon and Mars come from OpenPlanetaryMap; Mercury, Venus, Galilean moons, Titan, Pluto, and Charon come from USGS Astrogeology**. The key detail is **per-project ellipsoid parameters**, so distance and area measurements are accurate for the celestial body you're measuring on.

![Moon: basemap from OpenPlanetaryMap, scale bar at 300 km](https://assets.geolibre.app/images/moon-map.webp)

![Mars: same interface, different project — a different planet](https://assets.geolibre.app/images/mars.webp)

![Pluto: from USGS Astrogeology; the heart-shaped Sputnik Planitia is clearly visible](https://assets.geolibre.app/images/pluto.webp)

> **Editor's note**: Initially this seemed like a surface-level feature. The per-project ellipsoid parameters changed that impression — the project treats coordinate systems seriously, not as a mere basemap overlay.

---

## 8. Project & Style Interoperability

This is easy to overlook but determines whether GeoLibre can fit into your existing workflow.

| Format | Extension | Direction |
|---|---|---|
| GeoLibre project | `.geolibre` / `.geolibre.json` | Read + write |
| **QGIS project** | `.qgz` `.qgs` | **Import only**. Parses XML with DOMParser; no QGIS code is executed; only imports the 17 recognized vector formats and GeoTIFF |
| **Mapbox GL / MapLibre style** | `.json` | Import + export |
| **OGC SLD** | `.sld` `.xml` | Import + export |
| **QGIS QML** | `.qml` | Import + export |

> **Key insight**: Symbology configured in QGIS can be brought over, and vice versa. Style import format is **determined by content, not by extension** — a file with the wrong extension will still be recognized.

Additionally, there are numerous `.json`-based libraries: style libraries, layer libraries ("My Data"), service libraries, legends, camera fly-throughs, story maps — all importable and exportable.

---

## 9. Export & Format Conversion: Essentially a Free GDAL Frontend

The official site underplays this, but it's one of the most practical capabilities.

### Direct Layer Export

Right-click a layer to export — **all done in the browser, no backend needed**:

`.geojson` · `.csv` · `.kml` · `.kmz` · `.parquet` (GeoParquet) · `.gpkg` (GeoPackage) · `.zip` (Shapefile)

**GeoPackage and Shapefile writing are pure JS implementations** — because DuckDB-WASM cannot write GeoPackage, the author hand-wrote a GeoPackage 1.3 writer using sql.js; for Shapefile, five files (`.shp/.shx/.dbf/.prj/.cpg`) are manually assembled and then zipped.

### Format Conversion Tools (9)

| Tool | Input | Output |
|---|---|---|
| Vector → Vector | `geojson geojsonl json parquet geoparquet fgb gpkg shp zip kml gml gpx` | Desktop: 14 drivers — GeoJSON, GeoJSONSeq, FlatGeobuf, GPKG, Shapefile, GML, KML, CSV, SQLite, GMT, DXF, MapInfo, JML, GPX |
| Vector → GeoParquet | Same as above | `.parquet`; compression: `zstd / snappy / gzip / lz4 / uncompressed` |
| Vector → FlatGeobuf | Same as above | `.fgb` |
| Vector → Shapefile | Same as above | `.zip` |
| Vector → GeoPackage | Same as above | `.gpkg` |
| CSV → GeoParquet | `csv tsv txt` | `.parquet` |
| **Vector → PMTiles** | `parquet geoparquet geojson json gpkg fgb shp` | `.pmtiles`. **Desktop up to zoom level 24**; browser uses WASM tiler with shallower levels |
| **Raster → PMTiles** | Only accepts `.tif/.tiff` | `.pmtiles` (single-band through color ramp, not true color) |
| **Raster → COG** | Desktop `tif tiff img vrt asc nc jp2 hgt`; browser tif only | `.tif`; compression: `deflate zstd lzw webp jpeg packbits raw` |

_Browser-side output format is a subset: geojson / json / csv / parquet / geoparquet / gpkg / zip / fgb. For the full 14-driver set, use the desktop version (via Python sidecar)._

### Other Exports

Export raster layers as GeoTIFF, clip raster subsets by bounding box, extract basemaps as PMTiles offline packages, print layout to PNG/PDF/multi-page ZIP, **export entire project as a standalone HTML file**, story maps to HTML/PDF, map screen recording to WebM, charts to SVG/PNG.

!!! tip "Export Project as Standalone HTML"
    This feature is severely underrated — sharing a single-file webpage with a collaborator to view results is far more practical than asking them to install specialized software.

---

## 10. Platform Differences: Points of Caution

Mentioned piecemeal above, consolidated here. **This is where things most easily go wrong.**

| Limitation | Impact |
|---|---|
| **Desktop (Tauri) exclusive** | Native file/folder dialogs, local MBTiles, local raster reads, Shapefile companion file auto-discovery, PostGIS/Martin, file geodatabase, local file watch reload |
| **Requires Python sidecar** | File geodatabase, all desktop conversion tools (preferred path), raster tools (rasterio), AI segmentation, PostGIS, Sedona |
| **Mac App Store build** | No Python sidecar: hides PostgreSQL and GDB data sources, hides AI segmentation; Whitebox, conversion, raster, and vector tools all fall back to their browser/WASM engines; Shapefile companion files must be manually multi-selected |
| **Android / iOS (mobile)** | Hides raster tools, conversion tools, AI segmentation, PostgreSQL — all sidecar-backed. The Whitebox toolbox is WASM-backed and stays available |
| **Browser** | No local MBTiles/GDB/PostGIS; conversion output is subset; vector conversion doesn't accept `.zip`; raster-to-COG only accepts GeoTIFF; Zarr local folders unavailable in Firefox/Safari |

---

## 11. Architecture: How It Manages to Support So Many Formats

After listing over a hundred formats, the natural reaction is "how complex must this be." Here's a brief explanation of how it holds together.

**The core is an engine-agnostic store.** The `@geolibre/core` package depends on neither MapLibre, nor Cesium, nor deck.gl — it stores only two things: a set of flat layer records (id, type, source, style, visibility…) and a five-field `MapViewState` (center / zoom / bearing / pitch / bbox).

**All UI operations modify only the store; a sync layer pushes changes to the rendering engine. Strictly one-way.** Dragging an opacity slider in the UI modifies the store, not a MapLibre object.

The dividend of this design: **adding a format is cheap**. As long as a new format can be represented as a layer record, it automatically gains the full capabilities of the layer panel — opacity, ordering, project save, style export.

**Division of labor among three renderers** (note: there is no "engine abstraction layer"):

- **MapLibre** is the default primary map; the vast majority of layers are rendered by it
- **deck.gl** does not occupy a separate view — it is an overlay **interleaved within the MapLibre canvas**, responsible for COG, 3D Tiles, I3S, Z-enabled vectors, and visualization layers. There's a hard constraint: all interleaving producers must share the **same** overlay instance, or later ones will wipe out earlier layers (the author encountered this firsthand)
- **Cesium** is a view mode within split-screen, not a replacement. It only supports GeoJSON, 3D Tiles, and imagery layers; other types are labeled "2D only" in the panel

![Cesium view mode showing the 3D globe; the same layer panel is on the left](https://assets.geolibre.app/images/earth-cesium-globe.webp)

A noteworthy detail: **Cesium's camera sync is not aligned by zoom level, but by ground resolution (meters/pixel)**, so split-screen panels at different heights maintain the same on-screen scale.

**Five compute engines**, all under the same UI: DuckDB-WASM Spatial (the workhorse, running in a dedicated Worker), PGlite + PostGIS, Apache Sedona (sidecar or browser WASM version), Pyodide (running GeoPandas/Shapely in the browser), Whitebox WASM (700+ tools).

!["Processing" menu expanded: Whitebox, Conversion, Hydrology, LiDAR, Network, Projection, Raster, Remote Sensing, Terrain, Vector — with an alphabetical tool list on the right](https://assets.geolibre.app/images/processing-tools-menu.webp)

**A clever approach: the Python implementation of vector operators is a "framework-free" module; the sidecar and the browser Pyodide execute the exact same code**, so results from both paths are completely consistent — no "local computation doesn't match server computation" discrepancies.

---

## 12. Performance: Some Real Numbers

A quick overview, all verifiable numbers from the source — not estimates.

**How large vectors are handled.** **Above 50,000 features, it stops using MapLibre's native GeoJSON source and instead tiles on-the-fly client-side** — geojson-vt generates tiles (point layers use Supercluster for aggregation), vt-pbf encodes to MVT, then feeds MapLibre through a custom protocol. Max zoom 16, 4096 extent.

Two details that show engineering care: tile index objects are **deliberately excluded from the store** (too large, non-serializable, can't be written into a project file); encoding checks an abort signal before proceeding, since MapLibre cancels tile requests that scroll off-screen.

**Other guard thresholds** (these numbers are themselves good reference points):

| Threshold | Value |
|---|---|
| Tiling render trigger | 50,000 features |
| DuckDB result materialization confirmation prompt | 500,000 rows |
| Browser-side Sedona cap | 50,000 features |
| OSM PBF warning / timeout | 50 MB / 5 minutes |
| Remote vector file cap | 2 GiB (DuckDB-WASM uses 32-bit for remote file sizes) |
| Local COG cap | 2 GiB |
| Undo history soft budget | 500,000 features |

**Attribute table is virtualized**, but sorting, filtering, and selection operate on the full data model — virtualization only governs rendering.

**Undo history has a memory cap.** Because every snapshot holds the full GeoJSON of layers, repeated editing pins multiple copies in memory. The approach: set a feature-count soft budget; when exceeded, discard the oldest snapshots, but **always retain the newest one**, guaranteeing at least one undo step even after a large edit. Slider drags are coalesced into a single undo record within 400 ms.

**Bundle size is controlled through CDN offloading.** Three heavyweight WASM engines (PGlite+PostGIS ~25 MB, CereusDB ~40 MB, gdal3.js ~28 MB + 12 MB) are not bundled. They're fetched from CDN at runtime by exact version; after first use, Service Worker caches them for offline availability. Two historical notes in source comments: **bundling PGlite would inflate the binary from 42 MB to 63 MB; CereusDB would increase the installer from 27 MB to 36 MB** — that's how the 30 MB installer figure is achieved.

**One honest performance issue.** The documentation has an entire section on Linux/WebKitGTK investigation: empty map steady at 60 FPS at any zoom, but with any tile layer present, **FPS drops to single digits during tile loading**, immediately returning to 60 once loading stops. Root cause: WebKitGTK performs GPU uploads for each new tile on the main thread (textures for raster, vertex buffers for vectors), **with a single tile integration cycle measuring ~125 ms versus Chromium's few ms**. The author ruled out software rendering, GPU saturation, Tauri IPC, JSON.parse, compositor latency, and numerous other possibilities. Mitigations (increase tile cache, 512px raster tiles, disable fade-in) are documented but **not yet implemented**. macOS/Windows WebViews have not been tested.

> **Editor's note**: Projects that willingly document negative findings like this in their architecture docs are rare. This practice deserves recognition.

---

## 13. Its Boundaries

Having covered the strengths, let's discuss the limitations.

!!! warning "It Is Not a QGIS Replacement"
    This is the consensus across multiple reviews, and the author has never claimed otherwise.

**1. The feature scope is deliberately narrow.** It focuses on browser workflows, local processing, cloud-native formats, spatial SQL, modern visualization, and portability. Complex professional workflows still belong in QGIS.

**2. The iteration speed is a double-edged sword.** From 0 to 2.4.0 in just over two months; 2.0.0 to 2.1.0 was separated by roughly 19 hours. If you're considering it as a long-term production dependency, factor in this churn risk.

**3. Several clear format gaps.** glTF/GLB has no local file picker (URL only), `.obj` is completely unsupported, Excel is unsupported, HDF4 is unsupported, raw `.osm` XML is unsupported.

**4. Platform capability asymmetry.** See the table in Section 10. Don't extrapolate the browser version's experience to represent the whole.

**5. Cesium 3D Globe requires an Ion token.** The free tier is sufficient for individual use; teams need to budget accordingly.

**6. The China-specific environment.** Default sources for basemaps, terrain, and Photorealistic 3D Tiles are all outside the firewall; coordinates use standard WGS84 — **GCJ-02 offsets must be handled separately**. These two issues need to be addressed first for serious use. Reliable first-hand data on this is unavailable; further input from actual users is welcome.

---

## In Closing

You receive a zip archive containing a mix of shp, tif, gpkg, and tileset.json — previously requiring three or four different applications. The answer now: **open a 30 MB application (or just a webpage), and drag everything in.**

GeoLibre's real value is not that it's better than QGIS (it isn't) — it's that it drives **the cost of "just take a quick look at the data" down to near zero**. This niche was previously empty.

For those working with Cesium / 3D GIS development, there's an additional layer of reference value: **the engine-agnostic store design**. Storing state as plain layer records and view state, rather than tied to a specific rendering engine's objects, allows a second renderer to slide in smoothly. This approach is worth adopting.

Usage paths by scenario:

1. **Just want to take a look** — Open `web.geolibre.app` directly; no installation, no registration
2. **Need to get real work done** — Download the desktop version from GitHub Releases, or via Microsoft Store / Homebrew / winget; a two-minute process
3. **Python users** — `pip install geolibre`; for GeoPandas support, `pip install "geolibre[all]"`; requires Python 3.10+
4. **Intranet / offline environments** — `VITE_PYODIDE_INDEX_URL` and `VITE_DUCKDB_SPATIAL_EXTENSION_PATH` can point Pyodide and the DuckDB spatial extension to internal mirrors, **no rebuild required**; an official Docker image is also available at `ghcr.io/opengeos/geolibre:latest`
5. **Secondary development** — npm workspaces monorepo, so use **npm** (the repo tracks `package-lock.json`) on **Node 22+**; main application in `apps/geolibre-desktop`; MIT licensed

Final takeaway: for data preview and exploration, highly recommended; for production deployment, wait a bit longer — at least until the version iteration cadence stabilizes.
