# Vector Analysis

This tutorial runs a small vector workflow: buffer a layer, overlay it with another, and export the result. It uses the [Vector tools](../user-guide/processing.md#vector) under **Processing → Vector**.

## 1. Load input data

Add at least one vector layer (see [Adding Data](../user-guide/adding-data.md)). For an overlay you will need two layers, for example a set of points or lines and a polygon layer to clip against.

## 2. Buffer a layer

1. Open **Processing → Vector → Buffer**.
2. Set **Input layer** to your layer.
3. Set the **Distance** and **Units** (kilometers, meters, or miles).
4. Choose an **Engine**:
   - **Client (Turf.js)** runs in the browser with no setup.
   - **Sidecar (GeoPandas)** runs on the Python sidecar for projection-aware distances (desktop app).
5. Click **Run**. A buffered layer is added to the map.

!!! tip "Projection-aware distances"
    The client engine buffers in geographic coordinates. For accurate metric distances over large areas, use the GeoPandas sidecar engine, which reprojects before buffering.

## 3. Overlay two layers

With the buffer (or any polygon layer) and a second layer, run an overlay:

- **Clip** keeps the part of the input that falls inside the overlay, preserving the input's attributes.
- **Intersection** keeps only the overlapping areas of two polygon layers.
- **Difference** removes the overlay's area from the input.
- **Union** merges two polygon layers into one (attributes are not preserved, on either engine).
- **Spatial join** attaches a join layer's attributes to each input feature based on a spatial relationship (intersects, within, or contains) — for example, tagging each point with the polygon that contains it. Works with any geometry type.
- **Attribute join** attaches a join table's attributes to each input feature where a key field matches — no geometry involved (for example, joining census statistics to boundary polygons by a shared FIPS code). It is one-to-one (the first matching join row wins); pick the key field on each side, optionally list which fields to bring over, and choose an inner or left join.

Open the tool from **Processing → Vector**, pick the input and overlay layers, and **Run**.

## 4. Inspect and refine

Open the [Attribute table](../user-guide/attribute-table.md) on the result layer to check the output, and adjust its [style](../user-guide/styling.md) so it stands out from the inputs.

## 5. Export the result

To save the output as a cloud-native file, use **Processing → Conversion** (for example **Vector to GeoParquet** or **Vector to FlatGeobuf**). See [Cloud-Native Data](cloud-native-data.md). You can also export records from the [Attribute table](../user-guide/attribute-table.md) or the [SQL Workspace](../user-guide/sql-workspace.md).

## Next steps

- Do the same kind of analysis in SQL with [Spatial SQL](spatial-sql.md).
- Move to raster analysis in [Terrain Analysis](terrain-analysis.md).
