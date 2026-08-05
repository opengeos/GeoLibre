import type { NetcdfProfileSample } from "./netcdf-profile-store";
import { csvCell, spreadsheetSafeText } from "./csv";
import { displayUnits } from "./cf-units";

/**
 * Per-sample colors, shared by the chart lines, the legend swatches, and the
 * on-map markers so a line and the pixel it was read from are matched by color
 * as well as by number. Matches the Time Slider's pixel chart so the two read
 * as one family.
 */
export const NETCDF_SERIES_COLORS = [
  "hsl(var(--primary))",
  "hsl(12 76% 61%)",
  "hsl(173 58% 39%)",
  "hsl(262 52% 56%)",
  "hsl(43 74% 49%)",
  "hsl(199 89% 48%)",
];

/**
 * The color for a sample, keyed off its stable `order` rather than its position
 * in the list, so a point does not change color when an older one falls off the
 * cap.
 *
 * @param sample - The sampled pixel.
 * @returns A CSS color, possibly referencing a theme variable.
 */
export function netcdfSeriesColor(sample: Pick<NetcdfProfileSample, "order">): string {
  return NETCDF_SERIES_COLORS[(sample.order - 1) % NETCDF_SERIES_COLORS.length];
}

/**
 * The x-axis positions for a sample: the axis' own coordinate values when the
 * file has them (wavelengths in nm), else the bare index.
 *
 * @param sample - A sample whose profile has resolved.
 * @returns One position per profile value.
 */
export function netcdfAxisPositions(
  sample: NetcdfProfileSample & { profile: NonNullable<NetcdfProfileSample["profile"]> },
): number[] {
  const { axis, values } = sample.profile;
  if (axis.values && axis.values.length === values.length) return axis.values;
  return values.map((_, index) => index);
}

/** Multipliers a tick step may take, per power of ten. 2.5 earns its place on a
 * 400-2500 nm spectrum, where the alternatives give either 4 labels or 11; it is
 * penalized below because on a small integer axis (band indices) it puts ticks
 * on half-bands. */
const TICK_MULTIPLIERS = [1, 2, 2.5, 5];

/** How many ticks a step yields inside `[min, max]`. */
function tickCount(min: number, max: number, step: number): number {
  return Math.floor(max / step) - Math.ceil(min / step) + 1;
}

/**
 * Tick positions across a domain, on round numbers.
 *
 * Labelling only the ends and the midpoint leaves a wavelength axis nearly
 * unreadable — you cannot tell where 1000 nm falls. This walks round multiples
 * instead, so the labels are values a reader recognizes rather than whatever the
 * data's extremes happened to be.
 *
 * Picks the step whose resulting *count* lands nearest `target`, rather than
 * rounding the interval up to the next round number: rounding up overshoots
 * badly on the domains this chart actually sees, turning an asked-for 8 labels
 * into 4.
 *
 * @param min - Domain start.
 * @param max - Domain end.
 * @param target - Roughly how many ticks to aim for; round numbers win over
 *   hitting it exactly, so the result lands near it rather than on it.
 * @returns The ticks, ascending. A degenerate domain yields its single value.
 */
export function niceTickValues(min: number, max: number, target: number): number[] {
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0 || target < 2) return [min];

  const middle = Math.floor(Math.log10(span / target));
  let best: { step: number; score: number } | null = null;
  // Two powers either side of the estimate covers every step that could plausibly
  // land near `target`, without depending on where the rounding fell.
  for (let exponent = middle - 1; exponent <= middle + 2; exponent++) {
    const power = 10 ** exponent;
    for (const multiplier of TICK_MULTIPLIERS) {
      const step = multiplier * power;
      const count = tickCount(min, max, step);
      if (count < 2) continue;
      // Ties, and near-ties against 2.5, go to the rounder and sparser step.
      const score = Math.abs(count - target) + (multiplier === 2.5 ? 1 : 0);
      if (!best || score < best.score || (score === best.score && step > best.step)) {
        best = { step, score };
      }
    }
  }
  if (!best) return [min, max];

  const { step } = best;
  const ticks: number[] = [];
  const firstIndex = Math.ceil(min / step);
  const lastIndex = Math.floor(max / step);
  for (let index = firstIndex; index <= lastIndex; index++) {
    // Multiply the index rather than accumulating: repeated addition drifts, and
    // the drift shows up as "1400.0000000000002" in a label.
    ticks.push(Number((index * step).toPrecision(12)));
  }
  return ticks;
}

/**
 * Lay the sampled profiles out as CSV: one row per axis entry, one column per
 * sampled pixel.
 *
 * Samples of the same variable share a band axis, so the axis column is taken
 * from the first sample that has one; a sample whose profile is shorter (or
 * still unread) leaves its cells empty rather than shifting the rows out of
 * alignment. A fill reading is empty too, which is what a spreadsheet and most
 * plotting tools read as a gap — the same break the chart draws.
 *
 * @param samples - The sampled pixels, in list order.
 * @returns The CSV text, or null when no sample has a profile to write.
 */
export function buildNetcdfProfileCsv(samples: NetcdfProfileSample[]): string | null {
  const charted = samples.filter(
    (sample): sample is NetcdfProfileSample & { profile: NonNullable<typeof sample.profile> } =>
      sample.profile !== undefined && sample.profile.values.length > 0,
  );
  if (charted.length === 0) return null;

  const first = charted[0];
  // Through `displayUnits` like the chart's own axis label: a coordinate
  // variable can declare `unitless`/`1`/`n/a`, and the export should not say
  // "wavelength (1)" where the chart it came from says "wavelength".
  const axisUnits = displayUnits(first.profile.axis.units);
  const axisName = axisUnits
    ? `${first.profile.axis.name} (${axisUnits})`
    : first.profile.axis.name;
  const positions = netcdfAxisPositions(first);
  const rowCount = Math.max(...charted.map((sample) => sample.profile.values.length));

  const header = [
    // The axis name and units are free text out of the file's own metadata, so
    // guard the export against spreadsheet formula injection. The point columns
    // below are built from numbers and stay verbatim.
    csvCell(spreadsheetSafeText(axisName)),
    ...charted.map((sample) =>
      // The lon/lat is what identifies the pixel; the point number ties the
      // column back to its marker on the map.
      csvCell(`point ${sample.order} (${sample.lng.toFixed(5)}, ${sample.lat.toFixed(5)})`),
    ),
  ].join(",");

  const rows = Array.from({ length: rowCount }, (_, index) => {
    const position = index < positions.length ? csvCell(positions[index]) : "";
    const cells = charted.map((sample) => {
      const value = sample.profile.values[index];
      return value === null || value === undefined ? "" : csvCell(value);
    });
    return [position, ...cells].join(",");
  });

  return [header, ...rows].join("\n");
}
