/**
 * A tolerant parser for free-text geographic coordinates pasted into the Set
 * View dialog. It recognizes the three notations field workers and GIS users
 * commonly copy from external sources and returns signed decimal degrees:
 *
 * - Decimal degrees (DD):              `51.5074, -0.1278`  ·  `35.475317 -97.514272`
 * - Degrees, minutes, seconds (DMS):   `51°30'26"N, 0°07'39"W`
 * - Degrees and decimal minutes (DDM): `51°30.44'N, 0°07.65'W`
 *
 * Kept separate from the React component so the parsing can be unit tested in
 * isolation.
 */

/** A parsed geographic coordinate as signed decimal degrees. */
export interface LatLon {
  lat: number;
  lon: number;
}

/** Maps a hemisphere letter to the axis it names and the sign it implies. */
const HEMISPHERE: Record<string, { axis: "lat" | "lon"; sign: 1 | -1 }> = {
  N: { axis: "lat", sign: 1 },
  S: { axis: "lat", sign: -1 },
  E: { axis: "lon", sign: 1 },
  W: { axis: "lon", sign: -1 },
};

/** One axis component: its signed decimal value and the axis the letter names. */
interface Component {
  value: number;
  axis: "lat" | "lon" | null;
}

/**
 * Parse a single axis token (one of the two halves of a coordinate string) into
 * signed decimal degrees. Handles a bare decimal, a hemisphere-tagged decimal,
 * and degrees/minutes/seconds groupings whatever separators (°, ', ", spaces)
 * are used between them.
 */
function parseComponent(raw: string): Component | null {
  const text = raw.trim();
  if (!text) return null;
  const hemiMatch = text.match(/[NSEW]/i);
  const hemi = hemiMatch ? hemiMatch[0].toUpperCase() : null;
  const negative = /^\s*-/.test(text);
  // Numbers in order are degrees, then optional minutes, then optional seconds.
  const numbers = text.match(/\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length === 0 || numbers.length > 3) return null;
  // Real DMS/DDM always has a whole-number degrees field; only DD (a single
  // number) legitimately carries a fractional degree. Reject e.g. "51.5 30 26N".
  if (numbers.length > 1 && !Number.isInteger(Number(numbers[0]))) return null;
  const [deg, min = "0", sec = "0"] = numbers;
  const minutes = Number(min);
  const seconds = Number(sec);
  // Minutes/seconds are sub-degree subdivisions, so values >= 60 are malformed.
  if (minutes >= 60 || seconds >= 60) return null;
  const magnitude = Number(deg) + minutes / 60 + seconds / 3600;
  if (!Number.isFinite(magnitude)) return null;
  // A leading "-" and a positive hemisphere (N/E) contradict each other (e.g.
  // "-51.5N"), so reject rather than silently letting the sign win.
  const signFromHemi = hemi ? HEMISPHERE[hemi].sign : null;
  if (negative && signFromHemi === 1) return null;
  const sign = negative || signFromHemi === -1 ? -1 : 1;
  return { value: sign * magnitude, axis: hemi ? HEMISPHERE[hemi].axis : null };
}

/**
 * Parse a free-text coordinate string into signed decimal lat/lon, auto-detecting
 * DD, DMS, or DDM. Returns null when the text is not two valid, in-range axes.
 *
 * When hemisphere letters are present each half is assigned to its axis by the
 * letter, so order does not matter. Only suffix notation (`51.5N`) is handled,
 * not prefix notation (`N51.5`). For a bare decimal pair (no letters) the order
 * is assumed to be `lat, lon` (the Google Maps convention); if the first value
 * cannot be a latitude (|value| > 90) the two are swapped.
 *
 * @param input Raw text such as `51°30'26"N, 0°07'39"W` or `51.5074, -0.1278`.
 * @returns The decoded coordinate, or null if it cannot be parsed.
 */
export function parseLatLon(input: string): LatLon | null {
  const text = input.trim();
  if (!text) return null;

  const hasHemisphere = /[NSEW]/i.test(text);
  // Only hemisphere-suffix notation (e.g. `51.5N`) is recognized; prefix
  // notation (e.g. `N51.5`) splits into 3+ parts below and returns null.
  const parts = hasHemisphere
    ? // Split after each hemisphere letter so each axis is its own token.
      text
        .split(/(?<=[NSEW])/i)
        .map((part) => part.replace(/^[\s,]+/, "").trim())
        .filter(Boolean)
    : // A bare decimal pair separated by a comma and/or whitespace.
      text.split(/[\s,]+/).filter(Boolean);
  if (parts.length !== 2) return null;

  const first = parseComponent(parts[0]);
  const second = parseComponent(parts[1]);
  if (!first || !second) return null;

  let lat: number;
  let lon: number;
  if (first.axis && second.axis) {
    if (first.axis === second.axis) return null; // two of the same axis
    lat = first.axis === "lat" ? first.value : second.value;
    lon = first.axis === "lon" ? first.value : second.value;
  } else if (!first.axis && !second.axis) {
    let a = first.value;
    let b = second.value;
    if (Math.abs(a) > 90 && Math.abs(b) <= 90) {
      [a, b] = [b, a];
    }
    lat = a;
    lon = b;
  } else {
    // A mix of one tagged and one bare token is ambiguous; reject it.
    return null;
  }

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}
