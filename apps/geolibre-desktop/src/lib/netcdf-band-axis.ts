import { TIME_DIMENSION_NAMES } from "@geolibre/plugins/zarr-time-axis";
import type { LocalNetcdfAxis } from "@geolibre/plugins/local-netcdf";

/**
 * Reading a NetCDF variable's spectral (band) axis: labelling its entries, and
 * choosing sensible band triples from it.
 *
 * Shared by the Add NetCDF dialog, which picks the bands a layer is built from,
 * and the 3-D cube setup, which picks the bands its top-face overlay is composed
 * from. Both have to answer "which band is red?" the same way, or the overlay
 * would come out a different colour from the RGB composite the same file made in
 * the Add dialog.
 */

// Approximate red/green/blue band centres in nanometres. A hyperspectral cube's
// band axis is a wavelength coordinate, so a natural-colour composite is the
// three bands nearest these — which is what a user reaching for "band
// combination" on an EMIT reflectance cube expects to see first.
export const NATURAL_COLOR_NM: [number, number, number] = [640, 550, 470];

/**
 * Above this many entries an axis is offered as a number box rather than a
 * dropdown: a `<select>` with tens of thousands of options is unusable and slow
 * to build. A band axis (EMIT has 285) stays well under it.
 */
export const MAX_AXIS_OPTIONS = 2000;

// Wavelength units a spectral axis may declare, in the spellings CF files use.
// Micrometres are the other common one; anything else (an index, a time, a
// pressure level) is not a wavelength and gets evenly spread band defaults.
const NANOMETRE_UNITS = new Set(["nm", "nanometer", "nanometers", "nanometre", "nanometres"]);
const MICROMETRE_UNITS = new Set([
  "um",
  "µm",
  "micron",
  "microns",
  "micrometer",
  "micrometers",
  "micrometre",
  "micrometres",
]);

/**
 * A coordinate as it reads in a label: two decimals, or as it stands when it is
 * whole. Shared by every label below so a wavelength cannot come out to one
 * precision in the band picker and another in the identify popup.
 */
function roundedCoordinate(coordinate: number): string {
  return Number.isInteger(coordinate) ? String(coordinate) : coordinate.toFixed(2);
}

/** `"650.41 nm (bands 47)"` — the coordinate value first, then where it sits. */
export function axisOptionLabel(axis: LocalNetcdfAxis, coordinate: number, index: number): string {
  const rounded = roundedCoordinate(coordinate);
  const measure = axis.units ? `${rounded} ${axis.units}` : rounded;
  return `${measure} (${axis.name} ${index})`;
}

/**
 * `"650.41 nm"` — just the band's measure, for places where the axis and the
 * channel it feeds are already named around it (the identify popup's red/green/
 * blue rows, the Style panel's band summary). Shorter than {@link bandLabel} on
 * purpose: those sit inside a row that is already a label.
 *
 * An axis with no coordinate values, or none at this index, has no measure to
 * show, so it falls back to naming the position — the only thing known about it.
 *
 * @param axis - The band axis.
 * @param index - The band's position along it.
 * @returns The coordinate with its units, or `"bands 47"`.
 */
export function bandMeasure(axis: LocalNetcdfAxis, index: number): string {
  const coordinate = axis.values?.[index];
  if (coordinate === undefined) return `${axis.name} ${index}`;
  const rounded = roundedCoordinate(coordinate);
  // Without units the bare number reads as nothing in particular, so keep the
  // axis name in front of it rather than showing a naked "47".
  return axis.units ? `${rounded} ${axis.units}` : `${axis.name} ${rounded}`;
}

/** How one band index should read in a picker, whatever the axis carries. */
export function bandLabel(axis: LocalNetcdfAxis, index: number): string {
  const coordinate = axis.values?.[index];
  return coordinate === undefined
    ? `${axis.name} ${index}`
    : axisOptionLabel(axis, coordinate, index);
}

/**
 * Whether a dimension name reads as a time axis.
 *
 * Shares one list with the Zarr time-axis reader (see `TIME_DIMENSION_NAMES`),
 * so a `(time, lat, lon)` cube is recognised the same way whichever reader
 * opened it.
 */
export function isTimeAxisName(name: string): boolean {
  const lower = name.toLowerCase();
  return TIME_DIMENSION_NAMES.some((candidate) => candidate === lower);
}

/** The axis' values as nanometres, or null when it is not a wavelength axis. */
export function wavelengthsInNanometres(axis: LocalNetcdfAxis): number[] | null {
  if (!axis.values || axis.values.length === 0) return null;
  const units = axis.units?.trim().toLowerCase() ?? "";
  if (NANOMETRE_UNITS.has(units)) return axis.values;
  if (MICROMETRE_UNITS.has(units)) return axis.values.map((value) => value * 1000);
  return null;
}

/**
 * The three indices to open an RGB composite on.
 *
 * A wavelength axis (an EMIT `bands` coordinate in nm) gets the bands nearest
 * true red/green/blue, which is the composite a user actually wants to look at.
 * Anything else — an axis with no units, or units that are not a wavelength —
 * gets three evenly spread indices, since guessing colours from, say, a time
 * axis would be meaningless.
 *
 * @param axis - The band axis.
 * @returns Indices for red, green, and blue.
 */
export function defaultRgbBands(axis: LocalNetcdfAxis): [number, number, number] {
  const wavelengths = wavelengthsInNanometres(axis);
  if (wavelengths) {
    return NATURAL_COLOR_NM.map((target) => nearestIndex(wavelengths, target)) as [
      number,
      number,
      number,
    ];
  }
  return [0, Math.floor((axis.size - 1) / 2), axis.size - 1];
}

/**
 * The axis an RGB composite should draw its channels from: a wavelength axis if
 * the file declares one, else the first non-time axis with at least three
 * entries. Time is never a candidate: combining three dates as red/green/blue is
 * meaningless, and `(time, lat, lon)` is the commonest cube shape there is.
 *
 * @param axes - The variable's leading axes.
 * @returns The band axis, or null when the variable has none.
 */
export function pickBandAxis(axes: LocalNetcdfAxis[]): LocalNetcdfAxis | null {
  const candidates = axes.filter((axis) => axis.size >= 3 && !isTimeAxisName(axis.name));
  return candidates.find((axis) => wavelengthsInNanometres(axis)) ?? candidates[0] ?? null;
}

/** Index of the entry closest to `target`. */
function nearestIndex(values: number[], target: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < values.length; i++) {
    const distance = Math.abs(values[i] - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}
