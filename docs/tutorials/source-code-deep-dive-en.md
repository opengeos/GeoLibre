# GeoLibre Source Code Deep Dive: Core Techniques Worth Reusing in WebGIS Projects

> **Abstract**: This article provides an in-depth analysis of the GeoLibre source code architecture, covering dependency selection, the DuckDB-WASM Spatial core engine, web-side performance optimization, state management, offline PWA caching, and cloud-native geospatial data solutions. All source file paths are annotated for developer reference and reuse.
>
> **Original source**: "GIS开发手记", original link: <https://mp.weixin.qq.com/s/482yiH-VsKP7OmBw9UWG6g>

## Preface

This article walks through the GeoLibre repository source code layer by layer, covering dependency selection, the DuckDB-WASM spatial computation kernel, frontend performance optimization strategies, state management design, the three-tier offline caching strategy, and the cloud-native geospatial data solution. All corresponding source file paths are annotated. Every technical approach described can be directly applied to your own WebGIS projects.

## 1. The Toolbox: Open-Source Libraries Worth Examining Individually

The repository is an npm workspaces monorepo with 7 packages plus a desktop application. Dependencies are categorized by purpose below; the ones marked for attention are libraries worth focused study.

### 1.1 Format Parsing: Lightweight First, Heavy Artillery as Fallback

| Library | Version | Role | Why This One |
|---|---|---|---|
| **`@duckdb/duckdb-wasm`** | 1.33.1 | GeoParquet, FlatGeobuf, GML, DXF, TAB, and spatial SQL | A single library serving as both **format driver** and **compute engine** |
| **`shpjs`** | 6.2 | Shapefile | Pure JS, tens of KB; `.prj` for projection, `.cpg` for encoding (**Chinese attribute encoding issues resolved**) |
| **`fflate`** | 0.8 | zip / kmz / aprx decompression | Extremely small and fast |
| **`sql.js`** | 1.14 | GeoPackage read **and write** | **GPKG is essentially SQLite** — lightweight and efficient |
| **`exifr`** | 7.1 | Photo EXIF GPS → point layer | Practical for UAV/drone scenarios |
| **`gdal3.js`** | 2.8 | Only used for georeferenced GeoTIFF/COG export | WASM ~28MB + data ~12MB, loaded from CDN only, never bundled |
| **`geotiff`** | 3.0 | GeoTIFF decoding | — |
| **`h5wasm` / `netcdfjs`** | — | HDF5 / NetCDF-3 | Clear division of labor, each handles one format |
| **`@osmix/pbf` `@osmix/core`** | — | OSM PBF | Runs in a Web Worker |
| **`pmtiles`** `proj4` `fast-xml-parser` | — | Tile archives / projections / XML | Foundational utilities |

**The key takeaway here is "choose the lightest path for each format."** The source file `packages/plugins/package.json` has over 60 dependencies, yet there is no monolithic "unified read layer" — each format takes its own shortest path.

![Supported formats](https://assets.geolibre.app/images/add-data-formats.webp)

The KML case is particularly illustrative. `docs/architecture.md:61` states it clearly: KML is handled by a **custom-built parser** to **preserve embedded styling**, outputting simplestyle-spec properties (`fill`, `stroke`, `stroke-width`) so that styled KML looks the same in GeoLibre as it does in Google Earth. Only when the custom parser fails does it fall back to DuckDB Spatial, **at the cost of losing style information**.

> **Key insight**: General-purpose libraries inevitably discard format-specific information when unifying data models. And that information is often exactly what users care about most.

The same pattern repeats for Shapefile: **try shpjs first, only fall back to DuckDB Spatial if that fails**. **A fast path plus a slow-but-comprehensive fallback is a universal pattern for format parsing.**

### 1.2 Spatial Computation: Four Engine Tiers, Defaulting to the Lightest

This area is easy to misunderstand. Tracing through the source (per `docs/architecture.md:75-79`):

| Engine | Where It Runs | Positioning |
|---|---|---|
| **Turf.js** (`@turf/*`, ~20 sub-packages) | Browser, pure JS | **Default engine for vector tools**, zero dependencies, zero backend |
| **GeoPandas / Shapely** | Python sidecar | Upgrade path when **projection-aware** results are needed |
| **GeoPandas / Shapely** | Browser via Pyodide | **Same codebase**, usable in the web version |
| **DuckDB / PGlite+PostGIS / SedonaDB** | Browser or sidecar | Three engines for the SQL Workspace |

Note that Turf is imported **per sub-package** (`@turf/buffer`, `@turf/intersect`, etc.), not as a whole. This is important — importing all of Turf at once is substantial; per-package imports are what make it practical.

The "one codebase, two runtimes" design is documented at `docs/architecture.md:77`: the geometry logic lives in a **framework-free module** `backend/geolibre_server/geolibre_server/vector_ops.py`. A Vite plugin (`vite-plugins/copy-vector-ops.ts`) copies it into the frontend package, and the browser side uses a classic Web Worker to load Pyodide, install `geopandas`, and call `run_vector_tool` across a JSON string boundary.

> **Real-world lesson**: Anyone who has worked with GIS knows this pitfall — compute a buffer with Turf.js on the frontend, compute the same buffer with PostGIS on the backend, and the areas differ by 0.3%. Two days later you discover it's because the default segment count differs between the two implementations.

### 1.3 Rendering & Layers: The MapLibre Plugin Ecosystem

| Library | Role |
|---|---|
| **`maplibre-gl`** 5.24 | Primary map |
| **`deck.gl`** 9.3 (core/layers/geo-layers/mesh-layers/aggregation-layers/mapbox) | COG, 3D Tiles, I3S, visualization layers, interleaved into the MapLibre canvas |
| **`maplibre-gl-3d-tiles` / `-lidar` / `-splat` / `-raster` / `-vector`** | **Without switching engines, directly add 3D Tiles, point clouds, and Gaussian splats onto MapLibre** |
| **`@developmentseed/deck.gl-geotiff` / `-raster`** | COG rendering |
| **`@carbonplan/zarr-layer`** | Zarr scientific data |
| **`@loaders.gl/i3s`** / **`@esri/maplibre-arcgis`** | Esri ecosystem integration |
| **`@geoman-io/maplibre-geoman-free`** | Drawing and editing |
| **`maplibre-gl-time-slider` / `-swipe` / `-layer-control` / `-basemap-control`** | Interactive controls |
| **`@tanstack/react-virtual`** | Attribute table virtualization |
| **`cesium`** 1.143 | Optional 3D globe split-view, **lazy-loaded ~4.8 MB in a separate chunk** |

![3D Tiles, vectors, glTF, and Gaussian splats intermixed in a single layer list](https://assets.geolibre.app/images/3dtiles.webp)

**Many developers don't realize this about the `maplibre-gl-*` family: 3D Tiles, COPC point clouds, and Gaussian splats can all be loaded directly within the MapLibre canvas — no Cesium required.** If your project just needs "a quick look at some 3D Tiles," this path is far lighter than pulling in an entire 3D engine.

### Key Takeaways

- **1. Choose the lightest path per format.** The size difference between frontend libraries is orders of magnitude (shpjs at tens of KB vs. gdal3.js at 40 MB). The cost of library size is paid by users in first-screen load time.
- **2. Fast path + comprehensive fallback:** 90% of normal data goes through lightweight parsing; the 10% of edge cases fall back to the heavy engine.
- **3. Fidelity over generality.** Building a custom parser to preserve KML styling is worth the effort.
- **4. Import Turf by sub-package**, never as a whole.

---

## 2. DuckDB-WASM Spatial: One Library as Both Format Driver and Compute Engine

This section is the core of this article. **If you only read one thing, read this.**

First, let's cover WebAssembly in one sentence: the GeoLibre repository has 315 hits for the `wasm` identifier. **Database, language runtime, native toolchain, codec, and machine learning** — all five capability categories are powered by WASM engines: DuckDB, sql.js (SQLite), PGlite + PostGIS, CereusDB (SedonaDB), Pyodide, `geolibre-wasm` (a WASI build of Whitebox), gdal3.js, `cog-tiler-wasm`, h5wasm, onnxruntime-web. **When you trace the native languages, the picture becomes clear: C, C++, Rust. WASM here is not about accelerating JavaScript — it's about bringing decades of accumulated native GIS ecosystem into the browser wholesale.**

![Processing menu: a row of WASM engines behind it](https://assets.geolibre.app/images/processing-tools-menu.webp)

Among these dozen or so engines, **one stands out as worth trying right now**: `@duckdb/duckdb-wasm` plus its spatial extension. The reason is simple — other engines solve "a particular category of work," but this one is simultaneously a **format driver** and a **compute engine**. One library can take over both "read data" and "compute on data."

### 2.1 Clarifying the Three-Layer Relationship First

These three names are often conflated. They are nested:

| Layer | What It Is | Relationship |
|---|---|---|
| **WebAssembly** | Binary instruction format in the browser | Just "the ability to run native code"; does nothing GIS-related on its own |
| **DuckDB-WASM** | DuckDB (an analytical database written in C++) compiled to WASM | **It is "DuckDB implemented via WASM," not WASM itself** |
| **Spatial Extension** | DuckDB's spatial extension, also a separate `.wasm` file | Requires a **separate `INSTALL` / `LOAD`**; without it, there are no spatial functions at all |

> **The most common misconception**: thinking that installing duckdb-wasm gives you spatial capabilities. It does not. `ST_Read`, `ST_Transform`, `ST_AsWKB` — these all live in the spatial extension, which is a second WASM artifact fetched from CDN and loaded at runtime.

And behind the spatial extension's `ST_Read` lies **a subset of GDAL**. The implication: issue a single SQL statement in the browser, and you can read the vector formats that subset covers. It is the extension's own bundled GDAL, not whatever GDAL is installed on the machine, so the exact list is whatever the loaded build ships — run `SELECT * FROM ST_Drivers()` to see it.

### 2.2 What GeoLibre Uses It For

DuckDB invocation points in the source code are categorized as follows:

| Use Case | Interface Used | Notes |
|---|---|---|
| GeoParquet | `read_parquet` | **Both local and remote go through this**; remote uses HTTP Range requests |
| FlatGeobuf / GML / DXF / TAB, etc. | `ST_Read` | GDAL backend; format coverage depends on what the extension loads |
| Shapefile (zip) | First `shpjs`, fall back to Spatial | Lightweight first, heavy weapon as fallback |
| KML | First custom parser (preserve styling), fall back to Spatial | Spatial only gets geometry; styling is lost |
| CSV with WKT geometry columns | DuckDB SQL | Converts text geometry directly into a layer |
| Coordinate system transformation | `ST_Transform` | GeoJSON with legacy top-level `crs` members are reprojected through this |
| **SQL Workspace** | Full DuckDB SQL | **Loaded layers are registered as tables and can be directly JOINed** |

> **Key insight**: Pay attention to the last row. This is an easily underestimated design choice: layers on the map are simultaneously tables in SQL. Users can write `JOIN` and `ST_Intersects` across two layers, and the result becomes a new layer directly. **"Map" and "database" are two views of the same thing.**

![Vector data processing](https://assets.geolibre.app/demos/vector-data-demo.gif)

The SQL Workspace also features three "help the user say what they mean" rewrites. If you're building a SQL console, you can follow this approach directly:

- **Bare URLs or local paths after `FROM` / `JOIN` just work** — the source code automatically wraps them with the appropriate reader (`read_parquet`, `read_csv_auto`, `ST_Read`, etc.) based on the file extension. Users don't need to memorize which format maps to which function.
- `s3://`, `gs://`, `az://` are translated to their corresponding public HTTPS endpoints, traveling over the same HTTP Range channel.
- **HTTP URLs in reader parameters are rewritten into DuckDB file handles**, with the JS side issuing Range requests rather than going through WASM's built-in httpfs — because the latter fails outright on many servers.

> **Implementation detail**: These three rewrites apply only to **actual reader call arguments**. Strings that look like URLs inside string literals and comments are skipped (the source code implements a full SQL literal masking pass). **Never use raw regex to rewrite SQL.**

### 2.3 Four Implementation Details Worth Borrowing

**First, select bundles based on browser capabilities.** duckdb-wasm ships multiple WASM builds (mvp, eh, etc.) with different capabilities and sizes. `duckdb-wasm-bundles.ts` does exactly one thing: passes the mvp and eh artifacts — obtained via Vite's `?url` — to `duckdb.selectBundle()` for runtime selection:

```ts
const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: duckdbWasmMvp, mainWorker: mvpWorker },
  eh: { mainModule: duckdbWasmEh, mainWorker: ehWorker },
};
export function selectDuckDbBundle() {
  return duckdb.selectBundle(MANUAL_BUNDLES);
}
```

**Manually listing bundles rather than using the default CDN resolution ensures Vite produces content-hashed local artifacts for the WASM and worker** — which in turn enables safe caching by the Service Worker's CacheFirst strategy (see Section 5).

**Second, extension loading must be "per-instance, run-once."** `INSTALL spatial` goes over the network, and `LOAD` has state; concurrent calls will conflict. GeoLibre's approach is worth studying:

```ts
// Memoized per-instance: the shared library and the SQL Workspace
// each have their own DB, and each tracks its own loading state
const spatialExtensionByDb = new WeakMap<duckdb.AsyncDuckDB, Promise<void>>();

export async function ensureSpatialExtension(db, connection, beforeLoad?) {
  let promise = spatialExtensionByDb.get(db);
  if (!promise) {
    promise = (async () => { /* …INSTALL / LOAD… */ })();
    spatialExtensionByDb.set(db, promise);
  }
  try {
    await promise;
  } catch (error) {
    // Only clear if the memoized entry still points to this failed attempt,
    // otherwise retries would be permanently impossible
    if (spatialExtensionByDb.get(db) === promise) spatialExtensionByDb.delete(db);
    throw error;
  }
}
```

This short piece of code embodies three design decisions. It caches the Promise, not a boolean — concurrent calls share the same loading operation. It uses `WeakMap` keyed by instance — not a module-level singleton; when an instance is rebuilt, the cache automatically invalidates. On failure it clears the memoized entry, but only after verifying identity — preventing it from wiping out a new loading attempt someone else just wrote. **Miss any one of these three, and you'll encounter "spatial function sporadically does not exist" in production.**

**Third, leave an escape hatch for loading extensions without network access.** `INSTALL spatial` by default downloads from DuckDB's extension repository. GeoLibre adds an environment variable `VITE_DUCKDB_SPATIAL_EXTENSION_PATH`: when set, it directly issues `LOAD '<local path>'`, skipping `INSTALL` entirely.

For intranet, government, and offline desktop deployments, this single configuration setting is the difference between working and not working. The same pattern is reused for the h3 community extension (`INSTALL h3 FROM community`) — DuckDB's extension ecosystem is usable in the browser, and many developers don't know this.

**Fourth, manage Workers and lifecycles yourself.** DuckDB runs in a dedicated Worker. **The WASM heap is tied to the Worker's lifetime; only `terminate()` truly returns it to the system.** GeoLibre implements reference counting for the SQL Workspace instance: if queries are still running, it marks the instance for "destroy when idle" and waits until the last query releases before shutting down. **This is essential in scenarios requiring instance recreation — a direct `terminate()` would kill in-flight queries.**

### 2.4 A Real-World Bug Worth More Than Any Tutorial

A noteworthy record found in source code comments, **which illustrates "what it's like to run a database in a browser" better than everything above**:

> duckdb-wasm 1.33.1-dev45 will **permanently destroy** an instance's remote `read_parquet` — if that instance executes `LOAD spatial` **before completing its first remote read**. Afterward, all remote Parquet reads fail with `stoi: no conversion`, and this **cannot be recovered in-place**.

GeoLibre counters this with a two-pronged approach:

**First, warming up.** The `beforeLoad` hook on `ensureSpatialExtension` is exactly for this — before `LOAD spatial`, it runs `SELECT 1 FROM read_parquet(…) LIMIT 0` against whatever remote reader this query uses. **`LIMIT 0` only fetches the Parquet footer, incurring almost no additional traffic.** If this particular query has no remote Parquet, it falls back to reading a small public sample file.

**Second, rebuilding.** If the bug still strikes (e.g., the warm-up failed previously), `runSqlQuery` catches `stoi: no conversion`, calls `resetSqlDatabase(poisoned)` to replace the entire instance, and then **retries once**. The rebuild goes through the warm-up again, so the second attempt is clean.

Two additional defensive details: the retry is triggered only when the statement **actually contains a remote reader call** (URLs appearing inside string literals don't count), and `resetSqlDatabase` confirms that "the instance to replace is still the current instance" before acting.

!!! warning "Three Transportable Lessons"

    - **WASM extension loading order has side effects.** Do not assume "it doesn't matter when you LOAD," especially for extensions involving the network subsystem.
    - **Treat "warm-up" and "rebuild" as first-class citizens, not patches.** Graceful recovery from irreversible bad state is only possible if the instance is designed to be replaceable.
    - **Leave an escape hatch for upstream bugs, but narrow the scope to the symptom.** Match the specific error message + specific conditions + retry only once — don't blindly catch-all and retry.

### 2.5 Where Its Boundaries Lie

Many articles praise DuckDB-WASM. This section specifically examines the actual limitations revealed in the source code. Understanding these constraints provides more confidence than operating blindly.

| Limitation | Value | Reason |
|---|---|---|
| Remote file size | **2 GiB** | DuckDB-WASM's HTTP filesystem stores remote file sizes in 32 bits |
| Single-tab memory | ~4 GiB | WASM address space ceiling |
| Feature count confirmation threshold | 500,000 | User must confirm before materializing beyond this |
| Threading | Single-threaded | Very large data should go back to the server |

The 2 GiB limit has an instructive detail: the guard check happens **before ingestion begins** (`_registerSource` runs ahead of the streaming branch, so "streaming reads" can't bypass it either). GeoLibre's approach is to communicate this clearly in the file browser panel rather than letting users click Add and wait for an inevitable failure. **Failures that can be determined in advance should never be deferred to runtime.**

There's also the **copy vs. stream** trade-off: only GeoParquet truly supports "query in place without copying." Other formats silently fall back to full copy even when the stream option is provided — so GeoLibre only shows this button for GeoParquet. **A button whose click makes no difference is worse than no button at all.** In copy mode, memory usage roughly tracks the **decompressed** data size, which can be several times the Parquet disk size. Beyond 100 MB, the UI prompts the user to switch to streaming.

One final instructive comparison: GeoLibre's desktop build exposes a `native-duckdb` compile-time switch to use native DuckDB instead. But the Rust side carries a hard constraint:

```rust
compile_error!("the `mas` (Mac App Store) build must not enable `native-duckdb`: \
  DuckDB loads its spatial extension as unsigned native code at runtime, \
  which App Sandbox and App Store guideline 2.5.2 forbid.");
```

The native version is faster, but its runtime loading of unsigned native extensions directly violates Mac App Store rules. Conversely, **the WASM version, because it runs inside a sandbox, is the one that "ships everywhere."** This is a consideration rarely factored into technology selection.

### 2.6 Key Takeaways

- **1. Try DuckDB-WASM Spatial first, then consider alternatives.** One library solving both "read formats" and "compute spatially" is the highest ROI step for web-side GIS today. Remote GeoParquet + `read_parquet` — a dozen lines of code, no backend required.
- **2. Extension loading as "per-instance memoized Promise + identity-verified cache clearing on failure."** This pattern applies to all "async one-time initialization" scenarios, not just DuckDB.
- **3. Always provide a local extension path escape hatch.** Intranet / offline / desktop — this single configuration setting is everything.
- **4. For every WASM engine: lazy load + separate chunk + Worker execution + pinned version + replaceable lifecycle.** Keep it off the main thread and out of the critical rendering path.
- **5. Codify hard limits as named constants and validate upfront.** 2 GiB, 500K features, ~4 GiB heap — failures that can be communicated to the user in advance should never be deferred to runtime.

---

## 3. Web-Side Performance: Five Optimizations, Plus One Honest Negative Result

All numbers in this section are traceable to specific file line numbers.

### 3.1 Threshold-Driven: Set Clear Numbers, Switch Implementation at the Boundary

The core idea in one sentence: **Don't pursue one scheme to rule them all — switch implementations at well-defined thresholds.**

Threshold constants in the source (all verifiable):

| Constant | Value | Location | What It Protects |
|---|---|---|---|
| `LARGE_VECTOR_FEATURE_THRESHOLD` | **50,000** | `core/src/types.ts:670` | Main-thread GeoJSON parsing |
| `maxHistoryFeatureCount` | 500,000 | `core/src/history.ts:29` | Undo stack memory |
| `DUCKDB_VECTOR_FEATURE_WARN_COUNT` | 100,000 | `core/src/types.ts:1838` | Result materialization memory |
| `MAX_CEREUS_FEATURES` | 50,000 | `lib/sedona-workspace.ts:25` | WASM heap |
| `MAX_DERIVED_FEATURES` | 50,000 | `map/src/derived-geometry.ts:37` | Derived geometry computation |
| `historyCoalesceMs` | 400 ms | `core/src/history.ts:6` | Undo record explosion |
| Remote files | 2 GiB | `plugins/remote-file-formats.ts` | DuckDB-WASM 32-bit |

**Note that these thresholds are all named constants, all have documentation comments, and both `historyCoalesceMs` and `maxHistoryFeatureCount` have setters for runtime adjustment (set to 0 in tests).** This is a tier above magic numbers scattered through the code.

> **Takeaway: Every threshold should be able to articulate "what it protects."** A threshold that can't justify its protective purpose lacks a reliable foundation and is unlikely to survive long-term maintenance.

### 3.2 Client-Side Tiling: On-the-Fly Tile Generation Above 50K Features

The full pipeline is in `packages/map/src/geojson-vt-protocol.ts`, step by step:

- Indexing uses **`@maplibre/geojson-vt`** (note: this is MapLibre's fork; **Supercluster is included in this package** — the comments say it's "the same engine MapLibre uses internally")
- Point layers use `Supercluster` for indexing; everything else uses `GeoJSONVT`
- Encoding uses `@maplibre/vt-pbf`'s `fromGeojsonVt`
- Fed to MapLibre via a custom protocol `geolibre-gjvt`
- `TILE_EXTENT = 4096`, `TILE_MAX_ZOOM = 16` (beyond this, let MapLibre over-zoom)

![Large vector data loading](https://assets.geolibre.app/demos/vector-data-demo.gif)

Two details worth highlighting individually.

**First, tile indexes live in a module-level Map, not in the store.** The source comment puts it this way:

> Keyed by layer id. Module-level rather than on the Zustand record because **tile indexes are large, non-serializable objects that must not enter app state or be written to `.geolibre.json`**.

**This provides an excellent heuristic: what belongs in global state? — only what can be written into a project file.** Derived artifacts (tile indexes, spatial indexes, WebGL buffers, decoded bitmaps) should always live in module-level caches or on the engine side.

**Second, check the abort signal before encoding.** One line:

```ts
// packages/map/src/geojson-vt-protocol.ts:150
if (abortController?.signal.aborted) return { data: new ArrayBuffer(0) };
```

MapLibre cancels tile requests that scroll off-screen, and the result would be discarded anyway — so don't waste the computation.

**Generalized: every "on-demand production" async pipeline must support cancellation.** Applied to real projects: reprojecting off-screen tiles while the user rapidly drags the map, queries from previous pages still running while the attribute table rapidly flips pages, a previous layer's parse result arriving late and overwriting the new layer during rapid layer switching (**classic race condition**).

!!! warning "`AbortController` Is Not Just for `fetch`"
    Any loop that spans more than one frame should check `signal.aborted` in the loop body and exit early.

### 3.3 Undo Stack: Three Refinements Worth Studying

The file `packages/core/src/history.ts` is worth opening directly — about a hundred lines, high density. It uses `zundo` (Zustand's time-travel middleware).

The problem: **Every snapshot holds the full GeoJSON of layers.** Repeated editing pins multiple copies in memory (the comments reference issue #341).

**Treatment 1: Soft budget measured by feature count.** The comments explain why not bytes: "Feature count is a cheap proxy for payload size; it avoids serializing geometry on every edit" — **serializing geometry just to measure memory is itself a performance problem.**

**Treatment 2: Always retain the newest snapshot:**

```ts
// trimHistoryBySize: walk from newest to oldest, stop when the accumulated budget is exceeded
// The newest snapshot is always retained, even if it alone exceeds the budget.
let total = distinctFeatureCount(pastStates[lastIndex], seen);
```

**"When memory is tight, clear the undo stack" is many projects' approach — but that means the user, at the very moment they most need undo (right after a large edit), has exactly no undo available.**

**Treatment 3: Deduplicate by object reference.** `distinctFeatureCount` uses a `Set<object>` to track seen payloads: unchanged layers share the same reference across snapshots and are counted only once. **So "keeping many small-layer snapshots" has almost no additional memory cost.**

One more easily overlooked detail: that 400 ms is not ordinary debouncing — it's **leading-edge debounce**, serving as zundo's `handleSet`:

> firing only on the leading edge records the pre-burst state once

The distinction is critical — **what needs to be recorded is "the state before this burst of consecutive operations,"** so it must be recorded on the first trigger, not after things settle. **The value before you started dragging the slider is the value you want to undo back to.** Using ordinary trailing debounce would capture some intermediate value during the drag.

### 3.4 Virtualization Only Governs Rendering

The attribute table uses `@tanstack/react-virtual` for virtualization, but **sorting, filtering, and selection operate on the full data model**.

This sounds modest, but it's a high-frequency bug: many virtual list implementations "sort only the rendered rows," leading to sort results that change with scroll position, or "select all" that only selects visible rows. **And these bugs are impossible to reproduce in small-dataset testing.**

### 3.5 Bundle Size: How Far Does Lazy Loading Go?

The `manualChunks` configuration in `apps/geolibre-desktop/vite.config.ts` is the core of this approach. Take the most representative example — Cesium:

> CesiumJS (~4.8 MB) for the 3D-globe view. Lazily imported only when a pane switches to the globe……kept in its own build chunk and **off the 2D boot path**.

**"Off the boot path" is the key phrase.** For web GIS, this is the easiest performance win: the users who actually need 3D may only be 20%; there is no reason for 100% of users to pay the first-screen cost for it.

A detailed size breakdown from the source comments, organized here:

| Heavy Resource | Size | Strategy |
|---|---|---|
| CesiumJS | ~4.8 MB | Separate chunk, `import()` only when switching to globe view |
| PGlite + PostGIS | ~25 MB (bundling into desktop would add **~22 MB of nearly incompressible size**) | Default via jsDelivr CDN, not included in the build |
| gdal3.js | WASM ~28 MB + data ~12 MB | **Never bundled**, always from CDN; disabling CDN disables the feature |
| Pyodide / CereusDB | Tens of MB each | CDN-loaded; PGlite and CereusDB can be bundled-in via build switches |

**So that "only 30 MB installer" figure is achieved by "almost no heavy engine is bundled."** The philosophy worth borrowing: the default location for heavy engines should be "downloaded the first time the user clicks on it," not "included in the package just in case."

A companion practice: **all external resource URLs are runtime-configurable.** `VITE_PYODIDE_INDEX_URL`, `VITE_DUCKDB_SPATIAL_EXTENSION_PATH`, `VITE_CESIUM_TOKEN` can all be pointed to internal mirrors at runtime — **no rebuild required**.

For intranet/offline delivery scenarios, this is a lifesaving design. Hard-coded CDN URLs in the bundle mean an emergency rebuild when the network is down on site.

One more easily forgotten detail: `packages/processing/src/ort.ts` notes that onnxruntime-web's WASM artifacts are loaded from CDN, and **the version on CDN must exactly match the version pinned in npm** — otherwise it's a runtime crash. **For any library following the "JS glue in the package, WASM artifacts on CDN" pattern, this is the trap. The fix is to encode the version as a single constant consumed by both sides.**

Bottom line: CDN URLs, WASM versions, mirror paths — hard-code any of these three, and what awaits is an emergency packaging session on some Friday evening.

### 3.6 One Honest Negative Result

The final section of `docs/architecture.md` is literally titled "Performance: map rendering on Linux (WebKitGTK)." The details are worth reading in full:

- Empty map at any zoom level: steady 60 FPS
- Once there is a tile layer (vector **or** raster XYZ): **FPS drops to single digits during tile loading**, immediately returning to 60 once loading stops
- Root cause: WebKitGTK performs GPU uploads for each new tile on the main thread (textures for raster, vertex buffers for vectors), via synchronous WebGL calls, plus subsequent fade-in repaints
- **A single tile-integration render cycle measures ~125 ms; Chromium takes only a few ms**
- **Explicitly ruled out**: vector tile parsing and bucket construction run in MapLibre's Worker — they are not the bottleneck

The exclusion list is exhaustively detailed: software rendering (confirmed using Intel i915 GPU), GPU saturation (rendering engine still ~20% idle), Tauri IPC file reads (22 MB GeoJSON ~126 ms), `JSON.parse` (~36 ms), KWin compositor latency, `renderWorldCopies`, globe vs. Mercator projection, `preserveDrawingBuffer`.

The document even provides a one-line FPS counter for reproduction, plus three **not-yet-implemented** mitigations (increase `maxTileCacheSize`, 512px raster tiles, `fadeDuration: 0` — with a note to gate them on WebKitGTK only so they don't penalize Chromium builds).

Two lessons:

- **Cross-WebView performance does not extrapolate.** 60 FPS measured in Chrome does not guarantee the same in Electron's older Chromium, domestic browser kernels, or WKWebView. **Any project with client-side delivery requirements must test on the target WebView.**
- **Documenting the investigation process along with "what was ruled out" is more valuable than only stating the conclusion.** That 8-item exclusion list can save the next person two days.

> **Editor's note**: Being willing to write this kind of negative result into the architecture documentation, complete with reproduction steps and unimplemented TODOs, speaks well of the project's engineering maturity.

---

## 4. State Management: Three Directly Reusable Patterns

This section is pure web engineering, less GIS-specific, but has the lowest migration cost.

`@geolibre/core` has only four dependencies: `zustand`, `zundo`, `uuid`, `@maplibre/maplibre-gl-style-spec`. **Note that it does not depend on `maplibre-gl` itself** (the style-spec package is only used to evaluate style expressions), so the state layer and the rendering layer are genuinely separated.

![Layer panel: all parameters modify the store](https://assets.geolibre.app/images/raster-style-panel.webp)

**Pattern 1: Constant array as single source of truth.** The 20 layer types at `packages/core/src/types.ts:62`:

```ts
export const LAYER_TYPES = [
  "geojson", "raster", "wms", "wmts", "xyz", "vector-tiles", "arcgis",
  "pmtiles", "mbtiles", "zarr", "lidar", "gaussian-splat", "3d-tiles",
  "cog", "flatgeobuf", "geoparquet", "duckdb-query", "deckgl-viz",
  "video", "image",
] as const;
export type LayerType = (typeof LAYER_TYPES)[number];
```

The comments explain the rationale: **"as a runtime list so untrusted input (an imported Layer Library bundle, a hand-edited project) can be validated against it,"** and `LayerType` is derived from the array, **"so the two cannot drift."**

> **Takeaway: A single definition simultaneously provides runtime validation data and compile-time types, while preventing the two from drifting apart.** Every TypeScript project with a "finite enum + need to validate external input" scenario should follow this pattern.

**Pattern 2: State is a flat record + minimal view state.** `MapViewState` has only five fields:

```ts
export interface MapViewState {
  center: [number, number];
  zoom: number; bearing: number; pitch: number;
  bbox?: [number, number, number, number];
}
```

This minimalism is deliberate. The smaller the state, the greater the confidence in serializing it into a project file, and the lower the cost of connecting a second consumer (a second map panel, a second renderer, an exporter).

**Pattern 3: Cross-language boundaries marked with `SYNC:`.** This was the most surprising discovery from reading through the source.

The 17 vector file extensions exist as `VECTOR_FILE_DIALOG_EXTENSIONS` in TypeScript (`lib/tauri-io.ts:154`) and as `RESTORABLE_VECTOR_EXTENSIONS: [&str; 17]` in Rust (`src-tauri/src/lib.rs:418`) — **two copies, because constants can't be shared across languages**. Their solution is to annotate both sides. Quoted verbatim from `lib/tauri-io.ts:150-153`:

> SYNC: RESTORABLE_VECTOR_EXTENSIONS in src-tauri/src/lib.rs must list the same extensions, or a format added here would be rejected by the Rust restore guard on every project reopen (**the bug this PR fixes**). Grep "SYNC:" to find the partner list.

Note the parenthetical "the bug this PR fixes" — it refers to the pull request that added the comment, so it will not mean much to a future reader, but the failure it records is real: a new format was added in TypeScript, the Rust-side guard was not updated, and every project reopen was rejected.

> **Takeaway: When you can consolidate into one source, do so. When you can't (cross-language, cross-process, cross-repository), use a unified, grep-able marker to pin them together, and document in the comment exactly what happens if they drift.** This is far more effective than "everyone please remember to keep these in sync."

---

## 5. Offline Capability: Workbox Three-Tier Caching Strategy

This section stands alone because it's especially relevant for intranet, offline, and government deployment scenarios, and `docs/architecture.md:83-100` documents it comprehensively.

The web build is an installable PWA using `vite-plugin-pwa` + Workbox. Caching is **deliberately split into three tiers**:

| Tier | Strategy | Content | Why This Split |
|---|---|---|---|
| **Precache** | Precache | HTML + JS/CSS chunks essential for map startup | **After first visit, the shell works without network**; heavy chunks are **excluded** to avoid massive first-screen downloads |
| **Same-origin runtime cache** | CacheFirst | Content-hashed artifacts under `/assets/`: MapLibre, **DuckDB-WASM and its spatial extension**, plugin chunks | Content-hashed filenames make CacheFirst safe — redeployment generates new URLs, old entries won't be served as new |
| **CDN engine cache** | CacheFirst (separate rule `geolibre-cdn-engines`) | Pyodide, PGlite/PostGIS, CereusDB, gdal3.js on jsDelivr | URLs embed exact version numbers, similarly preventing stale serving; jsDelivr's CORS headers make these properly verifiable and evictable 200 responses, not opaque |

**So the accurate description for these CDN engines is: in the web PWA, the network is required for the first *successful* fetch — CacheFirst only serves from cache once a matching response has actually been stored — and they are available offline from then on.** Desktop builds install no Service Worker at all, so this does not apply to them; see the bullets below.

Why not just bundle everything? The following details make it clear.

Several particularly pragmatic details:

- To eliminate the "network required on first use," you can set `GEOLIBRE_PGLITE_CDN=0` and `GEOLIBRE_CEREUS_CDN=0` to bundle them into `/assets/` — **at the cost of PGlite alone adding back ~22 MB to the Tauri binary**
- **Pyodide and gdal3.js have no such switch.** Pyodide always loads from CDN (`VITE_PYODIDE_INDEX_URL` can change the mirror, but **that mirror is not within the scope of the two CacheFirst rules**; unless you place it under `/assets/`, it falls back to ordinary HTTP caching). gdal3.js is never vendored; `GEOLIBRE_GDAL_CDN=0` disables **that export feature**, it does not bundle it
- **Desktop builds do not install a Service Worker** (Tauri's own resources are already offline), so desktop installations re-fetch CDN engines on every install
- Basemaps only cache CORS-friendly default sources (OpenFreeMap, CARTO); other remote tiles and WMS/WFS are **by design unavailable offline**
- New deployments use `registerType: "autoUpdate"` + `skipWaiting`, but **deliberately suppress Workbox's default "force reload on activation"** — because under relative-base sub-paths like `/demo/`, it incorrectly triggers and wipes out the user's in-progress map state. Page recovery is handled by `installStaleChunkReload`, which **only reloads when an orphaned lazy chunk 404s**, with cooldown protection

!!! tip "The Most Valuable Detail"
    This last detail is the most valuable in the entire section — the kind of code "only written after experiencing real production issues." Auto-update causing users to lose unsaved work is the most common and most damaging PWA mistake.

### Key Takeaways

- **1. Split caching into three tiers — "shell / same-origin heavy resources / CDN engines"** — don't use one rule for everything.
- **2. Content hashes or version numbers are the prerequisite for CacheFirst to be safe.** Without them, CacheFirst is "permanently serve the old version."
- **3. Explicitly document "what is definitely unavailable offline"** (remote services, non-allowlisted basemaps) — don't make users guess.
- **4. Auto-update should not force-reload the page.** Only reload on orphaned chunk detection, with cooldown.

---

## 6. Cloud-Native Formats: What Gets Replaced Is Not the Frontend Library, but the Entire Distribution Architecture

The previous five sections dealt with code. This section deals with something that affects **architecture and cost**.

Traditional pipeline: **Data → ingest into database → publish via GeoServer / ArcGIS Server → generate tiles → frontend requests services**. Requires maintaining a server, a publishing workflow, a tile cache, plus monitoring, backup, and scaling for all of it.

Cloud-native pipeline: **Data → convert to COG / GeoParquet / PMTiles / FlatGeobuf → drop onto any static storage that responds to Range requests → frontend fetches byte ranges on demand**. The server tier disappears entirely; what remains is just object storage traffic costs.

> **The key phrase is HTTP Range.** What these formats share is not "better compression," but that **each file carries its own layout metadata — a header or footer, tile directory, R-tree index, overviews, row-group statistics** — the client reads a few KB of that metadata, calculates which byte ranges it needs, and issues a `Range` request to fetch them. Static storage is sufficient; no "service" is required.

### 6.1 What Makes This Good: Five Concrete Benefits

**Benefit 1: Download volume converges on "what you need to see," not "how large the file is."**

This is the most fundamental shift. Traditional formats (GeoJSON, Shapefile, striped GeoTIFF) **offer no useful partial-range access — even when an index exists it sits in a sidecar file, so the client still has to fetch all of the data**. Cloud-native formats keep that index inside the data file itself, enabling pruning across three dimensions:

| Pruning Dimension | Mechanism | Effect |
|---|---|---|
| **Spatial** | FlatGeobuf's R-tree index, PMTiles tile layout | **Only fetch features/tiles within the viewport** |
| **Resolution** | COG pyramids (overviews), PMTiles zoom levels | View the entire country at the coarsest level; don't decode 100 million pixels |
| **Attribute columns** | GeoParquet's **columnar storage** | If you need only 3 columns, read only those 3 columns' bytes; other columns are never touched |

**The third dimension is GeoParquet's most underappreciated strength. Columnar storage + row-group statistics (min/max) means `WHERE` predicates can be pushed down** — DuckDB can determine from statistics alone that an entire row group doesn't satisfy the condition and skip it, without ever downloading those bytes.

**Benefit 2: Parse cost drops from "tens of milliseconds blocking the main thread" to near zero.**

The hidden cost of text formats is `JSON.parse`. Section 3.6's investigation checklist provides two measured numbers: **a 22 MB GeoJSON takes ~126 ms to read from disk, then ~36 ms more for `JSON.parse`** — all on the main thread.

Binary columnar formats eliminate this step: the byte layout is the memory layout. DuckDB reads vectorized columns directly — no per-character parsing, no constructing hundreds of thousands of JS objects. **When feature counts are high, what actually freezes the page is often not rendering but parsing and GC.**

**Benefit 3: Caching becomes nearly free.**

Cloud-native formats are **static files**, so they naturally consume the entire existing HTTP caching pipeline: **CDN edge caching, browser cache, Service Worker, `ETag` / immutable URLs** — none of which you need to implement yourself.

Compare with dynamic tile services: tile caches you must build yourself, invalidation strategies you must write yourself, cache hit rates you must monitor yourself. **A Range request hitting the same byte range of the same immutable file is just an ordinary cache hit at the CDN layer. The reason Section 5's Workbox three-tier caching strategy works at all is precisely because the resources are static and content-hashed.**

**Benefit 4: The concurrency bottleneck moves off your servers.**

The capacity bottleneck for tile services is server-side CPU: 100 concurrent users means 100 copies of rendering cost. **Static storage + CDN follows a completely different scaling curve** — there is no per-user rendering to scale, so the additional load shows up mostly as traffic cost. And edge caching intercepts the vast majority of requests at the node closest to the user. What does not disappear is capacity planning: cache misses still reach origin, and object stores have their own per-prefix request-rate limits and egress bills.

This is especially critical for government dashboards and public service portals — the "idle most of the time, but everyone watches simultaneously during meetings" traffic pattern. Handling that shape with a tile service means either overpaying for peak capacity long-term or crashing during the peak.

**Benefit 5: A whole link disappears from the chain, and operational costs collapse with it.**

**No publishing workflow, no service processes, no database connection pools, no middleware to patch.** A data update is just overwriting a file. GeoLibre's entire "directly read remote GeoParquet / COG / PMTiles in the browser" capability is proof this path works. Every online catalog it connects to (STAC, Source Cooperative, Overture Maps, Planetary Computer) follows this model.

**But the trade-offs are real — these four points are genuine:**

- **Small data is actually slower.** Reading the header, reading the index, then fetching the data — that's several network round-trips. A few hundred KB of GeoJSON is one request and done; wrapping it in a cloud-native format is counterproductive. **The threshold is roughly "too large for a single request."**
- **Range request count increases significantly.** HTTP/1.1 handles `Range` fine, but HTTP/2 or HTTP/3 is strongly recommended at this request volume; otherwise connection overhead will eat into the benefits.
- **The server must support `Range` and CORS** (plus `Access-Control-Expose-Headers`) — this trips people up more often than expected; the next sub-section covers it in detail.
- **Computation moves from server to client.** The decoding, filtering, and stitching that servers used to do now runs in the user's browser, subject to the ~4 GiB memory and single-thread constraints (see Section 2.5). **It's not "got faster" — it's "moved where the computation happens" — and it's only a win when the new location computes more cost-effectively.**

> **So cloud-native formats have a well-defined sweet spot: large, static, multi-user reads, viewport-constrained access — all four satisfied yields maximum benefit.** Conversely, high-frequency-write dynamic operational data does not suit this model, which is why Section 6.7's checklist explicitly says "do not touch the PostGIS path."

### 6.2 How GeoLibre Reads These Formats

| Format | Read Path | Key Point |
|---|---|---|
| **PMTiles** | MapLibre custom protocol (`pmtiles` package) | One file replaces an entire tile service; frontend only registers one extra protocol |
| **COG** | **`cog-tiler-wasm` (default)** / deck.gl GPU / TiTiler | Three switchable engines; the first two are fully client-side |
| **GeoParquet** | DuckDB-WASM `read_parquet` | Optional "in-place streaming query" — no need to copy the entire dataset into memory |
| **FlatGeobuf** | DuckDB Spatial `ST_Read` | Built-in spatial index, naturally suited for range reads |
| **MosaicJSON / STAC catalog** | Raster control reads catalog, **stitches scenes at read time** | The catalog itself contains no data — only a list of asset URLs |
| **Cloud-optimized NetCDF/HDF5** | kerchunk reference manifest → Zarr rendering pipeline | See 6.5 |

### 6.3 The Real Barrier Is Not Format Conversion — It's CORS

**Format conversion is a one-time task. CORS is a wall you hit every single day.** The source code's description of Source Cooperative is precise: the data endpoint `data.source.coop` sends `Access-Control-Allow-Origin: *` **and** supports byte-range requests, so **PMTiles protocol, DuckDB-WASM, and COG readers can all connect directly without any proxy**. But its **metadata API sends no CORS headers at all**. So how does the browser handle it? The desktop version goes through Tauri's native HTTP (server-to-server, no such thing as CORS). The web version goes through a self-built Cloudflare Worker that re-serves the JSON with CORS headers added.

**The judgment "data can connect directly, metadata needs a proxy" is the first call to make when integrating any cloud-native data source.**

The same Worker contains an even more instructive comment about why planetary basemaps must be proxied:

> MapLibre uses `fetch()` to retrieve raster tiles, which goes through CORS checks — so the map renders as a black screen. Meanwhile, openplanetarymap.org itself works fine because Leaflet loads tiles via `<img>` tags, **and `<img>` does not perform CORS checks**.

!!! danger "Critical Trap"
    The same tile URL displays in Leaflet but not in MapLibre. The root cause may be neither the code nor the tile itself — it's that the two libraries fetch images differently.

Three practices worth borrowing from this pipeline: **fetch data server-side and add CORS headers** (avoid having the browser hit the wall directly), **cache results at the edge** (repeat requests don't go back to origin), **strict allowlist, never an open proxy** (the source code's words: "keyed to a tight allowlist so it is never an open proxy"). The third is a security baseline: a public proxy that can forward arbitrary URLs will eventually be abused, and the consequences are on you.

One more detail worth remembering: Source Cooperative's unknown API paths don't return 404 — they fall through to a catch-all page route, **returning HTML with status code 200**. So the source code validates the parsed structure on every read. **`response.ok` only means the network layer didn't error; it does not mean you got what you asked for.**

### 6.4 "Convert to COG" Does Not Mean Renaming the Extension to `.tif`

COG's ability to be read via Range requests depends on **internal tiling and pyramid overviews within the file**. A striped GeoTIFF can technically be range-read too — its strip offsets and byte counts are in the header — but a strip spans the full image width, so fetching a small map extent drags in far more bytes than it needs, and with no overviews there is no coarse level to zoom out against. Naming it `.tif` changes none of that, and GeoLibre's client-side readers require internal tiles outright.

GeoLibre's handling is instructive: the panel **first reads the file header with a Range request** to determine whether internal tiles exist; if not, it prompts the user to go through client-side conversion (the gdal3.js path) before loading. **A few KB of header for a definitive answer, rather than making the user wait through an inevitably slow load.**

The trade-offs among the three raster engines are also documented in the source: `cog-tiler-wasm` (default, browser WASM, **at the cost of only using built-in color ramps** — custom classification is lost), `maplibre-gl-raster` (GPU, full symbology), `titiler` (server-side). **The default is chosen for stability, not feature completeness.**

### 6.5 What If the Data Isn't Cloud-Native? Externalize the Index

NetCDF / HDF5 are de facto standards for scientific data, but they weren't designed for HTTP. GeoLibre's approach is **kerchunk reference manifests**: the manifest maps Zarr keys to **`[url, offset, length]`** (byte ranges within the original file), and implements a **minimal zarrita `Readable` (only needs a `get(key)`)** — then feeds it directly into the existing Zarr rendering pipeline. The source comment's phrase "with no rewrite" is the key point: **not a single line of rendering code changed.**

> **This idea generalizes: don't change the data, don't change the renderer — just insert a "key → byte range" mapping layer in between.** Historical formats unsuitable for streaming reads become demand-readable as long as you can compute the offsets.

### 6.6 Catalog Browsers Should Do Exactly One Thing: Produce URLs

GeoLibre integrates STAC, Source Cooperative, Overture Maps, Planetary Computer, Hugging Face — a large number of online data sources — and stays manageable through one principle: **when adding a layer, deliberately delegate to the controls that already understand each format** — PMTiles to `addPMTilesLayerFromUrl`, GeoParquet to `addVectorLayerFromUrl`, COG to `app.addCogLayer`. As a result, data clicked in from a catalog and data added manually via Add Data are **fully equivalent**: the same layer panel, the same styling capabilities, the same persistence into projects.

> **One data source integration = one "how to find the URL" adapter. Reading and rendering are always a single implementation. This is the only way to integrate N data sources without losing control.**

### 6.7 Adoption Order & Key Takeaways

**Adoption order** (from lowest to highest investment):

1. Convert **externally-facing static data** to PMTiles — eliminate an entire tile service
2. Convert raster outputs to **genuine** COG (verify internal tiles and pyramids) — direct frontend read or pair with titiler
3. Convert large vector tables to GeoParquet — query directly with DuckDB
4. For historical formats that can't be converted, consider external indexes (the kerchunk approach)
5. **Dynamic operational data stays on PostGIS — do not touch this path**

- **1. The essence is "index in the file + HTTP Range" — so what gets replaced is the server side, not the frontend library.**
- **2. First distinguish "data can connect directly" from "metadata needs a proxy." The proxy must be allowlisted + edge-cached, and must never be an open proxy.**
- **3. When programming against external APIs, validate the parsed structure — don't trust `response.ok`.**
- **4. Multi-source integration must converge on a single set of format-reading implementations; catalog panels are only responsible for producing URLs.**

> **Item 1 has the highest ROI: one PMTiles file + a static server replaces an entire tile publishing workflow. Many projects can complete this transition in a short time.**

---

## In Closing: An Adoption Checklist Ordered by Investment

### Validatable Within a Day

1. Try **DuckDB-WASM Spatial** once — read a remote GeoParquet directly and experience "no backend required"
2. Convert heavy engines in your project to **on-demand lazy loading + separate chunks**, especially 3D engines — get them off the first-screen path
3. Make all CDN / resource URLs runtime-configurable

### Achievable This Iteration

<ol start="4" markdown>

- Set a clear threshold for large-data layers; switch to client-side tiling above the line (`@maplibre/geojson-vt` + `@maplibre/vt-pbf`)
- Wire `AbortController` into all async pipelines, including non-network long loops
- Check whether your undo stack has a memory budget and whether the newest snapshot is always retained; check whether virtual list sorting operates on the full data model
- Rewrite enums using `as const` arrays so runtime validation and type definitions share a single source
- Pin cross-language / cross-process duplicate constants with a unified `SYNC:` marker

</ol>

### Worth Evaluating as a Project

<ol start="9" markdown>

- Upgrade DuckDB-WASM Spatial **from "format reader" to "query layer"**: let layers simultaneously be SQL tables, so users can write `JOIN` and `ST_Intersects` across two layers
- De-framework the computation layer so the browser and server run the same code — never reconcile results again
- Move static data pipelines to cloud-native formats, starting with PMTiles; confirm storage supports `Range` and CORS, and clarify which metadata must go through a proxy
- If building a web application, rebuild your Service Worker caching using the three-tier strategy

</ol>

> None of the items on this checklist require importing a single line of GeoLibre's code. Its greatest contribution is not yet another mapping application — it's proving, with a complete project you can run, install, and read the source of, that **a spatial database running in the browser is sufficient to replace the half of the work that used to require a server**.
