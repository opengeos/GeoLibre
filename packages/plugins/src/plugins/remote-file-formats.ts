/**
 * What GeoLibre can do with a remote data file, decided from its path and size.
 *
 * Every "browse a remote bucket and put a file on the map" panel — Source
 * Cooperative, Hugging Face — has to answer the same three questions before it
 * can draw a card: what format is this, which reader would open it, and is it
 * small enough for that reader to manage. The answers are facts about
 * *GeoLibre's readers*, not about any one host, so they live here once instead
 * of being re-derived (and drifting) per panel. In particular
 * {@link MAX_VECTOR_BYTES} mirrors a constant inside `maplibre-gl-vector` that
 * has to be re-checked on every bump of that package; a second copy elsewhere
 * would silently miss that check.
 *
 * Deliberately DOM-free and framework-free so it can be unit tested under
 * `node --test`.
 */

/**
 * A data format GeoLibre can act on. Everything GeoLibre cannot render is
 * `other` and offers download only.
 */
export type RemoteFileFormat =
  | "pmtiles"
  | "geoparquet"
  | "cog"
  | "geojson"
  | "flatgeobuf"
  | "gpkg"
  | "csv"
  | "other";

/** How a vector file is read into DuckDB. Mirrors `IngestMode` in maplibre-gl-vector. */
export type RemoteIngestMode = "table" | "stream";

/** Guards a value before it reaches an `<a href>` or a map source. */
export const HTTP_URL_RE = /^https?:\/\//i;

/**
 * Extension → format, first match wins. The patterns are mutually exclusive, so
 * the order is presentational rather than load-bearing. Note `.geo.json` needs
 * its own rule: the `geojson` alternative below requires that literal token, so
 * it does not match a `.geo.json` suffix.
 */
const FORMAT_BY_EXTENSION: [RegExp, RemoteFileFormat][] = [
  [/\.pmtiles$/i, "pmtiles"],
  [/\.(geo)?parquet$/i, "geoparquet"],
  [/\.(tif|tiff)$/i, "cog"],
  [/\.(geojson|geojsonl|ndjson)$/i, "geojson"],
  [/\.geo\.json$/i, "geojson"],
  [/\.fgb$/i, "flatgeobuf"],
  [/\.gpkg$/i, "gpkg"],
  [/\.csv$/i, "csv"],
];

/**
 * Classifies a path by extension. Extension-based because a `HEAD` per file
 * would cost one request per row, and remote object stores mostly serve
 * `application/octet-stream` anyway.
 *
 * @param path - An object key, repo-relative path, or URL path
 * @returns The format GeoLibre will treat the file as
 */
export function classifyPath(path: string): RemoteFileFormat {
  for (const [pattern, format] of FORMAT_BY_EXTENSION) {
    if (pattern.test(path)) return format;
  }
  return "other";
}

/**
 * Which reader puts a format on the map — the one fact both {@link isAddable}
 * and {@link usesDuckDB} are really asking about:
 *
 * - `duckdb` — read through the vector control, so DuckDB-WASM's limits apply
 *   (see {@link isTooLargeToOpen}).
 * - `range` — has its own range-request reader (MapLibre's PMTiles protocol, a
 *   COG reader). Streams by nature, and none of the DuckDB limits apply.
 * - `none` — GeoLibre cannot render it; download only.
 *
 * One `Record` over the whole union rather than a set per question: adding a
 * member to {@link RemoteFileFormat} then fails to compile until it is
 * classified here, so a new format cannot silently inherit the wrong reader's
 * size rules. Deriving one set from the other would not hold — "addable" and
 * "goes through DuckDB" are independent facts about a format, and treating
 * DuckDB as everything-but-PMTiles/COG would quietly subject the next
 * range-request format to a 2 GiB gate that does not apply to it.
 */
const FORMAT_READER: Record<RemoteFileFormat, "duckdb" | "range" | "none"> = {
  pmtiles: "range",
  cog: "range",
  geoparquet: "duckdb",
  geojson: "duckdb",
  flatgeobuf: "duckdb",
  gpkg: "duckdb",
  csv: "duckdb",
  other: "none",
};

/**
 * Whether GeoLibre can put a format on the map (the rest are download-only).
 *
 * @param format - The classified format
 * @returns True when some reader renders it
 */
export function isAddable(format: RemoteFileFormat): boolean {
  return FORMAT_READER[format] !== "none";
}

/**
 * Whether a format reaches the map through the vector control, and so DuckDB-WASM.
 *
 * @param format - The classified format
 * @returns True when the file is read by DuckDB-WASM
 */
export function usesDuckDB(format: RemoteFileFormat): boolean {
  return FORMAT_READER[format] === "duckdb";
}

/**
 * Whether a file can be queried in place rather than copied into DuckDB.
 * GeoParquet only: the vector control ignores `stream` for every other format
 * and quietly falls back to a copy, so offering the choice elsewhere would be a
 * button that does nothing different.
 *
 * @param format - The classified format
 * @returns True when `stream` ingest is honoured
 */
export function canStream(format: RemoteFileFormat): boolean {
  return format === "geoparquet";
}

/**
 * Largest remote file DuckDB-WASM can open, mirroring `MAX_REMOTE_FILE_BYTES`
 * in maplibre-gl-vector. Duplicated rather than imported because the constant
 * is internal to that package; {@link isTooLargeToOpen} explains why the
 * browse panels need to know it.
 */
export const MAX_VECTOR_BYTES = 2 ** 31 - 1;

/**
 * PMTiles/COG at or above this size get a note that they stream rather than
 * download. Deliberately not applied to the DuckDB formats: those do not read
 * only the parts in view unless the user picks Stream, and at this size they do
 * not open at all.
 */
export const LARGE_FILE_BYTES = 2 * 1024 ** 3;

/**
 * GeoParquet at or above this size gets a note nudging toward Stream. A copy
 * materializes into the WASM heap and memory roughly tracks the *decompressed*
 * dataset — several times a Parquet's on-disk size — which is where a large
 * file runs the tab out of memory. Below this a copy is cheap enough that the
 * nudge would be noise; the Stream button is still offered.
 */
export const STREAM_HINT_BYTES = 100 * 1024 ** 2;

/**
 * Whether the browser cannot open a file at all, at either ingest mode.
 *
 * DuckDB-WASM's HTTP filesystem holds remote file sizes in 32 bits, so it
 * rejects anything of 2 GiB or more — and it rejects it *before* the ingest
 * mode is consulted (`_registerSource` runs ahead of the stream branch in
 * maplibre-gl-vector's DuckDBEngine), so streaming does not get past this.
 * Knowing the limit lets a panel say so up front instead of offering an Add
 * that is certain to fail.
 *
 * @param format - The classified format
 * @param size - The file size in bytes
 * @returns True when no ingest mode can open the file
 */
export function isTooLargeToOpen(format: RemoteFileFormat, size: number): boolean {
  return usesDuckDB(format) && size > MAX_VECTOR_BYTES;
}

/**
 * Which advisory line a file's card should carry, if any. The cases are
 * mutually exclusive and turn on format, because "large" means something
 * different per reader: a PMTiles/COG of any size really does read only the
 * parts in view, a DuckDB-format file past the 2 GiB limit cannot be opened at
 * either mode, and a big GeoParquet has a real choice to make.
 *
 * Returns the decision only — each panel owns the wording, which keeps this
 * module DOM- and i18n-free.
 */
export type RemoteFileNote = "none" | "streams" | "streamChoice" | "tooLarge";

/**
 * Picks the advisory note for a file.
 *
 * @param format - The classified format
 * @param size - The file size in bytes
 * @returns Which note the card should render, or `none`
 */
export function fileNote(format: RemoteFileFormat, size: number): RemoteFileNote {
  if (!isAddable(format)) return "none";
  if (isTooLargeToOpen(format, size)) return "tooLarge";
  if (!usesDuckDB(format)) {
    return size >= LARGE_FILE_BYTES ? "streams" : "none";
  }
  if (canStream(format) && size >= STREAM_HINT_BYTES) {
    return "streamChoice";
  }
  return "none";
}

/**
 * Human-readable byte size, e.g. `1.1 GB`.
 *
 * @param bytes - A size in bytes
 * @returns The formatted size, or `0 B` for a non-positive/non-finite input
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}
