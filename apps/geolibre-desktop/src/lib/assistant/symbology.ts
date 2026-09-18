import {
  createGraduatedClassBreaks,
  interpolateRampColors,
  type GeoLibreLayer,
  type LayerStyle,
  type VectorStyleStop,
} from "@geolibre/core";

/** Styling mode the assistant can apply to a vector layer. */
export type AssistantSymbologyMode = "graduated" | "categorized";

/** Options describing the symbology the assistant wants to apply. */
export interface SymbologyRequest {
  mode: AssistantSymbologyMode;
  /** Feature property to drive the styling. */
  property: string;
  /** Color ramp id (e.g. "reds", "viridis"); defaults to "viridis". */
  colorRamp?: string;
  /** Number of classes for graduated mode (default 5). */
  classCount?: number;
  /** Classification scheme for graduated mode. */
  scheme?: "equal-interval" | "quantile";
  /**
   * Explicit class lower bounds for graduated mode. When present these are used
   * verbatim in place of `classCount`/`scheme`, so a caller can reproduce
   * unevenly spaced thresholds fixed by an external standard (an air-quality
   * band table, an agency's severity levels) that no statistical scheme
   * reproduces.
   */
  breaks?: number[];
}

/** Read every value a property takes across a layer's features. */
function propertyValues(layer: GeoLibreLayer, property: string): unknown[] {
  const features = layer.geojson?.features ?? [];
  const values: unknown[] = [];
  for (const feature of features) {
    const value = feature.properties?.[property];
    if (value !== undefined && value !== null) values.push(value);
  }
  return values;
}

/** Build graduated color stops from numeric breaks and a ramp. */
function graduatedStops(
  values: number[],
  classCount: number,
  scheme: "equal-interval" | "quantile",
  colorRamp: string,
): VectorStyleStop[] {
  // Class lower bounds, matching the Style panel: the top class is open-ended
  // above rather than ending at the maximum (see createGraduatedClassBreaks).
  // Duplicate breaks collapse, so size the ramp off the breaks, not the count.
  const breaks = createGraduatedClassBreaks(values, classCount, scheme);
  const colors = interpolateRampColors(colorRamp, breaks.length);
  return breaks.map((value, index) => ({
    value,
    color: colors[index],
  }));
}

/**
 * Build graduated color stops from caller-supplied break values and a ramp.
 *
 * The breaks are class lower bounds, the same contract `graduatedStops` follows,
 * so they are sorted ascending and de-duplicated before use: MapLibre rejects a
 * `step` expression whose inputs are not strictly ascending, and a caller
 * listing an official band table is under no obligation to have sorted it.
 */
function customGraduatedStops(breaks: number[], colorRamp: string): VectorStyleStop[] {
  const sorted = breaks.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const unique: number[] = [];
  for (const value of sorted) {
    if (unique.length > 0 && value === unique[unique.length - 1]) continue;
    unique.push(value);
  }
  const colors = interpolateRampColors(colorRamp, unique.length);
  return unique.map((value, index) => ({
    value,
    color: colors[index],
  }));
}

/** Build categorized color stops, one per distinct value (capped). */
function categorizedStops(values: unknown[], colorRamp: string): VectorStyleStop[] {
  // Cap categories so a high-cardinality field can't produce a giant legend.
  const MAX_CATEGORIES = 24;
  const distinct: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(key);
    if (distinct.length >= MAX_CATEGORIES) break;
  }
  const colors = interpolateRampColors(colorRamp, distinct.length);
  return distinct.map((value, index) => ({
    value,
    color: colors[index],
    label: value,
  }));
}

/**
 * Build a {@link LayerStyle} patch implementing the requested data-driven
 * symbology, mapping onto the store's existing `graduated`/`categorized` modes
 * and color-ramp helpers. Pure and side-effect-free so it is unit-testable; the
 * tool layer applies the result via `setLayerStyle`.
 *
 * @param layer The layer to read property values from.
 * @param request The symbology to apply.
 * @returns A partial style ready for `setLayerStyle`.
 * @throws If the property is missing, graduated mode has too few numeric values,
 *   or `breaks` was supplied with fewer than two distinct finite values in it.
 */
export function buildSymbologyStyle(
  layer: GeoLibreLayer,
  request: SymbologyRequest,
): Partial<LayerStyle> {
  const colorRamp = request.colorRamp?.trim() || "viridis";
  const values = propertyValues(layer, request.property);
  if (values.length === 0) {
    throw new Error(`Property "${request.property}" has no values on layer "${layer.name}".`);
  }

  if (request.mode === "graduated") {
    const numbers = values
      .map((value) => (typeof value === "number" ? value : Number.parseFloat(String(value))))
      .filter((value) => Number.isFinite(value));
    if (numbers.length === 0) {
      throw new Error(
        `Property "${request.property}" is not numeric; use categorized mode instead.`,
      );
    }
    if (request.breaks !== undefined) {
      // Explicit breaks describe the classes outright, so neither the class
      // count nor the scheme applies, and the "needs two values to classify"
      // floor below does not either: the thresholds come from the caller, not
      // from the sample. `vectorStyleClassificationScheme` is left out of the
      // patch because no scheme produced these stops; note that `setLayerStyle`
      // merges shallowly, so the layer keeps whatever scheme it already had.
      // That leftover value only matters if the user then edits the ramp or
      // class count in the Style panel, which regenerates stops from scratch —
      // the same thing that already happens to hand-edited stops there.
      const stops = customGraduatedStops(request.breaks, colorRamp);
      // Two is the render-side floor, not a stylistic one: vectorColorExpression
      // falls back to a flat color below two graduated stops, so a single break
      // would report success and paint nothing. The statistical path holds the
      // same floor through `Math.max(2, ...)` on the class count.
      if (stops.length < 2) {
        throw new Error("`breaks` must contain at least two distinct finite numbers.");
      }
      // No ceiling to match the statistical path's 12, though: that cap exists so
      // a derived classification never asks for more breaks than the sample
      // supports, which says nothing about a published band table. The map paints
      // every break; only the Style panel's Classes control clamps its reading to
      // 12 (clampClassCount), so past that the stop list and the count it shows
      // disagree. Truncating a standard's thresholds to fit that widget would
      // defeat the point of accepting them, so the breaks win.
      return {
        vectorStyleMode: "graduated",
        vectorStyleProperty: request.property,
        vectorStyleColorRamp: colorRamp,
        vectorStyleClassCount: stops.length,
        vectorStyleStops: stops,
      };
    }
    if (numbers.length < 2) {
      // One numeric value is not a broken property, it is too little data to
      // break into classes; saying "not numeric" there sends the reader after
      // the wrong cause.
      throw new Error(
        `Property "${request.property}" has only one numeric value on layer "${layer.name}"; graduated mode needs at least two.`,
      );
    }
    // Cap classes by the number of values too, so we never ask for more breaks
    // than the data supports (which would yield duplicate/empty color stops).
    const classCount = Math.max(2, Math.min(request.classCount ?? 5, 12, numbers.length));
    const scheme = request.scheme ?? "equal-interval";
    return {
      vectorStyleMode: "graduated",
      vectorStyleProperty: request.property,
      vectorStyleColorRamp: colorRamp,
      vectorStyleClassCount: classCount,
      vectorStyleClassificationScheme: scheme,
      vectorStyleStops: graduatedStops(numbers, classCount, scheme, colorRamp),
    };
  }

  return {
    vectorStyleMode: "categorized",
    vectorStyleProperty: request.property,
    vectorStyleColorRamp: colorRamp,
    vectorStyleStops: categorizedStops(values, colorRamp),
  };
}
