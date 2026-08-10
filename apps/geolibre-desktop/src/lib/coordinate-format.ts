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
 */

// Imported from the plugin's own subpath rather than the package barrel: the
// barrel pulls in every plugin (Earth Engine among them), which a small
// formatter has no business loading.
import { formatEasting, formatNorthing, lngLatToUtm } from "@geolibre/plugins/maplibre-graticule";
import { decimalToDdmAxis, decimalToDmsAxis } from "./dms";

/** Coordinate notations the status bar can display. */
export const COORDINATE_FORMATS = ["dd", "dms", "ddm", "utm"] as const;

export type CoordinateFormat = (typeof COORDINATE_FORMATS)[number];

/** Coerce an unknown/missing stored value to a valid format. */
export function normalizeCoordinateFormat(value: unknown): CoordinateFormat {
  return COORDINATE_FORMATS.includes(value as CoordinateFormat)
    ? (value as CoordinateFormat)
    : "dd";
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
 * confident lie. The same fallback covers a projection failure.
 */
export function formatCoordinate(rawLng: number, lat: number, format: CoordinateFormat): string {
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
    case "dd":
    default:
      // `default` also catches a value that bypassed normalizeCoordinateFormat;
      // the explicit case keeps the switch self-documenting so a fifth format
      // added without a branch reads as a gap rather than as intended.
      return `${lng.toFixed(5)}, ${lat.toFixed(5)}`;
  }
}
