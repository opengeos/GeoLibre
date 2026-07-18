import {
  createEqualIntervalBreaks,
  createQuantileBreaks,
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
  const breaks =
    scheme === "quantile"
      ? createQuantileBreaks(values, classCount)
      : createEqualIntervalBreaks(Math.min(...values), Math.max(...values), classCount);
  const colors = interpolateRampColors(colorRamp, breaks.length);
  return breaks.map((value, index) => ({
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
 * @throws If the property is missing, or graduated mode has too few numeric values.
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
    if (numbers.length < 2) {
      throw new Error(
        `Property "${request.property}" is not numeric; use categorized mode instead.`,
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
