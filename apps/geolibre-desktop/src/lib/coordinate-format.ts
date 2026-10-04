/**
 * Coordinate formatting for the status-bar readout (issue #1814).
 *
 * GeoLibre could already *parse* DD/DMS/DDM on input (the Set View dialog) and
 * *draw* a UTM grid (the Gridlines overlay), but it could only ever *report* a
 * coordinate in decimal degrees. So a user could see a UTM grid over the map
 * and type a DMS coordinate to fly somewhere, yet had no way to point at a
 * feature and read its coordinate in either. This module is the missing third
 * side: one place that renders a coordinate in whichever format the user picked.
 *
 * Neither conversion is reimplemented here. DMS/DDM come from `./dms`, which
 * the Set View dialog already uses, and UTM comes from `lngLatToUtm` in the
 * Gridlines plugin, which is the same proj4 projection that draws the grid
 * lines — so the numbers in the status bar always agree with the grid on screen.
 *
 * Issue #2858 added MGRS and USNG grid references (from the `mgrs` package,
 * through the plugins' `mgrs-reference` module) and x/y in any EPSG CRS (from
 * the same offline EPSG tables `epsg-proj4.ts` resolves for WMS and GML
 * reprojection).
 */

// Imported from the plugin's own subpath rather than the package barrel: the
// barrel pulls in every plugin (Earth Engine among them), which a small
// formatter has no business loading.
import { formatEasting, formatNorthing, lngLatToUtm } from "@geolibre/plugins/maplibre-graticule";
import { lngLatToMgrs, mgrsToUsng } from "@geolibre/plugins/mgrs-reference";
import { decimalToDdmAxis, decimalToDmsAxis } from "./dms";
import { resolveEpsgProjection } from "./epsg-proj4";

/** Coordinate notations the status bar can display. */
export const COORDINATE_FORMATS = ["dd", "dms", "ddm", "utm", "mgrs", "usng", "epsg"] as const;

export type CoordinateFormat = (typeof COORDINATE_FORMATS)[number];

/** Coerce an unknown/missing stored value to a valid format. */
export function normalizeCoordinateFormat(value: unknown): CoordinateFormat {
  return COORDINATE_FORMATS.includes(value as CoordinateFormat)
    ? (value as CoordinateFormat)
    : "dd";
}

/** EPSG code the `"epsg"` format uses until the user picks one: Web Mercator. */
export const DEFAULT_COORDINATE_EPSG_CODE = 3857;

/**
 * Coerce a stored EPSG code to a usable one.
 *
 * Args:
 *   value: The stored `coordinateEpsgCode` preference, of unknown shape.
 *
 * Returns:
 *   The code when it is a positive integer, else {@link DEFAULT_COORDINATE_EPSG_CODE}.
 */
export function normalizeCoordinateEpsgCode(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_COORDINATE_EPSG_CODE;
}

/**
 * Parse an EPSG code as typed into a text field (`3857`, `EPSG:3857`,
 * `epsg 32618`).
 *
 * Args:
 *   text: The typed text.
 *
 * Returns:
 *   The positive integer code, or null when the text is not one.
 */
export function parseEpsgCodeInput(text: string): number | null {
  const match = /^(?:EPSG\s*:*\s*)?(\d{1,6})$/i.exec(text.trim());
  if (!match) return null;
  const code = Number(match[1]);
  return code > 0 ? code : null;
}

/**
 * A resolved projection the `"epsg"` format formats through. Resolving one is
 * asynchronous (the EPSG tables and proj4 load on first use), so the caller
 * builds it with {@link createProjectedReadout} and passes it to
 * {@link formatCoordinate}, which stays synchronous for the pointer-move path.
 */
export interface ProjectedReadout {
  /** The EPSG code this readout projects into. */
  code: number;
  /** Whether the CRS is geographic, so its values are degrees, not metres. */
  geographic: boolean;
  /** Project a WGS84 lng/lat to the CRS's x/y (easting/northing order). */
  forward: (lng: number, lat: number) => [number, number];
}

/**
 * Resolve an EPSG code into a readout projection.
 *
 * Args:
 *   code: The EPSG code, e.g. 3857 or 32618.
 *
 * Returns:
 *   The readout, or null when the bundled EPSG tables do not know the code.
 */
export async function createProjectedReadout(code: number): Promise<ProjectedReadout | null> {
  const projection = await resolveEpsgProjection(code);
  if (!projection) return null;
  try {
    const converter = projection.proj4("EPSG:4326", projection.definition);
    return {
      code,
      geographic: projection.geographic,
      forward: (lng, lat) => converter.forward([lng, lat]) as [number, number],
    };
  } catch {
    return null;
  }
}

/** Options for {@link formatCoordinate}. */
export interface FormatCoordinateOptions {
  /**
   * The projection for the `"epsg"` format. Absent or null (still resolving, or
   * an unknown code) falls back to decimal degrees.
   */
  projected?: ProjectedReadout | null;
}

/** The next format in the cycle, for click-to-switch on the readout. */
export function nextCoordinateFormat(current: CoordinateFormat): CoordinateFormat {
  const index = COORDINATE_FORMATS.indexOf(current);
  return COORDINATE_FORMATS[(index + 1) % COORDINATE_FORMATS.length];
}

function formatDms(value: number, axis: "lat" | "lon"): string {
  const { deg, min, sec, dir } = decimalToDmsAxis(value, axis);
  return `${deg}°${min}'${sec}"${dir}`;
}

function formatDdm(value: number, axis: "lat" | "lon"): string {
  const { deg, min, dir } = decimalToDdmAxis(value, axis);
  return `${deg}°${min}'${dir}`;
}

/**
 * Render a coordinate in the requested notation.
 *
 * Ordering follows each notation's own convention rather than being forced to
 * match: decimal degrees stay lng/lat (the order the rest of the app and every
 * GeoJSON use), while DMS and DDM lead with latitude, which is how those are
 * conventionally written and spoken.
 *
 * UTM falls back to decimal degrees outside its valid latitude range (-80 to
 * 84) — the poles have no UTM coordinate, and printing one anyway would be a
 * confident lie. The same fallback covers a projection failure. MGRS and USNG
 * do the same at the poles, where the grid switches to UPS (A/B/Y/Z), which
 * the `mgrs` package does not implement. The `"epsg"` format falls back while
 * its projection is still resolving, for an unknown code, and where the CRS
 * cannot project the point (proj4 can return non-finite values outside a
 * projection's domain).
 *
 * Args:
 *   rawLng: Longitude in degrees; values past the antimeridian are wrapped.
 *   lat: Latitude in degrees.
 *   format: The notation.
 *   options: The projection for the `"epsg"` format.
 *
 * Returns:
 *   The formatted coordinate.
 */
export function formatCoordinate(
  rawLng: number,
  lat: number,
  format: CoordinateFormat,
  options: FormatCoordinateOptions = {},
): string {
  // MapLibre does not wrap `lngLat.lng` after the user pans past the
  // antimeridian, so it can arrive as 190 or -190. Decimal degrees tolerate
  // that, but DMS would render "190°0'0\"E" and UTM would resolve a zone that
  // does not exist, so normalise once here rather than in each branch.
  const lng = ((((rawLng + 180) % 360) + 360) % 360) - 180;
  switch (format) {
    case "dms":
      return `${formatDms(lat, "lat")} ${formatDms(lng, "lon")}`;
    case "ddm":
      return `${formatDdm(lat, "lat")} ${formatDdm(lng, "lon")}`;
    case "utm": {
      const utm = lngLatToUtm(lng, lat);
      if (!utm) return formatCoordinate(lng, lat, "dd");
      // Reuses the grid overlay's own easting/northing formatters, so the
      // readout and the grid labels round and suffix identically.
      return `${utm.zone}${utm.band} ${formatEasting(utm.easting)} ${formatNorthing(utm.northing)}`;
    }
    case "mgrs":
    case "usng": {
      const reference = lngLatToMgrs(lng, lat, 5);
      if (!reference) return formatCoordinate(lng, lat, "dd");
      return format === "usng" ? mgrsToUsng(reference) : reference;
    }
    case "epsg": {
      const projected = options.projected;
      if (!projected) return formatCoordinate(lng, lat, "dd");
      let xy: [number, number];
      try {
        xy = projected.forward(lng, lat);
      } catch {
        return formatCoordinate(lng, lat, "dd");
      }
      const [x, y] = xy;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return formatCoordinate(lng, lat, "dd");
      // Degrees get one more place than the decimal-degree readout (~0.1 m);
      // projected units (metres, or feet for some national grids) get two
      // places, finer than a pointer can resolve.
      const digits = projected.geographic ? 6 : 2;
      return `${x.toFixed(digits)}, ${y.toFixed(digits)} (EPSG:${projected.code})`;
    }
    case "dd":
    default:
      // `default` also catches a value that bypassed normalizeCoordinateFormat;
      // the explicit case keeps the switch self-documenting so a fifth format
      // added without a branch reads as a gap rather than as intended.
      return `${lng.toFixed(5)}, ${lat.toFixed(5)}`;
  }
}
