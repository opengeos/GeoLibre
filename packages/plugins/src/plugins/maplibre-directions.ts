import {
  extractDirectionsRouteMetrics,
  type DirectionsRouteLegMetric,
  type DirectionsRouteMetrics,
  type DirectionsRuntimeState,
} from "@geolibre/core";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export {
  extractDirectionsRouteMetrics,
  type DirectionsRouteLegMetric,
  type DirectionsRouteMetrics,
};

/** Stable id for the lazy adapter-owned Directions runtime. */
export const DIRECTIONS_PLUGIN_ID = "maplibre-gl-directions";

type DirectionsStateListener = () => void;

const inactiveState: DirectionsRuntimeState = {
  waypointCount: 0,
  routeMetrics: null,
  routeLoading: false,
  removalInFlight: false,
};

let activeApp: GeoLibreAppAPI | null = null;
let state: DirectionsRuntimeState = inactiveState;
const listeners = new Set<DirectionsStateListener>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error("Directions: state listener threw.", error);
    }
  }
}

function isDirectionsRuntimeState(value: unknown): value is DirectionsRuntimeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<DirectionsRuntimeState>;
  return (
    typeof candidate.waypointCount === "number" &&
    Number.isFinite(candidate.waypointCount) &&
    typeof candidate.routeLoading === "boolean" &&
    typeof candidate.removalInFlight === "boolean" &&
    (candidate.routeMetrics === null || typeof candidate.routeMetrics === "object")
  );
}

function adoptRuntimeState(next: unknown): void {
  if (!isDirectionsRuntimeState(next)) return;
  state = next;
  notify();
}

function resetState(): void {
  state = inactiveState;
  notify();
}

function activateDirections(app: GeoLibreAppAPI): boolean | Promise<boolean> {
  activeApp = app;
  return app.map.invoke("hosted-plugin.activate", {
    pluginId: DIRECTIONS_PLUGIN_ID,
    onStateChange: adoptRuntimeState,
  });
}

function deactivateDirections(app: GeoLibreAppAPI): void {
  app.map.invoke("hosted-plugin.deactivate", { pluginId: DIRECTIONS_PLUGIN_ID });
  activeApp = null;
  resetState();
}

/** Subscribe to the current renderer-neutral Directions session state. */
export function subscribeDirectionsState(listener: DirectionsStateListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Number of waypoints in the active directions session, or zero when inactive. */
export function getDirectionsWaypointCount(): number {
  return state.waypointCount;
}

/** Latest validated route metrics, or null while no route is available. */
export function getDirectionsRouteMetrics(): DirectionsRouteMetrics | null {
  return state.routeMetrics;
}

/** Whether the active directions session is awaiting a route response. */
export function isDirectionsRouteLoading(): boolean {
  return state.routeLoading;
}

/** Whether removal of the final waypoint is awaiting its route refetch. */
export function isDirectionsRemovalInFlight(): boolean {
  return state.removalInFlight;
}

/** Request removal of the most recent waypoint through the typed MapEngine seam. */
export function removeLastDirectionsWaypoint(): void {
  activeApp?.map.invoke("directions.remove-last", undefined);
}

/** Request a transient route/waypoint clear through the typed MapEngine seam. */
export function clearDirectionsWaypoints(): void {
  activeApp?.map.invoke("directions.clear", undefined);
}

/** Rebind an active Directions session after the host reinitializes its engine. */
export function restoreDirections(app: GeoLibreAppAPI, active: boolean): void {
  if (active) {
    void activateDirections(app);
    return;
  }
  deactivateDirections(app);
}

/** Renderer-neutral descriptor for the lazy MapLibre Directions runtime. */
export const maplibreDirectionsPlugin: GeoLibrePlugin = {
  id: DIRECTIONS_PLUGIN_ID,
  name: "Directions",
  version: "1.0.0",
  activate: activateDirections,
  deactivate: deactivateDirections,
};
