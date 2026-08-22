// Ground-unit entry for the Processing toolbox's distance parameters.
//
// A vector layer on the map is always handed to a tool as GeoJSON, which RFC
// 7946 fixes to WGS84 — so a tool's spacing/search-radius/tolerance value is
// measured in *degrees*, not metres, and there is no CRS left on the layer to
// say so (GeoLibre#1540). These helpers recognize which numeric parameters are
// ground distances and convert a value typed in metres (or km/ft/mi) into the
// degrees the tool will actually use.
//
// The conversion is deliberately approximate: a degree in WGS84 is not a fixed
// ground distance, and a Euclidean distance in degree-space is direction
// dependent. The dialog says so next to the field, and reprojecting to a
// projected CRS remains the exact answer.

/** Units a distance parameter can be entered in. `degrees` is the tool's own unit. */
export type DistanceUnit = "degrees" | "meters" | "kilometers" | "feet" | "miles";

/** Selectable units, in the order the picker lists them. */
export const DISTANCE_UNITS: DistanceUnit[] = ["degrees", "meters", "kilometers", "feet", "miles"];

/** Metres in one of each ground unit. */
const METERS_PER_UNIT: Record<Exclude<DistanceUnit, "degrees">, number> = {
  meters: 1,
  kilometers: 1000,
  feet: 0.3048,
  miles: 1609.344,
};

/**
 * Name segments that mark a numeric parameter as a ground distance measured in
 * the input's coordinate units: `search_radius`, `snap_tolerance`,
 * `max_edge_length`, `spacing`, `resolution`, `max_dist`, and the rest.
 *
 * Every segment here is generic enough to also match something that is not a
 * ground distance: a photogrammetry `focal_length` in millimetres, or a
 * dimensionless `corridor_tolerance`. Nothing reachable hits that today, because
 * the caller only applies this rule to a tool whose every dataset input is a
 * vector layer, and the measurements that would collide sit on imagery/LiDAR
 * tools. That is a coincidence rather than a guarantee, so a name that collides
 * on a vector-only tool goes in {@link NON_DISTANCE_NAMES}.
 */
const DISTANCE_SEGMENTS = [
  "dist",
  "distance",
  "radius",
  "spacing",
  "tolerance",
  "length",
  "resolution",
];

/**
 * Parameter names that are a ground distance only when they are the *whole*
 * name. `width`/`height` name a grid cell's dimensions on the vector grid tools
 * but a pixel count on `image_width`/`image_height`, so the segment rule above
 * would over-match them.
 */
const DISTANCE_NAMES = new Set(["cell_size", "width", "height"]);

/**
 * Names that match a segment above but measure something dimensionless, so
 * offering a metric unit picker for them would convert a number that was never
 * a length. `corridor_mapping_intelligence`'s `corridor_tolerance` is a fraction
 * above optimal cost in 0-1, not a width. `contiguous_cartogram`'s
 * `densify_spacing` is an edge length counted in cells of the cartogram's own
 * diffusion grid, not ground units — and unlike `corridor_tolerance` that tool
 * takes only vector inputs, so the picker really does reach it.
 *
 * The catalog scan behind this list looked for a matching `double` whose
 * description reads as a fraction, ratio, angle or weight; re-run it when
 * `geolibre-wasm` is bumped, since the tool-level gate that saves these today is
 * incidental. That re-check is recorded in `CLAUDE.md`'s Conventions section
 * alongside the repo's other name/version mirrors.
 */
const NON_DISTANCE_NAMES = new Set(["corridor_tolerance", "densify_spacing"]);

const DISTANCE_SEGMENT_PATTERN = new RegExp(`(^|_)(${DISTANCE_SEGMENTS.join("|")})(_|$)`, "i");

/**
 * Whether a parameter name reads as a ground distance in the input's coordinate
 * units.
 *
 * Callers must also check the parameter is numeric and that the tool's input is
 * a WGS84 map layer — a distance on a *raster* or LiDAR tool is in that
 * dataset's own CRS units, which GeoLibre leaves untouched.
 *
 * @param name - The tool parameter's name.
 * @returns `true` when the name reads as a linear distance.
 */
export function isDistanceParameterName(name: string): boolean {
  const lower = name.toLowerCase();
  if (NON_DISTANCE_NAMES.has(lower)) return false;
  return DISTANCE_NAMES.has(lower) || DISTANCE_SEGMENT_PATTERN.test(name);
}

/**
 * Metres per degree on the WGS84 ellipsoid at a latitude, as the geometric mean
 * of the meridional (north-south) and parallel (east-west) scales.
 *
 * A single scalar cannot be right in both directions away from the equator, so
 * the geometric mean splits the error rather than favouring one axis: at 45°
 * a degree spans 111.1 km north-south but only 78.8 km east-west, and the mean
 * lands within 19% of either, where the meridian alone would be 41% out
 * east-west. Latitude is clamped to ±85° so the vanishing parallel scale near
 * the poles cannot collapse the result to zero.
 *
 * @param latitudeDeg - Latitude in degrees.
 * @returns Metres per degree at that latitude.
 */
export function metersPerDegreeAt(latitudeDeg: number): number {
  const lat = (Math.max(-85, Math.min(85, latitudeDeg)) * Math.PI) / 180;
  // Standard WGS84 series for the length of a degree (metres).
  const meridian =
    111132.92 - 559.82 * Math.cos(2 * lat) + 1.175 * Math.cos(4 * lat) - 0.0023 * Math.cos(6 * lat);
  const parallel = 111412.84 * Math.cos(lat) - 93.5 * Math.cos(3 * lat) + 0.118 * Math.cos(5 * lat);
  return Math.sqrt(meridian * parallel);
}

/**
 * Convert a value typed in `unit` into the degrees a tool reading WGS84 GeoJSON
 * will use.
 *
 * @param value - The value in `unit`.
 * @param unit - The unit the value was typed in.
 * @param latitudeDeg - Reference latitude for the conversion (the layer's centre).
 * @returns The equivalent value in degrees.
 */
export function unitToDegrees(value: number, unit: DistanceUnit, latitudeDeg: number): number {
  if (unit === "degrees") return value;
  return (value * METERS_PER_UNIT[unit]) / metersPerDegreeAt(latitudeDeg);
}

/**
 * Convert degrees back into `unit`, so switching the picker keeps showing the
 * same ground distance.
 *
 * @param degrees - The value in degrees.
 * @param unit - The unit to express it in.
 * @param latitudeDeg - Reference latitude for the conversion (the layer's centre).
 * @returns The equivalent value in `unit`.
 */
export function degreesToUnit(degrees: number, unit: DistanceUnit, latitudeDeg: number): number {
  if (unit === "degrees") return degrees;
  return (degrees * metersPerDegreeAt(latitudeDeg)) / METERS_PER_UNIT[unit];
}

/**
 * Read a number the user typed into a distance field, or `null` when the text
 * is not a complete number.
 *
 * Uses `Number` rather than `parseFloat`, which stops at the first character it
 * cannot read: `parseFloat("12,000")` is `12`, so a thousands separator (or the
 * comma decimal mark much of the world types) would be silently converted as a
 * distance a thousand times too small while the field still displayed the
 * original text. Rejecting it instead leaves the raw text to be stored, which
 * fails loudly when the tool reads it.
 *
 * @param text - The raw field text.
 * @returns The parsed number, or `null` for empty or malformed input.
 */
export function parseDistanceInput(text: string): number | null {
  const trimmed = text.trim();
  // Number("") is 0, and Number also reads the `0x`/`0b`/`0o` literals plus
  // "Infinity" — none of which is a decimal distance anyone typed on purpose.
  // Require the plain decimal shape first, then let Number do the conversion.
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The map layers a tool's vector inputs resolve to, or `null` when any of them
 * leaves the tool's coordinate units unknowable.
 *
 * An input pointing at a file path is read from disk in whatever CRS it carries,
 * so one anywhere on the tool disqualifies the whole tool — required or not. An
 * input with nothing chosen contributes no geometry, which is fatal only when it
 * is required.
 *
 * @param inputs - The tool's vector inputs, with their current form values.
 * @param layerTokenPrefix - Prefix marking a value as a layer reference.
 * @returns The chosen layers' ids, or `null` when the units are unknown.
 */
export function wgs84VectorLayerIds(
  inputs: { required?: boolean; value: unknown }[],
  layerTokenPrefix: string,
): string[] | null {
  const ids: string[] = [];
  for (const input of inputs) {
    const values = Array.isArray(input.value) ? input.value : [input.value];
    const selected = values.filter(
      (value): value is string => typeof value === "string" && value.trim() !== "",
    );
    if (!selected.length) {
      if (input.required) return null;
      continue;
    }
    for (const value of selected) {
      if (!value.startsWith(layerTokenPrefix)) return null;
      ids.push(value.slice(layerTokenPrefix.length));
    }
  }
  return ids.length ? ids : null;
}

/**
 * Round a converted value to a fixed number of significant digits and drop the
 * trailing zeros, so a conversion reads as `0.0106` rather than
 * `0.010601234567890123` (and never as exponent notation, which the tools'
 * numeric parsers do not all accept).
 *
 * @param value - The value to format.
 * @param significantDigits - Digits to keep (default 6).
 * @returns The formatted number as a plain decimal string.
 */
export function formatDistanceValue(value: number, significantDigits = 6): string {
  if (!Number.isFinite(value)) return "";
  if (value === 0) return "0";
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const decimals = Math.max(0, Math.min(20, significantDigits - 1 - magnitude));
  const fixed = value.toFixed(decimals);
  // Number(...).toString() drops the padding zeros, but flips to exponent
  // notation below 1e-6 — so trim the fixed string by hand in that range.
  const rounded = Number(fixed);
  if (rounded !== 0 && Math.abs(rounded) < 1e-6) {
    return decimals > 0 ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
  }
  return rounded.toString();
}
