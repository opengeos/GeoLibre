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

/** Start a map selection interaction. Click selection stays active until cancelled. */
export function startFeatureSelection(request: FeatureSelectionRequest): void {
  window.dispatchEvent(
    new CustomEvent<FeatureSelectionRequest>(FEATURE_SELECTION_EVENT, {
      detail: request,
    }),
  );
}

/** Whether a completed gesture should stay armed for another selection. */
export function keepsFeatureSelectionActive(shape: FeatureSelectionShape): boolean {
  return shape === "single";
}

/** The MapLibre camera interactions a selection gesture can suspend. */
export const CAMERA_HANDLERS = [
  "dragPan",
  "boxZoom",
  "doubleClickZoom",
  "scrollZoom",
  "keyboard",
  "dragRotate",
  "touchZoomRotate",
  "touchPitch",
] as const;

export type CameraHandlerName = (typeof CAMERA_HANDLERS)[number];

/**
 * The camera interactions a gesture suspends while it runs.
 *
 * A drawn shape freezes the camera outright: its vertices are recorded in
 * screen space and unprojected once, at the end, so a scroll-wheel zoom or an
 * arrow-key pan placed between two polygon clicks would leave the earlier
 * vertices pointing at different ground than the user aimed at.
 *
 * Click selection stays armed across clicks, so it keeps the camera live for
 * panning and zooming between picks — all but box zoom, which claims every
 * Shift+left-drag and calls `DOM.suppressClick()` on release. That fires even
 * for a Shift+click that never moved, swallowing the `click` this tool listens
 * for and making the Shift ("add") and Shift+Alt ("intersect") modifiers
 * silently do nothing.
 */
export function suspendedCameraHandlers(
  shape: FeatureSelectionShape,
): readonly CameraHandlerName[] {
  return shape === "single" ? ["boxZoom"] : CAMERA_HANDLERS;
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
