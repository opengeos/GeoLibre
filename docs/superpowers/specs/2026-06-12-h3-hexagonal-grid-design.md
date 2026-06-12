# H3 Hexagonal Grid — Design

Issue: #245 — Add support for creating H3 Hexagonal Grid using the DuckDB `h3` community extension and the `spatial` extension.

## Goal

Let users generate H3 hexagonal grids and aggregate point data into H3 cells, entirely client-side via DuckDB-WASM, surfaced through the existing Processing → Vector Tools dialog. Output is a polygon GeoJSON layer added to the map via `addGeoJsonLayer`.

## Scope

Two processing tools, group `"H3"`, defined in a new file `packages/processing/src/h3-tools.ts` and registered in the vector tools registry:

1. **Create H3 Grid** — fill an area with H3 hexagons at a chosen resolution.
   - Area source (`select`): `Layer geometry (polyfill)` | `Layer extent (bbox)` | `Map viewport`.
   - Input layer (`layer`) — visible when source is polyfill or extent.
   - Resolution (`number`, 0–15) — pre-filled with an auto-suggested value.
   - Output: polygon layer; each hexagon carries its `h3` index string as a property.
2. **Bin Points to H3** — aggregate a point layer into H3 cells.
   - Input point layer (`layer`).
   - Resolution (`number`, 0–15) — auto-suggested.
   - Aggregate field (`field`, optional) + aggregate op (`select`: `count` | `sum` | `mean` | `min` | `max`). `count` needs no field.
   - Output: polygon hexagon layer with properties `h3`, `count`, and the aggregate value (when a field is chosen).

Out of scope: server/sidecar H3, raster H3, H3 compaction/parent-child hierarchy tools, persisting H3 indexes back to source layers.

## Architecture

### Integration: inject a DuckDB capability into `ProcessingContext` (Approach A)

`@geolibre/processing` stays framework-agnostic and must not import `@duckdb/duckdb-wasm`. DuckDB-WASM lives in `apps/geolibre-desktop/src/lib/duckdb-vector-loader.ts`. We add an optional capability to the context so processing tools can run SQL without the package depending on DuckDB:

```ts
// packages/processing/src/types.ts
export interface DuckDbGeoJsonSource {
  sql: string; // FROM-able expression; geometry column is `geom`
  release: () => Promise<void>;
}

export interface DuckDbCapability {
  ensureExtensions: (names: string[]) => Promise<void>;
  registerGeoJson: (geojson: FeatureCollection) => Promise<DuckDbGeoJsonSource>;
  query: (sql: string) => Promise<Record<string, unknown>[]>;
}

export interface ProcessingContext {
  // ...existing fields...
  duckdb?: DuckDbCapability;
  viewportBounds?: () => [number, number, number, number] | null;
}
```

- The H3 tools call `ctx.duckdb`. If it is absent (e.g. headless/test without wiring), the tool throws a clear error: `"This tool requires DuckDB-WASM, which is unavailable in this environment."`.
- The desktop app implements `DuckDbCapability` over the existing loader (memoized DB + connection) and passes it into the context built in `VectorToolsDialog.tsx`.

### Extension loading

Add `ensureH3Extension(connection, beforeLoad?)` in `duckdb-vector-loader.ts`, mirroring `ensureSpatialExtension`:

```ts
await connection.query("INSTALL h3 FROM community");
await connection.query("LOAD h3");
```

Memoized via a module-level promise, cleared on error for retry (same pattern as spatial). `ensureExtensions(['spatial','h3'])` calls `ensureSpatialExtension` then `ensureH3Extension`.

### H3 engine (SQL)

Helpers (pure, unit-tested) build SQL strings; the DuckDB capability executes them.

**Create H3 Grid (polyfill):**
```sql
WITH cells AS (
  SELECT unnest(h3_polygon_wkt_to_cells(:wkt, :res)) AS cell
)
SELECT h3_h3_to_string(cell) AS h3,
       ST_AsGeoJSON(ST_GeomFromText(h3_cell_to_boundary_wkt(cell))) AS geojson
FROM cells;
```
- Area WKT:
  - `Layer geometry (polyfill)`: union of the input layer's features → WKT (`ST_Union_Agg` / `ST_AsText`). For multi-feature layers, dissolve to a single (multi)polygon first.
  - `Layer extent (bbox)`: build a rectangle WKT from the layer's bounds.
  - `Map viewport`: rectangle WKT from `map.getBounds()` provided by the dialog.

**Bin Points to H3:**
```sql
WITH binned AS (
  SELECT h3_latlng_to_cell(lat, lng, :res) AS cell,
         count(*) AS count,
         <AGG>(value) AS value   -- omitted when op = count
  FROM points
  GROUP BY cell
)
SELECT h3_h3_to_string(cell) AS h3, count, value,
       ST_AsGeoJSON(ST_GeomFromText(h3_cell_to_boundary_wkt(cell))) AS geojson
FROM binned;
```
Points are loaded into DuckDB from the layer's GeoJSON (register as a virtual file / table; reuse the existing GeoJSON-into-DuckDB path used by the vector loader where possible). Latitude/longitude come from each point geometry.

Each result row's `geojson` (a polygon geometry) is wrapped into a `Feature` with `{ h3, count?, agg? }` properties; rows are collected into a `FeatureCollection` and passed to `ctx.addResultLayer(name, fc)`.

### Auto-suggested resolution + safety cap

- Compute the target area (km²) from the chosen source. Using H3 average hexagon areas per resolution, pick the **finest** resolution whose estimated cell count stays under a soft target (~10,000). This fills the default; the user can override.
- Before running, estimate cell count for the chosen resolution. If it exceeds a hard cap (200,000), abort with a clear message rather than generating a runaway grid. `Bin Points to H3` is naturally bounded by the data but still validates resolution range.

### Antimeridian / edge cases

`h3_cell_to_boundary_wkt` can produce boundaries spanning the antimeridian for cells crossing ±180°. This is a known H3 edge case; for v1 we render the WKT as returned and note the limitation. Hexagons at the poles/antimeridian may render distorted — acceptable for v1.

## Data flow

1. User opens Processing → Vector Tools, selects an H3 tool, sets parameters.
2. `VectorToolsDialog` builds `ProcessingContext` including `duckdb` capability and (for viewport) current map bounds.
3. Tool `run(ctx)`: `await ctx.duckdb.ensureExtensions(['spatial','h3'])`, build WKT/SQL via helpers, `query` (and `registerGeoJson`/`release` for the polyfill and bin paths), assemble `FeatureCollection`, `ctx.addResultLayer(name, fc)`.
4. `addResultLayer` → `addGeoJsonLayer` → store → `MapController.syncLayers` renders it; dialog fits to the new layer.

## Error handling

- Missing `ctx.duckdb` → clear "requires DuckDB-WASM" error.
- Extension `LOAD` failure (version mismatch / network) → surface the DuckDB error in the dialog log; reset the memoized promise so a retry can succeed.
- Empty area / no points / zero cells → log "No features produced" (existing `addResultLayer` already guards empty FCs).
- Resolution out of range or over the hard cap → validation error before query.

## Testing

In `tests/` (frontend `node --test`):
- WKT builders: bbox → rectangle WKT; viewport bounds → WKT.
- SQL builders for both tools (correct function names, parameter substitution, agg-op branching, `count` with no field).
- Auto-resolution math: known area → expected resolution; monotonicity; hard-cap enforcement.
- DuckDB capability is mocked (returns canned rows) to test the FeatureCollection assembly without DuckDB.

Manual verification (desktop dev): load a polygon layer, create grid (each of the 3 sources); load a point layer, bin with count and with a sum field; confirm extension loads and grids render.

## Feasibility — verified (2026-06-12)

- Installed `@duckdb/duckdb-wasm` is `1.33.1-dev45.0`, which wraps **DuckDB core v1.5.1**.
- The `h3` community extension is published for v1.5.1 on all WASM platforms — `wasm_eh`, `wasm_mvp`, and `wasm_threads` (`https://community-extensions.duckdb.org/v1.5.1/<platform>/h3.duckdb_extension.wasm` → HTTP 200). `INSTALL h3 FROM community; LOAD h3;` is therefore valid in this app.
- All required functions exist in the extension: `h3_polygon_wkt_to_cells(wkt, res)`, `h3_cell_to_boundary_wkt(cell)`, `h3_h3_to_string(cell)`, `h3_latlng_to_cell(lat, lng, res)`. Convenience variants `h3_latlng_to_cell_string` and `h3_string_to_h3` are also available.

Residual risk: none blocking. The `LOAD h3` fetch (~MB, signature-checked) requires network on first use; surface failures in the dialog log and reset the memoized promise for retry.
