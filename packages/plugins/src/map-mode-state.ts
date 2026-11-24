import type { GeoLibreAppAPI } from "./types";
type DirectionsModule = typeof import("./plugins/maplibre-directions");
type DirectionsAPI = Pick<
  DirectionsModule,
  | "getDirectionsWaypointCount"
  | "getDirectionsRouteMetrics"
  | "isDirectionsRouteLoading"
  | "isDirectionsRemovalInFlight"
  | "removeLastDirectionsWaypoint"
  | "clearDirectionsWaypoints"
  | "subscribeDirectionsState"
  | "restoreDirections"
>;

let directions: DirectionsAPI | undefined;
let disconnectDirections: (() => void) | undefined;
const listeners = new Set<() => void>();
function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error("Directions: state listener threw.", error);
    }
  }
}

/** Connect either a catalog-loaded provider or the existing direct SDK export. */
export function provideDirectionsRuntime(provider: DirectionsAPI): void {
  if (directions === provider) return;
  disconnectDirections?.();
  directions = provider;
  disconnectDirections = provider.subscribeDirectionsState(notify);
  notify();
}

export const getDirectionsWaypointCount = (): number =>
  directions?.getDirectionsWaypointCount() ?? 0;
export const getDirectionsRouteMetrics = (): ReturnType<
  DirectionsAPI["getDirectionsRouteMetrics"]
> => directions?.getDirectionsRouteMetrics() ?? null;
export const isDirectionsRouteLoading = (): boolean =>
  directions?.isDirectionsRouteLoading() ?? false;
export const isDirectionsRemovalInFlight = (): boolean =>
  directions?.isDirectionsRemovalInFlight() ?? false;
export const removeLastDirectionsWaypoint = (): void => directions?.removeLastDirectionsWaypoint();
export const clearDirectionsWaypoints = (): void => directions?.clearDirectionsWaypoints();
export const restoreDirections = (app: GeoLibreAppAPI, active: boolean): void =>
  directions?.restoreDirections(app, active);
export function subscribeDirectionsState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** An unloaded reverse-geocode provider has no click subscription to rebind. */
export const reverseGeocodeRuntime: { restore: (app: GeoLibreAppAPI, active: boolean) => void } = {
  restore: () => {},
};
