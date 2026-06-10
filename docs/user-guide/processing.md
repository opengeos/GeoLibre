# Processing Tools

The **Processing** menu collects GeoLibre's analysis and conversion tools: vector geometry and overlay tools, raster terrain and clipping tools, format conversion, and the Whitebox toolbox. The [SQL Workspace](sql-workspace.md) also lives here and has its own page.

![Vector tools dialog](https://data.geolibre.app/images/geolibre-processing-vector.webp)

## Vector

**Processing > Vector** opens the Vector tools dialog. Pick a tool from the list, choose the input layer and parameters, select an engine, then **Run**. Output appears as a new layer.

**Geometry**

| Tool | Description |
| --- | --- |
| **Buffer** | Create a buffer polygon around each feature by a fixed distance. |
| **Centroids** | Compute the centroid point of each feature. |
| **Convex hull** | Compute the convex hull enclosing all features. |
| **Dissolve** | Merge polygon features into a single geometry, optionally grouped by a field. |
| **Bounding box** | Compute the rectangular envelope of all features. |
| **Simplify** | Reduce the number of vertices using Douglas-Peucker. |

**Overlay**

| Tool | Description |
| --- | --- |
| **Clip** | Clip the input layer to the area covered by an overlay layer (keeps input attributes). |
| **Intersection** | Keep only the areas where both polygon layers overlap. |
| **Difference** | Remove the overlay layer's area from the input layer. |
| **Union** | Merge two polygon layers into a single combined geometry. |

### Engines

Every vector tool can run on one of two engines, selectable in the dialog:

- **Client (Turf.js)**: runs entirely in the browser. No setup, works offline, and operates on the layer's GeoJSON.
- **Sidecar (GeoPandas)**: runs on the optional Python sidecar for projection-aware results, backed by GeoPandas and Shapely. The dialog falls back to the client engine when the sidecar's optional `vector` extra is not installed.

See the [Vector Analysis tutorial](../tutorials/vector-analysis.md).

## Raster

**Processing > Raster** opens the Raster tools dialog. Raster tools run on the rasterio Python sidecar: they take a file path in and write a file path out, then add the result to the map.

**Terrain**

| Tool | Description |
| --- | --- |
| **Hillshade** | Compute a shaded-relief raster from an elevation model. |
| **Slope** | Compute slope (steepness) from an elevation model. |
| **Aspect** | Compute aspect (compass direction of the steepest slope) from an elevation model. |

**Reproject**

| Tool | Description |
| --- | --- |
| **Reproject** | Warp a raster to a different coordinate reference system. |
| **Resample** | Resample a raster to a different pixel size (resolution). |

**Clip**

| Tool | Description |
| --- | --- |
| **Clip by extent** | Crop a raster to a bounding box (in the raster's CRS). |
| **Clip by mask layer** | Clip a raster to the geometries of a vector mask file. |

**Raster to Vector**

| Tool | Description |
| --- | --- |
| **Polygonize** | Convert a raster band into vector polygons grouped by pixel value. |
| **Contour** | Generate contour lines from an elevation model. |

See the [Terrain Analysis tutorial](../tutorials/terrain-analysis.md).

## Conversion

**Processing > Conversion** writes data to cloud-native formats:

| Tool | Engine | Description |
| --- | --- | --- |
| **Vector to GeoParquet** | Browser (DuckDB-WASM) | Hilbert-sorted, compressed GeoParquet. |
| **Vector to FlatGeobuf** | Sidecar | Cloud-optimized, spatially indexed vector. |
| **CSV to GeoParquet** | Browser (DuckDB-WASM) | Convert a CSV with coordinates to GeoParquet. |
| **Vector to PMTiles** | Sidecar | Build a vector tile archive. |
| **Raster to COG** | Sidecar | Write a Cloud-Optimized GeoTIFF. |

The conversion sidecar is hardened with a path allowlist.

## Whitebox

**Processing > Whitebox** opens the Whitebox toolbox for batch geoprocessing, backed by a managed Python sidecar. Point it at an input directory and run tools across the files in it.

## Planetary Computer and Earth Engine

The Processing menu also opens the **Planetary Computer** and **Earth Engine** panels for browsing and loading cloud datasets. See [Data Integrations](data-integrations.md).

## The Python sidecar

The raster tools, the sidecar conversion tools, the Whitebox toolbox, and the optional GeoPandas vector engine all use a local FastAPI sidecar that the desktop app starts on demand. The vector tools' client engine and the browser-based conversions need no sidecar. See [Getting Started](../getting-started.md#optional-python-sidecar) for setup and [Reference > Architecture](../architecture.md#python-sidecar) for how it works.

!!! note "Browser vs desktop"
    The client-side vector tools and the browser conversions (Vector to GeoParquet, CSV to GeoParquet) run in the browser. The raster tools, sidecar conversions, and Whitebox require the desktop app and the Python sidecar.
