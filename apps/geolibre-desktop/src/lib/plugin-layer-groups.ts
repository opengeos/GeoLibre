import { useAppStore } from "@geolibre/core";

/**
 * The Layers-panel group (folder) half of the external plugin API: create a
 * group, move layers or whole groups between groups, and remove a group.
 *
 * Extracted from `usePlugins.ts` for the same reason as
 * `plugin-layer-queries.ts`: that module imports the entire built-in plugin
 * registry, so reaching these through `createAppAPI` in a unit test would mean
 * stubbing `maplibre-gl`, `window`, and `localStorage` and dragging dozens of
 * browser-only files into the coverage report. These need only the store.
 *
 * Unlike the queries, a typed spread is not enough to hold this wiring on its
 * own: every method on `GeoLibreAppAPI` is optional, so type checking would not
 * notice one of them going missing or being handed its arguments in the wrong
 * order. The store actions are covered by their own tests; what these need
 * covering for is the delegation itself.
 *
 * The signatures are deliberately narrower than the store's. `moveLayersToGroup`
 * drops `beforeLayerId` (a plugin has no panel position to anchor to), and
 * `removeLayerGroup` drops `options`, so a plugin can take a folder apart but
 * never delete the layers inside it.
 */
export function createPluginLayerGroupActions() {
  return {
    addLayerGroup: (name?: string, layerIds?: string[]) =>
      useAppStore.getState().addLayerGroup(name, layerIds),
    moveLayersToGroup: (layerIds: string[], groupId: string | null) =>
      useAppStore.getState().moveLayersToGroup(layerIds, groupId),
    // The group-of-groups counterpart of moveLayersToGroup (#2553). The store
    // action already refuses an unknown id and any move that would make a group
    // its own ancestor, so a plugin cannot cycle the tree through this.
    moveLayerGroupToGroup: (id: string, parentId: string | null) =>
      useAppStore.getState().moveLayerGroupToGroup(id, parentId),
    removeLayerGroup: (id: string) => useAppStore.getState().removeLayerGroup(id),
  };
}
