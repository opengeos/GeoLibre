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

/**
 * Reads the name of a legacy top-level GeoJSON `crs` member when it declares a
 * projected (non-WGS84) CRS, or null otherwise.
 *
 * RFC 7946 mandates WGS84 for GeoJSON, but GDAL/QGIS still emit the pre-RFC form
 * with a `"crs": { "type": "name", "properties": { "name": "urn:ogc:def:crs:EPSG::26911" } }`
 * member and coordinates in the projected CRS. Such coordinates (metres) cannot
 * be rendered by MapLibre and must be reprojected to WGS84 first. A member that
 * is absent, malformed, or already WGS84/CRS84 returns null so the caller keeps
 * the cheap, DuckDB-free path.
 *
 * The returned name is handed as-is to `reprojectFeatureCollectionToWgs84`,
 * which parses the EPSG code from it, so both the URN and short forms work.
 *
 * @param value - A parsed GeoJSON object that may carry a `crs` member
 * @returns The projected CRS name to reproject from, or null when none is needed
 */
export function projectedGeoJsonCrs(value: unknown): string | null {
  const name = (value as { crs?: { properties?: { name?: unknown } } })?.crs?.properties?.name;
  if (typeof name !== "string") return null;
  return isGeographicCrs(name) ? null : name;
}
