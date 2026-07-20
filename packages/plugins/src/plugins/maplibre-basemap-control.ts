import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "../types";

export const BASEMAP_CONTROL_PLUGIN_ID = "maplibre-gl-basemap-control";

/**
 * User-facing strings the adapter-owned panel cannot translate itself. Defaults
 * are English; the desktop shell pushes translated values here because this
 * renderer-neutral descriptor has no direct access to react-i18next.
 */
export interface BasemapControlLabels {
  /**
   * Builds the confirmation shown before a style basemap replaces stacked raster
   * basemaps, given the style name and how many will be removed.
   */
  confirmStyleReplace: (basemapName: string, count: number) => string;
}

let labels: BasemapControlLabels = {
  confirmStyleReplace: (basemapName, count) =>
    count === 1
      ? `Switching to "${basemapName}" replaces the whole map style and will remove the stacked basemap you added. Continue?`
      : `Switching to "${basemapName}" replaces the whole map style and will remove the ${count} stacked basemaps you added. Continue?`,
};

/** Override the panel strings (called from the app layer with translated text). */
export function setBasemapControlLabels(next: Partial<BasemapControlLabels>): void {
  labels = { ...labels, ...next };
}

let position: GeoLibreMapControlPosition = "top-left";

function confirmStyleReplace(basemapName: string, count: number): boolean {
  // A sandboxed cross-origin iframe (e.g. the Jupyter embed) suppresses
  // confirm and returns false, which fails safe by keeping stacked basemaps.
  return (
    typeof window !== "undefined" && window.confirm(labels.confirmStyleReplace(basemapName, count))
  );
}

/** Renderer-neutral descriptor for the adapter-owned Basemap Control runtime. */
export const maplibreBasemapControlPlugin: GeoLibrePlugin = {
  id: BASEMAP_CONTROL_PLUGIN_ID,
  name: "Basemaps",
  version: "0.3.0",
  activate: (app: GeoLibreAppAPI, context) =>
    app.map.invoke("hosted-plugin.activate", {
      pluginId: BASEMAP_CONTROL_PLUGIN_ID,
      position,
      collapsed: context?.collapsed,
      confirmStyleReplace,
    }),
  deactivate: (app: GeoLibreAppAPI) => {
    app.map.invoke("hosted-plugin.deactivate", { pluginId: BASEMAP_CONTROL_PLUGIN_ID });
  },
  getMapControlPosition: () => position,
  setMapControlPosition: (app: GeoLibreAppAPI, nextPosition: GeoLibreMapControlPosition) => {
    position = nextPosition;
    const applied = app.map.invoke("hosted-plugin.set-position", {
      pluginId: BASEMAP_CONTROL_PLUGIN_ID,
      position: nextPosition,
    });
    return typeof applied === "boolean" ? applied : undefined;
  },
};
