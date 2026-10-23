import type { LineOfSightPoint, LineOfSightResult } from "@geolibre/processing";
import type { Feature, FeatureCollection } from "geojson";
import type * as maplibregl from "maplibre-gl";

/**
 * GeoJSON and on-map drawing for the Line of Sight tool (issue #2858).
 *
 * The line is drawn as transient map sources -- like the GPS track and the
 * measure sketch -- rather than as a project layer: a sight line is usually a
 * question asked and answered in a few seconds, and a layer per question would
 * litter the Layers panel. "Save as layer" turns one into a GeoJSON layer with
 * {@link lineOfSightLayerCollection} when the answer is worth keeping.
 */

/** Visible stretches of the line. */
export const LOS_VISIBLE_COLOR = "#16a34a";
/** Obstructed stretches of the line. */
export const LOS_HIDDEN_COLOR = "#dc2626";
export const LOS_OBSERVER_COLOR = "#2563eb";
export const LOS_TARGET_COLOR = "#7c3aed";
export const LOS_OBSTRUCTION_COLOR = "#f97316";

/** The point roles drawn and saved. */
export type LineOfSightRole = "observer" | "target" | "obstruction";

const ROLE_COLORS: Record<LineOfSightRole, string> = {
  observer: LOS_OBSERVER_COLOR,
  target: LOS_TARGET_COLOR,
  obstruction: LOS_OBSTRUCTION_COLOR,
};

/** Round metres for an attribute table: centimetres are noise on a terrain tile. */
const round = (value: number, digits = 1) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

/**
 * The features the map draws for the tool's current state.
 *
 * @param state - The placed observer (and target, once picked), and the result
 *   when the analysis has finished.
 * @returns Line segments carrying `visible`, and points carrying `role`.
 */
export function lineOfSightOverlayCollection(state: {
  observer: LineOfSightPoint | null;
  target: LineOfSightPoint | null;
  result: LineOfSightResult | null;
}): FeatureCollection {
  const features: Feature[] = [];
  const { observer, target, result } = state;
  if (result) {
    for (const segment of result.segments) {
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: segment.coordinates },
        properties: { visible: segment.visible },
      });
    }
  } else if (observer && target) {
    // Analysing: a neutral line between the two picks, so the click visibly
    // took while the terrain loads.
    features.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [observer.lng, observer.lat],
          [target.lng, target.lat],
        ],
      },
      properties: { pending: true },
    });
  }
  const point = (role: LineOfSightRole, at: LineOfSightPoint) =>
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [at.lng, at.lat] },
      properties: { role },
    });
  if (result?.firstObstruction) point("obstruction", result.firstObstruction);
  if (observer) point("observer", observer);
  if (target) point("target", target);
  return { type: "FeatureCollection", features };
}

/** The settings a result was computed with, recorded on the saved layer. */
export interface LineOfSightSettings {
  observerHeightMeters: number;
  targetHeightMeters: number;
  curvature: boolean;
}

/**
 * A result as a self-describing GeoJSON layer: the line's segments with their
 * visibility and distance range, the observer and target with their heights,
 * and the first obstruction when there is one.
 *
 * Colours are written as simplestyle properties (`stroke`, `marker-color`), so
 * the new layer draws green/red without restyling -- the store turns
 * simplestyle on for any collection that carries them.
 *
 * @param result - The computed line of sight.
 * @param settings - The heights and curvature model it was computed with.
 * @returns The collection to add as a layer.
 */
export function lineOfSightLayerCollection(
  result: LineOfSightResult,
  settings: LineOfSightSettings,
): FeatureCollection {
  const features: Feature[] = result.segments.map((segment) => ({
    type: "Feature",
    geometry: { type: "LineString", coordinates: segment.coordinates },
    properties: {
      kind: "segment",
      visible: segment.visible,
      start_m: round(segment.startDistance),
      end_m: round(segment.endDistance),
      length_m: round(segment.endDistance - segment.startDistance),
      stroke: segment.visible ? LOS_VISIBLE_COLOR : LOS_HIDDEN_COLOR,
      "stroke-width": 4,
    },
  }));
  const shared = {
    target_visible: result.targetVisible,
    distance_m: round(result.totalDistance),
    curvature: settings.curvature,
  };
  features.push({
    type: "Feature",
    geometry: { type: "Point", coordinates: [result.observer.lng, result.observer.lat] },
    properties: {
      kind: "observer",
      ground_m: round(result.observer.groundMeters),
      height_m: settings.observerHeightMeters,
      eye_m: round(result.observer.eyeMeters),
      ...shared,
      "marker-color": ROLE_COLORS.observer,
    },
  });
  features.push({
    type: "Feature",
    geometry: { type: "Point", coordinates: [result.target.lng, result.target.lat] },
    properties: {
      kind: "target",
      ground_m: round(result.target.groundMeters),
      height_m: settings.targetHeightMeters,
      top_m: round(result.target.topMeters),
      ...shared,
      "marker-color": ROLE_COLORS.target,
    },
  });
  const obstruction = result.firstObstruction;
  if (obstruction) {
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [obstruction.lng, obstruction.lat] },
      properties: {
        kind: "obstruction",
        ground_m: round(obstruction.elevation),
        from_observer_m: round(obstruction.distance),
        "marker-color": ROLE_COLORS.obstruction,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

// --- Transient map overlay (MapLibre) -----------------------------------------

const SOURCE_ID = "geolibre-line-of-sight";
const CASING_LAYER = `${SOURCE_ID}-casing`;
const VISIBLE_LAYER = `${SOURCE_ID}-visible`;
const HIDDEN_LAYER = `${SOURCE_ID}-hidden`;
const PENDING_LAYER = `${SOURCE_ID}-pending`;
const POINT_LAYER = `${SOURCE_ID}-points`;
const LAYER_IDS = [CASING_LAYER, PENDING_LAYER, VISIBLE_LAYER, HIDDEN_LAYER, POINT_LAYER];

/** Marks the overlay's style layers as internal, so layer lists skip them. */
const INTERNAL_METADATA = { "geolibre:internal": true };

const LINE_FILTER: maplibregl.ExpressionSpecification = ["==", ["geometry-type"], "LineString"];

/**
 * Add the overlay's source and layers when they are missing. A basemap switch
 * (`setStyle`) wipes them, so this runs again on `styledata`; it is a no-op
 * while a replacement style is still loading, when `addSource` would throw.
 */
function ensureOverlay(map: maplibregl.Map, data: FeatureCollection): void {
  if (!map.isStyleLoaded()) return;
  if (!map.getSource(SOURCE_ID)) map.addSource(SOURCE_ID, { type: "geojson", data });
  const add = (layer: maplibregl.LayerSpecification) => {
    if (!map.getLayer(layer.id)) map.addLayer({ ...layer, metadata: INTERNAL_METADATA });
  };
  add({
    id: CASING_LAYER,
    type: "line",
    source: SOURCE_ID,
    filter: LINE_FILTER,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.85 },
  });
  add({
    id: PENDING_LAYER,
    type: "line",
    source: SOURCE_ID,
    filter: ["all", LINE_FILTER, ["has", "pending"]],
    paint: { "line-color": "#64748b", "line-width": 3, "line-dasharray": [2, 2] },
  });
  add({
    id: VISIBLE_LAYER,
    type: "line",
    source: SOURCE_ID,
    filter: ["all", LINE_FILTER, ["==", ["get", "visible"], true]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": LOS_VISIBLE_COLOR, "line-width": 4 },
  });
  // Obstructed stretches are dashed as well as red, so the split still reads
  // for a red-green colour-blind viewer.
  add({
    id: HIDDEN_LAYER,
    type: "line",
    source: SOURCE_ID,
    filter: ["all", LINE_FILTER, ["==", ["get", "visible"], false]],
    paint: { "line-color": LOS_HIDDEN_COLOR, "line-width": 4, "line-dasharray": [1.5, 1] },
  });
  add({
    id: POINT_LAYER,
    type: "circle",
    source: SOURCE_ID,
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": ["match", ["get", "role"], "obstruction", 6, 7],
      "circle-color": [
        "match",
        ["get", "role"],
        "observer",
        LOS_OBSERVER_COLOR,
        "target",
        LOS_TARGET_COLOR,
        LOS_OBSTRUCTION_COLOR,
      ],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
    },
  });
}

function removeOverlay(map: maplibregl.Map): void {
  try {
    for (const id of LAYER_IDS) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  } catch {
    // Mid-style-switch the overlay already went with the old style.
  }
}

/** The tool's drawing on one map. */
export interface LineOfSightOverlay {
  setData(data: FeatureCollection): void;
  remove(): void;
}

/**
 * Draw the tool's features as transient sources on a MapLibre map, re-adding
 * them after a basemap switch.
 *
 * @param map - The live MapLibre map.
 * @returns The overlay handle.
 */
export function createLineOfSightOverlay(map: maplibregl.Map): LineOfSightOverlay {
  let data: FeatureCollection = { type: "FeatureCollection", features: [] };
  let removed = false;
  const apply = () => {
    if (removed) return;
    ensureOverlay(map, data);
    const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    // setData resolves once the worker has the data; nothing waits on it.
    void source?.setData(data);
  };
  // Gated on the source being gone, so ordinary style edits cost one lookup.
  const onStyleData = () => {
    if (!map.getSource(SOURCE_ID)) apply();
  };
  map.on("styledata", onStyleData);
  return {
    setData(next) {
      data = next;
      apply();
    },
    remove() {
      if (removed) return;
      removed = true;
      map.off("styledata", onStyleData);
      removeOverlay(map);
    },
  };
}
