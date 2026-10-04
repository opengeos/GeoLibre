/**
 * Turns map-engine errors and tile responses into at most one toast per layer
 * per session (issue #2858). A broken tile source errors on every pan, so the
 * first notice is enough; the rest stay in Diagnostics.
 *
 * Two inputs feed it, for every renderer:
 * - engine error events (`MapDiagnosticEvent`): MapLibre/Mapbox name the layer
 *   by source id, Cesium and ArcGIS by store layer id;
 * - completed `fetch` responses from the Diagnostics capture, which is the only
 *   place a tile 404 is visible on MapLibre (it drops 404 tile errors as
 *   "empty tile" before they become error events).
 */
import type { GeoLibreLayer } from "@geolibre/core";
import type { MapDiagnosticEvent } from "@geolibre/map";
import type { DiagnosticRecord, NetworkResponseObservation } from "./diagnostics";
import {
  layerForTileUrl,
  mapErrorNotice,
  tilesLookBroken,
  type LayerFailureNotice,
} from "./map-error-notification";
import { notify } from "./notify";

/** Translates a key with interpolation values (react-i18next's `t`). */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface LayerFailureNotifierOptions {
  /** Reads the store's current layers. */
  getLayers: () => readonly GeoLibreLayer[];
  t: Translate;
}

export interface LayerFailureNotifier {
  /**
   * Handles an engine error event that was already recorded in Diagnostics.
   *
   * @param event - The engine's error event.
   * @param diagnostic - The Diagnostics record written for it, which an error
   *   toast links to rather than writing a second one.
   */
  handleMapEvent(event: MapDiagnosticEvent, diagnostic?: DiagnosticRecord): void;
  /**
   * Counts a completed tile response toward its layer's health.
   *
   * @param response - A response the Diagnostics capture observed.
   */
  handleNetworkResponse(response: NetworkResponseObservation): void;
}

/** HTTP statuses a tile server answers for a tile that holds no data. */
const EMPTY_TILE_STATUSES = new Set([204, 404]);

/**
 * Creates a notifier. One instance lives as long as the shell, so "once per
 * layer" spans renderer swaps too.
 *
 * @param options - How to read layers and translate messages.
 * @returns The notifier.
 */
export function createLayerFailureNotifier(
  options: LayerFailureNotifierOptions,
): LayerFailureNotifier {
  const notified = new Set<string>();
  // Per-layer tile tallies from the network capture. A layer that has loaded
  // even one tile is a sparse set, never a broken one, so it stops counting.
  const tallies = new Map<string, { loaded: number; failed: number }>();

  const show = (notice: LayerFailureNotice, diagnostic?: DiagnosticRecord) => {
    const { layer } = notice;
    if (notified.has(layer.id)) return;
    notified.add(layer.id);
    const dedupeKey = `map-layer:${layer.id}`;
    const { t } = options;
    // The warnings stay up like the error does: the layer stays broken until
    // its URL or key is fixed, so the notice should not time out unread.
    if (notice.kind === "accessDenied") {
      notify.warning(t("notifications.layerAccessDenied", { name: layer.name }), {
        description: t("notifications.layerAccessDeniedHint", { status: notice.status ?? 403 }),
        dedupeKey,
        durationMs: null,
      });
    } else if (notice.kind === "tilesMissing") {
      notify.warning(t("notifications.layerTilesMissing", { name: layer.name }), {
        description: t("notifications.layerTilesMissingHint"),
        dedupeKey,
        durationMs: null,
      });
    } else {
      notify.error(t("notifications.layerLoadFailed", { name: layer.name }), {
        description: t("notifications.layerLoadFailedHint"),
        dedupeKey,
        diagnostic,
      });
    }
  };

  return {
    handleMapEvent(event, diagnostic) {
      const notice = mapErrorNotice(event, options.getLayers());
      if (notice) show(notice, diagnostic);
    },
    handleNetworkResponse({ url, status }) {
      const ok = status >= 200 && status < 300 && status !== 204;
      const denied = status === 401 || status === 403;
      if (!ok && !denied && !EMPTY_TILE_STATUSES.has(status)) return;
      const layer = layerForTileUrl(url, options.getLayers());
      if (!layer || notified.has(layer.id)) return;
      if (denied) {
        show({ layer, kind: "accessDenied", status });
        return;
      }
      const tally = tallies.get(layer.id) ?? { loaded: 0, failed: 0 };
      if (tally.loaded > 0) return;
      if (ok) tally.loaded += 1;
      else tally.failed += 1;
      tallies.set(layer.id, tally);
      if (tilesLookBroken(tally)) show({ layer, kind: "tilesMissing" });
    },
  };
}
