/**
 * Drives the on-map Legend panel from the currently VISIBLE layers' symbology.
 *
 * The Legend control, its toggle, and `openLegendPanelWithItems` already exist
 * (used by the raster palette UIs); what was missing is a reactive feed. While
 * the panel is open, this hook recomputes the legend from the store on every
 * layer change (add/remove, visibility, rename, restyle) and pushes it in — so
 * items appear and disappear as layers are shown and hidden, like GeoLens.
 */
import { useAppStore } from "@geolibre/core";
import { openLegendPanelWithItems } from "@geolibre/plugins";
import { useEffect } from "react";
import type { createAppAPI } from "./usePlugins";
import { autoLegendItems } from "../lib/layer-swatch";

/**
 * Keep the Legend panel in sync with the visible layers while it is open.
 *
 * @param app - The host app API (stably memoized by the caller).
 * @param active - Whether the Legend panel is currently visible.
 * @param title - Panel title (reuse the existing "Legend" i18n string).
 */
export function useAutoLegend(
  app: ReturnType<typeof createAppAPI>,
  active: boolean,
  title: string,
): void {
  const layers = useAppStore((state) => state.layers);

  useEffect(() => {
    if (!active) return;
    // A per-run token so a superseded update (rapid visibility toggles) can't
    // clobber a newer one — openLegendPanelWithItems honors the AbortSignal.
    const controller = new AbortController();
    void openLegendPanelWithItems(app, {
      title,
      items: autoLegendItems(layers),
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [app, active, title, layers]);
}
