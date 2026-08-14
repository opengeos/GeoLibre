import { useAppStore } from "@geolibre/core";
import { SKETCHES_SOURCE_KIND } from "@geolibre/plugins/geo-editor-geometry";
import type { GeoLibreSelection } from "@geolibre/plugins";

/**
 * The read-only half of the external plugin API: everything a plugin may ask
 * about the layers currently on the map, and nothing that writes to them.
 *
 * Kept out of `usePlugins.ts` on purpose. That module imports the whole
 * built-in plugin registry (and through it MapCanvas, CesiumCanvas, and every
 * `maplibre-*` plugin), so a unit test reaching these queries through
 * `createAppAPI` had to stub `maplibre-gl`, `window`, and `localStorage` just
 * to load the module, and dragged 39 browser-only files into the coverage
 * report along the way. These functions need only the store, so they live
 * here and `createAppAPI` spreads them in. Same reasoning as
 * `geo-editor-geometry.ts` in `@geolibre/plugins`.
 *
 * Every accessor hands back a `structuredClone`, so a plugin holding a
 * returned feature cannot reach into store state and mutate it.
 */

/** The current selection as plugins see it: the layer id and its selected features. */
export function readPluginSelection(): GeoLibreSelection {
  const state = useAppStore.getState();
  const layer = state.layers.find((item) => item.id === state.selectedLayerId);
  if (!layer || state.selectedFeatureIds.length === 0) {
    return { layerId: state.selectedLayerId, features: [] };
  }
  const selected = new Set(state.selectedFeatureIds);
  const features = structuredClone(
    (layer.geojson?.features ?? []).filter((feature, index) =>
      selected.has(String(feature.id ?? index)),
    ),
  );
  return { layerId: state.selectedLayerId, features };
}

/**
 * Build the read-only query methods that `createAppAPI` exposes to plugins.
 * Reads the store on every call rather than closing over a snapshot, so a
 * plugin holding the API sees the map as it is now.
 */
export function createPluginLayerQueries() {
  return {
    listLayers: () =>
      useAppStore.getState().layers.map(({ id, name, type, visible, opacity }) => ({
        id,
        name,
        type,
        visible,
        opacity,
      })),
    getLayerFeatures: (layerId: string) => {
      const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
      if (!layer) throw new Error(`No layer with id "${layerId}"`);
      return structuredClone(layer.geojson?.features ?? []);
    },
    getSelectedFeatures: () => readPluginSelection().features,
    getSelectedLayerId: () => useAppStore.getState().selectedLayerId,
    getDrawnFeatures: () =>
      structuredClone(
        useAppStore
          .getState()
          .layers.flatMap((layer) =>
            layer.metadata.sourceKind === SKETCHES_SOURCE_KIND
              ? (layer.geojson?.features ?? [])
              : [],
          ),
      ),
    onSelectionChange: (callback: (selection: GeoLibreSelection) => void) =>
      useAppStore.subscribe((state, previous) => {
        if (
          state.selectedLayerId !== previous.selectedLayerId ||
          state.selectedFeatureIds !== previous.selectedFeatureIds
        ) {
          callback(readPluginSelection());
        }
      }),
  };
}
