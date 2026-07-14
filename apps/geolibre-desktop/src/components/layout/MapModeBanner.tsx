import {
  clearDirectionsWaypoints,
  getDirectionsRouteMetrics,
  DIRECTIONS_PLUGIN_ID,
  getDirectionsWaypointCount,
  isDirectionsRemovalInFlight,
  isDirectionsRouteLoading,
  removeLastDirectionsWaypoint,
  REVERSE_GEOCODE_PLUGIN_ID,
  subscribeDirectionsState,
} from "@geolibre/plugins";
import type { MapController } from "@geolibre/map";
import { Clock, MapPin, Navigation, Route, Trash2, Undo2, X } from "lucide-react";
import { type RefObject, useSyncExternalStore } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Button } from "@geolibre/ui";
import { createAppAPI, usePluginRegistry } from "../../hooks/usePlugins";

interface MapModeBannerProps {
  mapControllerRef: RefObject<MapController | null>;
}

function formatDistance(
  meters: number,
  locale: string,
  t: TFunction,
): string {
  if (meters >= 1000) {
    const value = new Intl.NumberFormat(locale, {
      maximumFractionDigits: meters >= 10000 ? 0 : 1,
    }).format(meters / 1000);
    return t("map.directionsMode.distanceKilometers", { value });
  }
  const value = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(meters);
  return t("map.directionsMode.distanceMeters", { value });
}

function formatDuration(
  seconds: number,
  locale: string,
  t: TFunction,
): string {
  if (seconds < 30) {
    return t("map.directionsMode.durationLessThanMinute");
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) {
    const value = new Intl.NumberFormat(locale).format(minutes);
    return t("map.directionsMode.durationMinutes", { value });
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  const formattedHours = new Intl.NumberFormat(locale).format(hours);
  if (remainder > 0) {
    const formattedMinutes = new Intl.NumberFormat(locale).format(remainder);
    return t("map.directionsMode.durationHoursMinutes", {
      hours: formattedHours,
      minutes: formattedMinutes,
    });
  }
  return t("map.directionsMode.durationHours", { value: formattedHours });
}

/**
 * Persistent banner shown over the map while a click-to-interact tool
 * (Directions or Reverse Geocode) is active. These tools have no layer or
 * panel of their own, so without a banner the map looks identical to the
 * normal view and users have no cue that clicks now place waypoints or run a
 * lookup, nor an obvious way to undo a misclick or leave the mode (issue #784).
 *
 * The banner explains the active mode and offers inline controls: for
 * Directions, remove the last waypoint or clear them all; for either mode, an
 * Exit button that toggles the plugin off. Routes are recalculated
 * automatically as waypoints change, so no manual "calculate" action is needed.
 */
export function MapModeBanner({ mapControllerRef }: MapModeBannerProps) {
  const { i18n, t } = useTranslation();
  const { isActive, toggle } = usePluginRegistry();

  // Live waypoint count, so the remove/clear actions can disable themselves
  // when there is nothing to act on.
  const waypointCount = useSyncExternalStore(
    subscribeDirectionsState,
    getDirectionsWaypointCount,
    getDirectionsWaypointCount,
  );
  // Disable "Remove last" while a removal awaits its route refetch, so rapid
  // clicks can't queue concurrent calls against a stale waypoint count.
  const removalInFlight = useSyncExternalStore(
    subscribeDirectionsState,
    isDirectionsRemovalInFlight,
    isDirectionsRemovalInFlight,
  );
  const routeMetrics = useSyncExternalStore(
    subscribeDirectionsState,
    getDirectionsRouteMetrics,
    getDirectionsRouteMetrics,
  );
  const routeLoading = useSyncExternalStore(
    subscribeDirectionsState,
    isDirectionsRouteLoading,
    isDirectionsRouteLoading,
  );

  const directionsActive = isActive(DIRECTIONS_PLUGIN_ID);
  const reverseGeocodeActive = isActive(REVERSE_GEOCODE_PLUGIN_ID);

  if (!directionsActive && !reverseGeocodeActive) {
    return null;
  }

  const exit = (id: string) => toggle(id, createAppAPI(mapControllerRef));

  return (
    <div className="pointer-events-none absolute left-1/2 top-3 z-20 flex w-[min(92vw,30rem)] -translate-x-1/2 flex-col gap-2">
      {directionsActive ? (
        <div
          className="pointer-events-auto flex flex-col gap-2 rounded-md border bg-background/95 px-3 py-2 text-sm shadow-lg backdrop-blur-sm"
          role="region"
          aria-label={t("map.directionsMode.title")}
          data-testid="directions-mode-banner"
        >
          <div className="flex items-start gap-2">
            <Navigation
              className="mt-0.5 h-4 w-4 shrink-0 text-primary"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="font-medium">{t("map.directionsMode.title")}</p>
              <p className="text-xs text-muted-foreground">
                {t("map.directionsMode.hint")}
              </p>
            </div>
          </div>
          {/* Visually-hidden live region so screen readers are told when the
              waypoint controls become available (0 → 1) or empty again, since
              the only visual cue is the buttons' disabled state. */}
          {/* count: 0 resolves to the waypointCount_zero catalog key ("No
              waypoints placed yet"); i18next honours _zero for count === 0
              before falling through to _other, so that key is intentional. */}
          <span className="sr-only" aria-live="polite">
            {t("map.directionsMode.waypointCount", { count: waypointCount })}
          </span>
          {waypointCount >= 2 ? (
            <div
              className="rounded-md border bg-muted/30 p-2"
              aria-live="polite"
              aria-atomic="true"
              data-testid="directions-route-metrics"
            >
              {routeLoading ? (
                <p className="text-xs text-muted-foreground">
                  {t("map.directionsMode.calculating")}
                </p>
              ) : routeMetrics ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                        <Route className="h-3 w-3" aria-hidden="true" />
                        {t("map.directionsMode.totalDistance")}
                      </div>
                      <p className="truncate text-sm font-semibold">
                        {formatDistance(
                          routeMetrics.totalDistanceMeters,
                          i18n.language,
                          t,
                        )}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                        <Clock className="h-3 w-3" aria-hidden="true" />
                        {t("map.directionsMode.estimatedTime")}
                      </div>
                      <p className="truncate text-sm font-semibold">
                        {formatDuration(
                          routeMetrics.totalDurationSeconds,
                          i18n.language,
                          t,
                        )}
                      </p>
                    </div>
                  </div>
                  {routeMetrics.legs.length > 1 ? (
                    <div className="max-h-20 space-y-1 overflow-auto border-t pt-2 text-xs text-muted-foreground">
                      {routeMetrics.legs.map((leg, index) => (
                        <div
                          key={index}
                          className="flex items-center justify-between gap-3"
                        >
                          <span>
                            {t("map.directionsMode.segment", {
                              index: index + 1,
                            })}
                          </span>
                          <span className="shrink-0 tabular-nums">
                            {formatDistance(
                              leg.distanceMeters,
                              i18n.language,
                              t,
                            )}
                            {" / "}
                            {formatDuration(
                              leg.durationSeconds,
                              i18n.language,
                              t,
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t("map.directionsMode.metricsUnavailable")}
                </p>
              )}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={waypointCount === 0 || removalInFlight}
              onClick={removeLastDirectionsWaypoint}
            >
              <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
              {t("map.directionsMode.removeLast")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              // Unlike Remove last, Clear stays enabled during an in-flight
              // removal: clearDirectionsWaypoints() aborts the pending refetch
              // before clearing, so it is safe and lets the user dump waypoints
              // immediately rather than waiting for a route load to finish.
              disabled={waypointCount === 0}
              onClick={clearDirectionsWaypoints}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              {t("map.directionsMode.clear")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => exit(DIRECTIONS_PLUGIN_ID)}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              {t("map.directionsMode.exit")}
            </Button>
          </div>
        </div>
      ) : null}

      {reverseGeocodeActive ? (
        <div
          className="pointer-events-auto flex items-center gap-2 rounded-md border bg-background/95 px-3 py-2 text-sm shadow-lg backdrop-blur-sm"
          role="region"
          aria-label={t("map.reverseGeocodeMode.title")}
          data-testid="reverse-geocode-mode-banner"
        >
          <MapPin
            className="h-4 w-4 shrink-0 text-primary"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t("map.reverseGeocodeMode.title")}</p>
            <p className="text-xs text-muted-foreground">
              {t("map.reverseGeocodeMode.hint")}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => exit(REVERSE_GEOCODE_PLUGIN_ID)}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            {t("map.reverseGeocodeMode.exit")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
