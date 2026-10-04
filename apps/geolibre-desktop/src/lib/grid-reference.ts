/**
 * Grid-reference input for the place search (issue #2858): MGRS, USNG and UTM
 * typed into the search box resolve locally to a lng/lat, the way lat/lon text
 * (`coordinates.ts`) and H3 cells (`h3-search.ts`) already do.
 *
 * Both conversions are shared rather than reimplemented: MGRS/USNG decode
 * through the plugins' `mgrs-reference` module (the same one the status-bar
 * readout formats with) and UTM unprojects through the Gridlines plugin's own
 * proj4 definition, so a coordinate copied out of the readout searches back to
 * the point it was read at.
 */

import { utmToLngLat } from "@geolibre/plugins/maplibre-graticule";
import { parseMgrsReference } from "@geolibre/plugins/mgrs-reference";

/** A grid reference resolved to a point. */
export interface GridReferenceMatch {
  /** Which grid the text was read as. */
  kind: "mgrs" | "utm";
  lat: number;
  lon: number;
  /**
   * The reference in a normalized spelling for display: compact MGRS
   * (`18SUJ2337106519`) or `zone+letter easting northing` for UTM.
   */
  label: string;
}

/** Latitude-band letters, south to north (C–X without I and O). */
const BANDS = "CDEFGHJKLMNPQRSTUVWX";

/**
 * Zone, a band or hemisphere letter, easting, northing. Separators are spaces
 * and/or commas, and the `mE`/`mN` suffixes the status-bar readout prints are
 * accepted, so `18S 323394mE 4307395mN` reads back as well as
 * `18N 323394 4307395`.
 */
const UTM_RE =
  /^(\d{1,2})\s*([A-Z])[\s,]+(\d{1,7}(?:\.\d+)?)\s*(?:M?E)?[\s,]+(\d{1,8}(?:\.\d+)?)\s*(?:M?N)?$/;

/** Plausible UTM eastings: a zone is ~668 km wide around the 500 km false easting. */
const MIN_EASTING = 100_000;
const MAX_EASTING = 900_000;
/** Northings run from the equator (0, or 10,000 km in the south) to the pole. */
const MAX_NORTHING = 10_000_000;

/** Slack, in degrees, when checking a decoded point against its band. */
const BAND_TOLERANCE_DEG = 1;

/** Whether a latitude lies within (or within a degree of) a UTM band. */
function inBand(lat: number, band: string): boolean {
  const index = BANDS.indexOf(band);
  if (index < 0) return false;
  const south = -80 + index * 8;
  const north = band === "X" ? 84 : south + 8;
  return lat >= south - BAND_TOLERANCE_DEG && lat <= north + BAND_TOLERANCE_DEG;
}

/**
 * Unproject a UTM easting/northing for one hemisphere, returning null when the
 * result is not a sensible UTM latitude.
 */
function utmPoint(
  zone: number,
  south: boolean,
  easting: number,
  northing: number,
): [number, number] | null {
  const point = utmToLngLat(zone, south, easting, northing);
  if (!point) return null;
  const [, lat] = point;
  if (lat < -80 - BAND_TOLERANCE_DEG || lat > 84 + BAND_TOLERANCE_DEG) return null;
  if (south ? lat > 0 : lat < 0) return null;
  return point;
}

/**
 * Parse a typed UTM coordinate such as `18N 323394 4307395` or the status-bar
 * readout's `18S 323394mE 4307395mN`.
 *
 * The letter after the zone is read as a latitude band (C–X), which is what the
 * readout prints and which also settles the hemisphere: C–M are south, N–X
 * north. Two letters are also hemisphere abbreviations, so they get a fallback:
 *
 * - `N` always means north. As a band it would pin the point to 0°–8°N, but as
 *   a hemisphere it allows any northern latitude, and both are the north.
 * - `S` is band S (32°N–40°N) when the northing lands in that band, and the
 *   southern hemisphere otherwise. A northing that fits both (band S and some
 *   latitude far south) is read as the band, matching the readout's spelling.
 *
 * Any other letter must agree with the decoded latitude (within a degree), so a
 * mistyped band does not jump somewhere arbitrary.
 *
 * Args:
 *   text: The text to parse.
 *
 * Returns:
 *   The point, or null when the text is not a valid UTM coordinate.
 */
export function parseUtmReference(text: string): GridReferenceMatch | null {
  const match = UTM_RE.exec(text.trim().toUpperCase());
  if (!match) return null;
  const zone = Number(match[1]);
  const letter = match[2];
  const easting = Number(match[3]);
  const northing = Number(match[4]);
  if (zone < 1 || zone > 60) return null;
  if (!BANDS.includes(letter)) return null;
  if (easting < MIN_EASTING || easting > MAX_EASTING) return null;
  if (northing < 0 || northing > MAX_NORTHING) return null;

  let point: [number, number] | null;
  if (letter === "N") {
    point = utmPoint(zone, false, easting, northing);
  } else if (letter === "S") {
    const north = utmPoint(zone, false, easting, northing);
    point = north && inBand(north[1], "S") ? north : utmPoint(zone, true, easting, northing);
  } else {
    const south = BANDS.indexOf(letter) < BANDS.indexOf("N");
    point = utmPoint(zone, south, easting, northing);
    if (point && !inBand(point[1], letter)) return null;
  }
  if (!point) return null;
  const [lon, lat] = point;
  return {
    kind: "utm",
    lat,
    lon,
    label: `${zone}${letter} ${match[3]} ${match[4]}`,
  };
}

/**
 * Parse a typed MGRS or USNG reference (see `parseMgrsReference`).
 *
 * Args:
 *   text: The text to parse.
 *
 * Returns:
 *   The centre of the referenced square, or null when the text is not one.
 */
export function parseMgrsInput(text: string): GridReferenceMatch | null {
  const reference = parseMgrsReference(text);
  if (!reference) return null;
  return { kind: "mgrs", lat: reference.lat, lon: reference.lng, label: reference.mgrs };
}

/**
 * Parse text as any supported grid reference: MGRS/USNG first, then UTM. The
 * two cannot be confused (MGRS has two square letters after the band, UTM a
 * separated easting and northing), so the order only decides which parser runs
 * first.
 *
 * Args:
 *   text: The text to parse.
 *
 * Returns:
 *   The resolved point, or null when the text is neither.
 */
export function parseGridReference(text: string): GridReferenceMatch | null {
  return parseMgrsInput(text) ?? parseUtmReference(text);
}
