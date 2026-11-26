// Selection vector tools: select by value, select by location and random extract.

import { featureCollection } from "@turf/helpers";
import type { Feature } from "geojson";
import type { ProcessingAlgorithm } from "./types";
import {
  MAX_CLIENT_PAIRS,
  getLayer,
  requireFeatures,
  numberParam,
  type SpatialPredicate,
  rawPredicate,
  stableStringify,
  parseFiniteNumber,
} from "./vector-tools-common";

/** Comparison operators for the Select by value tool; kept in sync with the backend. */
export const SELECT_VALUE_OPERATORS = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "starts-with",
  "is-null",
  "is-not-null",
]);

/** Render a GeoJSON property value as a string, matching the backend's `_value_to_string`. */
export function valueToString(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  // Arrays/objects: canonical JSON (sorted keys), matching json.dumps on the
  // Python side, so eq/contains agree across engines for non-scalar values.
  if (value !== null && typeof value === "object") return stableStringify(value);
  return String(value);
}

/**
 * Evaluate one feature's attribute value against an operator and the user's
 * input string. Comparisons are numeric only when both sides are finite
 * numbers, otherwise string-based. Empty values (null/undefined/NaN/empty
 * string) match only the is-empty/is-not-empty operators (SQL-like). Mirrors
 * `_match_value` in the Python backend so all three engines agree.
 */
export function matchesValue(value: unknown, operator: string, raw: string): boolean {
  const isEmpty =
    value === null ||
    value === undefined ||
    (typeof value === "number" && Number.isNaN(value)) ||
    valueToString(value) === "";
  if (operator === "is-null") return isEmpty;
  if (operator === "is-not-null") return !isEmpty;
  if (isEmpty) return false;

  const sv = valueToString(value);
  if (operator === "contains") return sv.toLowerCase().includes(raw.toLowerCase());
  if (operator === "starts-with") return sv.toLowerCase().startsWith(raw.toLowerCase());

  // Numeric comparison only when the value and the input both parse as numbers.
  // Use parseFiniteNumber (not Number()) so we accept exactly what Python's
  // float() does — decimal/scientific only, no hex/octal/binary — keeping the
  // client and Python engines in agreement.
  const vNum = typeof value === "number" ? value : parseFiniteNumber(sv);
  const rNum = parseFiniteNumber(raw);
  const numeric = typeof value !== "boolean" && Number.isFinite(vNum) && Number.isFinite(rNum);
  const a: number | string = numeric ? vNum : sv;
  const b: number | string = numeric ? rNum : raw;
  switch (operator) {
    case "eq":
      return a === b;
    case "neq":
      return a !== b;
    case "gt":
      return a > b;
    case "gte":
      return a >= b;
    case "lt":
      return a < b;
    case "lte":
      return a <= b;
    default:
      return false;
  }
}

export const selectByValueTool: ProcessingAlgorithm = {
  id: "select-by-value",
  name: "Select by value",
  description: "Extract features whose attribute value matches a condition into a new layer",
  group: "Select",
  supportsSidecar: true,
  parameters: [
    { id: "layer", label: "Input layer", type: "layer", required: true },
    {
      id: "field",
      label: "Field",
      type: "field",
      fieldSource: "layer",
      required: true,
    },
    {
      id: "operator",
      label: "Operator",
      type: "select",
      default: "eq",
      options: [
        { value: "eq", label: "= (equals)" },
        { value: "neq", label: "≠ (not equals)" },
        { value: "gt", label: "> (greater than)" },
        { value: "gte", label: "≥ (greater than or equal)" },
        { value: "lt", label: "< (less than)" },
        { value: "lte", label: "≤ (less than or equal)" },
        { value: "contains", label: "contains (text)" },
        { value: "starts-with", label: "starts with (text)" },
        { value: "is-null", label: "is empty" },
        { value: "is-not-null", label: "is not empty" },
      ],
    },
    {
      id: "value",
      label: "Value",
      type: "string",
      required: true,
      description: "Compared as a number when both sides are numeric.",
      // Hidden (and so skipped by required validation) for the operators that
      // ignore a value; required and form-validated for all the others.
      visibleWhen: { param: "operator", notIn: ["is-null", "is-not-null"] },
    },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx, "layer");
    if (!fc) return;
    const field = (ctx.parameters.field as string)?.trim();
    if (!field) {
      ctx.log("Error: a field is required");
      return;
    }
    const operator = (ctx.parameters.operator as string) || "eq";
    if (!SELECT_VALUE_OPERATORS.has(operator)) {
      ctx.log(`Error: unknown operator '${operator}'`);
      return;
    }
    const raw = (ctx.parameters.value as string) ?? "";
    const needsValue = operator !== "is-null" && operator !== "is-not-null";
    if (needsValue && raw === "") {
      ctx.log("Error: a value is required for this operator");
      return;
    }
    // A field absent from every feature is treated as all-empty (schemaless
    // GeoJSON), so is-empty matches everything and the rest match nothing —
    // rather than erroring. matchesValue handles the missing value per feature.
    const selected = fc.features.filter((f) => matchesValue(f.properties?.[field], operator, raw));
    ctx.log(`Select by value: ${selected.length} of ${fc.features.length} feature(s) matched`);
    ctx.addResultLayer?.("Select by value", featureCollection(selected));
  },
};

/** Select by location adds "disjoint" (the complement of intersects). */
export type SelectLocationPredicate = SpatialPredicate | "disjoint";

/** Spatial predicates for Select by location; kept in sync with the backend. */
export const SELECT_LOCATION_PREDICATES = new Set<SelectLocationPredicate>([
  "intersects",
  "within",
  "contains",
  "disjoint",
]);

/** Result of {@link matchFeaturesByLocation}. */
export interface LocationMatches {
  /** One entry per input feature (aligned by index): did it match? */
  matches: boolean[];
  /**
   * Features excluded from a `disjoint` result only because a pair could not
   * be evaluated (e.g. a GeometryCollection Turf cannot test). Always 0 for
   * positive predicates.
   */
  unevaluableDropped: number;
}

/**
 * Tests every input feature against the filter features under a spatial
 * predicate, mirroring the sidecar's semantics: "disjoint" matches features
 * that intersect nothing, the others match features relating to any filter
 * feature. Features without geometry never match; filter features without
 * geometry are ignored. Shared by the Select by location processing tool and
 * the interactive Select by Location dialog (#1314).
 *
 * The pairwise test runs on the calling thread — callers should cap
 * `inputFeatures.length * filterFeatures.length` at {@link MAX_CLIENT_PAIRS}.
 */
export function matchFeaturesByLocation(
  inputFeatures: readonly Feature[],
  filterFeatures: readonly Feature[],
  predicate: SelectLocationPredicate,
): LocationMatches {
  const evaluableFilters = filterFeatures.filter((f) => f.geometry);
  // In the false branch TS narrows `predicate` to SpatialPredicate, so this is
  // checked — no cast — and would error if the "disjoint" guard were removed.
  const test: SpatialPredicate = predicate === "disjoint" ? "intersects" : predicate;
  let unevaluableDropped = 0;
  const matches = inputFeatures.map((f) => {
    if (!f.geometry) return false;
    let matchesAny = false;
    let unevaluable = false;
    for (const g of evaluableFilters) {
      try {
        if (rawPredicate(f, g, test)) {
          matchesAny = true;
          break;
        }
      } catch {
        // Turf can't evaluate this pair (e.g. a GeometryCollection).
        unevaluable = true;
      }
    }
    // For positive predicates an unevaluable pair is just a non-match. For the
    // complement (disjoint) we must NOT claim "no intersection" when a pair
    // couldn't be checked, so require every pair to have been evaluable.
    if (predicate === "disjoint") {
      if (!matchesAny && unevaluable) unevaluableDropped += 1;
      return !matchesAny && !unevaluable;
    }
    return matchesAny;
  });
  return { matches, unevaluableDropped };
}

export const selectByLocationTool: ProcessingAlgorithm = {
  id: "select-by-location",
  name: "Select by location",
  description: "Extract features by their spatial relationship to a second layer into a new layer",
  group: "Select",
  supportsSidecar: true,
  parameters: [
    { id: "layer", label: "Input layer", type: "layer", required: true },
    { id: "overlay", label: "Filter layer", type: "layer", required: true },
    {
      id: "predicate",
      label: "Spatial relationship",
      type: "select",
      default: "intersects",
      options: [
        { value: "intersects", label: "Intersects" },
        { value: "within", label: "Within" },
        { value: "contains", label: "Contains" },
        { value: "disjoint", label: "Disjoint (no intersection)" },
      ],
    },
  ],
  run: (ctx) => {
    const input = requireFeatures(ctx, "layer");
    if (!input) return;
    const filterLayer = getLayer(ctx, "overlay");
    if (!filterLayer) {
      ctx.log('Error: parameter "overlay" has no layer selected');
      return;
    }
    // A non-vector layer (raster/tile) has no `geojson`; that's distinct from an
    // empty-but-valid filter layer, so reject it rather than silently treating
    // it as an empty filter (which would select everything for disjoint).
    if (!filterLayer.geojson) {
      ctx.log("Error: the filter layer has no vector data");
      return;
    }
    const predicateInput = (ctx.parameters.predicate as string) || "intersects";
    if (!SELECT_LOCATION_PREDICATES.has(predicateInput as SelectLocationPredicate)) {
      ctx.log(`Error: unknown predicate '${predicateInput}'`);
      return;
    }
    const predicate = predicateInput as SelectLocationPredicate;
    const inputFeatures = input.features.filter((f) => f.geometry);
    const filterFeatures = filterLayer.geojson.features.filter((f) => f.geometry);
    if (!inputFeatures.length) {
      ctx.log("Error: input layer has no features with geometry");
      return;
    }
    // This pairwise test runs on the main thread; cap it so very large layers
    // cannot freeze the browser tab. Use the Sidecar engine for bigger jobs.
    const pairs = inputFeatures.length * filterFeatures.length;
    if (pairs > MAX_CLIENT_PAIRS) {
      ctx.log(
        `Error: select by location needs ${pairs} comparisons (limit ${MAX_CLIENT_PAIRS}); use the Sidecar engine for large layers`,
      );
      return;
    }
    // "disjoint" selects features that intersect nothing; the others select
    // features matching the predicate against any filter feature. With an empty
    // filter layer nothing matches, so disjoint keeps everything and the rest
    // keep nothing — matching the backend.
    const { matches, unevaluableDropped } = matchFeaturesByLocation(
      inputFeatures,
      filterFeatures,
      predicate,
    );
    const selected = inputFeatures.filter((_, index) => matches[index]);
    // Report the total the user sees in the layer list; note any geometry-less
    // features that were skipped (the sidecar drops them too).
    const skipped = input.features.length - inputFeatures.length;
    ctx.log(
      `Select by location: ${selected.length} of ${input.features.length} feature(s) matched` +
        (skipped > 0 ? ` (${skipped} skipped, no geometry)` : ""),
    );
    if (unevaluableDropped > 0) {
      ctx.log(
        `Note: ${unevaluableDropped} feature(s) excluded from disjoint because Turf could not evaluate their geometry; use the Sidecar engine for full support`,
      );
    }
    ctx.addResultLayer?.("Select by location", featureCollection(selected));
  },
};

export const randomExtractTool: ProcessingAlgorithm = {
  id: "random-extract",
  name: "Random extract",
  description:
    "Extract a random subset of features into a new layer, sized by a feature count or a percentage of the input.",
  group: "Select",
  parameters: [
    { id: "layer", label: "Input layer", type: "layer", required: true },
    {
      id: "method",
      label: "Method",
      type: "select",
      default: "count",
      options: [
        { value: "count", label: "Number of features" },
        { value: "percentage", label: "Percentage of features" },
      ],
    },
    {
      id: "count",
      label: "Number of features",
      type: "number",
      default: 10,
      min: 0,
      step: 1,
      description: "Clamped to the number of input features when larger.",
      visibleWhen: { param: "method", in: ["count"] },
    },
    {
      id: "percentage",
      label: "Percentage of features",
      type: "number",
      default: 10,
      min: 0,
      max: 100,
      step: 1,
      visibleWhen: { param: "method", in: ["percentage"] },
    },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx, "layer");
    if (!fc) return;
    const total = fc.features.length;
    const method = (ctx.parameters.method as string) || "count";

    // Resolve the requested sample size, then clamp to [0, total] so an
    // oversized count or a >100 percentage yields every feature rather than
    // erroring, and a negative value yields none.
    let requested: number;
    if (method === "percentage") {
      const pct = numberParam(ctx, "percentage", 10);
      requested = Math.round((pct / 100) * total);
    } else {
      requested = Math.round(numberParam(ctx, "count", 10));
    }
    const sampleSize = Math.max(0, Math.min(total, requested));

    // Partial Fisher-Yates: draw `sampleSize` distinct indices uniformly
    // without replacement, without shuffling the whole array.
    const indices = Array.from({ length: total }, (_, i) => i);
    for (let i = 0; i < sampleSize; i += 1) {
      const j = i + Math.floor(Math.random() * (total - i));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    // Sort the chosen indices so the output keeps the input's feature order.
    const chosen = indices.slice(0, sampleSize).sort((a, b) => a - b);
    const selected = chosen.map((i) => fc.features[i]);

    ctx.log(`Random extract: selected ${selected.length} of ${total} feature(s)`);
    ctx.addResultLayer?.("Random extract", featureCollection(selected));
  },
};
