/**
 * The range a numeric field's values *typically* fall in, for scaling a slider
 * or a histogram so that a handful of outliers cannot flatten it (#3455).
 *
 * A field where 1,283 of 1,284 values sit below 4,800 but one is 1e12 spans
 * 0…1e12, so every typical value lands in the first pixel of a slider and the
 * first bar of a histogram. When the data has outliers like that, the controls
 * scale to the 1st–99th percentile instead and gather the values beyond it at
 * each end. A field without outliers keeps its exact min–max extent, so normal
 * fields look exactly as they did.
 *
 * Pure and dependency-free so it can be unit-tested on its own.
 */

/** Lower percentile the clipped domain starts at. */
export const TYPICAL_LOW_PERCENTILE = 0.01;
/** Upper percentile the clipped domain ends at. */
export const TYPICAL_HIGH_PERCENTILE = 0.99;
/**
 * How many times wider than the 1st–99th percentile span the full extent has
 * to be before the domain is clipped. Below this the extent is drawn as is: a
 * long tail that still leaves the bulk of the values a tenth of the axis or
 * more is readable, and clipping it would only add overflow bars.
 */
export const OUTLIER_SPREAD_RATIO = 10;
/**
 * Values needed before clipping is considered. With fewer, the 1st and 99th
 * percentiles are the second-smallest and second-largest values, so "outlier"
 * would just mean "the ends".
 */
export const MIN_VALUES_TO_CLIP = 20;

export interface TypicalRange {
  /** The full extent of the values. */
  min: number;
  max: number;
  /**
   * The domain to scale to: the 1st and 99th percentiles when {@link clipped},
   * otherwise `min` and `max`.
   */
  low: number;
  high: number;
  /** The values have outliers, so `low`/`high` are percentiles rather than the extent. */
  clipped: boolean;
  /** Values strictly below `low` and strictly above `high` (both 0 unless clipped). */
  below: number;
  above: number;
  /** Finite numeric values considered. */
  count: number;
}

/**
 * Work out the domain a slider or histogram should span for a set of values.
 *
 * The percentiles are taken at data ranks rounded inward (the 1st percentile
 * rounds up, the 99th down), so both ends of a clipped domain are real values
 * from the field rather than interpolated ones. Labels built from them with
 * {@link formatRangeBound} are rounded for display.
 *
 * @param values - The values to scan. Anything that is not a finite number
 *   (`null`, `NaN`, text, `Infinity`) is ignored.
 * @returns The extent, the domain to scale to, and how many values fall beyond
 *   it at each end, or `null` when there are no finite numbers.
 */
export function typicalRange(values: Iterable<unknown>): TypicalRange | null {
  const numbers: number[] = [];
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) numbers.push(value);
  }
  const count = numbers.length;
  if (count === 0) return null;

  const sorted = Float64Array.from(numbers).sort();
  const min = sorted[0];
  const max = sorted[count - 1];
  const exact: TypicalRange = {
    min,
    max,
    low: min,
    high: max,
    clipped: false,
    below: 0,
    above: 0,
    count,
  };
  if (count < MIN_VALUES_TO_CLIP || min === max) return exact;

  const low = sorted[Math.ceil(TYPICAL_LOW_PERCENTILE * (count - 1))];
  const high = sorted[Math.floor(TYPICAL_HIGH_PERCENTILE * (count - 1))];
  // A zero-width typical span (99% of the values identical) leaves nothing to
  // draw a slider across, so the exact extent is the better of two poor scales.
  if (!(high > low)) return exact;
  if (max - min <= OUTLIER_SPREAD_RATIO * (high - low)) return exact;

  let below = 0;
  while (below < count && sorted[below] < low) below += 1;
  let above = 0;
  while (above < count && sorted[count - 1 - above] > high) above += 1;
  return { min, max, low, high, clipped: true, below, above, count };
}

/**
 * Format a domain bound for a label such as "< 0.2" or "> 4,615": grouped
 * thousands, no decimals once a value is in the thousands, three significant
 * digits below that, and exponent notation at extreme magnitudes.
 *
 * @param value - The bound to format.
 * @param locale - The locale to group digits for; the runtime locale if omitted.
 * @returns The formatted number, or an empty string for a non-finite value.
 */
export function formatRangeBound(value: number, locale?: string): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e9)) {
    return new Intl.NumberFormat(locale, {
      notation: "scientific",
      maximumSignificantDigits: 3,
    }).format(value);
  }
  return new Intl.NumberFormat(
    locale,
    abs >= 1000 ? { maximumFractionDigits: 0 } : { maximumSignificantDigits: 3 },
  ).format(value);
}
