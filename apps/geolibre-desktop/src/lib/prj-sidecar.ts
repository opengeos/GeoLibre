/**
 * The `.prj` sidecar CRS fallback, kept in its own module (free of the
 * DuckDB-WASM import) so it can be unit-tested under `node --test`, which cannot
 * load `duckdb-vector-loader`'s wasm dependency.
 */

/** The minimal shape {@link prjSidecarCrs} reads: the file and its siblings. */
export interface PrjSidecarSource {
  /** The main file's lowercased extension (the fallback is `.shp`-only). */
  extension: string;
  siblingFiles?: ReadonlyArray<{ extension: string; data: Uint8Array }>;
}

/**
 * The CRS a shapefile's `.prj` sidecar carries, as its raw WKT text, or null
 * when the main file is not a `.shp`, or it has no (non-empty) `.prj`. Used as
 * the last-resort reprojection source when ST_Read_Meta cannot report the CRS:
 * ST_Transform accepts a `.prj`'s WKT string as a source CRS just as it does an
 * `AUTHORITY:CODE` (issue #1148).
 *
 * Scoped to shapefiles (mirroring the native path's `extension == "shp"` guard)
 * so an unrelated `.prj` co-selected with a non-shapefile main file cannot be
 * mistaken for its CRS.
 *
 * Must be read BEFORE the file buffers are registered with DuckDB, which hands
 * each sibling's buffer to the worker as a transferable and so detaches it —
 * afterwards `sibling.data` is a zero-length view and the WKT is lost.
 */
export function prjSidecarCrs(file: PrjSidecarSource): string | null {
  if (file.extension !== "shp") return null;
  const prj = file.siblingFiles?.find((sibling) => sibling.extension === "prj");
  if (!prj) return null;
  const text = new TextDecoder().decode(prj.data).trim();
  return text || null;
}
