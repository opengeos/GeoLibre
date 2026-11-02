/**
 * The `crs` host URL parameter (GeoLibre#3308): a link names the CRS the map is
 * drawn in, as Settings > Map does by hand.
 *
 * Kept free of the store and the map so it is unit-testable under node. The
 * hooks that apply it are `useStartupProject`, `useProjectUrlLoader` and
 * `useMapCrsUrl`.
 */
import { normalizeMapCrs, parseMapCrsEpsgCode } from "@geolibre/core";

/** What a link's `crs` parameter asks for. */
export interface MapCrsUrlRequest {
  /** The parameter as written, for the diagnostic. */
  raw: string;
  /**
   * The normalized `preferences.map.mapCrs` value, `null` for an explicit Web
   * Mercator code (the default map, even over a project saved in a CRS), or
   * `undefined` when the value is neither a preset id nor an EPSG code.
   */
  mapCrs: string | null | undefined;
}

/**
 * Read the `crs` parameter of a query string.
 *
 * Args:
 *   search: A `window.location.search`-style query string.
 *
 * Returns:
 *   The request, or `null` when the link carries no `crs` value.
 */
export function mapCrsRequestFromSearch(search: string): MapCrsUrlRequest | null {
  const raw = new URLSearchParams(search).get("crs")?.trim();
  if (!raw) return null;
  const mapCrs = normalizeMapCrs(raw);
  if (mapCrs !== undefined) return { raw, mapCrs };
  return { raw, mapCrs: parseMapCrsEpsgCode(raw) === null ? undefined : null };
}
