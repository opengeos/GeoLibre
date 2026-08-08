# GeoLibre vs. other GIS platforms

How GeoLibre compares to the desktop GIS, cloud GIS, and web-mapping tools people
most often ask about: **QGIS**, **ArcGIS Pro**, **ArcGIS Online**, **CARTO**,
**Felt**, and **kepler.gl**.

GeoLibre is not trying to replace any of these outright. It occupies a spot none
of them quite fills: a **free and open-source GIS that runs in a browser tab with
nothing installed**, keeps your data on your own machine, and still ships real
analysis, spatial SQL, cartography, and a project file — then packages the *same*
app as a desktop install, an Android app, and a Jupyter widget.

!!! note "How to read this"
    Comparisons like this age quickly and are written by an interested party. The
    GeoLibre column reflects [what ships today](features.md); the other columns
    describe each product's mainstream, out-of-the-box behavior as of
    **August 2026**, not what is reachable with every add-on, extension, or
    third-party plugin. Where a capability arrives through a separate product
    (QField for QGIS in the field, ArcGIS Field Maps for ArcGIS), the table says
    so rather than crediting it to the base product. Found something wrong or
    out of date? Please
    [open an issue](https://github.com/opengeos/GeoLibre/issues) — corrections
    are welcome.

## Complementary, not competing

A useful way to think about GeoLibre and QGIS is smartphone cameras versus
professional cameras. Smartphone cameras did not replace professional cameras,
and it would not have made sense to pour every advance in photography into
making professional cameras better. The two serve different people and
different moments. A professional camera offers tremendous power, flexibility,
and control. A smartphone camera prioritizes accessibility, convenience, and
the ability to capture and share something instantly.

QGIS is the professional camera: mature, powerful, feature-rich, and
extensible. GeoLibre is closer to the smartphone camera: lightweight,
reachable from a web browser, cross-platform, and designed so that people can
work with geospatial data without installing complex software or setting up
servers.

![QGIS and GeoLibre as professional and smartphone cameras](https://assets.geolibre.app/images/QGIS-GeoLibre.webp)

The geospatial community benefits from both. Separate projects can also
experiment with new architectures and technologies, and the ideas that work out
can strengthen the broader open-source geospatial ecosystem. The goal of
GeoLibre is not to replace QGIS, but to make GIS accessible in places, and to
people, where a traditional desktop GIS may not be the best fit.

The rest of this page is written in that spirit: the tables are there to help
you pick the right tool for a given job, not to declare a winner.

## At a glance

| | **GeoLibre** | **QGIS** | **ArcGIS Pro** | **ArcGIS Online** | **CARTO** | **Felt** | **kepler.gl** |
|---|---|---|---|---|---|---|---|
| **License** | MIT, open source | GPL-2.0+, open source | Proprietary | Proprietary | Proprietary | Proprietary | MIT, open source |
| **Cost** | Free | Free | Paid subscription | Paid subscription (credit-metered analysis) | Paid subscription | Paid subscription | Free |
| **Browser** | Full app, nothing to install | No official browser build | No | Yes (the product *is* the browser app) | Yes | Yes (the authoring product) | Yes |
| **Desktop** | Windows, macOS, Linux (Tauri) | Windows, macOS, Linux | Windows only | — | — | — | — |
| **Mobile** | Native Android app; responsive touch layout | Via QField / Mergin Maps (separate apps) | — | Via ArcGIS Field Maps (separate app) | — | Felt Field App for iOS and Android (separate app) | Responsive web |
| **In Jupyter** | Full app as an anywidget, two-way sync | Via `qgis` bindings, not the UI | Notebooks drive `arcpy`, not the UI | ArcGIS API for Python | Via `pydeck-carto` | — | Yes (widget) |
| **Works offline** | Yes — PWA install, offline area download, desktop build | Yes | Yes | Limited (Field Maps offline areas) | No — connected platform by design | Field App offline areas, syncing on reconnect (higher plans) | Client-side, but assets are hosted |
| **Where your data lives** | Your device — processed client-side in the browser session | Your device | Your device / your enterprise geodatabase | Vendor cloud | Your own cloud data warehouse — no CARTO-side storage (except cache) or sync; imports write to a warehouse you own | Vendor cloud, or a single-tenant instance in your own AWS account (Enterprise) | Your browser |
| **Project file** | `.geolibre.json` (open, documented) | `.qgs` / `.qgz` (open) | `.aprx` (proprietary) | Web map JSON (hosted) | Map/Workflow JSON via CLI and MCP | Hosted map (no local file) | Exportable map config JSON |

## Data and formats

| | **GeoLibre** | **QGIS** | **ArcGIS Pro** | **ArcGIS Online** | **CARTO** | **Felt** | **kepler.gl** |
|---|---|---|---|---|---|---|---|
| **Format breadth** | Wide — DuckDB-WASM Spatial plus in-house readers | **Widest** — everything GDAL/OGR reads | Very wide, plus native Esri formats | Common upload formats | Common upload formats + RaQuet for raster data | Common upload formats | CSV, GeoJSON, Arrow/Parquet |
| **Cloud-native vector** | GeoParquet, FlatGeobuf, PMTiles, streamed over HTTP range requests | GeoParquet, FlatGeobuf, PMTiles (recent GDAL) | GeoParquet (recent), no native PMTiles | — | GeoParquet | Some cloud sources on higher plans | Arrow/Parquet |
| **Cloud-native raster** | COG, Zarr, Cloud-Optimized NetCDF/HDF, kerchunk, MBTiles | COG, Zarr (GDAL's built-in driver) | COG; Zarr as a native multidimensional raster type | Hosted imagery layers | COG and GeoTIFF, loaded into warehouse tables (RaQuet spec) | GeoTIFF upload | — |
| **STAC** | Built-in catalog browser + STAC Index discovery | Built-in STAC connections (Browser panel and Data Source Manager) | Built-in STAC connections and the Explore STAC pane | Living Atlas (not STAC) | — | — | — |
| **OGC services** | XYZ; WMS/WFS/WMTS discovered via GetCapabilities; OGC API Features/Tiles from a landing page, collection, or items URL | Full OGC support | Full OGC support | Yes | Limited | Limited | XYZ / vector tiles |
| **Esri services and geodatabases** | ArcGIS FeatureServer, VectorTileServer, I3S, plus local `.gdb` File Geodatabase folders (desktop) | Yes | Native | Hosted feature, tile, imagery, and scene layers | One-way ArcGIS Online / Portal migration tooling only | Some ArcGIS layers | — |
| **Databases** | PostGIS browsing, DuckDB, in-browser PGlite/PostGIS | PostGIS, SpatiaLite, Oracle, SQL Server, SAP HANA | Enterprise geodatabases (SDE) | Hosted only | The core product — BigQuery, Snowflake, Redshift, Databricks, PostgreSQL/PostGIS, Oracle Spatial, all queried live | PostGIS / Snowflake connections (higher plans) | — |
| **3D and point clouds** | LiDAR, 3D Tiles, I3S, Gaussian splats, glTF/GLB, Cesium globe pane | Point clouds, 3D map view, tiled scene layers | **Deepest 3D** — scenes, I3S, mesh, LAS | Scene Viewer | 3D map view, extrusion, Google Photorealistic 3D Tiles basemap. No point clouds or LiDAR | — | Extrusions and hexbins only |
| **Planetary basemaps** | Moon, Mars, Mercury, Venus, Galilean moons, Titan, Pluto, Charon — with a per-project ellipsoid driving measurements | Via plugins | Limited | — | — | — | — |

## Analysis and processing

| | **GeoLibre** | **QGIS** | **ArcGIS Pro** | **ArcGIS Online** | **CARTO** | **Felt** | **kepler.gl** |
|---|---|---|---|---|---|---|---|
| **Geoprocessing tools** | **1,000+** (Whitebox suite + GeoLibre's own), running in the browser on WebAssembly | **1,000+** (native, GDAL, GRASS, SAGA) | **Most mature and complete**, plus paid extensions | A useful subset, credit-metered | 200+ Workflows components and 180+ Analytics Toolbox SQL functions, **executed as SQL in your warehouse** | A small set of common tools | No tool catalog — analysis goes through SQL and the AI assistant |
| **Where analysis runs** | Your browser (WASM), no server required; optional Python sidecar on desktop | Your machine | Your machine, or a server/portal | Vendor cloud | **Your cloud data warehouse** — queries are pushed down live, with repeated identical queries served from CARTO-managed cache | Vendor cloud | Your browser |
| **Vector analysis** | Buffer, overlay, dissolve, joins, selection, topology checks — Turf.js, or GeoPandas via Pyodide/sidecar | Comprehensive | Comprehensive | Common tools | Buffer, overlay, spatial join, clip, Voronoi/Delaunay, KNN, trade areas — as warehouse SQL | Common tools | Spatial joins via SQL or the AI assistant |
| **Raster analysis** | Hillshade, slope, contour, zonal/focal stats, raster calculator, reclassify, mosaic — rasterio sidecar with a browser fallback | Comprehensive (GDAL/GRASS/SAGA) | Comprehensive; Spatial Analyst extension | Limited | Narrow — zonal statistics and band value extraction | — | — |
| **Spatial SQL** | DuckDB Spatial, PGlite/PostGIS, and Apache Sedona — **all in the browser** | Virtual layers, DB Manager, PostGIS connections | SQL against enterprise geodatabases | — | **The native interface** — warehouse SQL everywhere: query sources, SQL parameters, Workflows, SQL API | SQL on connected sources (higher plans) | DuckDB SQL Data Explorer over loaded data and remote URLs |
| **Model / batch chaining** | Batch runner with model and pipeline chaining | Graphical Model Designer | ModelBuilder | — | **Workflows** — visual DAG builder with scheduling, version history, and SQL export | — | — |
| **Spatial statistics** | Toolbox including Emerging Hot Spot Analysis | Via plugins and processing providers | Full Spatial Statistics toolbox | Some | Deep — Getis-Ord, Moran's I, space-time hotspots, GWR, kriging/IDW, composite scores, twin areas | — | — |
| **Network analysis** | Isochrones, service areas, OD cost matrices, routing | QGIS Network Analysis, plugins (ORS, pgRouting) | Network Analyst extension | Routing services (credits) | Isolines, routes, and routing matrices via Location Data Services (credit-metered) | — | — |
| **AI / ML** | AI Segmentation (SamGeo/SAM 3), in-browser ONNX/YOLO object detection | Via plugins | `arcgis.learn` deep-learning toolset | Pretrained models (credits) | BigQuery ML and Snowflake ML components; embeddings and geospatial foundation models | — | — |
| **Processing history** | Every run listed, re-runnable, with copyable Python | History panel | Geoprocessing history | — | Workflow version history and run logs; org-wide activity/audit log (Enterprise) | — | — |

## Cartography, styling, and layout

| | **GeoLibre** | **QGIS** | **ArcGIS Pro** | **ArcGIS Online** | **CARTO** | **Felt** | **kepler.gl** |
|---|---|---|---|---|---|---|---|
| **Renderers** | Single, categorized, graduated, rule-based, expression, heatmap, cluster, proportional symbols, diagrams | **Richest** — plus every symbol layer type | Very rich | Smart-mapping styles | Point, line, polygon, grid, H3, raster — plus heatmap and cluster aggregation; quantile/quantize/log/custom scales | Simple, well-designed defaults | Visualization-oriented |
| **Data-defined everything** | Expression Builder wired into filters, labels, styling, field calculation, selection | Yes, pervasive | Attribute-driven symbology (Arcade) | Arcade | Attribute-driven styling per channel; custom **SQL** aggregation expressions in place of an expression language | — | — |
| **Labeling** | Data-defined engine with placement, offset, rotation, wrap, dedup | Best-in-class placement engine | Maplex label engine | Basic | Basic | Basic | Basic |
| **Print layout** | Print Layout composer with legend, scale, title block, atlas / map series, PNG and PDF | Full print composer with atlas | Full layout view with map series | Basic print / export | Export to high-res image and PDF | Export to image and PDF | Image export |
| **Style interchange** | Imports and exports **OGC SLD, QGIS QML, and Mapbox GL JSON** | QML, SLD | `.lyrx`, limited SLD | — | — | — | — |
| **Project import** | Reads **QGIS `.qgs`/`.qgz` and ArcGIS Pro `.aprx`/`.mapx`** | Reads its own | Reads its own (and `.mxd`) | — | — | — | — |
| **Story maps** | Built-in story map builder with presenter view and standalone HTML export | Via plugins | — | ArcGIS StoryMaps (separate product) | Built-in skill for storymaps app development | Shareable maps, not chaptered stories | — |
| **Dashboards** | Dashboard panel of chart and indicator widgets with cross-filtering | Via plugins | — | ArcGIS Dashboards (separate product) | **Core to CARTO Builder** — formula, category, pie, histogram, range, time series, and table widgets with cross-filtering | Dashboard components — statistics, bar, histogram, time series | Charts and filters in-map |

## Automation, extensibility, and sharing

| | **GeoLibre** | **QGIS** | **ArcGIS Pro** | **ArcGIS Online** | **CARTO** | **Felt** | **kepler.gl** |
|---|---|---|---|---|---|---|---|
| **Scripting** | Python Console, `geolibre` Python package, docked Jupyter notebook beside the map | PyQGIS, `qgis_process` headless CLI | `arcpy`, notebooks | ArcGIS API for Python / JavaScript | CARTO + deck.gl + CARTO CLI + REST APIs | REST API + Python client | JS library |
| **Notebook integration** | The **whole app** embeds as a Jupyter anywidget with two-way project sync | Bindings, not the UI | Notebooks in Pro drive `arcpy` | Hosted notebooks | `pydeck-carto` widget in Jupyter or Colab; Analytics Toolbox SQL from any warehouse notebook | — | Widget |
| **Plugin ecosystem** | TypeScript plugin API, built-ins, zip installs, bundled drop-ins | **Largest** — thousands of Python plugins | .NET add-ins, Python toolboxes | Configurable app templates | Workflows extension packages | None (API only) | Fork the library |
| **AI assistant** | Natural-language assistant that turns plain English into auditable, undoable operations; bring your own API key | Via plugins | Copilot features | Arcade assistant (beta) and the AI assistants family | **AI Agents** on a map — semantic model, configurable tools, bring your own LLM — plus a hosted **MCP server**, CLI, and agent skills | AI-assisted map making | Yes — OpenAI, Gemini, DeepSeek, or local Ollama; bring your own key |
| **Real-time collaboration** | Yes (MVP) — hosted relay, optionally self-hosted — plus anchored review comments | No (Mergin Maps for sync) | No | Shared editing of hosted layers | Asynchronous plus real-time map-anchored comments | **Best-in-class** multiplayer editing and comments | — |
| **Embedding** | `maponly` and `layout=viewer` URL modes, a versioned `postMessage` API, and the typed `@geolibre/embed` npm client | QGIS Server / QGIS2Web export | — | Embeddable web apps | Embeddable private maps with URL parameters and a `postMessage` API | Embeddable maps | Embeddable |
| **Self-hosting** | Docker image, or serve the static build anywhere | QGIS Server | ArcGIS Enterprise (paid) | — | Yes — Docker on a single VM or Kubernetes, on any vendor cloud or on-premises | Single-tenant AWS VPC, Felt-maintained (Enterprise) | Static build |
| **Standalone export** | Whole project to **one offline HTML file**, no server | Via qgis2web plugin | — | — | Data export to CSV, GeoJSON, GeoPackage, GeoParquet, KML, and Shapefile | — | HTML export |

## Where each one is the right choice

**Choose GeoLibre when** you want a real GIS in a browser tab with nothing to
install, your data has to stay on your machine, you work with cloud-native
formats (COG, GeoParquet, PMTiles, Zarr, STAC), you want the same app on desktop,
Android, and inside a notebook, or you are embedding a map workspace into your
own product and want an open, documented project format and license.

**Choose QGIS when** you need the widest possible format support through
GDAL/OGR, the deepest desktop cartography and label placement, a mature plugin
for a niche task, or heavy local processing over datasets larger than a browser
can hold.

**Choose ArcGIS Pro when** you are already in the Esri ecosystem, need
enterprise geodatabase editing and versioning, the deepest 3D and imagery
workflows, or a specific specialized toolbox with organizational support behind
it.

**Choose ArcGIS Online when** the priority is hosted layers, organizational
sharing and permissions, and the surrounding Esri app family (Dashboards,
StoryMaps, Field Maps, Experience Builder).

**Choose CARTO when** your data already lives in a cloud data warehouse and you
need it to stay there. It suits teams that want AI Agents, visual analytics
pipelines, dashboards and/or custom apps for large-scale data that non-analysts
can use.

**Choose Felt when** collaborative, low-friction map *making* with a team is the
whole job, and polished multiplayer editing and field data collection matter more
than analysis depth. Enterprise plans can run a single-tenant instance in your own
AWS account if data residency is the blocker.

**Choose kepler.gl when** you want fast, beautiful exploratory visualization of
large point and trip datasets, and DuckDB SQL plus its AI assistant cover the
analysis you need — rather than a geoprocessing toolbox, cartographic output, or
a portable project file.

They also compose. GeoLibre reads QGIS and ArcGIS Pro projects and exchanges
symbology as SLD, QML, and Mapbox GL JSON, so it is reasonable to author in
QGIS or Pro and publish or embed with GeoLibre.

## Where GeoLibre is not the strongest option

Stated plainly, so the table above is worth trusting:

- **Very large local datasets.** Browser memory and WASM are real limits.
  Client-side vector tiling and streaming push the ceiling up, but a
  multi-gigabyte local processing job still belongs on a desktop GIS. The
  desktop build's Python sidecar helps; QGIS or ArcGIS Pro helps more.
- **Format breadth.** GDAL/OGR reads more than DuckDB-WASM Spatial does. Some
  formats — notably File Geodatabase — only work in the desktop build.
- **Depth of specialized toolboxes.** ArcGIS Pro's Spatial Analyst, Geostatistical
  Analyst, and Network Analyst, and QGIS's twenty years of plugins, cover
  workflows GeoLibre has no equivalent for.
- **Enterprise data management.** Versioned editing, replication, and enterprise
  geodatabase administration are outside GeoLibre's scope.
- **Maturity.** GeoLibre is stable and in active development, but it is far
  younger than QGIS or ArcGIS. Some capabilities listed as shipping are recent —
  see [Recently added](index.md#recently-added).

## See also

- [Features](features.md) — the complete, current inventory of what GeoLibre does
- [Roadmap](roadmap.md) — release history and what is planned next
- [Getting Started](getting-started.md) — install the app or open GeoLibre Web
- [Importing a QGIS project](user-guide/projects.md#importing-a-qgis-project) and
  [an ArcGIS Pro project](user-guide/projects.md#importing-an-arcgis-pro-project)
