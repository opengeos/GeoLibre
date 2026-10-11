import { getRoutingConfig, requestNavigationRoute, RoutingRequestError } from "@geolibre/core";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { logNavigation } from "../../lib/navigation/log";
import { buildNavRouteRequest, parseNavRoutes, type NavRoute } from "../../lib/navigation/route";
import {
  boundsOf,
  planPadding,
  type NavPoint,
  type NavRouteStatus,
  type NavSettings,
} from "../../lib/navigation/session";

/** What the planner's route request reads and writes. */
export interface RouteRequestOptions {
  /** Ask only while planning; a drive manages its own route. */
  enabled: boolean;
  waypoints: (NavPoint | null)[];
  settings: NavSettings;
  language: string;
  imperial: boolean;
  getMap: () => maplibregl.Map | null;
  setRoutes: Dispatch<SetStateAction<NavRoute[]>>;
  setSelected: Dispatch<SetStateAction<number>>;
  setStatus: Dispatch<SetStateAction<NavRouteStatus>>;
  /** Called when a request comes back with at least one route. */
  onRoutesFound: () => void;
}

/**
 * Ask Valhalla for routes (with alternates) whenever every point is placed or
 * the mode, avoid options, language, or units change, then fit the map to them.
 * Requests are debounced, and a newer one supersedes an older one in flight.
 *
 * @param options - The planner's points, settings, map, and state setters.
 */
export function useRouteRequest({
  enabled,
  waypoints,
  settings,
  language,
  imperial,
  getMap,
  setRoutes,
  setSelected,
  setStatus,
  onRoutesFound,
}: RouteRequestOptions): void {
  const onRoutesFoundRef = useRef(onRoutesFound);
  onRoutesFoundRef.current = onRoutesFound;
  const complete = waypoints.every((w): w is NavPoint => w !== null);
  const waypointKey = waypoints.map((w) => (w ? `${w.lng},${w.lat}` : "-")).join(";");
  const avoidKey = `${settings.avoid.tolls}${settings.avoid.highways}${settings.avoid.ferries}`;
  const routeRequestRef = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    if (!complete) {
      setRoutes([]);
      setStatus("idle");
      return;
    }
    const points = waypoints as NavPoint[];
    const controller = new AbortController();
    const token = ++routeRequestRef.current;
    setStatus("loading");
    const timer = setTimeout(() => {
      const body = buildNavRouteRequest({
        waypoints: points,
        mode: settings.mode,
        language,
        imperial,
        avoid: settings.avoid,
        alternates: 2,
      });
      requestNavigationRoute(getRoutingConfig().endpoint, body, controller.signal)
        .then((response) => {
          if (controller.signal.aborted || token !== routeRequestRef.current) return;
          const parsed = parseNavRoutes(response, settings.mode);
          setRoutes(parsed);
          setSelected(0);
          setStatus(parsed.length > 0 ? "idle" : "noRoute");
          if (parsed.length > 0) onRoutesFoundRef.current();
          const bounds = boundsOf(parsed.flatMap((r) => r.coordinates));
          const map = getMap();
          if (bounds && map) {
            const container = map.getContainer();
            const rtl = getComputedStyle(container).direction === "rtl";
            map.fitBounds(bounds, {
              padding: planPadding(container.clientWidth, rtl),
              maxZoom: 16,
              duration: 600,
            });
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || token !== routeRequestRef.current) return;
          setRoutes([]);
          // Valhalla answers 400 when it finds no path between the points.
          if (error instanceof RoutingRequestError && error.status === 400) setStatus("noRoute");
          else {
            logNavigation("Navigation route request failed.", error);
            setStatus("error");
          }
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // waypointKey and avoidKey stand in for the arrays they are built from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, complete, waypointKey, settings.mode, avoidKey, language, imperial, getMap]);
}
