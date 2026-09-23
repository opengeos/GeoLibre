import { DEFAULT_LAYER_STYLE, type LayerStyle } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { GEOMAN_SHAPE_PROPERTY, TEXT_MARKER_SHAPE } from "./label-style";

// Symbology decisions shared by MapLibre's layer-sync and the Mapbox compiler.
// Kept free of any renderer import so the Mapbox bundle never pulls in
// maplibre-gl.

/**
 * Return the first zoom where a zoom-stepped extrusion becomes non-flat.
 * A zero-height fill-extrusion is still triangulated as 3D geometry by
 * MapLibre and can produce large tile-boundary shards on the globe. Callers
 * use this cutoff to render an ordinary fill below it instead.
 */
export function flatExtrusionCutoff(style: LayerStyle): number | null {
  if (!style.extrusionAdvancedStyleEnabled || !style.extrusionHeightExpression) return null;
  try {
    const expression: unknown = JSON.parse(style.extrusionHeightExpression);
    if (
      Array.isArray(expression) &&
      expression[0] === "step" &&
      Array.isArray(expression[1]) &&
      expression[1][0] === "zoom" &&
      expression[2] === 0 &&
      typeof expression[3] === "number" &&
      Number.isFinite(expression[3])
    ) {
      return Math.min(
        DEFAULT_LAYER_STYLE.maxZoom,
        Math.max(DEFAULT_LAYER_STYLE.minZoom, expression[3]),
      );
    }
  } catch {
    // Invalid expressions are handled by the existing style-expression path.
  }
  return null;
}

// syncs can fire rapidly (e.g. dragging an opacity slider), and this is an O(n)
// scan that the tiled path now runs against 50k+ feature collections. Memoize by
// collection reference — the store replaces the object on every mutation.
const textMarkerCache = new WeakMap<FeatureCollection, boolean>();

// Keep this predicate aligned with textMarkerFilter: any text-marker-shaped
// point routes to the symbol layer, even with empty text, so features are
// never excluded from the circle layer without a matching symbol entry.
export function hasTextMarkerFeatures(collection: FeatureCollection): boolean {
  const cached = textMarkerCache.get(collection);
  if (cached !== undefined) return cached;
  const result = computeHasTextMarkerFeatures(collection);
  textMarkerCache.set(collection, result);
  return result;
}

function computeHasTextMarkerFeatures(collection: FeatureCollection): boolean {
  return collection.features.some((feature) => {
    if (feature.geometry?.type !== "Point" && feature.geometry?.type !== "MultiPoint") {
      return false;
    }
    const properties = feature.properties;
    if (!properties) return false;
    return (
      properties[GEOMAN_SHAPE_PROPERTY] === TEXT_MARKER_SHAPE ||
      properties.shape === TEXT_MARKER_SHAPE
    );
  });
}
