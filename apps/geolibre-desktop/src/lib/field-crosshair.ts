import { create } from "zustand";
import type { Feature, FeatureCollection, Point } from "geojson";

export const FIELD_CROSSHAIR_LAYER_ID = "field-crosshair-captures";

export interface FieldCrosshairPoint {
  lng: number;
  lat: number;
  accuracyM?: number | null;
  source: "crosshair" | "gps";
  capturedAt: string;
}

interface FieldCrosshairState {
  active: boolean;
  capturedCount: number;
  start: () => void;
  stop: () => void;
  incrementCaptured: () => void;
}

/**
 * Coordinates the mobile crosshair-at-map-center digitizing session
 * (GeoLibre#3537 Phase 4), letting field users pan the map beneath a fixed
 * reticle and drop points without their thumb obscuring the target.
 */
export const useFieldCrosshairStore = create<FieldCrosshairState>((set) => ({
  active: false,
  capturedCount: 0,
  start: () => set({ active: true }),
  stop: () => set({ active: false }),
  incrementCaptured: () => set((s) => ({ capturedCount: s.capturedCount + 1 })),
}));

/** Build a GeoJSON Point feature from a crosshair or GPS capture. */
export function buildFieldCaptureFeature(
  point: FieldCrosshairPoint,
  index: number,
): Feature<Point> {
  return {
    type: "Feature",
    id: `field-pt-${index}`,
    geometry: {
      type: "Point",
      coordinates: [point.lng, point.lat],
    },
    properties: {
      name: `Point ${index}`,
      source: point.source,
      captured_at: point.capturedAt,
      ...(point.accuracyM != null ? { accuracy_m: Math.round(point.accuracyM * 10) / 10 } : {}),
    },
  };
}

/** Append a captured point to an existing GeoJSON collection immutably. */
export function appendFieldCaptureFeature(
  existing: FeatureCollection | undefined,
  point: FieldCrosshairPoint,
): FeatureCollection {
  const prevFeatures = existing?.features ?? [];
  const feature = buildFieldCaptureFeature(point, prevFeatures.length + 1);
  return {
    type: "FeatureCollection",
    features: [...prevFeatures, feature],
  };
}
