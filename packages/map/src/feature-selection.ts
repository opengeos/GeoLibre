import booleanIntersects from "@turf/boolean-intersects";
import { featureSelectionId, type SelectionMode } from "@geolibre/core";
import type { Feature, Polygon } from "geojson";

export type FeatureSelectionShape = "single" | "rectangle" | "polygon" | "freehand" | "radius";

export interface FeatureSelectionRequest {
  layerId: string;
  shape: FeatureSelectionShape;
  mode?: SelectionMode;
}

export const FEATURE_SELECTION_EVENT = "geolibre:select-features-on-map";

/** Start a one-shot map selection interaction. */
export function startFeatureSelection(request: FeatureSelectionRequest): void {
  window.dispatchEvent(
    new CustomEvent<FeatureSelectionRequest>(FEATURE_SELECTION_EVENT, {
      detail: request,
    }),
  );
}

/** QGIS-style keyboard modifiers for a spatial selection gesture. */
export function selectionModeFromModifiers(
  shiftKey: boolean,
  altKey: boolean,
  fallback: SelectionMode = "new",
): SelectionMode {
  if (shiftKey && altKey) return "intersect";
  if (shiftKey) return "add";
  if (altKey) return "remove";
  return fallback;
}

/** Match every layer feature that intersects the drawn selection polygon. */
export function featuresIntersectingPolygon(features: Feature[], polygon: Polygon): string[] {
  const selection: Feature = {
    type: "Feature",
    properties: {},
    geometry: polygon,
  };
  const matches: string[] = [];
  features.forEach((feature, index) => {
    if (!feature.geometry) return;
    try {
      if (booleanIntersects(feature, selection)) matches.push(featureSelectionId(feature, index));
    } catch {
      // A malformed feature should not abort selection of the remaining layer.
    }
  });
  return matches;
}
