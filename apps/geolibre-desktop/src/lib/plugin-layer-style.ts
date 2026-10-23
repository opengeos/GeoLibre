import { isStyleLibraryTargetLayer, useAppStore } from "@geolibre/core";
import { importStyleText } from "@geolibre/map/style-import";
import type { GeoLibreImportLayerStyleResult } from "@geolibre/plugins";

/**
 * The layer-style half of the external plugin API: dress a layer with a style
 * written elsewhere (an OGC SLD, a QGIS QML, a Mapbox GL style), the way the
 * Layers panel's "Import style" does.
 *
 * Extracted from `usePlugins.ts` for the same reason as
 * `plugin-layer-queries.ts` and `plugin-layer-groups.ts`: that module imports
 * the entire built-in plugin registry, so a unit test reaching this through
 * `createAppAPI` would have to stub `maplibre-gl`, `window`, and
 * `localStorage`. This needs only the store and the pure style readers of
 * `@geolibre/map/style-import`.
 */
export function createPluginLayerStyleActions() {
  return {
    importLayerStyle: (layerId: string, text: string): GeoLibreImportLayerStyleResult => {
      const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
      if (!layer) throw new Error(`No layer with id "${layerId}"`);
      // The same gate as every other style-import entry point (Layers panel,
      // Style Manager, Style panel): a raster or tile layer would take the
      // vector fields into its saved style without drawing them.
      if (!isStyleLibraryTargetLayer(layer.type)) {
        return { ok: false, reason: "unsupported-layer", warnings: [] };
      }
      const imported = importStyleText(text);
      if (!imported.ok) return { ok: false, reason: imported.reason, warnings: imported.warnings };
      // Merged onto the layer's current style, as the Layers panel import does,
      // so fields the style does not describe keep their values.
      useAppStore.getState().updateLayer(layerId, { style: imported.apply(layer.style) });
      return { ok: true, warnings: imported.warnings };
    },
  };
}
