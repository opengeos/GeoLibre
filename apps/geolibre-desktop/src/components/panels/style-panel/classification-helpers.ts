import {
  DEFAULT_LAYER_STYLE,
  removeTrailingJsonCommas,
  styleValue,
  type GeoLibreLayer,
  type VectorStyleMode,
  type VectorStyleStop,
} from "@geolibre/core";
import type { ParseKeys, TFunction } from "i18next";
import {
  chooseGraduatedProperty,
  clampClassCount,
  createCategorizedStops,
  createGraduatedStops,
  countCategorizedValues,
  getPropertyValues,
  isCategoricalProperty,
  isNumericProperty,
  MAX_MANUAL_CATEGORIZED_VALUES,
} from "../../../lib/vector-style-classification";

const VECTOR_STYLE_COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2"];

export const VECTOR_STYLE_CLASS_COUNTS = Array.from({ length: 12 }, (_, index) => index + 1);

export const GRADUATED_CLASSIFICATION_SCHEMES: ReadonlyArray<{
  value: string;
  labelKey: ParseKeys;
}> = [
  { value: "equal-interval", labelKey: "style.symbology.schemeEqualInterval" },
  { value: "quantile", labelKey: "style.symbology.schemeQuantile" },
  { value: "natural-breaks", labelKey: "style.symbology.schemeNaturalBreaks" },
];

export const CATEGORIZED_CLASSIFICATION_SCHEMES: ReadonlyArray<{
  value: string;
  labelKey: ParseKeys;
}> = [
  { value: "top-values", labelKey: "style.symbology.schemeTopValues" },
  { value: "alphabetical", labelKey: "style.symbology.schemeAlphabetical" },
  { value: "first-values", labelKey: "style.symbology.schemeFirstValues" },
];

export function createDefaultStops(
  layer: Parameters<typeof getPropertyValues>[0],
  mode: VectorStyleMode,
  property: string,
  classCount: number,
  colorRamp: string,
  classificationScheme: string,
  propertyValues?: unknown[],
): VectorStyleStop[] {
  if (mode === "graduated") {
    return createGraduatedStops(
      layer,
      property,
      classCount,
      colorRamp,
      classificationScheme,
      propertyValues,
    );
  }
  if (mode === "categorized") {
    return createCategorizedStops(
      layer,
      property,
      classCount,
      colorRamp,
      classificationScheme,
      propertyValues,
    );
  }
  return styleValue(DEFAULT_LAYER_STYLE, "vectorStyleStops");
}

/**
 * Count the distinct values a property offers as categorized stops, or 0 when
 * that count is not known to be complete.
 *
 * A tiled source only exposes the features MapLibre has currently rendered, so
 * its distinct values are a viewport sample that changes as the map pans. Add
 * Vector Layer datasets are the exception: they render as tiles but their
 * values come back complete from DuckDB, which is why the property-value
 * loading effect keys on `metadata.sourceKind === "maplibre-gl-vector"` rather
 * than on `layer.type`. Counts past the manual ceiling also report 0, so the
 * panel never offers to render more category rows than it can.
 */
export function completeCategorizedValueCount(
  layer: GeoLibreLayer | undefined,
  property: string,
  loadedValues: unknown[] | undefined,
): number {
  if (!layer || !property) return 0;
  const valuesAreSampled =
    !layer.geojson &&
    layer.metadata.sourceKind !== "maplibre-gl-vector" &&
    (layer.type === "vector-tiles" || layer.type === "pmtiles" || layer.type === "mbtiles");
  if (valuesAreSampled) return 0;
  const count = countCategorizedValues(loadedValues ?? getPropertyValues(layer, property));
  return count <= MAX_MANUAL_CATEGORIZED_VALUES ? count : 0;
}

export function normalizeVectorStyleClassCount(mode: VectorStyleMode, value: number): number {
  return clampClassCount(
    value,
    mode === "categorized" ? 1 : 2,
    mode === "categorized" ? MAX_MANUAL_CATEGORIZED_VALUES : 12,
  );
}

export function defaultClassificationScheme(mode: VectorStyleMode): string {
  return mode === "categorized" ? "top-values" : "equal-interval";
}

export function normalizeClassificationScheme(mode: VectorStyleMode, scheme: string): string {
  const options =
    mode === "categorized" ? CATEGORIZED_CLASSIFICATION_SCHEMES : GRADUATED_CLASSIFICATION_SCHEMES;
  return options.some((option) => option.value === scheme)
    ? scheme
    : defaultClassificationScheme(mode);
}

export function chooseDefaultStyleProperty(
  layer: Parameters<typeof getPropertyValues>[0],
  mode: VectorStyleMode,
  properties: string[],
  currentProperty: string,
): string {
  if (mode === "graduated") {
    if (currentProperty && isNumericProperty(layer, currentProperty)) {
      return currentProperty;
    }
    return (
      chooseGraduatedProperty(layer, properties) || (!layer.geojson ? (properties[0] ?? "") : "")
    );
  }

  if (mode === "categorized") {
    if (currentProperty && isCategoricalProperty(layer, currentProperty)) {
      return currentProperty;
    }
    return (
      properties.find((property) => isCategoricalProperty(layer, property)) ?? properties[0] ?? ""
    );
  }

  return currentProperty;
}

export function normalizeVectorStyleStops(
  mode: VectorStyleMode,
  stops: VectorStyleStop[],
): VectorStyleStop[] {
  return stops
    .map((stop) => ({
      value:
        mode === "graduated" && typeof stop.value === "string"
          ? Number.parseFloat(stop.value)
          : typeof stop.value === "string"
            ? stop.value.trim()
            : stop.value,
      color: stop.color.trim(),
    }))
    .filter((stop) => {
      if (!/^#[0-9a-f]{6}$/i.test(stop.color)) return false;
      if (mode === "graduated") {
        return typeof stop.value === "number" && Number.isFinite(stop.value);
      }
      return String(stop.value).trim().length > 0;
    });
}

export function nextStopColor(index: number): string {
  return VECTOR_STYLE_COLORS[index % VECTOR_STYLE_COLORS.length];
}

export function validateExpressionJson(value: string, label: string, t: TFunction): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(removeTrailingJsonCommas(trimmed));
    if (!Array.isArray(parsed)) {
      return t("style.expressionErrors.notArray", { label });
    }
    // Every MapLibre expression starts with a string operator. Reject e.g.
    // `["to-number", …]` used as a filter or a bare value array, which parses as
    // JSON but compiles to an expression MapLibre rejects at runtime.
    if (typeof parsed[0] !== "string") {
      return t("style.expressionErrors.notOperator", { label });
    }
    return null;
  } catch (error) {
    return t("style.expressionErrors.notJson", {
      label,
      message: error instanceof Error ? error.message : "unknown parse error",
    });
  }
}
