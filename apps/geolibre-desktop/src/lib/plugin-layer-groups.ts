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
    addLayerGroup: (name?: string, layerIds?: string[]) => {
      const reused = reusablePluginLayerGroup(name, layerIds);
      if (reused) {
        useAppStore.getState().moveLayersToGroup(layerIds ?? [], reused);
        return reused;
      }
      return useAppStore.getState().addLayerGroup(name, layerIds);
    },
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

/**
 * The id of an existing group a plugin's `addLayerGroup` call should land in
 * instead of creating a second folder of the same name, or null.
 *
 * A plugin builds its folder when it first adds its layers. Reopening a saved
 * project restores that folder with the layers in it, then reactivates the
 * plugin, which builds the folder again: the layers moved into the new copy
 * and the restored one stayed behind, empty (#3473). So a call that names its
 * layers reuses a same-named group holding nothing but (some of) those
 * layers. A group with anything else in it, a layer or a subgroup, is a
 * different folder that only shares the name, and is left alone; so is every
 * call that names no layers, which keeps creating a new group as before.
 *
 * @param name - The requested group name.
 * @param layerIds - The layers the plugin is putting in the group.
 * @returns The group id to reuse, or null to create a new group.
 */
export function reusablePluginLayerGroup(name?: string, layerIds?: string[]): string | null {
  const trimmed = name?.trim();
  if (!trimmed || !layerIds?.length) return null;
  const wanted = new Set(layerIds);
  const { layers, layerGroups } = useAppStore.getState();
  const candidates = layerGroups.filter(
    (group) =>
      group.name === trimmed &&
      !layerGroups.some((child) => child.parentId === group.id) &&
      layers.every((layer) => layer.groupId !== group.id || wanted.has(layer.id)),
  );
  // Prefer the folder that already holds the layers (the restored one) over
  // an empty namesake.
  const holding = candidates.find((group) => layers.some((layer) => layer.groupId === group.id));
  return (holding ?? candidates[0])?.id ?? null;
}
