import {
  type GraduatedClassificationScheme,
  type VectorStyleStop,
  createGraduatedClassBreaks,
  interpolateRampColors,
} from "@geolibre/core";

export interface ClassifiableLayer {
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
export function clampClassCount(value: number, min: number, max = 12): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Return the stable identity of a scalar that can be used as a categorized stop. */
function categorizedValueKey(value: unknown): string | null {
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "number" && Number.isFinite(value)) return `number:${String(value)}`;
  return null;
}

/** Count distinct scalar values that can be used as categorized stops. */
export function countCategorizedValues(values: unknown[]): number {
  return new Set(values.map(categorizedValueKey).filter((key) => key !== null)).size;
}

/** Convert a scalar numeric property value without coercing blanks or non-scalars. */
function finitePropertyNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
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
    .map(finitePropertyNumber)
    .filter((value): value is number => value !== null);
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
    value,
    color: stopColors[index] ?? stopColors.at(-1) ?? "#2563eb",
  }));
}

/**
 * Create categorized color stops from GeoJSON or separately loaded property values.
 *
 * Automatic style suggestions intentionally recognize at most
 * {@link MAX_CATEGORICAL_VALUES} distinct values so suggested legends stay
 * compact. Manual categorized styling can request every distinct value.
 */
export function createCategorizedStops(
  layer: ClassifiableLayer,
  property: string,
  classCount: number,
  colorRamp: string,
  classificationScheme: string,
  propertyValues?: unknown[],
): VectorStyleStop[] {
  const categories = new Map<
    string,
    {
      value: string | number;
      count: number;
      firstSeen: number;
    }
  >();
  for (const value of propertyValues ?? getPropertyValues(layer, property)) {
    const key = categorizedValueKey(value);
    if (key === null) continue;
    const category = categories.get(key);
    if (category) {
      category.count += 1;
    } else {
      categories.set(key, {
        value: value as string | number,
        count: 1,
        firstSeen: categories.size,
      });
    }
  }

  const count = clampClassCount(classCount, 1, Number.POSITIVE_INFINITY);
  const sortedCategories = Array.from(categories.values()).sort((a, b) => {
    if (classificationScheme === "alphabetical") {
      return String(a.value).localeCompare(String(b.value), undefined, {
        numeric: true,
        sensitivity: "base",
      });
    }
    if (classificationScheme === "first-values") {
      return a.firstSeen - b.firstSeen;
    }
    return b.count - a.count || String(a.value).localeCompare(String(b.value));
  });
  const colors = interpolateRampColors(
    colorRamp,
    Math.min(count, sortedCategories.length || count),
  );

  return sortedCategories.slice(0, count).map((category, index) => ({
    value: category.value,
    color:
      colors[index] ??
      CLASSIFICATION_FALLBACK_COLORS[index % CLASSIFICATION_FALLBACK_COLORS.length]!,
  }));
}

/**
 * Numeric min/max for a property, used to seed proportional-symbol value
 * bounds when the user picks a size field. Returns `null` when the column has
 * no finite numbers or every value is the same (a zero-width range cannot
 * drive an interpolate).
 */
export function proportionalSizeBounds(
  layer: ClassifiableLayer,
  property: string,
  propertyValues?: unknown[],
): { min: number; max: number } | null {
  if (!property) return null;
  const values = (propertyValues ?? getPropertyValues(layer, property))
    .map(finitePropertyNumber)
    .filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  const { min, max } = numericBounds(values);
  if (!(Number.isFinite(min) && Number.isFinite(max)) || min === max) return null;
  return { min, max };
}

/**
 * True when a property has at least two *distinct* finite numeric values, so a
 * graduated classification has a range to break up.
 *
 * Distinct, not merely two values: a constant column yields a single class, and
 * the Style panel then refuses to apply the renderer it was offered.
 */
export function isNumericProperty(layer: ClassifiableLayer, property: string): boolean {
  const values = getPropertyValues(layer, property);
  const numericValues = values.map((value) => Number(value)).filter(Number.isFinite);
  return new Set(numericValues).size > 1;
}

/**
 * Pick the numeric property that best suits a graduated renderer: the one with
 * the most distinct values spread over the widest range, so the classes carry
 * real information rather than splitting a near-constant column.
 *
 * @returns The property name, or `""` when no column qualifies.
 */
export function chooseGraduatedProperty(layer: ClassifiableLayer, properties: string[]): string {
  let bestProperty = "";
  let bestScore = -1;

  for (const property of properties) {
    const values = getPropertyValues(layer, property)
      .map((value) => Number(value))
      .filter(Number.isFinite);
    // Distinct values, not just value count: a constant column cannot be split
    // into the two stops a graduated renderer needs.
    const distinct = new Set(values).size;
    if (distinct < 2) continue;

    const { min, max } = numericBounds(values);
    const range = max - min;
    const score = distinct * Math.log10(Math.max(1, range) + 1);
    if (score > bestScore) {
      bestProperty = property;
      bestScore = score;
    }
  }

  return bestProperty;
}

/** Upper bound on distinct values before a column is too fine to categorize. */
export const MAX_CATEGORICAL_VALUES = 12;

/**
 * True when a property has between 2 and {@link MAX_CATEGORICAL_VALUES}
 * distinct values — enough to distinguish, few enough to read as a legend.
 */
export function isCategoricalProperty(layer: ClassifiableLayer, property: string): boolean {
  const values = getPropertyValues(layer, property).map((value) => String(value));
  const uniqueCount = new Set(values).size;
  return uniqueCount > 1 && uniqueCount <= MAX_CATEGORICAL_VALUES;
}
