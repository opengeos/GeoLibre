/**
 * MGRS / USNG grid references (issue #2858): formatting a lng/lat as a Military
 * Grid Reference System string for the status-bar readout, and parsing one typed
 * into the place search back into a lng/lat.
 *
 * The conversions themselves come from the `mgrs` package (the one the
 * satellite-embeddings grid already uses), which applies the Norway/Svalbard
 * zone exceptions and the 100 km square lettering. This module adds what that
 * package leaves to its callers: polar and out-of-range points return null
 * instead of throwing, and a typed reference is validated before it is trusted,
 * because `mgrs.toPoint` happily decodes letters that cannot occur in the given
 * zone (e.g. `18SAA…`) into a confident but meaningless coordinate.
 *
 * USNG is the same grid as MGRS on the WGS84 datum, written with spaces between
 * the zone, the 100 km square and the two numeric halves: `18S UJ 23371 06519`
 * is USNG for the MGRS reference `18SUJ2337106519`.
 *
 * The polar UPS areas (south of 80°S and north of 84°N, lettered A/B/Y/Z) are
 * not covered: `mgrs` does not implement them, so those points format to null
 * and those references do not parse.
 */

import * as mgrsModule from "mgrs";

// mgrs 2.x publishes an ESM `module` build with named exports only, and a
// minified UMD `main` whose named exports Node cannot detect (under Node the
// namespace holds just `default`). Bundlers take the first, Node and the test
// runner the second, so read the functions from whichever carries them. Same
// shim as satellite-embeddings-grids.ts.
const mgrs: typeof mgrsModule =
  "forward" in mgrsModule ? mgrsModule : (Reflect.get(mgrsModule, "default") as typeof mgrsModule);

/** Latitude-band letters, south to north (C–X without I and O). */
const BANDS = "CDEFGHJKLMNPQRSTUVWX";

/**
 * 100 km column letters per zone set. The set is `zone % 6` (6 for a multiple
 * of six), and sets 1–3 repeat for 4–6.
 */
const COLUMN_LETTERS = ["ABCDEFGH", "JKLMNPQR", "STUVWXYZ"];

/** 100 km row letters (A–V without I and O); any of them can occur in any zone. */
const ROW_LETTERS = "ABCDEFGHJKLMNPQRSTUV";

/**
 * Zone, band, square letters, then either two space-separated digit groups or
 * one run of digits. Whitespace after the band and before the digits is
 * optional, so both MGRS (`18SUJ2337106519`) and USNG (`18S UJ 23371 06519`)
 * spellings match. The zone and band stay adjacent, as both notations write
 * them: allowing a space there would read a street-address query such as
 * `1 MAD` as a 100 km square.
 */
const REFERENCE_RE = /^(\d{1,2})([A-Z])\s*([A-Z])([A-Z])\s*(?:(\d{1,5})\s+(\d{1,5})|(\d{0,10}))$/;

/**
 * Slack, in degrees, when checking a decoded square centre against its band:
 * half a square's height (a 100 km square spans ~0.9° of latitude, and its
 * centre can sit outside the band when the square straddles the band edge),
 * plus a small margin.
 */
function bandTolerance(precision: number): number {
  return 0.5 / 10 ** precision + 0.01;
}

/** A grid reference decoded from text. */
export interface MgrsReferenceMatch {
  /** Longitude of the referenced square's centre, in degrees. */
  lng: number;
  /** Latitude of the referenced square's centre, in degrees. */
  lat: number;
  /** Digits per axis, 0 (100 km square) through 5 (1 m). */
  precision: number;
  /** The reference in compact MGRS form, upper-cased, e.g. `18SUJ2337106519`. */
  mgrs: string;
  /** The same reference in USNG's spaced form, e.g. `18S UJ 23371 06519`. */
  usng: string;
}

/**
 * Format a lng/lat as a compact MGRS reference.
 *
 * Args:
 *   lng: Longitude in degrees; values outside -180..180 are wrapped.
 *   lat: Latitude in degrees.
 *   precision: Digits per axis, 0 (100 km) to 5 (1 m). Defaults to 5.
 *
 * Returns:
 *   A reference such as `18SUJ2337106519`, or null for a polar point (outside
 *   80°S–84°N, which MGRS covers with UPS rather than UTM) or a non-finite input.
 */
export function lngLatToMgrs(lng: number, lat: number, precision = 5): string | null {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  // `mgrs` documents its range as 80°S..84°N, but at exactly 84° it resolves a
  // band past X and returns garbage, so the north edge is exclusive.
  if (lat < -80 || lat >= 84) return null;
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  const digits = Math.max(0, Math.min(5, Math.round(precision)));
  try {
    return mgrs.forward([wrapped, lat], digits);
  } catch {
    return null;
  }
}

/**
 * Re-space a compact MGRS reference into USNG's grouping.
 *
 * Args:
 *   reference: A compact MGRS string such as `18SUJ2337106519`.
 *
 * Returns:
 *   The USNG form, e.g. `18S UJ 23371 06519`, or the input unchanged when it is
 *   not a well-formed reference.
 */
export function mgrsToUsng(reference: string): string {
  const match = /^(\d{1,2}[A-Z])([A-Z]{2})(\d*)$/.exec(reference.trim().toUpperCase());
  if (!match || match[3].length % 2 !== 0) return reference;
  const [, zoneBand, square, digits] = match;
  if (!digits) return `${zoneBand} ${square}`;
  const half = digits.length / 2;
  return `${zoneBand} ${square} ${digits.slice(0, half)} ${digits.slice(half)}`;
}

/**
 * Format a lng/lat as a USNG reference (MGRS with spaces).
 *
 * Args:
 *   lng: Longitude in degrees.
 *   lat: Latitude in degrees.
 *   precision: Digits per axis, 0 to 5. Defaults to 5.
 *
 * Returns:
 *   A reference such as `18S UJ 23371 06519`, or null where
 *   {@link lngLatToMgrs} returns null.
 */
export function lngLatToUsng(lng: number, lat: number, precision = 5): string | null {
  const reference = lngLatToMgrs(lng, lat, precision);
  return reference ? mgrsToUsng(reference) : null;
}

/**
 * UTM/MGRS zone number for a point, applying the two exceptions to the regular
 * 6°-wide zones: zone 32 is widened to 3°E–12°E in band V (56°N–64°N, southern
 * Norway), and band X (72°N–84°N, Svalbard) uses four widened zones 31
 * (0°–9°E), 33 (9°E–21°E), 35 (21°E–33°E) and 37 (33°E–42°E), so 32X, 34X and
 * 36X do not exist.
 *
 * This is the one zone rule shared by the UTM readout (`lngLatToUtm`), the MGRS
 * grid overlay and, through the `mgrs` package which applies the same rule, the
 * MGRS readout, so the three never disagree about which zone a point is in.
 *
 * Args:
 *   lng: Longitude in degrees; values outside -180..180 are wrapped.
 *   lat: Latitude in degrees.
 *
 * Returns:
 *   The zone number, 1–60.
 */
export function utmZoneNumber(lng: number, lat: number): number {
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  if (lat >= 56 && lat < 64 && wrapped >= 3 && wrapped < 12) return 32;
  if (lat >= 72 && wrapped >= 0 && wrapped < 42) {
    if (wrapped < 9) return 31;
    if (wrapped < 21) return 33;
    if (wrapped < 33) return 35;
    return 37;
  }
  return Math.floor((wrapped + 180) / 6) + 1;
}

/**
 * Longitude extent of one zone within a latitude band, honouring the
 * Norway/Svalbard exceptions (see {@link utmZoneNumber}).
 *
 * Args:
 *   zone: Zone number, 1–60.
 *   band: Latitude-band letter, C–X without I and O.
 *
 * Returns:
 *   `[west, east]` in degrees, or null when the zone does not occur in that band
 *   (32X, 34X, 36X) or either argument is invalid.
 */
export function gridZoneLongitudeRange(zone: number, band: string): [number, number] | null {
  if (!Number.isInteger(zone) || zone < 1 || zone > 60 || !utmBandRange(band)) return null;
  const west = (zone - 1) * 6 - 180;
  if (band === "V") {
    if (zone === 31) return [0, 3];
    if (zone === 32) return [3, 12];
  }
  if (band === "X" && zone >= 31 && zone <= 37) {
    switch (zone) {
      case 31:
        return [0, 9];
      case 33:
        return [9, 21];
      case 35:
        return [21, 33];
      case 37:
        return [33, 42];
      default:
        return null;
    }
  }
  return [west, west + 6];
}

/**
 * The 100 km square identifier (column and row letters) of a UTM coordinate,
 * using the standard MGRS lettering (the "AA" scheme on WGS84): the column
 * letter set repeats every three zones, and even zones offset their row
 * letters by five.
 *
 * Args:
 *   zone: Zone number, 1–60.
 *   easting: Easting in metres (100,000–899,999 inside a zone).
 *   northing: Northing in metres, including the 10,000,000 m false northing in
 *     the southern hemisphere.
 *
 * Returns:
 *   Two letters such as `UJ`, or null when the easting lies outside the eight
 *   100 km columns a zone can hold.
 */
export function mgrsSquareId(zone: number, easting: number, northing: number): string | null {
  if (!Number.isInteger(zone) || zone < 1 || zone > 60) return null;
  const column = Math.floor(easting / 100_000);
  if (!Number.isFinite(column) || column < 1 || column > 8) return null;
  const columnLetter = COLUMN_LETTERS[(zone - 1) % 3][column - 1];
  const rowIndex = Math.floor(northing / 100_000);
  if (!Number.isFinite(rowIndex)) return null;
  const offset = zone % 2 === 0 ? 5 : 0;
  const rowLetter = ROW_LETTERS[(((rowIndex + offset) % 20) + 20) % 20];
  return `${columnLetter}${rowLetter}`;
}

/**
 * Southern and northern edge of a UTM/MGRS latitude band. Shared with the UTM
 * search parser (`grid-reference.ts`) so the band layout is defined once.
 *
 * Args:
 *   band: A band letter, C–X without I and O (upper case).
 *
 * Returns:
 *   `[south, north]` in degrees, or null for a letter that is not a band.
 */
export function utmBandRange(band: string): [number, number] | null {
  // A single letter only: indexOf would find "" (and "CD"…) at index 0.
  const index = band.length === 1 ? BANDS.indexOf(band) : -1;
  if (index < 0) return null;
  const south = -80 + index * 8;
  // Band X is 12° tall (72°N–84°N); every other band is 8°.
  return [south, band === "X" ? 84 : south + 8];
}

/**
 * Parse a typed MGRS or USNG reference.
 *
 * Accepts upper or lower case, with or without spaces between the zone+band,
 * the 100 km square and the digits (`18SUJ2337106519`, `18S UJ 23371 06519`,
 * `18suj 2337 0651`), at any precision from the bare square (`18SUJ`) to 1 m.
 * The reference is validated against the grid rather than trusted: the zone
 * must be 1–60, the band a UTM band, the column letter one used by that zone,
 * and the decoded point must fall in the stated band (allowing for a coarse
 * square that straddles its edge).
 *
 * Args:
 *   text: The text to parse.
 *
 * Returns:
 *   The centre of the referenced square with its normalized spellings, or null
 *   when the text is not a valid MGRS/USNG reference. Polar UPS references are
 *   not supported and return null.
 */
export function parseMgrsReference(text: string): MgrsReferenceMatch | null {
  const match = REFERENCE_RE.exec(text.trim().toUpperCase());
  if (!match) return null;
  const [, zoneText, band, column, row, easting, northing, run] = match;
  let digits: string;
  if (easting !== undefined && northing !== undefined) {
    // Split halves must be the same precision, or the grouping is ambiguous.
    if (easting.length !== northing.length) return null;
    digits = easting + northing;
  } else {
    digits = run ?? "";
    if (digits.length % 2 !== 0) return null;
  }

  const zone = Number(zoneText);
  if (zone < 1 || zone > 60) return null;
  const range = utmBandRange(band);
  if (!range) return null;
  // The Svalbard exception widens zones 31, 33, 35 and 37 across band X, so
  // 32X, 34X and 36X do not exist; `mgrs` would still decode them.
  if (band === "X" && (zone === 32 || zone === 34 || zone === 36)) return null;
  if (!COLUMN_LETTERS[(zone - 1) % 3].includes(column)) return null;
  if (!ROW_LETTERS.includes(row)) return null;

  const reference = `${zone}${band}${column}${row}${digits}`;
  let point: number[];
  try {
    point = mgrs.toPoint(reference);
  } catch {
    return null;
  }
  const [lng, lat] = point;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  // A row letter repeats every 2,000 km, and `mgrs` uses the band to choose the
  // repetition. A row that no repetition puts inside the band decodes outside
  // it: reject that rather than jump to a point the reference does not name.
  const precision = digits.length / 2;
  const tolerance = bandTolerance(precision);
  if (lat < range[0] - tolerance || lat > range[1] + tolerance) return null;

  return { lng, lat, precision, mgrs: reference, usng: mgrsToUsng(reference) };
}
