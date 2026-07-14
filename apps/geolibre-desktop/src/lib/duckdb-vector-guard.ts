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
export const DUCKDB_VECTOR_FEATURE_WARN_COUNT = 500_000;

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
