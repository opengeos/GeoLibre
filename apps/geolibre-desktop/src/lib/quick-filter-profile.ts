import type { QuickFilterDateKind, QuickFilterKind } from "@geolibre/core";

/**
 * Field profiling for quick filters (issue #2114): decide which control a
 * field deserves — checkboxes with counts, a numeric range, a date range, or a
 * text match — from the values the field actually holds.
 *
 * The profile is derived, never persisted: only the control state the user
 * answers with is stored on the layer (`LayerQuickFilter`). That keeps a saved
 * filter meaningful when the underlying data changes, and keeps the profile
 * free to be recomputed from whatever the app can see — a GeoJSON layer's full
 * feature list, or the features a tile-backed layer has currently loaded.
 *
 * Every field reports both a suggested control and the controls it *supports*,
 * so a numeric code column that profiles as a range can still be filtered with
 * checkboxes if that is what the question calls for.
 */

/** A distinct value of a field, with how many inspected features carry it. */
export interface QuickFilterValueCount {
  value: string | number | boolean;
  count: number;
}

/** What a single field looks like, and which controls suit it. */
export interface QuickFilterFieldProfile {
  field: string;
  /** The control the field is best served by. */
  kind: QuickFilterKind;
  /** Every control the field can render, in the order they should be offered. */
  availableKinds: QuickFilterKind[];
  /**
   * Distinct values with counts, most frequent first. Empty when the field has
   * too many distinct values to enumerate (see {@link valuesTruncated}).
   */
  values: QuickFilterValueCount[];
  /** Distinct values exceeded the cap, so `values` is not the whole set. */
  valuesTruncated: boolean;
  /** Numeric extent, present for a field that supports a range control. */
  min?: number;
  max?: number;
  /** How a date field stores its values, and its `YYYY-MM-DD` extent. */
  dateKind?: QuickFilterDateKind;
  minDate?: string;
  maxDate?: string;
  /** Features inspected, and how many of them carried a value for this field. */
  sampled: number;
  present: number;
}

export interface ProfileQuickFilterOptions<T = Record<string, unknown> | null | undefined> {
  /** Features to inspect. Defaults to {@link PROFILE_LIMIT}. */
  sampleLimit?: number;
  /** Field names to skip (geometry helpers, tracking columns, …). */
  exclude?: readonly string[];
  /**
   * Profile only these fields instead of every field. A quick filter needs the
   * profile of the one field it is on, so asking for that field alone costs a
   * property read per feature rather than a tally of the whole attribute table.
   * A requested field that no inspected record carries gets no profile.
   */
  fields?: readonly string[];
  /**
   * How to reach a record's property bag. Lets a caller hand over its features
   * as they are instead of first mapping them to a second array of bags.
   */
  properties?: (record: T) => Record<string, unknown> | null | undefined;
}

/**
 * A pass over a layer's records that can be run a slice at a time, so a caller
 * can keep it off the render path and yield to the event loop between slices.
 */
export interface QuickFilterScan {
  /**
   * Read records until the pass is complete or `shouldYield` asks for a break.
   *
   * @param shouldYield - Polled every {@link SCAN_YIELD_INTERVAL} records;
   *   return `true` to stop the slice. Omit to run to completion.
   * @returns `true` once every record within the sample limit has been read.
   */
  step(shouldYield?: () => boolean): boolean;
  /** One profile per scanned field, in first-seen order. Call once the scan is done. */
  profiles(): QuickFilterFieldProfile[];
  /**
   * Every field name seen, in first-seen order, when the scan was created with
   * `names: true`. Not narrowed by `fields` or `exclude`.
   */
  fieldNames(): string[];
}

/**
 * Features inspected per layer by default. The value counts are shown next to
 * each checkbox and the numeric/date extents bound the range sliders, so the
 * profile reads every feature of an ordinary layer (as the attribute table's
 * column explorer does) rather than presenting a sample as totals. At this
 * many features a pass over a wide attribute table already takes about half a
 * second, so a larger layer is profiled from its first {@link PROFILE_LIMIT}
 * features and the panel says so (see `useQuickFilterProfiles`).
 */
const PROFILE_LIMIT = 50_000;

/**
 * Distinct values past which a field is not offered as checkboxes. A list this
 * long is a search box, not a set of boxes to tick.
 */
const MAX_DISTINCT = 200;

/** Distinct values up to which checkboxes are the *suggested* control. */
const SUGGEST_CATEGORICAL_MAX = 25;

/** Above this magnitude a numeric timestamp is milliseconds, not seconds. */
const EPOCH_MS_THRESHOLD = 1e11;

/** Below this magnitude a number is an ordinary measure, not an epoch stamp. */
const EPOCH_SECONDS_MIN = 1e8;

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Text that reads as a plain number. Mirrors the Time Slider's own detector. */
const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

/**
 * A padded *integer* (`02134`, `007`) is an identifier that happens to be made
 * of digits, not a measure: a ZIP code or a FIPS code belongs in a value list,
 * and turning it into a range slider would both misrepresent it and lose the
 * padding. Excluded from numeric-string detection for that reason.
 *
 * Anchored at both ends so it matches only whole padded integers. A decimal
 * that happens to start with a padded zero (`01.25`) is still a measure, and a
 * bare `0` carries no padding at all.
 */
const LEADING_ZERO_INTEGER = /^-?0\d+$/;

/**
 * The number a value holds for profiling, or `null` when it is not numeric.
 *
 * Numeric text counts: a CSV, a delimited-text import, or a service that does
 * not preserve JS number types can deliver `"1200"` where another source
 * delivers `1200`, and the compiled filter coerces with `to-number` either way
 * — so refusing to profile the string form would withhold the range and date
 * controls from a field they would filter correctly.
 */
function numericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!NUMERIC_STRING.test(trimmed) || LEADING_ZERO_INTEGER.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Values that carry no information for a filter control. */
function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/** The `YYYY-MM-DD` day of an epoch-millisecond instant, or `undefined`. */
function isoDay(ms: number): string | undefined {
  if (!Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

interface FieldTally {
  present: number;
  strings: number;
  /** Values that read as numbers, whether stored as numbers or as numeric text. */
  numericLike: number;
  numbers: number;
  booleans: number;
  others: number;
  isoDates: number;
  isoDateTimes: number;
  min: number;
  max: number;
  minEpochMs: number;
  maxEpochMs: number;
  epochCandidates: number;
  /** Largest raw magnitude among epoch candidates, telling seconds from milliseconds. */
  maxEpochMagnitude: number;
  counts: Map<string | number | boolean, number>;
  distinctOverflow: boolean;
}

function newTally(): FieldTally {
  return {
    present: 0,
    strings: 0,
    numericLike: 0,
    numbers: 0,
    booleans: 0,
    others: 0,
    isoDates: 0,
    isoDateTimes: 0,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
    minEpochMs: Number.POSITIVE_INFINITY,
    maxEpochMs: Number.NEGATIVE_INFINITY,
    epochCandidates: 0,
    maxEpochMagnitude: 0,
    counts: new Map(),
    distinctOverflow: false,
  };
}

function tallyValue(tally: FieldTally, value: unknown): void {
  tally.present += 1;

  const numeric = numericValue(value);
  if (numeric !== null) {
    tally.numericLike += 1;
    if (typeof value === "number") tally.numbers += 1;
    else tally.strings += 1;
    tally.min = Math.min(tally.min, numeric);
    tally.max = Math.max(tally.max, numeric);
    const magnitude = Math.abs(numeric);
    if (magnitude >= EPOCH_SECONDS_MIN) {
      // Only a clearly epoch-scale number is a timestamp candidate. A bare
      // year (1998) or a population count stays an ordinary measure, which is
      // what a range slider is for.
      tally.epochCandidates += 1;
      tally.maxEpochMagnitude = Math.max(tally.maxEpochMagnitude, magnitude);
      const ms = magnitude >= EPOCH_MS_THRESHOLD ? numeric : numeric * 1000;
      tally.minEpochMs = Math.min(tally.minEpochMs, ms);
      tally.maxEpochMs = Math.max(tally.maxEpochMs, ms);
    }
  } else if (typeof value === "string") {
    tally.strings += 1;
    const trimmed = value.trim();
    const isDateOnly = ISO_DATE_ONLY.test(trimmed);
    if (isDateOnly || ISO_DATE_TIME.test(trimmed)) {
      const ms = Date.parse(isDateOnly ? `${trimmed}T00:00:00Z` : trimmed);
      if (Number.isFinite(ms)) {
        if (isDateOnly) tally.isoDates += 1;
        else tally.isoDateTimes += 1;
        tally.minEpochMs = Math.min(tally.minEpochMs, ms);
        tally.maxEpochMs = Math.max(tally.maxEpochMs, ms);
      }
    }
  } else if (typeof value === "boolean") {
    tally.booleans += 1;
  } else {
    // Nested objects and arrays cannot be compared by any of the controls.
    tally.others += 1;
    return;
  }

  const key = value as string | number | boolean;
  const seen = tally.counts.get(key);
  if (seen !== undefined) {
    tally.counts.set(key, seen + 1);
  } else if (tally.counts.size < MAX_DISTINCT) {
    tally.counts.set(key, 1);
  } else {
    tally.distinctOverflow = true;
  }
}

/**
 * Turn one field's tally into its profile: which controls it supports, which
 * one to suggest, and the value list / extents those controls need.
 */
function profileFromTally(
  field: string,
  tally: FieldTally,
  sampled: number,
): QuickFilterFieldProfile {
  const { present } = tally;
  // Numeric text counts as numeric: the compiled filter coerces with
  // `to-number`, so a CSV column of `"1200"` deserves the same range control a
  // column of `1200` gets.
  const allNumbers = present > 0 && tally.numericLike === present;
  const allStrings = present > 0 && tally.strings === present;
  const isoTotal = tally.isoDates + tally.isoDateTimes;
  // A date column is one whose text values are *all* ISO timestamps, or whose
  // numbers are all at epoch scale. A mixed column is compared as text instead,
  // where a non-date value cannot be silently coerced into range.
  const isIsoDate = allStrings && isoTotal === present;
  const isEpochDate = allNumbers && tally.epochCandidates === present;
  const isDate = isIsoDate || isEpochDate;

  const distinct = tally.counts.size;
  const canEnumerate = present > 0 && !tally.distinctOverflow && distinct > 0;

  const availableKinds: QuickFilterKind[] = [];
  if (isDate) availableKinds.push("date");
  if (allNumbers && !isEpochDate) availableKinds.push("range");
  if (canEnumerate) availableKinds.push("categorical");
  if (tally.strings > 0) availableKinds.push("text");
  // A field of nothing but nested values (or one with no values at all) still
  // offers a text match, so it is never listed with no way to filter it.
  if (availableKinds.length === 0) availableKinds.push("text");

  // A numeric field is always *suggested* as a range: guessing that a small set
  // of numbers is a code rather than a measure gets it wrong as often as right
  // (four cities' populations are four distinct numbers too), and checkboxes
  // stay one click away in `availableKinds`.
  let kind: QuickFilterKind;
  if (isDate) {
    kind = "date";
  } else if (allNumbers) {
    kind = "range";
  } else if (canEnumerate && distinct <= SUGGEST_CATEGORICAL_MAX) {
    kind = "categorical";
  } else {
    kind = "text";
  }

  const values: QuickFilterValueCount[] = canEnumerate
    ? [...tally.counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)))
    : [];

  const profile: QuickFilterFieldProfile = {
    field,
    kind,
    availableKinds,
    values,
    valuesTruncated: tally.distinctOverflow,
    sampled,
    present,
  };

  if (availableKinds.includes("range")) {
    profile.min = tally.min;
    profile.max = tally.max;
  }
  if (isDate) {
    profile.dateKind = isIsoDate
      ? "iso"
      : tally.maxEpochMagnitude >= EPOCH_MS_THRESHOLD
        ? "epochMs"
        : "epochS";
    profile.minDate = isoDay(tally.minEpochMs);
    profile.maxDate = isoDay(tally.maxEpochMs);
  }
  return profile;
}

/** Records read between two `shouldYield` polls of a {@link QuickFilterScan}. */
const SCAN_YIELD_INTERVAL = 512;

const hasOwn = Object.prototype.hasOwnProperty;

/**
 * Start a resumable pass over a layer's records.
 *
 * With `fields`, only those fields are tallied; without it, every field is
 * (minus `exclude`). With `names`, the pass also collects every field name it
 * sees, which is all the "Add a filter" menu needs until a field is picked: a
 * scan created with `fields: []` and `names: true` lists the fields without
 * tallying a single value.
 *
 * @param records - The layer's records, in sample order.
 * @param options - Sample size, the fields to profile or skip, how to reach a
 *   record's properties, and whether to collect field names.
 * @returns The scan, not yet started.
 */
export function createQuickFilterScan<T = Record<string, unknown> | null | undefined>(
  records: readonly T[],
  options: ProfileQuickFilterOptions<T> & { names?: boolean } = {},
): QuickFilterScan {
  const limit = Math.max(0, options.sampleLimit ?? PROFILE_LIMIT);
  const excluded = new Set(options.exclude ?? []);
  const wanted = options.fields ? [...new Set(options.fields)] : null;
  const propertiesOf = options.properties;
  const names = options.names ? new Set<string>() : null;
  const tallies = new Map<string, FieldTally>();
  const inspected = Math.min(records.length, limit);
  let index = 0;

  const tallyField = (field: string, value: unknown): void => {
    let tally = tallies.get(field);
    if (!tally) tallies.set(field, (tally = newTally()));
    if (!isEmptyValue(value)) tallyValue(tally, value);
  };

  return {
    step(shouldYield) {
      while (index < inspected) {
        const record = records[index];
        index += 1;
        const properties = propertiesOf
          ? propertiesOf(record)
          : (record as Record<string, unknown> | null | undefined);
        if (properties) {
          if (wanted) {
            if (names) for (const field of Object.keys(properties)) names.add(field);
            for (const field of wanted) {
              if (hasOwn.call(properties, field)) tallyField(field, properties[field]);
            }
          } else {
            for (const [field, value] of Object.entries(properties)) {
              names?.add(field);
              if (!excluded.has(field)) tallyField(field, value);
            }
          }
        }
        if (index % SCAN_YIELD_INTERVAL === 0 && index < inspected && shouldYield?.()) {
          return false;
        }
      }
      return true;
    },
    profiles() {
      return [...tallies.entries()].map(([field, tally]) =>
        profileFromTally(field, tally, inspected),
      );
    },
    fieldNames() {
      return names ? [...names] : [];
    },
  };
}

/**
 * Profile fields across feature property bags in one synchronous pass.
 *
 * @param records - Feature property bags, in sample order. Tile-backed layers
 *   pass whatever is currently loaded; GeoJSON layers pass their features.
 * @param options - Sample size, and the fields to profile or skip.
 * @returns One profile per field, in first-seen order.
 */
export function profileQuickFilterFields<T = Record<string, unknown> | null | undefined>(
  records: readonly T[],
  options: ProfileQuickFilterOptions<T> = {},
): QuickFilterFieldProfile[] {
  const scan = createQuickFilterScan(records, options);
  scan.step();
  return scan.profiles();
}

export const QUICK_FILTER_PROFILE_LIMIT = PROFILE_LIMIT;
