import type { GeoLibreLayer, LayerQuickFilter } from "./types";

/**
 * Quick filters (issue #2114): per-layer, data-driven filter controls that
 * compile down to the MapLibre filter a layer already supports.
 *
 * The persisted record is the *control state* (field, kind, chosen values),
 * never the compiled expression. Storing the compiled output would make a
 * filter unreadable and un-editable the moment it is saved, which is exactly
 * the wall this feature exists to remove: a rule filter, Select by Expression,
 * and the attribute table's filter box all already accept a hand-written
 * MapLibre expression.
 *
 * Compilation happens at sync time in `@geolibre/map`'s layer sync, which
 * combines the result with the transient `timeFilter`, the embed API's
 * `embedFilter`, and the rule-based visibility filter under one `["all", …]`,
 * so a host page's filter and a user's filter narrow the layer together
 * instead of clobbering each other.
 *
 * Every clause reads the property in place, so the same expression is correct
 * for a GeoJSON source and for a tile-backed source whose tiles decode later.
 */

/** Day length in milliseconds, used to make a date filter's end day inclusive. */
const DAY_MS = 86_400_000;

/** The `YYYY-MM-DD` prefix length every ISO date comparison slices to. */
const ISO_DAY_LENGTH = 10;

/** Whether a filter is switched on (the field defaults to enabled). */
function isEnabled(filter: LayerQuickFilter): boolean {
  return filter.enabled !== false;
}

/** A validated date bound: its canonical `YYYY-MM-DD` text and UTC midnight. */
interface IsoDayBound {
  day: string;
  ms: number;
}

/**
 * Validate a `YYYY-MM-DD` bound, returning its canonical text and UTC midnight,
 * or `null` when the text is blank, malformed, or not a real calendar day.
 *
 * The round-trip check is what rejects a day that does not exist: `Date.parse`
 * happily reads `2026-02-30` as March 2, so shape-checking alone would compile
 * a bound the user never chose. Rejecting here means a half-typed or impossible
 * bound compiles to no clause at all, leaving that side unconstrained rather
 * than filtering on a date nobody asked for.
 */
function parseIsoDayBound(day: string | null | undefined): IsoDayBound | null {
  if (typeof day !== "string") return null;
  const trimmed = day.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const ms = Date.parse(`${trimmed}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, ISO_DAY_LENGTH) === trimmed
    ? { day: trimmed, ms }
    : null;
}

/** A finite number, or `null` for every other input (including `NaN`). */
function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * `["get", field]` coerced for comparison, guarded by `["has", field]` where a
 * missing property would otherwise coerce into range (`to-number` turns a
 * missing property into `0`, and `to-string` into `""`, either of which can sit
 * inside a one-sided bound).
 */
function presenceGuard(field: string): unknown[] {
  return ["has", field];
}

function compileCategorical(filter: LayerQuickFilter): unknown[] | null {
  const values = filter.values ?? [];
  if (values.length === 0) return null;
  // `in` keeps the values at their original type, so a numeric code and its
  // string spelling never collapse into one another the way `match` labels do.
  return ["in", ["get", filter.field], ["literal", values]];
}

function compileRange(filter: LayerQuickFilter): unknown[] | null {
  const first = finite(filter.min);
  const second = finite(filter.max);
  if (first === null && second === null) return null;
  // Order the bounds rather than trusting which box they were typed into. The
  // slider's thumbs cannot cross, but the two number inputs commit
  // independently, so a bound is briefly inverted on the way to any value whose
  // first digit is smaller (typing `200000` into a max already showing `800000`
  // passes through `2`). Compiling that literally yields an unsatisfiable
  // filter, which empties the layer with nothing on screen to explain why.
  const min = first !== null && second !== null ? Math.min(first, second) : first;
  const max = first !== null && second !== null ? Math.max(first, second) : second;
  const value = ["to-number", ["get", filter.field]];
  const clauses: unknown[] = [presenceGuard(filter.field)];
  if (min !== null) clauses.push([">=", value, min]);
  if (max !== null) clauses.push(["<=", value, max]);
  return ["all", ...clauses];
}

function compileDate(filter: LayerQuickFilter): unknown[] | null {
  // Both branches read the *validated* bounds, never the raw strings: with one
  // bound valid and the other malformed the filter still compiles, and pushing
  // the raw text would compare against a value no real date can satisfy — which
  // hides every feature instead of leaving that side open.
  const first = parseIsoDayBound(filter.start);
  const second = parseIsoDayBound(filter.end);
  if (first === null && second === null) return null;
  // Ordered for the same reason as `compileRange`: a date typed into the wrong
  // box (or a from/to pair edited out of order) should read as the interval
  // between them, not as an empty layer.
  const inverted = first !== null && second !== null && first.ms > second.ms;
  const start = inverted ? second : first;
  const end = inverted ? first : second;
  const clauses: unknown[] = [presenceGuard(filter.field)];

  if ((filter.dateKind ?? "iso") === "iso") {
    // Compare the leading `YYYY-MM-DD` slice on both sides: ISO text sorts
    // chronologically, and slicing makes a datetime comparable to a plain day
    // bound without parsing. Both bounds are inclusive because the slice drops
    // the time of day.
    const value = ["slice", ["to-string", ["get", filter.field]], 0, ISO_DAY_LENGTH];
    if (start !== null) clauses.push([">=", value, start.day]);
    if (end !== null) clauses.push(["<=", value, end.day]);
    return ["all", ...clauses];
  }

  // Epoch numbers: the end bound is exclusive at the *next* day's midnight, so
  // the chosen end day is kept in full rather than only its midnight instant.
  const scale = filter.dateKind === "epochS" ? 0.001 : 1;
  const value = ["to-number", ["get", filter.field]];
  if (start !== null) clauses.push([">=", value, start.ms * scale]);
  if (end !== null) clauses.push(["<", value, (end.ms + DAY_MS) * scale]);
  return ["all", ...clauses];
}

function compileText(filter: LayerQuickFilter): unknown[] | null {
  const needle = filter.text?.trim().toLowerCase() ?? "";
  if (needle === "") return null;
  // Case-insensitive on both sides: a viewer typing "portland" should not have
  // to guess how the data capitalizes it.
  const haystack = ["downcase", ["to-string", ["get", filter.field]]];
  switch (filter.operator ?? "contains") {
    case "equals":
      return ["==", haystack, needle];
    case "startsWith":
      return ["==", ["index-of", needle, haystack], 0];
    default:
      return ["!=", ["index-of", needle, haystack], -1];
  }
}

/**
 * Compile one quick filter to a MapLibre filter expression, or `null` when it
 * places no constraint (switched off, no field, or nothing chosen yet). A
 * control that has been added but not yet answered must never hide features.
 *
 * @param filter - The persisted control state.
 * @returns A MapLibre filter expression, or `null`.
 */
export function compileQuickFilter(filter: LayerQuickFilter): unknown[] | null {
  if (!isEnabled(filter) || typeof filter.field !== "string" || filter.field === "") return null;
  switch (filter.kind) {
    case "categorical":
      return compileCategorical(filter);
    case "range":
      return compileRange(filter);
    case "date":
      return compileDate(filter);
    case "text":
      return compileText(filter);
    default:
      return null;
  }
}

/**
 * Compile a layer's quick filters into a single MapLibre filter expression.
 * Multiple controls narrow the data together (`["all", …]`), matching how a
 * viewer reads a stack of filters. Returns `null` when no control constrains
 * anything, so the common path adds no filter at all.
 *
 * @param filters - The layer's persisted quick filters.
 * @returns A MapLibre filter expression, or `null`.
 */
export function compileQuickFilters(
  filters: readonly LayerQuickFilter[] | undefined,
): unknown[] | null {
  if (!filters || filters.length === 0) return null;
  const clauses: unknown[] = [];
  for (const filter of filters) {
    const compiled = compileQuickFilter(filter);
    if (compiled) clauses.push(compiled);
  }
  if (clauses.length === 0) return null;
  return clauses.length === 1 ? (clauses[0] as unknown[]) : ["all", ...clauses];
}

/**
 * The quick filters that actually constrain the layer right now. Drives the
 * "filtered" badge on the layer row and its count, so an active filter is
 * never mistaken for missing data.
 *
 * @param layer - The layer to inspect.
 * @returns The constraining filters, in their configured order.
 */
export function activeQuickFilters(layer: GeoLibreLayer): LayerQuickFilter[] {
  return (layer.quickFilters ?? []).filter((filter) => compileQuickFilter(filter) !== null);
}

/**
 * Whether the layer is currently narrowed by at least one quick filter.
 *
 * @param layer - The layer to inspect.
 * @returns `true` when a quick filter constrains the rendered features.
 */
export function hasActiveQuickFilter(layer: GeoLibreLayer): boolean {
  return (layer.quickFilters ?? []).some((filter) => compileQuickFilter(filter) !== null);
}

/**
 * Clear every chosen value while keeping the controls themselves, so "Clear
 * filters" is one action that leaves the layer's configured controls in place
 * for the next question.
 *
 * @param filters - The layer's persisted quick filters.
 * @returns The same controls with their selections emptied.
 */
export function clearQuickFilterValues(
  filters: readonly LayerQuickFilter[] | undefined,
): LayerQuickFilter[] {
  return (filters ?? []).map((filter) => ({
    ...filter,
    values: filter.kind === "categorical" ? [] : filter.values,
    min: filter.kind === "range" ? null : filter.min,
    max: filter.kind === "range" ? null : filter.max,
    start: filter.kind === "date" ? null : filter.start,
    end: filter.kind === "date" ? null : filter.end,
    text: filter.kind === "text" ? "" : filter.text,
  }));
}
