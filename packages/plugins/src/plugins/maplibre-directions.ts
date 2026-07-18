import type MapLibreGlDirections from "@maplibre/maplibre-gl-directions";
import type { MapLibreGlDirectionsRoutingData } from "@maplibre/maplibre-gl-directions";
import type { IControl, Map as MapLibreMap } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

/**
 * Interactive routing via `@maplibre/maplibre-gl-directions`.
 *
 * Toggled from the Controls menu (off by default). When active, the user can
 * click the map to add waypoints, drag them to reposition, and click a waypoint
 * to remove it; routes come from the library's default OSRM demo server
 * (`https://router.project-osrm.org`, driving only). The route is transient — it
 * is not persisted in the project and is cleared when the tool is toggled off.
 *
 * Privacy note: waypoints are sent to the public OSRM demo server. This is
 * surfaced to the user via the Controls menu item's tooltip and the README; a
 * configurable/self-hosted routing server is a planned follow-up.
 *
 * The heavy routing library is lazy-imported on activate so it stays out of the
 * main bundle.
 */
export const DIRECTIONS_PLUGIN_ID = "maplibre-gl-directions";

let directions: MapLibreGlDirections | null = null;
// The map the current instance is bound to, so restoreDirections can detect a
// map re-initialization (a brand-new Map object) and rebind.
let directionsMap: MapLibreMap | null = null;
let loadingControl: IControl | null = null;
// Bumped on every attach/teardown. A lazy import that resolves with a stale
// token (the user toggled off, or off then on, while it loaded) is discarded so
// it doesn't attach a directions instance to a tool that is no longer active.
let loadToken = 0;

// Listeners notified whenever the waypoint set changes (add/remove/clear) or the
// instance is attached/torn down. The desktop shell's mode banner subscribes via
// useSyncExternalStore so it can mirror the live waypoint count and enable or
// disable its "remove last"/"clear" actions. Kept here (not in the app) so the
// plugin stays the single owner of the directions instance.
type DirectionsStateListener = () => void;
const directionsStateListeners = new Set<DirectionsStateListener>();

export interface DirectionsRouteLegMetric {
  distanceMeters: number;
  durationSeconds: number;
}

export interface DirectionsRouteMetrics {
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  legs: DirectionsRouteLegMetric[];
}

interface OsrmRouteLeg {
  distance?: unknown;
  duration?: unknown;
}

interface OsrmRoute {
  distance?: unknown;
  duration?: unknown;
  legs?: OsrmRouteLeg[];
}

let routeMetrics: DirectionsRouteMetrics | null = null;
let routeLoading = false;
let routeLoadingFallbackTimer: ReturnType<typeof setTimeout> | null = null;
const ROUTE_LOADING_FALLBACK_MS = 60_000;

// True while a removeLastDirectionsWaypoint() call is mid route-refetch. Exposed
// so the banner can disable its "remove last" button until the async call
// settles, which closes the rapid-click window where two clicks would both read
// the same pre-removal count and target an index the first call already removed.
let removalInFlight = false;
// Bumped on every removal start and on clear. A removal's finalizer compares its
// captured value against this so a superseded removal (aborted by clear, then
// replaced by a new removal) can't flip the flag back for the newer request.
let removalToken = 0;

function notifyDirectionsState(): void {
  // Isolate subscriber failures so one throwing listener does not block the
  // rest from receiving the update.
  for (const listener of directionsStateListeners) {
    try {
      listener();
    } catch (error) {
      console.error("Directions: state listener threw.", error);
    }
  }
}

/**
 * Subscribe to directions waypoint-set changes. The listener fires after every
 * add, remove, clear, and on attach/teardown.
 *
 * @param listener Callback invoked on each change.
 * @returns An unsubscribe function.
 */
export function subscribeDirectionsState(listener: DirectionsStateListener): () => void {
  directionsStateListeners.add(listener);
  return () => {
    directionsStateListeners.delete(listener);
  };
}

/**
 * The number of waypoints currently placed in the active directions session.
 *
 * @returns The waypoint count, or 0 when the tool is inactive or still loading.
 */
export function getDirectionsWaypointCount(): number {
  return directions ? directions.waypoints.length : 0;
}

/**
 * The latest metrics returned by the active directions session.
 *
 * @returns Distance/time metrics for the selected route, or null while no
 * route has been calculated.
 */
export function getDirectionsRouteMetrics(): DirectionsRouteMetrics | null {
  return routeMetrics;
}

/**
 * Whether the current directions session is waiting on a route response.
 *
 * @returns True while OSRM is calculating a route.
 */
export function isDirectionsRouteLoading(): boolean {
  return routeLoading;
}

/**
 * Whether a waypoint removal is currently awaiting its route refetch.
 *
 * @returns True between the removeWaypoint call and its settlement.
 */
export function isDirectionsRemovalInFlight(): boolean {
  return removalInFlight;
}

/**
 * Remove the most recently placed waypoint and re-fetch the route. No-op when
 * the tool is inactive, no waypoints have been placed, or a removal is already
 * in flight (so rapid clicks cannot queue concurrent calls on a stale count).
 */
export function removeLastDirectionsWaypoint(): void {
  if (!directions || removalInFlight) return;
  const count = directions.waypoints.length;
  if (count === 0) return;
  removalInFlight = true;
  // Snapshot the session token: teardown()/attach() bump loadToken, so if the
  // user exits (or exits and re-enters) before this settles, a stale token means
  // we must not touch the now-current session's in-flight state or notify its
  // subscribers (teardown already reset the flag for the session we belonged to).
  const callToken = loadToken;
  // Snapshot the removal token too: a clear (or a newer removal) bumps it, so a
  // superseded finalizer can't reset removalInFlight for a later in-flight call.
  const callRemovalToken = ++removalToken;
  notifyDirectionsState();
  // removeWaypoint re-fetches the route, which can reject (network/OSRM error).
  // Log rather than let it surface as an unhandled rejection, mirroring how
  // attach() handles its load failure; clear the in-flight flag either way.
  void directions
    .removeWaypoint(count - 1)
    .catch((error: unknown) => {
      // An AbortError means clearDirectionsWaypoints() intentionally cancelled
      // this refetch; that is expected, not a failure, so don't log it. Match on
      // the name rather than the DOMException type so a library that re-wraps the
      // native abort in a plain Error is still recognized.
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
      // Skip if the session changed or this removal was superseded (e.g. by a
      // clear or a newer removal); that newer owner manages the flag itself.
      if (callToken !== loadToken || callRemovalToken !== removalToken) return;
      removalInFlight = false;
      notifyDirectionsState();
    });
}

/**
 * Clear all waypoints and the rendered route from the active directions
 * session. No-op when the tool is inactive.
 */
export function clearDirectionsWaypoints(): void {
  if (!directions) return;
  // Supersede any in-flight removal's finalizer so it can't later reset the flag.
  ++removalToken;
  // Abort any in-flight route refetch (e.g. from a pending removal) so its
  // response can't redraw a route onto the map after we clear; clear() alone
  // does not cancel the request. abortController only exists while a request is
  // ongoing. This keeps clear() honoring its contract (always clears) rather
  // than bailing out and silently no-op'ing when a removal is in flight.
  directions.abortController?.abort();
  // clear() does not emit a waypoint event, so notify listeners directly.
  directions.clear();
  // Clearing supersedes any in-flight removal: drop the flag so the post-clear
  // state is consistent (the aborted removal's .finally re-runs this harmlessly).
  removalInFlight = false;
  clearRouteLoadingFallback();
  routeLoading = false;
  routeMetrics = null;
  notifyDirectionsState();
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clearRouteLoadingFallback(): void {
  if (routeLoadingFallbackTimer == null) return;
  clearTimeout(routeLoadingFallbackTimer);
  routeLoadingFallbackTimer = null;
}

export function extractDirectionsRouteMetrics(
  directions: MapLibreGlDirectionsRoutingData["directions"],
): DirectionsRouteMetrics | null {
  const route = directions?.routes[0] as OsrmRoute | undefined;
  if (!route) return null;

  const rawLegs = route.legs ?? [];
  const legs = rawLegs
    .map((leg) => {
      const distanceMeters = toFiniteNumber(leg.distance);
      const durationSeconds = toFiniteNumber(leg.duration);
      if (distanceMeters == null || durationSeconds == null) return null;
      return { distanceMeters, durationSeconds };
    })
    .filter((leg): leg is DirectionsRouteLegMetric => leg != null);

  const routeDistanceMeters = toFiniteNumber(route.distance);
  const routeDurationSeconds = toFiniteNumber(route.duration);
  const canUseLegTotals = rawLegs.length > 0 && legs.length === rawLegs.length;
  const totalDistanceMeters =
    routeDistanceMeters ??
    (canUseLegTotals ? legs.reduce((sum, leg) => sum + leg.distanceMeters, 0) : null);
  const totalDurationSeconds =
    routeDurationSeconds ??
    (canUseLegTotals ? legs.reduce((sum, leg) => sum + leg.durationSeconds, 0) : null);

  if (
    totalDistanceMeters == null ||
    totalDurationSeconds == null ||
    totalDistanceMeters <= 0 ||
    totalDurationSeconds <= 0
  ) {
    return null;
  }
  return { totalDistanceMeters, totalDurationSeconds, legs };
}

function handleDirectionsFetchStart(): void {
  clearRouteLoadingFallback();
  routeLoading = true;
  routeMetrics = null;
  routeLoadingFallbackTimer = setTimeout(() => {
    routeLoadingFallbackTimer = null;
    if (!routeLoading) return;
    routeLoading = false;
    notifyDirectionsState();
  }, ROUTE_LOADING_FALLBACK_MS);
  notifyDirectionsState();
}

function handleDirectionsFetchEnd(event: { data: MapLibreGlDirectionsRoutingData }): void {
  clearRouteLoadingFallback();
  routeLoading = false;
  routeMetrics = extractDirectionsRouteMetrics(event.data.directions);
  notifyDirectionsState();
}

function handleDirectionsWaypointChange(): void {
  const count = getDirectionsWaypointCount();
  if (count < 2) {
    clearRouteLoadingFallback();
    routeLoading = false;
    routeMetrics = null;
  }
  notifyDirectionsState();
}

function attach(app: GeoLibreAppAPI): void {
  const map = app.getMap?.();
  if (!map) return;
  const token = ++loadToken;
  void import("@maplibre/maplibre-gl-directions")
    .then(({ default: DirectionsClass, LoadingIndicatorControl }) => {
      // Stale token means a newer attach()/teardown() superseded this import, so
      // discard it. The `|| directions` check is a defensive belt-and-braces:
      // every attach() bumps loadToken first, so a surviving token implies
      // directions is still null — but it guards against ever double-creating.
      if (token !== loadToken || directions) return;
      const currentMap = app.getMap?.();
      if (!currentMap) return;
      directions = new DirectionsClass(currentMap);
      // `interactive` is an instance setter, not a constructor config option in
      // this library version (it's absent from MapLibreGlDirectionsConfiguration).
      directions.interactive = true;
      directionsMap = currentMap;
      // Mirror the live waypoint count to any subscribed UI (the mode banner).
      // These events fire after the change is drawn, so the waypoints getter
      // already reflects the new state when notifyDirectionsState reads it.
      directions.on("addwaypoint", handleDirectionsWaypointChange);
      directions.on("removewaypoint", handleDirectionsWaypointChange);
      directions.on("setwaypoints", handleDirectionsWaypointChange);
      directions.on("fetchroutesstart", handleDirectionsFetchStart);
      directions.on("fetchroutesend", handleDirectionsFetchEnd);
      loadingControl = new LoadingIndicatorControl(directions);
      app.addMapControl(loadingControl, "top-right");
      // The instance now exists; nudge subscribers so a banner that mounted
      // before the lazy import resolved reads the (zeroed) count.
      notifyDirectionsState();
    })
    .catch((error) => {
      console.error("Directions plugin failed to load; it stays toggled on but inactive.", error);
    });
}

function teardown(app: GeoLibreAppAPI): void {
  // Invalidate any in-flight import so it doesn't reattach after teardown.
  ++loadToken;
  if (loadingControl) {
    app.removeMapControl(loadingControl);
    loadingControl = null;
  }
  // Detach our listeners before destroy() so teardown is self-contained and
  // does not rely on the library's destroy() also tearing down its emitter.
  directions?.off("addwaypoint", handleDirectionsWaypointChange);
  directions?.off("removewaypoint", handleDirectionsWaypointChange);
  directions?.off("setwaypoints", handleDirectionsWaypointChange);
  directions?.off("fetchroutesstart", handleDirectionsFetchStart);
  directions?.off("fetchroutesend", handleDirectionsFetchEnd);
  directions?.destroy();
  directions = null;
  directionsMap = null;
  // A removal can't be pending once the instance is gone; clear the flag so a
  // teardown mid-refetch doesn't leave the next session's button disabled.
  removalInFlight = false;
  clearRouteLoadingFallback();
  routeLoading = false;
  routeMetrics = null;
  // Reset the count subscribers see to 0 now the session is gone.
  notifyDirectionsState();
}

/**
 * Keep the directions tool bound to the current map after a map re-init.
 *
 * Mirrors `restoreEffects`: the desktop shell calls this after restoring plugin
 * state. Directions is off by default, so unlike the effects plugin it does not
 * need a first-load kick — this only matters when it is active and the map
 * object is replaced (a MapCanvas remount), where the manager would otherwise
 * leave the instance bound to the destroyed old map. Idempotent.
 */
export function restoreDirections(app: GeoLibreAppAPI, active: boolean): void {
  if (!active) {
    teardown(app);
    return;
  }
  const map = app.getMap?.();
  if (directions && directionsMap === map) return; // already bound to this map
  teardown(app);
  attach(app);
}

export const maplibreDirectionsPlugin: GeoLibrePlugin = {
  id: DIRECTIONS_PLUGIN_ID,
  name: "Directions",
  version: "1.0.0",
  activate: (app: GeoLibreAppAPI) => attach(app),
  deactivate: (app: GeoLibreAppAPI) => teardown(app),
};
