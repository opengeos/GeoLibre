import {
  clearDirectionsWaypoints,
  DIRECTIONS_PLUGIN_ID,
  getDirectionsWaypointCount,
  isDirectionsRemovalInFlight,
  removeLastDirectionsWaypoint,
  REVERSE_GEOCODE_PLUGIN_ID,
  subscribeDirectionsState,
} from "@geolibre/plugins";
import type { MapController } from "@geolibre/map";
import { MapPin, Navigation, Trash2, Undo2, X } from "lucide-react";
import { type RefObject, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@geolibre/ui";
import { createAppAPI, usePluginRegistry } from "../../hooks/usePlugins";

interface MapModeBannerProps {
  mapControllerRef: RefObject<MapController | null>;
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
  const { t } = useTranslation();
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
          <span className="sr-only" aria-live="polite">
            {t("map.directionsMode.waypointCount", { count: waypointCount })}
          </span>
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
