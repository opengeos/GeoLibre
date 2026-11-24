import proj4 from "proj4";
import { utmZoneNumber } from "./plugins/mgrs-reference";

/**
 * UTM zone number (1-60) for a longitude. Longitudes are normalized into
 * [-180, 180) first so unwrapped (antimeridian-crossing) values still map to a
 * valid zone. Note: this uses the regular 6°-wide zones and does not apply the
 * Norway/Svalbard exceptions (32V, 31-37X); the UTM grid overlay applies them
 * through its own zone layout.
 */
export function utmZoneForLon(lon: number): number {
  const norm = (((lon + 180) % 360) + 360) % 360; // 0..360
  return Math.floor(norm / 6) + 1;
}

/**
 * UTM latitude-band letter (C-X, skipping I and O) for a latitude, or "" when
 * outside the UTM range (-80° to 84°). The northernmost band X spans 12°
 * (72°-84°) rather than the usual 8°.
 */
export function utmLatBand(lat: number): string {
  if (lat < -80 || lat > 84) return "";
  const bands = "CDEFGHJKLMNPQRSTUVWX";
  const idx = Math.min(Math.floor((lat + 80) / 8), bands.length - 1);
  return bands[idx];
}

/** UTM zone designation such as "37T" for a longitude/latitude. */
export function utmZoneDesignation(lon: number, lat: number): string {
  return `${utmZoneForLon(lon)}${utmLatBand(lat)}`;
}

/** proj4 definition string for a WGS84 UTM zone (northern or southern). */
export function utmProjDef(zone: number, south: boolean): string {
  return `+proj=utm +zone=${zone}${
    south ? " +south" : ""
  } +datum=WGS84 +units=m +no_defs +type=crs`;
}

/**
 * A point's full UTM coordinate: zone number, latitude band, hemisphere, and
 * easting/northing in metres.
 */
export interface UtmCoordinate {
  zone: number;
  band: string;
  south: boolean;
  easting: number;
  northing: number;
}

/**
 * Project a lng/lat to its UTM zone's easting/northing.
 *
 * Shared with the status bar's coordinate readout (issue #1814) so the grid the
 * user sees and the numbers they read come from one projection, rather than the
 * grid using proj4 here and the readout re-deriving UTM somewhere else.
 *
 * Returns null outside UTM's valid latitude range (-80 to 84) or when proj4
 * cannot project the point, so callers can fall back rather than print a
 * meaningless number. The zone follows {@link utmZoneNumber}, the rule MGRS uses,
 * so the Norway/Svalbard exceptions apply (Bergen is 32V, Longyearbyen 33X) and
 * the UTM and MGRS readouts always agree on the zone.
 */
export function lngLatToUtm(lng: number, lat: number): UtmCoordinate | null {
  const band = utmLatBand(lat);
  if (!band) return null;
  const zone = utmZoneNumber(lng, lat);
  const south = lat < 0;
  try {
    const [easting, northing] = proj4("EPSG:4326", utmProjDef(zone, south), [lng, lat]) as [
      number,
      number,
    ];
    if (!Number.isFinite(easting) || !Number.isFinite(northing)) return null;
    return { zone, band, south, easting, northing };
  } catch {
    return null;
  }
}

/**
 * Inverse of {@link lngLatToUtm}: unproject a UTM easting/northing in a zone and
 * hemisphere back to lng/lat, through the same proj4 definition.
 *
 * Args:
 *   zone: UTM zone number, 1–60.
 *   south: Whether the northing is a southern-hemisphere (false-northing) value.
 *   easting: Easting in metres.
 *   northing: Northing in metres.
 *
 * Returns:
 *   `[lng, lat]` in degrees, or null for an invalid zone or when proj4 cannot
 *   unproject the values.
 */
export function utmToLngLat(
  zone: number,
  south: boolean,
  easting: number,
  northing: number,
): [number, number] | null {
  if (!Number.isInteger(zone) || zone < 1 || zone > 60) return null;
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) return null;
  try {
    const [lng, lat] = proj4(utmProjDef(zone, south), "EPSG:4326", [easting, northing]) as [
      number,
      number,
    ];
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return [lng, lat];
  } catch {
    return null;
  }
}

/** Format a UTM easting for display, e.g. `500000mE`. */
export function formatEasting(easting: number): string {
  return `${Math.round(easting)}mE`;
}

/** Format a UTM northing for display, e.g. `4649000mN`. */
export function formatNorthing(northing: number): string {
  return `${Math.round(northing)}mN`;
}
