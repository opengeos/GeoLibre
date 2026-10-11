import type { Feature, FeatureCollection } from "geojson";
import type * as maplibregl from "maplibre-gl";
import { sliceAlong, type LngLat } from "./geometry";
import type { NavRoute } from "./route";

/**
 * On-map drawing for the navigation tool: the candidate routes, the chosen
 * one with the part already driven greyed out, the waypoints, and the next
 * maneuver. Drawn as transient sources, like the Line of Sight tool and the GPS
 * track, so a route being planned or driven does not land in the Layers panel
 * until "Save as layer" puts it there.
 */

export const NAV_ROUTE_COLOR = "#2563eb";
export const NAV_ROUTE_CASING_COLOR = "#1e3a8a";
export const NAV_ALTERNATE_COLOR = "#94a3b8";
export const NAV_TRAVELED_COLOR = "#9ca3af";
export const NAV_ORIGIN_COLOR = "#16a34a";
export const NAV_STOP_COLOR = "#f59e0b";
export const NAV_DESTINATION_COLOR = "#dc2626";

/** Waypoint roles, by position in the waypoint list. */
export type NavWaypointRole = "origin" | "stop" | "destination";

/** What the overlay shows. */
export interface NavigationOverlayState {
  routes: NavRoute[];
  selectedIndex: number;
  /** Placed waypoints in order; null for a slot still empty. */
  waypoints: (LngLat | null)[];
  /** Distance driven along the selected route, while navigating. */
  traveledAlong?: number | null;
  /** The next maneuver, highlighted while navigating. */
  maneuver?: LngLat | null;
  /** While navigating, alternates are hidden and the origin marker dropped. */
  navigating?: boolean;
}

/**
 * The features the map draws for the tool's current state.
 *
 * @param state - Routes, the selection, waypoints, and drive progress.
 * @returns Lines carrying `role` (`alternate`, `route`, `traveled`) and, for an
 *   alternate, its `index`; points carrying `role` (a waypoint role, or
 *   `maneuver`).
 */
export function navigationOverlayCollection(state: NavigationOverlayState): FeatureCollection {
  const features: Feature[] = [];
  const { routes, selectedIndex, waypoints, traveledAlong, maneuver, navigating } = state;
  if (!navigating) {
    routes.forEach((route, index) => {
      if (index === selectedIndex) return;
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: route.coordinates },
        properties: { role: "alternate", index },
      });
    });
  }
  const selected = routes[selectedIndex];
  if (selected) {
    const driven = Math.max(0, Math.min(traveledAlong ?? 0, selected.distance));
    const ahead =
      driven > 0
        ? sliceAlong(selected.coordinates, selected.cumulative, driven, selected.distance)
        : selected.coordinates;
    if (driven > 0) {
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: sliceAlong(selected.coordinates, selected.cumulative, 0, driven),
        },
        properties: { role: "traveled" },
      });
    }
    if (ahead.length >= 2) {
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: ahead },
        properties: { role: "route", index: selectedIndex },
      });
    }
  }
  const last = waypoints.length - 1;
  waypoints.forEach((point, index) => {
    if (!point) return;
    const role: NavWaypointRole = index === 0 ? "origin" : index === last ? "destination" : "stop";
    if (navigating && role === "origin") return;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: point },
      properties: { role, order: index },
    });
  });
  if (maneuver) {
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: maneuver },
      properties: { role: "maneuver" },
    });
  }
  return { type: "FeatureCollection", features };
}

const SOURCE_ID = "geolibre-navigation";
const ALTERNATE_CASING = `${SOURCE_ID}-alternate-casing`;
/** The clickable alternate-route layer, for picking a route on the map. */
export const NAV_ALTERNATE_LAYER = `${SOURCE_ID}-alternate`;
const TRAVELED_LAYER = `${SOURCE_ID}-traveled`;
const ROUTE_CASING = `${SOURCE_ID}-route-casing`;
const ROUTE_LAYER = `${SOURCE_ID}-route`;
const MANEUVER_LAYER = `${SOURCE_ID}-maneuver`;
const WAYPOINT_LAYER = `${SOURCE_ID}-waypoints`;
const LAYER_IDS = [
  ALTERNATE_CASING,
  NAV_ALTERNATE_LAYER,
  TRAVELED_LAYER,
  ROUTE_CASING,
  ROUTE_LAYER,
  MANEUVER_LAYER,
  WAYPOINT_LAYER,
];

/** Marks the overlay's style layers as internal, so layer lists skip them. */
const INTERNAL_METADATA = { "geolibre:internal": true };

const role = (value: string): maplibregl.FilterSpecification => ["==", ["get", "role"], value];
const ROUND_LINE = { "line-cap": "round", "line-join": "round" } as const;

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
    id: ALTERNATE_CASING,
    type: "line",
    source: SOURCE_ID,
    filter: role("alternate"),
    layout: ROUND_LINE,
    paint: { "line-color": "#475569", "line-width": 9, "line-opacity": 0.5 },
  });
  add({
    id: NAV_ALTERNATE_LAYER,
    type: "line",
    source: SOURCE_ID,
    filter: role("alternate"),
    layout: ROUND_LINE,
    paint: { "line-color": NAV_ALTERNATE_COLOR, "line-width": 6 },
  });
  add({
    id: TRAVELED_LAYER,
    type: "line",
    source: SOURCE_ID,
    filter: role("traveled"),
    layout: ROUND_LINE,
    paint: { "line-color": NAV_TRAVELED_COLOR, "line-width": 6, "line-opacity": 0.8 },
  });
  add({
    id: ROUTE_CASING,
    type: "line",
    source: SOURCE_ID,
    filter: role("route"),
    layout: ROUND_LINE,
    paint: { "line-color": NAV_ROUTE_CASING_COLOR, "line-width": 10 },
  });
  add({
    id: ROUTE_LAYER,
    type: "line",
    source: SOURCE_ID,
    filter: role("route"),
    layout: ROUND_LINE,
    paint: { "line-color": NAV_ROUTE_COLOR, "line-width": 6 },
  });
  add({
    id: MANEUVER_LAYER,
    type: "circle",
    source: SOURCE_ID,
    filter: role("maneuver"),
    paint: {
      "circle-radius": 7,
      "circle-color": "#ffffff",
      "circle-stroke-color": NAV_ROUTE_CASING_COLOR,
      "circle-stroke-width": 3,
    },
  });
  add({
    id: WAYPOINT_LAYER,
    type: "circle",
    source: SOURCE_ID,
    filter: ["in", ["get", "role"], ["literal", ["origin", "stop", "destination"]]],
    paint: {
      "circle-radius": 8,
      "circle-color": [
        "match",
        ["get", "role"],
        "origin",
        NAV_ORIGIN_COLOR,
        "stop",
        NAV_STOP_COLOR,
        NAV_DESTINATION_COLOR,
      ],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2.5,
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
export interface NavigationOverlay {
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
export function createNavigationOverlay(map: maplibregl.Map): NavigationOverlay {
  let data: FeatureCollection = { type: "FeatureCollection", features: [] };
  let removed = false;
  const apply = () => {
    if (removed) return;
    ensureOverlay(map, data);
    const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
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
