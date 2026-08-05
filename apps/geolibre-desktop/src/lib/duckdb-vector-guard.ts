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

/**
 * V8 caps a single JavaScript string at `2**29 - 24` bytes (~537 MB) —
 * `require("buffer").constants.MAX_STRING_LENGTH`. A text vector file at or
 * above this size cannot be read into a string at all: `readTextFile` /
 * `File.text()` throw `RangeError: Invalid string length` before `JSON.parse`
 * ever runs. Loaders check this **before** reading so an oversized GeoJSON/KML/
 * GPX/CSV skips the doomed text parse and goes straight to the DuckDB reader,
 * which streams from the file rather than materializing one giant string.
 *
 * Without the check the RangeError is swallowed by the loaders' `catch` blocks
 * and the file is re-read through DuckDB anyway, with nothing in the log saying
 * why. Measured on an 873 MB GeoJSON in the browser the wasted attempt costs
 * only ~2s — `File.text()` fails on the known size rather than after reading —
 * so the value here is the explicit route and the breadcrumb, not the time. The
 * Tauri path (`readTextFile` over IPC) has not been measured and may pay more.
 */
export const MAX_TEXT_VECTOR_BYTES = 536_870_888;

/**
 * Local vector files at or above this size prompt a confirmation before any
 * reading begins. This is the byte-size counterpart to
 * {@link DUCKDB_VECTOR_FEATURE_WARN_COUNT}, which can only be evaluated after
 * the source is already open — by which point a half-gigabyte file has already
 * been read into memory. Mirrors `OSM_PBF_SIZE_WARN_BYTES` (`osm-pbf-loader.ts`)
 * but sits higher, since ordinary vector formats are cheaper per byte than an
 * OSM extract.
 */
export const LARGE_VECTOR_SIZE_WARN_BYTES = 200 * 1024 * 1024; // 200 MB

/**
 * Uncompressed `.shp` size at or above which a zipped shapefile skips shpjs and
 * loads through DuckDB instead.
 *
 * shpjs's `parseShp` is fully synchronous and applies the `.prj` proj4
 * transform **per coordinate**, so a large polygon shapefile wedges the main
 * thread with no progress and no way to cancel. DuckDB does the read off the
 * main thread (native on desktop, the DuckDB-WASM worker in the browser) and
 * reports a feature count first, so {@link DUCKDB_VECTOR_FEATURE_WARN_COUNT}
 * gets a chance to fire.
 *
 * This trades total time for responsiveness rather than being a pure win.
 * Measured on a 197 MB / 170k-polygon `.shp` in the browser: with a projected
 * `.prj` the worst main-thread stall drops from 8.9s to 1.6s while the whole
 * load goes from 10.3s to 13.3s; with an already-WGS84 `.prj` (where proj4 is
 * nearly free) it is 4.7s → 1.9s of stall for 6.1s → 10.3s overall. A UI that
 * keeps responding is worth the extra seconds; a nine-second freeze reads as a
 * crash.
 *
 * Below the threshold shpjs stays the default: it is faster end to end for
 * ordinary files and preserves field-name fidelity without a DuckDB round-trip.
 */
export const MAX_SHPJS_SHP_BYTES = 64 * 1024 * 1024; // 64 MB

/** Details passed to {@link DuckDbVectorLoadOptions.onLargeDataset}. */
export interface LargeVectorDataset {
  /** The file/layer name shown to the user. */
  name: string;
  /** Total feature (row) count DuckDB reported for the source. */
  featureCount: number;
}

/** Details passed to {@link DuckDbVectorLoadOptions.onLargeFile}. */
export interface LargeVectorFile {
  /** The file name shown to the user. */
  name: string;
  /** The file's size on disk, in bytes. */
  sizeBytes: number;
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
   * Invoked when the file's size on disk is at least
   * {@link LARGE_VECTOR_SIZE_WARN_BYTES}, before a single byte is read. Return
   * `false` (or a promise resolving to `false`) to abort the load — the loader
   * then throws {@link VectorLoadCancelledError}, which callers catch to skip
   * the file. When omitted, large files load without prompting, matching
   * {@link onLargeDataset}'s non-interactive default.
   *
   * This is the only guard that can run before the expensive read, so it is the
   * one that catches the case {@link onLargeDataset} cannot: a file too large to
   * open at all.
   */
  onLargeFile?: (file: LargeVectorFile) => boolean | Promise<boolean>;
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
 * Byte-size counterpart to {@link confirmLargeDataset}, run before the file is
 * read. A no-op below {@link LARGE_VECTOR_SIZE_WARN_BYTES}, when no callback is
 * attached, or when the size is unknown (a `stat` that failed — an unreadable
 * file surfaces its own error at read time, and refusing to guess a size is
 * better than blocking a load on a metadata hiccup).
 */
export async function confirmLargeVectorFile(
  file: LargeVectorFile | undefined,
  onLargeFile: DuckDbVectorLoadOptions["onLargeFile"],
): Promise<void> {
  if (!onLargeFile || !file) return;
  if (file.sizeBytes < LARGE_VECTOR_SIZE_WARN_BYTES) return;
  const proceed = await onLargeFile(file);
  if (!proceed) throw new VectorLoadCancelledError();
}

/**
 * Whether a file of this size is too large to read into a single JS string, and
 * so must skip the text-parsing branch entirely. An unknown size (undefined)
 * reads as "not too large" so a failed `stat` leaves the existing behaviour
 * untouched rather than diverting every file to DuckDB.
 *
 * @see MAX_TEXT_VECTOR_BYTES
 */
export function exceedsTextVectorLimit(sizeBytes: number | undefined): boolean {
  return sizeBytes !== undefined && sizeBytes >= MAX_TEXT_VECTOR_BYTES;
}
