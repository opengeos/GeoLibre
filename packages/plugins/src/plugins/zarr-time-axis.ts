import { parseTimeValue } from "./time-slider-binding";

/**
 * Reading a Zarr data cube's time axis so the Time Slider can drive it.
 *
 * `@carbonplan/zarr-layer` loads every non-spatial coordinate when a layer
 * initializes, but it hands back the **raw** values: a CF-encoded time axis
 * arrives as plain numbers (`19723`), not dates. Turning those into instants
 * needs the coordinate's `units` attribute (`"days since 1970-01-01"`), which
 * lives in the store's metadata rather than in the renderer, so this module
 * fetches it and decodes the axis.
 *
 * Everything here is deliberately independent of the renderer and of the store
 * layer: it takes a store URL, a dimension name, and raw values.
 */

/**
 * Dimension names read as a time axis, best first.
 *
 * Exported because the NetCDF path has to make the same call: a variable whose
 * leading axis is one of these keeps the Zarr render path so the Time Slider can
 * drive it, and is never offered as a band axis. Two copies would drift, and the
 * same file would then take different render paths depending on how it was
 * opened.
 */
export const TIME_DIMENSION_NAMES = [
  "time",
  "valid_time",
  "datetime",
  "date",
  "t",
  "forecast_time",
  "period",
];

/**
 * Fixed-length CF time units, in milliseconds. `months` and `years` are
 * deliberately absent: they are not a fixed number of milliseconds, so decoding
 * them would drift, and CF itself discourages their use for time coordinates.
 */
const CF_UNIT_MS: Record<string, number> = {
  millisecond: 1,
  milliseconds: 1,
  msec: 1,
  msecs: 1,
  ms: 1,
  second: 1000,
  seconds: 1000,
  sec: 1000,
  secs: 1000,
  s: 1000,
  minute: 60_000,
  minutes: 60_000,
  min: 60_000,
  mins: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  h: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
  d: 86_400_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

/**
 * Calendars whose day lengths match the proleptic Gregorian arithmetic
 * `Date.UTC` does. A `360_day` or `noleap` axis decoded with these rules drifts
 * further from the truth with every step, so such a store is reported as having
 * no usable time axis instead of a subtly wrong one.
 */
const SUPPORTED_CALENDARS = new Set(["standard", "gregorian", "proleptic_gregorian"]);

/** A decoded CF `<unit> since <reference date>` specification. */
export interface CfTimeUnits {
  /** Length of one axis step, in milliseconds. */
  unitMs: number;
  /** The reference date, in epoch milliseconds. */
  epochMs: number;
}

/**
 * Parse a CF `units` string such as `"days since 1970-01-01"` or
 * `"hours since 1900-01-01 00:00:00 +0:00"`.
 *
 * @param units - The coordinate's `units` attribute.
 * @returns The step length and reference instant, or null when the string is
 *   not a fixed-length CF time specification.
 */
export function parseCfTimeUnits(units: string | null | undefined): CfTimeUnits | null {
  if (typeof units !== "string") return null;
  const match = /^\s*([A-Za-z]+)\s+since\s+(.+?)\s*$/.exec(units);
  if (!match) return null;
  const unitMs = CF_UNIT_MS[match[1].toLowerCase()];
  if (unitMs === undefined) return null;
  const epochMs = parseCfReferenceDate(match[2]);
  return epochMs === null ? null : { unitMs, epochMs };
}

/**
 * Parse the reference date of a CF `units` string. Accepts the forms CF allows
 * (`YYYY-MM-DD`, an optional `T`- or space-separated time, an optional zone),
 * defaulting to UTC as CF specifies.
 *
 * @param reference - The text after `since`.
 * @returns Epoch milliseconds, or null when it is not a date.
 */
function parseCfReferenceDate(reference: string): number | null {
  const match =
    /^(\d{1,4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?)?\s*(Z|UTC|GMT|[+-]\d{1,2}(?::?\d{2})?)?\s*$/i.exec(
      reference.trim(),
    );
  if (!match) return null;
  const [, year, month, day, hours = "0", minutes = "0", seconds = "0", zone] = match;
  const offsetMs = parseZoneOffsetMs(zone);
  if (offsetMs === null) return null;
  const wholeSeconds = Math.floor(Number(seconds));
  const milliseconds = Math.round((Number(seconds) - wholeSeconds) * 1000);
  const base = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hours),
      Number(minutes),
      wholeSeconds,
      milliseconds,
    ),
  );
  // Date.UTC maps a two-digit year onto 1900-1999, which would silently turn a
  // reference of `0001-01-01` into 1901. Set the year explicitly instead.
  base.setUTCFullYear(Number(year));
  const ms = base.getTime();
  return Number.isFinite(ms) ? ms - offsetMs : null;
}

/**
 * Read a CF zone suffix into a millisecond offset from UTC. An absent zone is
 * UTC, per CF.
 *
 * @param zone - `Z`, `UTC`, `GMT`, `+HH`, `+HH:MM`, `+HHMM`, or undefined.
 * @returns The offset in milliseconds, or null when it cannot be read.
 */
function parseZoneOffsetMs(zone: string | undefined): number | null {
  if (!zone) return 0;
  if (/^(Z|UTC|GMT)$/i.test(zone)) return 0;
  const match = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(zone);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 3_600_000 + Number(match[3] ?? 0) * 60_000);
}

/**
 * Decode raw CF time values into epoch milliseconds, keeping index alignment: a
 * value that is not a finite number becomes `NaN` rather than shifting the axis.
 *
 * @param values - The coordinate's raw values, in index order.
 * @param units - The decoded `units` specification.
 * @returns The axis in epoch milliseconds.
 */
export function decodeCfTimeValues(
  values: ReadonlyArray<number | string | Date>,
  units: CfTimeUnits,
): number[] {
  return values.map((value) => {
    const raw = typeof value === "string" ? Number(value) : value;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return Number.NaN;
    return units.epochMs + raw * units.unitMs;
  });
}

/**
 * Choose which of a store's non-spatial dimensions is its time axis.
 *
 * A recognized name wins (`time`, `valid_time`, ...); failing that, a dimension
 * whose values already read as timestamps (ISO date strings, epoch numbers) is
 * accepted, so a store with an unconventional axis name still binds. A
 * dimension of plain small integers (a `month` of 1-12, a `band` index) is not
 * a time axis on its own and is left alone.
 *
 * @param dimensionValues - Raw coordinate values keyed by dimension name.
 * @returns The chosen dimension name, or null when none looks temporal.
 */
export function pickTimeDimension(
  dimensionValues: Record<string, ReadonlyArray<number | string> | undefined> | null | undefined,
): string | null {
  if (!dimensionValues) return null;
  const names = Object.keys(dimensionValues).filter(
    (name) => (dimensionValues[name]?.length ?? 0) > 0,
  );
  for (const candidate of TIME_DIMENSION_NAMES) {
    const match = names.find((name) => name.toLowerCase() === candidate);
    if (match) return match;
  }
  for (const name of names) {
    const values = dimensionValues[name] ?? [];
    // Require every sampled value to read as a timestamp, so a numeric index
    // dimension that happens to hold a few four-digit entries is not adopted.
    const sample = values.slice(0, 32);
    if (sample.every((value) => parseTimeValue(value) !== null)) return name;
  }
  return null;
}

/** The `units`/`calendar` attributes of a store's time coordinate. */
export interface ZarrTimeAttributes {
  units?: string;
  calendar?: string;
}

/** Options for {@link fetchZarrTimeAttributes}. */
export interface FetchZarrTimeAttributesOptions {
  /** Request headers for an authenticated store. */
  headers?: Record<string, string>;
  /** Injected fetch, for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds. Defaults to {@link METADATA_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * How long one metadata document may take. A store that accepts the connection
 * and never answers would otherwise leave the walk (and the cached promise
 * every later add awaits) hanging for the life of the page.
 */
const METADATA_TIMEOUT_MS = 10_000;

// One lookup per store+dimension, so re-binding or re-adding a layer does not
// re-walk the metadata documents. Keyed by `<store url>|<dimension>`. Only a
// *successful* lookup is kept: see the eviction in fetchZarrTimeAttributes.
const attributeCache = new Map<string, Promise<ZarrTimeAttributes | null>>();

/**
 * Fetch the `units`/`calendar` attributes of a Zarr store's time coordinate.
 *
 * Walks the documents a store may keep them in, cheapest first: the v2
 * consolidated `.zmetadata`, the v3 root `zarr.json` (which may carry
 * consolidated metadata), then the coordinate's own `.zattrs`/`zarr.json`. Each
 * is also tried under a `0/` prefix, because a multiscale pyramid keeps its
 * coordinates inside the first level rather than at the root.
 *
 * A lookup that finds nothing is **not** cached, so a transient outage (or a
 * first, unauthenticated add of a store that later arrives with credentials)
 * does not permanently disable the Time Slider binding for that store.
 *
 * @param storeUrl - The Zarr store's base URL.
 * @param dimension - The time coordinate's name.
 * @param options - Optional headers, timeout, and fetch override.
 * @returns The attributes, or null when the store exposes none.
 */
export function fetchZarrTimeAttributes(
  storeUrl: string,
  dimension: string,
  options: FetchZarrTimeAttributesOptions = {},
): Promise<ZarrTimeAttributes | null> {
  const base = storeUrl.replace(/\/+$/, "");
  const key = `${base}|${dimension}`;
  const cached = attributeCache.get(key);
  if (cached) return cached;
  const pending = readZarrTimeAttributes(base, dimension, options).catch(() => null);
  attributeCache.set(key, pending);
  void pending.then((attributes) => {
    // Keep only a hit. Evicting a miss costs one repeated walk per add of a
    // store that has no attributes, and buys a retry after a failure.
    if (!attributes && attributeCache.get(key) === pending) attributeCache.delete(key);
  });
  return pending;
}

async function readZarrTimeAttributes(
  base: string,
  dimension: string,
  options: FetchZarrTimeAttributesOptions,
): Promise<ZarrTimeAttributes | null> {
  const timeoutMs = options.timeoutMs ?? METADATA_TIMEOUT_MS;
  const fetchJson = async (path: string): Promise<unknown> => {
    const doFetch = options.fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== "function") return null;
    try {
      const response = await doFetch(`${base}/${path}`, {
        ...(options.headers ? { headers: options.headers } : {}),
        // Bound each document, so an unresponsive store aborts the walk rather
        // than hanging it. `AbortSignal.timeout` is absent in older runtimes
        // (and in some test stubs), so its absence just means no timeout.
        ...(typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
          ? { signal: AbortSignal.timeout(timeoutMs) }
          : {}),
      });
      if (!response.ok) return null;
      return (await response.json()) as unknown;
    } catch {
      // A missing document is the normal case for most of these paths (a v2
      // store has no `zarr.json`), so a failed lookup just moves to the next.
      return null;
    }
  };

  const consolidatedV2 = await fetchJson(".zmetadata");
  const fromV2 = attributesFromConsolidatedV2(consolidatedV2, dimension);
  if (fromV2) return fromV2;

  const rootV3 = await fetchJson("zarr.json");
  const fromV3 = attributesFromConsolidatedV3(rootV3, dimension);
  if (fromV3) return fromV3;

  return readCoordinateTimeAttributes(fetchJson, dimension);
}

/**
 * Walk a coordinate's own metadata documents for its CF `units`/`calendar`.
 *
 * Both Zarr versions are tried (`.zattrs`, then a v3 node's `attributes`), each
 * at the root and one level down, where a multiscale pyramid keeps its
 * coordinates. The reader is the seam: over HTTP, out of a folder on disk, or
 * through an Icechunk manifest — and only the last two can answer at all for a
 * store whose keys are not URLs.
 *
 * @param readDocument - Reads one store-relative key as parsed JSON.
 * @param dimension - The coordinate's name, e.g. `"time"`.
 * @returns Its `units`/`calendar`, or null when no document declares either.
 */
export async function readCoordinateTimeAttributes(
  readDocument: (key: string) => Promise<unknown>,
  dimension: string,
): Promise<ZarrTimeAttributes | null> {
  for (const prefix of ["", "0/"]) {
    for (const key of [`${prefix}${dimension}/.zattrs`, `${prefix}${dimension}/zarr.json`]) {
      const document = await readDocument(key);
      const attributes = key.endsWith("zarr.json")
        ? (document as { attributes?: unknown } | null | undefined)?.attributes
        : document;
      const picked = pickTimeAttributes(attributes);
      if (picked) return picked;
    }
  }
  return null;
}

/** Pull `units`/`calendar` out of an attributes object, if it has either. */
function pickTimeAttributes(attributes: unknown): ZarrTimeAttributes | null {
  if (!attributes || typeof attributes !== "object") return null;
  const record = attributes as Record<string, unknown>;
  const units = typeof record.units === "string" ? record.units : undefined;
  const calendar = typeof record.calendar === "string" ? record.calendar : undefined;
  if (units === undefined && calendar === undefined) return null;
  return {
    ...(units !== undefined ? { units } : {}),
    ...(calendar !== undefined ? { calendar } : {}),
  };
}

/**
 * Find the dimension's attributes in v2 consolidated metadata, whose keys are
 * store paths (`"time/.zattrs"`, or `"0/time/.zattrs"` in a pyramid).
 */
function attributesFromConsolidatedV2(
  document: unknown,
  dimension: string,
): ZarrTimeAttributes | null {
  const metadata = (document as { metadata?: unknown } | null)?.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const suffix = `${dimension}/.zattrs`;
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (key !== suffix && !key.endsWith(`/${suffix}`)) continue;
    const attributes = pickTimeAttributes(value);
    if (attributes) return attributes;
  }
  return null;
}

/**
 * Find the dimension's attributes in a v3 root `zarr.json` carrying
 * consolidated metadata, whose entries are keyed by node path.
 */
function attributesFromConsolidatedV3(
  document: unknown,
  dimension: string,
): ZarrTimeAttributes | null {
  const consolidated = (document as { consolidated_metadata?: unknown } | null)
    ?.consolidated_metadata;
  const metadata = (consolidated as { metadata?: unknown } | null)?.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (key !== dimension && !key.endsWith(`/${dimension}`)) continue;
    const attributes = pickTimeAttributes((value as { attributes?: unknown } | null)?.attributes);
    if (attributes) return attributes;
  }
  return null;
}

/** The time axis resolved for a Zarr layer. */
export interface ZarrTimeAxis {
  /** The internal dimension the timeline drives, e.g. `"time"`. */
  dimension: string;
  /** The axis in epoch milliseconds, index-aligned with the store. */
  values: number[];
}

/** Options for {@link resolveZarrTimeAxis}. */
export interface ResolveZarrTimeAxisOptions extends FetchZarrTimeAttributesOptions {
  /** Use this dimension instead of detecting one. */
  dimension?: string;
  /**
   * Attributes the caller already holds, skipping the metadata lookup. Used by
   * the Cloud-Optimized NetCDF flow, whose `url` points at a kerchunk manifest
   * rather than a Zarr store, so walking the store's metadata documents would
   * only produce a run of 404s.
   */
  attributes?: ZarrTimeAttributes | null;
}

/**
 * Resolve a Zarr store's time axis from the raw coordinate values the renderer
 * loaded, decoding CF-encoded numbers with the store's `units` attribute.
 *
 * The `units` attribute is consulted **first** for a numeric axis: a raw value
 * like `1980` is a plausible calendar year *and* a plausible "days since 1970"
 * offset, and only the store can say which. An axis of date strings, or of
 * numbers with no `units` to decode them, falls back to the same reader the
 * vector time bindings use.
 *
 * @param storeUrl - The Zarr store's base URL.
 * @param dimensionValues - Raw coordinate values keyed by dimension name.
 * @param options - Optional explicit dimension, headers, and fetch override.
 * @returns The decoded axis, or null when the store has no usable time axis.
 */
export async function resolveZarrTimeAxis(
  storeUrl: string,
  dimensionValues: Record<string, ReadonlyArray<number | string> | undefined> | null | undefined,
  options: ResolveZarrTimeAxisOptions = {},
): Promise<ZarrTimeAxis | null> {
  const dimension = options.dimension ?? pickTimeDimension(dimensionValues);
  if (!dimension) return null;
  const raw = dimensionValues?.[dimension];
  if (!raw || raw.length === 0) return null;

  const numeric = raw.every((value) => typeof value === "number" && Number.isFinite(value));
  if (numeric && (options.attributes !== undefined || storeUrl)) {
    const attributes =
      options.attributes !== undefined
        ? options.attributes
        : await fetchZarrTimeAttributes(storeUrl, dimension, options);
    // An unsupported calendar (360_day, noleap, ...) cannot be decoded with
    // Gregorian arithmetic, so report no axis rather than a drifting one.
    if (attributes?.calendar && !SUPPORTED_CALENDARS.has(attributes.calendar.toLowerCase())) {
      return null;
    }
    const units = parseCfTimeUnits(attributes?.units);
    if (units) {
      const values = decodeCfTimeValues(raw, units);
      return values.some((value) => Number.isFinite(value)) ? { dimension, values } : null;
    }
  }

  const values = raw.map((value) => parseTimeValue(value) ?? Number.NaN);
  return values.some((value) => Number.isFinite(value)) ? { dimension, values } : null;
}

/** Clear the metadata lookup cache. Exported for tests. */
export function __resetZarrTimeAttributeCacheForTests(): void {
  attributeCache.clear();
}

/** The outcome of {@link resolveZarrSelectorDates}. */
export interface ZarrSelectorDateResolution {
  /** The selector with date strings swapped for indices, or null when nothing changed. */
  selector: Record<string, number | string> | null;
  /** Dimensions whose string value matched neither a coordinate nor a date on the axis. */
  unresolved: string[];
}

/**
 * Turn date strings in a Zarr selector into indices along the store's time axis.
 *
 * `@carbonplan/zarr-layer` matches a string selector value against the raw
 * coordinate values, so `{ time: "2020-08-01" }` never matches a CF time axis
 * stored as `days since 1800-01-01` numbers. It reports that only as a console
 * warning and draws nothing, while the panel has already said the layer was
 * added (#3470). This reads the date against the decoded axis instead.
 *
 * A value that already names a coordinate is left alone, so a string-labelled
 * axis (`band: "prec"`) keeps matching natively. A date is taken to its nearest
 * time step, as the Time Slider does, but only within one step of the axis' own
 * span: a date years past the data is reported, not clamped to the last step.
 *
 * @param selector - The layer's selector, e.g. `{ time: "2020-08-01" }`.
 * @param dimensionValues - Raw coordinate values keyed by dimension name.
 * @param axis - The decoded time axis, or null when the store has none.
 * @returns The rewritten selector (null when unchanged) and the dimensions whose
 *   value could not be matched at all.
 */
export function resolveZarrSelectorDates(
  selector: Record<string, number | string> | null | undefined,
  dimensionValues: Record<string, ReadonlyArray<number | string> | undefined> | null | undefined,
  axis: ZarrTimeAxis | null,
): ZarrSelectorDateResolution {
  const unresolved: string[] = [];
  if (!selector) return { selector: null, unresolved };
  let changed = false;
  const next: Record<string, number | string> = { ...selector };
  for (const [dimension, value] of Object.entries(selector)) {
    if (typeof value !== "string") continue;
    const raw = dimensionValues?.[dimension];
    // The renderer only matches against values it loaded; with none loaded there
    // is nothing to check the selector against here either.
    if (!raw || raw.length === 0) continue;
    if (raw.includes(value)) continue;
    const index = axis?.dimension === dimension ? dateIndexOnAxis(axis.values, value) : -1;
    if (index >= 0) {
      next[dimension] = index;
      changed = true;
    } else {
      unresolved.push(dimension);
    }
  }
  return { selector: changed ? next : null, unresolved };
}

/**
 * The index of the time step nearest a date string, or -1 when the string is
 * not a date or falls more than one step outside the axis.
 *
 * @param values - The axis in epoch milliseconds, index-aligned with the store.
 * @param text - The selector's date, e.g. `"2020-08-01"`.
 * @returns The nearest index, or -1.
 */
function dateIndexOnAxis(values: readonly number[], text: string): number {
  const target = parseTimeValue(text);
  if (target === null) return -1;
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let step = 0;
  let previous: number | null = null;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
    if (previous !== null) step = Math.max(step, Math.abs(value - previous));
    previous = value;
    const distance = Math.abs(value - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  if (best < 0) return -1;
  // A single-step axis has no spacing to measure; allow a day either side.
  const tolerance = step > 0 ? step : 86_400_000;
  return target >= min - tolerance && target <= max + tolerance ? best : -1;
}

/**
 * Build the selector that reads several slices of a Zarr time axis at once.
 *
 * The slices are named by **position** with an explicit `type: "index"`: a bare
 * number is first matched against the coordinate values (e.g. days since 1900)
 * and only falls back to a position when no value matches, so an index that
 * happens to equal a coordinate value would read the wrong slice.
 *
 * @param dimension - The time dimension name, e.g. `"time"`.
 * @param indices - Positions along the axis to read.
 * @returns A selector for `queryData`.
 */
export function zarrIndexSeriesSelector(
  dimension: string,
  indices: readonly number[],
): Record<string, { selected: number[]; type: "index" }> {
  return { [dimension]: { selected: [...indices], type: "index" } };
}

/**
 * The key a Zarr query result holds the variable's values under: the variable
 * itself when present, else the first key that is not query metadata.
 *
 * @param result - The query result.
 * @param variable - The queried variable, when known.
 * @returns The key, or undefined when the result holds no data key.
 */
function resolveZarrVariableKey(
  result: Record<string, unknown>,
  variable: string | undefined,
): string | undefined {
  if (variable && variable in result) return variable;
  return Object.keys(result).find((name) => name !== "dimensions" && name !== "coordinates");
}

/**
 * Pull one value per requested time index out of a Zarr point query.
 *
 * A multi-value selector nests the variable's values by the requested label
 * (here the index): `{ sst: { 0: [12.3], 5: [NaN] } }`. A point usually yields
 * one sample per slice; when it yields several (a point on a cell edge), the
 * first finite one is kept. Fill values arrive as `NaN` and become null, as
 * does any index missing from the result, so the chart shows a gap rather than
 * a fabricated zero.
 *
 * @param result - The query result, or null when the layer was not live.
 * @param variable - The queried variable; when absent or not in the result, the
 *   first non-metadata key is used.
 * @param indices - The indices that were requested.
 * @returns The value per requested index.
 */
export function pointSeriesFromQueryResult(
  result: Record<string, unknown> | null | undefined,
  variable: string | undefined,
  indices: readonly number[],
): Map<number, number | null> {
  const values = new Map<number, number | null>();
  for (const index of indices) values.set(index, null);
  if (!result) return values;
  const key = resolveZarrVariableKey(result, variable);
  const nested = key ? result[key] : undefined;
  if (!nested || typeof nested !== "object") return values;
  // A single requested index comes back flat rather than nested.
  const lookup = (index: number): unknown =>
    Array.isArray(nested)
      ? indices.length === 1
        ? nested
        : undefined
      : (nested as Record<string, unknown>)[String(index)];
  for (const index of indices) {
    const samples = lookup(index);
    if (!Array.isArray(samples)) continue;
    const value = samples.find((sample) => typeof sample === "number" && Number.isFinite(sample));
    if (typeof value === "number") values.set(index, value);
  }
  return values;
}

/**
 * Read the single value a Zarr point query returned for the slice on screen.
 *
 * Tells "outside the grid" (no samples at all) apart from "no data here" (a fill
 * value, which the renderer reports as `NaN`), so Identify can stay silent for a
 * click off the data and still say "no data" for a land cell of an ocean grid.
 *
 * @param result - The query result, or null when the layer was not live.
 * @param variable - The queried variable; falls back to the first data key.
 * @returns The value, null for a fill value, or undefined when the point is
 *   outside the grid (or the layer was not live).
 */
export function zarrPointValue(
  result: Record<string, unknown> | null | undefined,
  variable: string | undefined,
): number | null | undefined {
  if (!result) return undefined;
  const key = resolveZarrVariableKey(result, variable);
  const samples = key ? result[key] : undefined;
  if (!Array.isArray(samples) || samples.length === 0) return undefined;
  const value = samples.find((sample) => typeof sample === "number" && Number.isFinite(sample));
  return typeof value === "number" ? value : null;
}
