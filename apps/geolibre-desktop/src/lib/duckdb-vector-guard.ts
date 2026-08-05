/**
 * Large-dataset guard for the DuckDB vector ingestion path.
 *
 * Kept in its own module — free of the DuckDB-WASM `?url` imports that
 * `duckdb-vector-loader.ts` carries — so the threshold, types, and decision
 * logic can be imported by the eagerly-loaded UI shell and unit-tested under
 * `node --test` without pulling the WASM engine into the bundle/test.
 */

/**
 * Sources whose feature (row) count reaches this threshold prompt a
 * confirmation before {@link loadDuckDbVectorFile} materializes every row as a
 * GeoJSON Feature in memory — each row is JSON-parsed and turned into its own
 * object, so a multi-million-row file can exhaust browser memory or wedge the
 * tab. This is the DuckDB ingestion counterpart to `OSM_PBF_SIZE_WARN_BYTES`
 * (`osm-pbf-loader.ts`); unlike a raw byte size it is accurate for compressed
 * formats like GeoParquet, where a small file can hold millions of rows.
 */
export const DUCKDB_VECTOR_FEATURE_WARN_COUNT = 100_000;

/**
 * Local vector files at or above this size skip the in-memory JavaScript
 * readers and stream through DuckDB instead.
 *
 * The JS readers all materialize the whole file on the main thread before
 * yielding anything: `JSON.parse` over one giant string for GeoJSON, and shpjs's
 * `parseShp`, which is fully synchronous and applies the `.prj` proj4 transform
 * **per coordinate**. Past this size that is a visible freeze with no progress
 * and no way to cancel. DuckDB reads off the main thread (native on desktop, the
 * DuckDB-WASM worker in the browser) and reports a feature count first, so
 * {@link DUCKDB_VECTOR_FEATURE_WARN_COUNT} gets a chance to fire.
 *
 * One threshold covers every format. For a zipped shapefile it is measured on
 * the **uncompressed** `.shp`, which is what governs the parse cost — shapefiles
 * compress heavily, so the archive's own size says little about it.
 *
 * Routing trades total time for responsiveness rather than being a pure win.
 * Measured on a 197 MB / 170k-polygon `.shp` in the browser: with a projected
 * `.prj` the worst main-thread stall drops from 8.9s to 1.6s while the whole
 * load goes from 10.3s to 13.3s; with an already-WGS84 `.prj` (where proj4 is
 * nearly free) it is 4.7s → 1.9s of stall for 6.1s → 10.3s overall. A UI that
 * keeps responding is worth the extra seconds; a nine-second freeze reads as a
 * crash. Below the threshold the JS readers stay the default: they are faster
 * end to end and preserve field-name fidelity without a DuckDB round-trip.
 *
 * This also subsumes a hard engine limit. V8 caps a single string at
 * `2**29 - 24` bytes (~537 MB), so a text file at or above *that* size could
 * never be read by the text path at all — `readTextFile` / `File.text()` throw
 * `RangeError: Invalid string length` before `JSON.parse` runs. Since 100 MB is
 * far below the cap, such files are already routed away and the RangeError is
 * now unreachable.
 */
export const DUCKDB_VECTOR_ROUTE_BYTES = 100 * 1024 * 1024; // 100 MB

/** Details passed to {@link DuckDbVectorLoadOptions.onLargeDataset}. */
export interface LargeVectorDataset {
  /** The file/layer name shown to the user. */
  name: string;
  /** Total feature (row) count DuckDB reported for the source. */
  featureCount: number;
}

export interface DuckDbVectorLoadOptions {
  /**
   * Invoked when the source's feature count is at least
   * {@link DUCKDB_VECTOR_FEATURE_WARN_COUNT}, before the expensive GeoJSON
   * materialization. Return `false` (or a promise resolving to `false`) to
   * abort the load — the loader then throws {@link VectorLoadCancelledError},
   * which callers can catch to skip the file. When this callback is omitted,
   * large datasets load without prompting; this preserves the non-interactive
   * behaviour relied on by KMZ sub-loads and tests, and keeps the load
   * single-pass (the extra `COUNT(*)` is only run when a guard is attached).
   */
  onLargeDataset?: (dataset: LargeVectorDataset) => boolean | Promise<boolean>;
  /**
   * Read a specific OGR layer from a multi-layer source (e.g. a CAD DWG with
   * several layers) by passing its name to `ST_Read(..., layer=...)`. When
   * omitted, `ST_Read` reads the first layer, matching its default. Ignored for
   * Parquet sources, which have no layer concept.
   *
   * Note: this selects which geometry is read, not which layer's CRS is
   * discovered — `readSourceCrs` always inspects the first layer. Callers that
   * need a non-first layer's CRS must supply {@link overrideSourceCrs}.
   */
  layer?: string;
  /**
   * Treat the source geometry as this CRS (an `AUTHORITY:CODE` string such as
   * `EPSG:26915`) and reproject it to WGS84, overriding any CRS read from the
   * file. Used for formats that carry no CRS metadata of their own (CAD
   * DXF/DWG), where the user supplies the coordinate system. A blank value
   * falls back to the file's own CRS.
   */
  overrideSourceCrs?: string;
  /**
   * Skip the KML/KMZ `<Model>` (COLLADA→GLB) conversion, returning only the
   * vector features. Set by callers that discard models anyway — e.g. re-reading
   * a referenced (not embedded) local layer's features on project reopen — so
   * they don't pay for the expensive conversion (or a remote-mesh fetch) they
   * never use.
   */
  skipModels?: boolean;
}

/**
 * Thrown by {@link loadDuckDbVectorFile} when the user declines to load a file
 * whose feature count exceeds {@link DUCKDB_VECTOR_FEATURE_WARN_COUNT}. Callers
 * iterating over several dropped files catch this to skip the declined file
 * without aborting the rest of the batch.
 */
export class VectorLoadCancelledError extends Error {
  constructor(message = "Vector load cancelled by the user.") {
    super(message);
    this.name = "VectorLoadCancelledError";
  }
}

/**
 * Run the large-dataset guard: when `featureCount` meets the warn threshold and
 * a callback is supplied, ask whether to proceed and throw
 * {@link VectorLoadCancelledError} if the user declines. A no-op below the
 * threshold or when no callback is attached. Pure (no DuckDB) so the guard
 * logic can be unit-tested directly.
 */
export async function confirmLargeDataset(
  dataset: LargeVectorDataset,
  onLargeDataset: DuckDbVectorLoadOptions["onLargeDataset"],
): Promise<void> {
  if (!onLargeDataset) return;
  if (dataset.featureCount < DUCKDB_VECTOR_FEATURE_WARN_COUNT) return;
  const proceed = await onLargeDataset(dataset);
  if (!proceed) throw new VectorLoadCancelledError();
}

/**
 * Whether a file of this size should skip the in-memory JavaScript readers and
 * stream through DuckDB instead. An unknown size (undefined) reads as "small",
 * so a failed `stat` leaves the existing behaviour untouched rather than
 * diverting every file to DuckDB on a metadata hiccup.
 *
 * @see DUCKDB_VECTOR_ROUTE_BYTES
 */
export function shouldRouteToDuckDb(sizeBytes: number | undefined): boolean {
  return sizeBytes !== undefined && sizeBytes >= DUCKDB_VECTOR_ROUTE_BYTES;
}
