import {
  extractDirectionsRouteMetrics,
  type DirectionsRouteMetrics,
  type DirectionsRuntimeState,
} from "@geolibre/core";
import type MapLibreGlDirections from "@maplibre/maplibre-gl-directions";
import type { MapLibreGlDirectionsRoutingData } from "@maplibre/maplibre-gl-directions";
import type { IControl, Map as MapLibreMap } from "maplibre-gl";
import type { MapLibreHostedRuntime, MapLibreHostedRuntimeContext } from "./types";

const ROUTE_LOADING_FALLBACK_MS = 60_000;

let directions: MapLibreGlDirections | null = null;
let directionsMap: MapLibreMap | null = null;
let loadingControl: IControl | null = null;
let active = false;
let loadToken = 0;
let routeMetrics: DirectionsRouteMetrics | null = null;
let routeLoading = false;
let routeLoadingFallbackTimer: ReturnType<typeof setTimeout> | null = null;
let removalInFlight = false;
let removalToken = 0;
let onStateChange: ((state: unknown) => void) | null = null;

function state(): DirectionsRuntimeState {
  return {
    waypointCount: directions?.waypoints.length ?? 0,
    routeMetrics,
    routeLoading,
    removalInFlight,
  };
}

function publishState(): void {
  onStateChange?.(state());
}

function clearRouteLoadingFallback(): void {
  if (routeLoadingFallbackTimer == null) return;
  clearTimeout(routeLoadingFallbackTimer);
  routeLoadingFallbackTimer = null;
}

function handleDirectionsFetchStart(): void {
  clearRouteLoadingFallback();
  routeLoading = true;
  routeMetrics = null;
  routeLoadingFallbackTimer = setTimeout(() => {
    routeLoadingFallbackTimer = null;
    if (!routeLoading) return;
    routeLoading = false;
    publishState();
  }, ROUTE_LOADING_FALLBACK_MS);
  publishState();
}

function handleDirectionsFetchEnd(event: { data: MapLibreGlDirectionsRoutingData }): void {
  clearRouteLoadingFallback();
  routeLoading = false;
  routeMetrics = extractDirectionsRouteMetrics(event.data.directions);
  publishState();
}

function handleDirectionsWaypointChange(): void {
  const count = directions?.waypoints.length ?? 0;
  if (count < 2) {
    clearRouteLoadingFallback();
    routeLoading = false;
    routeMetrics = null;
  }
  publishState();
}

function removeLastWaypoint(): boolean {
  if (!directions || removalInFlight) return false;
  const count = directions.waypoints.length;
  if (count === 0) return false;
  removalInFlight = true;
  const callToken = loadToken;
  const callRemovalToken = ++removalToken;
  publishState();
  void directions
    .removeWaypoint(count - 1)
    .catch((error: unknown) => {
      if (
        error != null &&
        typeof error === "object" &&
        (error as { name?: unknown }).name === "AbortError"
      ) {
        return;
      }
      console.error("Directions: removeWaypoint failed", error);
    })
    .finally(() => {
      if (callToken !== loadToken || callRemovalToken !== removalToken) return;
      removalInFlight = false;
      publishState();
    });
  return true;
}

function clearWaypoints(): boolean {
  if (!directions) return false;
  ++removalToken;
  directions.abortController?.abort();
  directions.clear();
  removalInFlight = false;
  clearRouteLoadingFallback();
  routeLoading = false;
  routeMetrics = null;
  publishState();
  return true;
}

function detach(context: MapLibreHostedRuntimeContext, publish = true): void {
  ++loadToken;
  if (loadingControl) {
    context.removeControl?.(loadingControl);
    loadingControl = null;
  }
  directions?.off("addwaypoint", handleDirectionsWaypointChange);
  directions?.off("removewaypoint", handleDirectionsWaypointChange);
  directions?.off("setwaypoints", handleDirectionsWaypointChange);
  directions?.off("fetchroutesstart", handleDirectionsFetchStart);
  directions?.off("fetchroutesend", handleDirectionsFetchEnd);
  directions?.destroy();
  directions = null;
  directionsMap = null;
  removalInFlight = false;
  clearRouteLoadingFallback();
  routeLoading = false;
  routeMetrics = null;
  if (publish) publishState();
}

async function attach(context: MapLibreHostedRuntimeContext, token: number): Promise<boolean> {
  const map = context.map;
  if (!map) return false;
  const { default: DirectionsClass, LoadingIndicatorControl } = await import(
    "@maplibre/maplibre-gl-directions"
  );
  if (!active || token !== loadToken || directions) return false;

  const instance = new DirectionsClass(map);
  instance.interactive = true;
  instance.on("addwaypoint", handleDirectionsWaypointChange);
  instance.on("removewaypoint", handleDirectionsWaypointChange);
  instance.on("setwaypoints", handleDirectionsWaypointChange);
  instance.on("fetchroutesstart", handleDirectionsFetchStart);
  instance.on("fetchroutesend", handleDirectionsFetchEnd);
  const indicator = new LoadingIndicatorControl(instance);
  const added = context.addControl?.(indicator, "top-right") ?? false;
  if (!added) {
    instance.off("addwaypoint", handleDirectionsWaypointChange);
    instance.off("removewaypoint", handleDirectionsWaypointChange);
    instance.off("setwaypoints", handleDirectionsWaypointChange);
    instance.off("fetchroutesstart", handleDirectionsFetchStart);
    instance.off("fetchroutesend", handleDirectionsFetchEnd);
    instance.destroy();
    return false;
  }

  directions = instance;
  directionsMap = map;
  loadingControl = indicator;
  publishState();
  return true;
}

/** Adapter-private lazy runtime for the renderer-neutral Directions descriptor. */
export const maplibreDirectionsRuntime: MapLibreHostedRuntime = {
  activate: (context, { onStateChange: nextOnStateChange }) => {
    if (!context.map) return false;
    onStateChange = nextOnStateChange ?? null;
    if (directions && directionsMap === context.map) {
      active = true;
      publishState();
      return true;
    }
    if (directions) detach(context, false);
    active = true;
    return attach(context, ++loadToken);
  },
  deactivate: (context) => {
    active = false;
    detach(context);
    onStateChange = null;
  },
  getState: () => state(),
  runCommand: (_context, command) => {
    if (command === "directions.remove-last") return removeLastWaypoint();
    if (command === "directions.clear") return clearWaypoints();
    return false;
  },
};
