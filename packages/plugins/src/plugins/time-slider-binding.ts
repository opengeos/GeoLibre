import type { FeatureCollection } from "geojson";

/**
 * Time granularities the binding understands. Mirrors the upstream
 * `maplibre-gl-time-slider` `Granularity` union so a binding's window and the
 * control's stepping speak the same vocabulary.
 */
export type TimeGranularity = "hour" | "day" | "month" | "year";

/**
 * How the chosen time property stores its values, decided once when a layer is
 * bound. It drives how {@link buildTimeFilter} writes the MapLibre comparison so
 * the in-place filter matches the data without rewriting the features:
 *
 * - `epochMs` / `epochS`: numeric epoch timestamps (milliseconds / seconds),
 *   compared with `to-number`.
 * - `isoDateTime`: full ISO-8601 datetime strings (e.g. `2015-03-01T10:00:00Z`),
 *   compared lexicographically, which equals chronological order for ISO-8601.
 * - `isoDate`: date-only ISO strings (`YYYY-MM-DD`), compared against date-only
 *   bounds so a feature on the boundary day is not dropped.
 * - `year`: bare calendar years (`1958`, `"2015"`), the common vintage column in
 *   GIS data (construction year, survey year). Compared numerically against
 *   year bounds; each year is anchored at Jan 1 UTC on the timeline.
 */
export type TimeValueKind = "epochMs" | "epochS" | "isoDateTime" | "isoDate" | "year";

/**
 * A sliding window of time placed around the timeline's current date. Features
 * whose timestamp falls in `[date - before*unit, date + after*unit)` are shown.
 */
export interface TimeWindow {
  unit: TimeGranularity;
  before: number;
  after: number;
}

/**
 * The persisted configuration that binds a GeoLibre vector layer to the Time
 * Slider. Stored on `layer.metadata.timeBinding` so it survives a project
 * round-trip; the live filter it produces is transient (see
 * `GeoLibreLayer.timeFilter`).
 */
export interface TimeBinding {
  /** Feature property holding the timestamp. */
  property: string;
  /** How that property stores its values. */
  valueKind: TimeValueKind;
  /** Epoch-millisecond extent of the data, used to set the timeline range. */
  min: number;
  max: number;
  /** Suggested stepping granularity derived from the data span. */
  granularity: TimeGranularity;
  /** Window of time shown around the current date. */
  window: TimeWindow;
}

/** A property offered as a candidate timestamp column in the bind dialog. */
export interface TimePropertyCandidate {
  property: string;
  /** Fraction (0-1) of inspected features whose value parsed as a date. */
  coverage: number;
  /** A representative raw value, shown to help the user pick. */
  sample: unknown;
}

/** At/above this magnitude a numeric timestamp is read as milliseconds, else seconds. */
const EPOCH_MS_THRESHOLD = 1e11;
/**
 * Smallest magnitude accepted as an epoch-second timestamp (~1973-03). Numbers
 * between the year range and this are not treated as timestamps, so counts and
 * ids are not misclassified as epoch seconds near 1970.
 */
const EPOCH_SECONDS_MIN = 1e8;
/**
 * Integers in `[YEAR_MIN, YEAR_MAX]` are read as bare calendar years — the
 * common vintage column in GIS data (construction year, survey year). Kept to
 * four digits so counts and codes outside the range stay rejected; a four-digit
 * count column can still slip in as a low-ranked candidate, which is why
 * {@link detectTimeProperties} breaks coverage ties by distinct-value count.
 */
const YEAR_MIN = 1000;
const YEAR_MAX = 9999;
/** How many features to inspect when detecting candidate columns / value kind. */
const SAMPLE_LIMIT = 500;
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

/**
 * Parse a raw property value into an epoch-millisecond timestamp.
 *
 * Numbers (and all-numeric strings) are treated as epoch seconds or
 * milliseconds by magnitude; four-digit integers are read as bare calendar
 * years anchored at Jan 1 UTC; other strings are parsed as dates (ISO and any
 * format `Date.parse` accepts). Remaining numbers (counts, ids) are rejected
 * rather than read as seconds near 1970.
 *
 * @param value - A raw feature-property value.
 * @returns Epoch milliseconds, or `null` when the value is not a timestamp.
 */
export function parseTimeValue(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const magnitude = Math.abs(value);
    if (magnitude >= EPOCH_MS_THRESHOLD) return value;
    if (magnitude >= EPOCH_SECONDS_MIN) return value * 1000;
    if (Number.isInteger(value) && value >= YEAR_MIN && value <= YEAR_MAX) {
      return Date.UTC(value, 0, 1);
    }
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    if (NUMERIC_STRING.test(trimmed)) {
      return parseTimeValue(Number(trimmed));
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Inspect a feature collection and return the properties that look like
 * timestamps, best first. A property qualifies when at least 60% of the
 * inspected features carry a parseable value. Candidates are ordered by
 * coverage, and ties by how many distinct timestamps they hold: a real time
 * column varies across features, while a constant code that happens to parse
 * (e.g. a `feature_code` of `2100` on every row) collapses to one value and
 * sinks below it.
 *
 * @param geojson - The layer's feature collection.
 * @returns Candidate timestamp properties for the bind dialog.
 */
export function detectTimeProperties(
  geojson: FeatureCollection | undefined,
): TimePropertyCandidate[] {
  const features = geojson?.features ?? [];
  if (features.length === 0) return [];

  const total = new Map<string, number>();
  const parsed = new Map<string, number>();
  const sample = new Map<string, unknown>();
  const distinct = new Map<string, Set<number>>();
  const inspected = Math.min(features.length, SAMPLE_LIMIT);

  for (let i = 0; i < inspected; i += 1) {
    const props = features[i]?.properties;
    if (!props) continue;
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === "") continue;
      total.set(key, (total.get(key) ?? 0) + 1);
      const ms = parseTimeValue(value);
      if (ms !== null) {
        parsed.set(key, (parsed.get(key) ?? 0) + 1);
        if (!sample.has(key)) sample.set(key, value);
        let seen = distinct.get(key);
        if (!seen) distinct.set(key, (seen = new Set()));
        seen.add(ms);
      }
    }
  }

  const candidates: TimePropertyCandidate[] = [];
  for (const [key, parsedCount] of parsed) {
    const totalCount = total.get(key) ?? 0;
    const coverage = totalCount === 0 ? 0 : parsedCount / totalCount;
    if (coverage >= 0.6) {
      candidates.push({ property: key, coverage, sample: sample.get(key) });
    }
  }
  candidates.sort(
    (a, b) =>
      b.coverage - a.coverage ||
      (distinct.get(b.property)?.size ?? 0) - (distinct.get(a.property)?.size ?? 0),
  );
  return candidates;
}

/**
 * Decide how a property stores its timestamps from a sample of its raw values.
 *
 * @param values - Raw, non-empty property values.
 * @returns The detected value kind.
 */
export function detectValueKind(values: unknown[]): TimeValueKind {
  let numeric = 0;
  let years = 0;
  let isoDateOnly = 0;
  let strings = 0;
  let maxMagnitude = 0;

  const countNumber = (n: number): void => {
    numeric += 1;
    maxMagnitude = Math.max(maxMagnitude, Math.abs(n));
    if (Number.isInteger(n) && n >= YEAR_MIN && n <= YEAR_MAX) years += 1;
  };

  for (const value of values) {
    if (typeof value === "number") {
      countNumber(value);
    } else if (typeof value === "string") {
      const trimmed = value.trim();
      if (NUMERIC_STRING.test(trimmed)) {
        countNumber(Number(trimmed));
      } else {
        strings += 1;
        if (ISO_DATE_ONLY.test(trimmed)) isoDateOnly += 1;
      }
    }
  }

  // Only a purely numeric column is treated as epoch or year. If any date
  // strings are present the column is compared as ISO text, so a mixed (or
  // exactly 50/50) sample is never misclassified as epoch — which would coerce
  // the ISO strings to NaN and silently drop them. An all-years sample is a
  // vintage column; otherwise magnitude tells milliseconds from seconds.
  if (numeric > 0 && strings === 0) {
    if (years === numeric) return "year";
    return maxMagnitude >= EPOCH_MS_THRESHOLD ? "epochMs" : "epochS";
  }
  // Bare calendar dates compare date-only; otherwise (datetimes, or an empty /
  // ambiguous sample) fall back to the safe full-string comparison.
  return strings > 0 && isoDateOnly === strings ? "isoDate" : "isoDateTime";
}

/**
 * Pick a sensible stepping granularity for a timeline that spans `spanMs`.
 *
 * @param spanMs - The data extent in milliseconds.
 * @returns The granularity to step the timeline by.
 */
export function pickGranularity(spanMs: number): TimeGranularity {
  const DAY = 86_400_000;
  if (spanMs <= 2 * DAY) return "hour";
  if (spanMs <= 120 * DAY) return "day";
  if (spanMs <= 3 * 365 * DAY) return "month";
  return "year";
}

/**
 * Build a {@link TimeBinding} for a property, scanning the data once to find its
 * extent and value kind. Returns `null` when the property has no parseable
 * timestamps.
 *
 * @param geojson - The layer's feature collection.
 * @param property - The chosen timestamp property.
 * @param window - Optional explicit window; defaults to one granularity step.
 * @returns The binding, or `null` when the property is not time-like.
 */
export function buildTimeBinding(
  geojson: FeatureCollection | undefined,
  property: string,
  window?: TimeWindow,
): TimeBinding | null {
  const features = geojson?.features ?? [];
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const rawSamples: unknown[] = [];

  for (let i = 0; i < features.length; i += 1) {
    const value = features[i]?.properties?.[property];
    if (value === null || value === undefined || value === "") continue;
    const ms = parseTimeValue(value);
    if (ms === null) continue;
    if (ms < min) min = ms;
    if (ms > max) max = ms;
    // Sample the first SAMPLE_LIMIT *parseable* values (not the first indices),
    // so value-kind detection is never starved when invalid rows lead the data.
    if (rawSamples.length < SAMPLE_LIMIT) rawSamples.push(value);
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  // A single-instant dataset still needs a non-zero span so the slider can move.
  if (max <= min) max = min + 86_400_000;

  const granularity = pickGranularity(max - min);
  return {
    property,
    valueKind: detectValueKind(rawSamples),
    min,
    max,
    granularity,
    window: window ?? { unit: granularity, before: 0, after: 1 },
  };
}

/**
 * Advance a date by `amount` units of `unit`. Hour/day use millisecond math;
 * month/year use UTC calendar components so month lengths and leap years are
 * respected and the result aligns with `toISOString` bounds. The day of month
 * is clamped to the target month's length so a shift from a month-end date does
 * not roll over (e.g. Jan 31 + 1 month is Feb 28, not Mar 3).
 *
 * @param date - The base date.
 * @param unit - The granularity unit.
 * @param amount - Signed number of units to add.
 * @returns A new shifted date.
 */
export function addGranularityUnits(date: Date, unit: TimeGranularity, amount: number): Date {
  if (unit === "hour") return new Date(date.getTime() + amount * 3_600_000);
  if (unit === "day") return new Date(date.getTime() + amount * 86_400_000);
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const h = date.getUTCHours();
  const min = date.getUTCMinutes();
  const s = date.getUTCSeconds();
  // Resolve the target year/month, folding any month overflow into the year.
  const rawMonth = unit === "month" ? m + amount : m;
  const targetYear = (unit === "year" ? y + amount : y) + Math.floor(rawMonth / 12);
  const targetMonth = ((rawMonth % 12) + 12) % 12;
  // Day 0 of the next month is the last day of the target month.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return new Date(Date.UTC(targetYear, targetMonth, day, h, min, s));
}

/**
 * Build a MapLibre filter expression that keeps only the features whose
 * timestamp falls inside the binding's window around `date`. The expression
 * compares against the property in place (no feature rewrite), matching the way
 * the data stores its values (see {@link TimeValueKind}).
 *
 * @param binding - The layer's time binding.
 * @param date - The timeline's current date.
 * @returns A MapLibre filter expression (assignable to `GeoLibreLayer.timeFilter`).
 */
export function buildTimeFilter(binding: TimeBinding, date: Date): unknown[] {
  const { window, property, valueKind } = binding;
  const lowerMs = addGranularityUnits(date, window.unit, -window.before).getTime();
  const upperMs = addGranularityUnits(date, window.unit, window.after).getTime();

  if (valueKind === "epochMs" || valueKind === "epochS") {
    const scale = valueKind === "epochS" ? 0.001 : 1;
    const value = ["to-number", ["get", property]];
    return ["all", [">=", value, lowerMs * scale], ["<", value, upperMs * scale]];
  }

  if (valueKind === "year") {
    // A year Y is in the window iff its Jan 1 UTC anchor falls in
    // [lowerMs, upperMs), i.e. Y lies in [firstYearAtOrAfter(lowerMs),
    // firstYearAtOrAfter(upperMs)). Comparing the year numbers directly keeps
    // the filter a plain numeric comparison on the raw property value.
    // `to-number` coerces a missing property to 0, below YEAR_MIN, so undated
    // features fall outside every window.
    const firstYearAtOrAfter = (ms: number): number => {
      const y = new Date(ms).getUTCFullYear();
      return Date.UTC(y, 0, 1) >= ms ? y : y + 1;
    };
    const value = ["to-number", ["get", property]];
    return [
      "all",
      [">=", value, firstYearAtOrAfter(lowerMs)],
      ["<", value, firstYearAtOrAfter(upperMs)],
    ];
  }

  // Compare a fixed-length leading slice of the ISO text on both sides so a
  // trailing `Z`, a `.SSS` milliseconds fraction, or a timezone offset cannot
  // break the boundary comparison: `YYYY-MM-DD` for date-only,
  // `YYYY-MM-DDTHH:MM:SS` for datetimes. Timestamps are therefore compared by
  // their wall-clock text and should use a consistent representation (UTC is
  // recommended); mixed explicit offsets are not normalized.
  const boundLength = valueKind === "isoDate" ? 10 : 19;
  const toBound = (ms: number): string => new Date(ms).toISOString().slice(0, boundLength);
  // `to-string` coerces missing/null values to "" so the comparison never
  // throws on a feature that lacks the property; "" sorts before any real
  // timestamp, so undated features fall outside every window.
  const value = ["slice", ["to-string", ["get", property]], 0, boundLength];
  return ["all", [">=", value, toBound(lowerMs)], ["<", value, toBound(upperMs)]];
}
