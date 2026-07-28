import {
  type GraduatedClassificationScheme,
  type VectorStyleStop,
  createGraduatedClassBreaks,
  interpolateRampColors,
} from "@geolibre/core";

interface ClassifiableLayer {
  geojson?: {
    features?: Array<{
      properties?: Record<string, unknown> | null;
    }>;
  };
}

const CLASSIFICATION_FALLBACK_COLORS = [
  "#2563eb",
  "#16a34a",
  "#f59e0b",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
];

/** Return the non-null values of a GeoJSON property. */
export function getPropertyValues(layer: ClassifiableLayer, property: string): unknown[] {
  if (!property) return [];

  return (layer.geojson?.features ?? [])
    .map((feature) => feature.properties?.[property])
    .filter((value) => value !== null && value !== undefined);
}

/** Find numeric bounds without spreading a potentially large array. */
export function numericBounds(values: number[]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

/** Clamp a requested class count to the supported range. */
export function clampClassCount(value: number, min: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(12, Math.max(min, Math.round(value)));
}

/**
 * Create graduated color stops from GeoJSON or separately loaded property values.
 */
export function createGraduatedStops(
  layer: ClassifiableLayer,
  property: string,
  classCount: number,
  colorRamp: string,
  classificationScheme: string,
  propertyValues?: unknown[],
): VectorStyleStop[] {
  const values = (propertyValues ?? getPropertyValues(layer, property))
    .map((value) => Number(value))
    .filter(Number.isFinite);
  const count = clampClassCount(classCount, 2);
  const colors = interpolateRampColors(colorRamp, count);
  if (values.length === 0) {
    return colors.map((color, index) => ({ value: index, color }));
  }

  const { min, max } = numericBounds(values);
  if (min === max) return [{ value: min, color: colors.at(-1) ?? "#2563eb" }];

  // The breaks are class lower bounds, so `count` classes give `count` stops
  // and the top class is open-ended above (see createGraduatedClassBreaks).
  // normalizeClassificationScheme keeps the scheme to the three known values;
  // anything else classifies as equal interval, as it did before.
  const breaks = createGraduatedClassBreaks(
    values,
    count,
    classificationScheme as GraduatedClassificationScheme,
  );

  // Any scheme can yield fewer breaks than the requested count when the layer
  // has few unique values (duplicate breaks collapse); align the color count so
  // none are dropped.
  const stopColors =
    breaks.length === count ? colors : interpolateRampColors(colorRamp, breaks.length);

  return breaks.map((value, index) => ({
    value: Number(value.toPrecision(8)),
    color: stopColors[index] ?? stopColors.at(-1) ?? "#2563eb",
  }));
}

/**
 * Create categorized color stops from GeoJSON or separately loaded property values.
 */
export function createCategorizedStops(
  layer: ClassifiableLayer,
  property: string,
  classCount: number,
  colorRamp: string,
  classificationScheme: string,
  propertyValues?: unknown[],
): VectorStyleStop[] {
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  for (const value of propertyValues ?? getPropertyValues(layer, property)) {
    const key = String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!firstSeen.has(key)) firstSeen.set(key, firstSeen.size);
  }

  const count = clampClassCount(classCount, 1);
  const categories = Array.from(counts.entries()).sort((a, b) => {
    if (classificationScheme === "alphabetical") {
      return a[0].localeCompare(b[0], undefined, {
        numeric: true,
        sensitivity: "base",
      });
    }
    if (classificationScheme === "first-values") {
      return (firstSeen.get(a[0]) ?? 0) - (firstSeen.get(b[0]) ?? 0);
    }
    return b[1] - a[1] || a[0].localeCompare(b[0]);
  });
  const colors = interpolateRampColors(colorRamp, Math.min(count, categories.length || count));

  return categories.slice(0, count).map(([value], index) => ({
    value,
    color:
      colors[index] ??
      CLASSIFICATION_FALLBACK_COLORS[index % CLASSIFICATION_FALLBACK_COLORS.length]!,
  }));
}
