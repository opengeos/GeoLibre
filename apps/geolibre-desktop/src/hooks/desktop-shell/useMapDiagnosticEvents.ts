import { useAppStore } from "@geolibre/core";
import type { MapDiagnosticEvent } from "@geolibre/map";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { appendDiagnostic, observeNetworkResponses } from "../../lib/diagnostics";
import { createLayerFailureNotifier } from "../../lib/layer-failure-notifier";
import { mapDiagnosticLevel } from "../../lib/map-error-notification";

/**
 * Route map-engine diagnostic events and tile responses to Diagnostics and to
 * one layer-failure toast per layer per session.
 *
 * A broken tile source errors on every pan, so only the first notice per layer
 * is shown and the rest stay in Diagnostics. The notifier is created once, so
 * the "already told" record survives re-renders, language changes and renderer
 * swaps. MapLibre drops a 404 tile as "empty" before it becomes an error event,
 * so a layer whose every tile is missing is only visible in the observed
 * network responses, which also feed the notifier while the shell is mounted.
 *
 * Args:
 *   t: The active translation function; the latest one is used for each toast.
 *
 * Returns:
 *   The handler to pass as a map engine's `onMapDiagnosticEvent`.
 */
export function useMapDiagnosticEvents(t: TFunction): (event: MapDiagnosticEvent) => void {
  const translateRef = useRef(t);
  translateRef.current = t;
  const [layerFailureNotifier] = useState(() =>
    createLayerFailureNotifier({
      getLayers: () => useAppStore.getState().layers,
      t: (key, options) => String(translateRef.current(key as never, options as never)),
    }),
  );
  useEffect(
    () =>
      observeNetworkResponses((response) => layerFailureNotifier.handleNetworkResponse(response)),
    [layerFailureNotifier],
  );
  return useCallback(
    (event: MapDiagnosticEvent) => {
      const record = appendDiagnostic({
        category: "map",
        level: mapDiagnosticLevel(event),
        message: event.message,
        detail: event.detail,
        source: event.source,
        status: event.status,
        url: event.url,
      });
      layerFailureNotifier.handleMapEvent(event, record ?? undefined);
    },
    [layerFailureNotifier],
  );
}
