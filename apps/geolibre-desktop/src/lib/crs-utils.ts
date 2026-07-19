/**
 * Small CRS helpers shared across data-loading modules. Kept in a neutral place
 * (rather than in a feature-specific module like `delimited-text.ts`) so both
 * the generic DuckDB vector loader and the delimited-text importer can depend on
 * it without a backwards feature-to-generic dependency.
 */

/**
 * True when `crs` denotes WGS84 longitude/latitude (or is blank), so the parsed
 * coordinates are already in the +/-180 / +/-90 range MapLibre expects and need
 * no reprojection. A projected CRS (e.g. `EPSG:32643`) returns `false`: its
 * coordinates are metres, must skip the lon/lat bounds check, and are
 * reprojected to WGS84 by the caller before the layer is added.
 *
 * @param crs - A CRS as `AUTHORITY:CODE` (e.g. `EPSG:4326`), a WGS84 alias
 *   (`CRS84`), or blank.
 * @returns `true` for a blank/WGS84 CRS, `false` for any other declared CRS.
 */
export function isGeographicCrs(crs: string | undefined): boolean {
  // Strip all whitespace before matching so a free-text CRS with a stray space
  // (e.g. `EPSG: 4326`) is still recognized as WGS84 rather than mistaken for a
  // projected CRS, which would skip the lon/lat bounds check and trigger a
  // needless reprojection round-trip.
  const value = (crs ?? "").replace(/\s+/g, "").toUpperCase();
  if (!value) return true;
  return value.includes("CRS84") || /EPSG:+4326\b/.test(value);
}
