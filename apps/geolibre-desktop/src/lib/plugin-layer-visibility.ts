import { useAppStore } from "@geolibre/core";

/**
 * The layer-visibility half of the external plugin API: show or hide a layer the
 * way the Layers panel's eye button does, so the panel and the map stay in step.
 *
 * Plugins could already read `visible` through `listLayers`, and the embed API and
 * the AI Assistant could already set it (`setLayerVisibility`, `set_layer_visibility`).
 * Without this, a plugin that wants to hide one of its own layers after a step (for
 * example a raster it has just vectorised) could only hide the MapLibre layer behind
 * the store's back, leaving the eye icon wrong until the next sync undid it.
 *
 * Extracted from `usePlugins.ts` for the same reason as `plugin-layer-groups.ts`:
 * this needs only the store, and a unit test should not have to load the built-in
 * plugin registry to reach it.
 */
export function createPluginLayerVisibilityActions() {
  return {
    setLayerVisibility: (layerId: string, visible: boolean): void => {
      // Plugins can be untyped JavaScript: a string such as "false" is truthy and would leave
      // a non-boolean in layer state, so refuse it as the embed API does.
      if (typeof visible !== "boolean") {
        throw new TypeError("setLayerVisibility: visible must be a boolean");
      }
      const state = useAppStore.getState();
      if (!state.layers.some((layer) => layer.id === layerId)) {
        throw new Error(`No layer with id "${layerId}"`);
      }
      state.setLayerVisibility(layerId, visible);
    },
  };
}
