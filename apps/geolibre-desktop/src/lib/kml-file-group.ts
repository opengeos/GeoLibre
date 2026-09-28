import { localFileName, useAppStore } from "@geolibre/core";

/** Whether an imported source path names a KML or KMZ file. */
export function isKmlSourcePath(path: string): boolean {
  return /\.km[lz]$/i.test(path);
}

/**
 * Gathers everything one KML/KMZ file added into a single group named after
 * the file (issue #2722).
 *
 * A KMZ can hold several placemarks, Folders, ground overlays, and models, and
 * each one lands in the Layers panel as its own row or Folder group. With a few
 * such files in a project it is no longer clear which rows came from which
 * file, and there is no single switch to hide or remove one file's contents.
 *
 * For each KML/KMZ source this finds the top-level items its layers ended up
 * in: a layer that sits in no group counts as itself, and a grouped layer
 * counts as the outermost group above it (a KML Folder, or a time-animation
 * group). When a file produced more than one such item they are moved under a
 * new group named after the file, keeping their order. A file that produced a
 * single layer or a single group is left alone, since wrapping it would only
 * add a level. Other formats are left alone too.
 *
 * A group keeps its own layers in one contiguous block, so a file whose loose
 * layers sit on both sides of one of its groups (e.g. static overlays above and
 * below a time-animation sequence) cannot be wrapped without changing which
 * layer draws on top. Such a file is left ungrouped rather than reordered.
 *
 * Call it after every layer and group of the import has been created.
 *
 * @param layerIdsBySource - Ids of every layer each source file added, keyed by
 *   the source path.
 * @returns The ids of the file groups created, keyed by source path.
 */
export function groupKmlLayersBySourceFile(
  layerIdsBySource: ReadonlyMap<string, readonly string[]>,
): Map<string, string> {
  const created = new Map<string, string>();
  for (const [path, layerIds] of layerIdsBySource) {
    if (!isKmlSourcePath(path)) continue;
    const { layers, layerGroups } = useAppStore.getState();
    const sourceIds = new Set(layerIds);
    const groupById = new Map(layerGroups.map((group) => [group.id, group]));

    const topLayerIds: string[] = [];
    const topGroupIds: string[] = [];
    // Whether each layer, in store (draw) order, is loose or inside a group,
    // to check the loose layers form one run a group can hold without
    // reordering them.
    const unitKinds: ("layer" | "group")[] = [];
    for (const layer of layers) {
      if (!sourceIds.has(layer.id)) continue;
      let groupId = layer.groupId && groupById.has(layer.groupId) ? layer.groupId : undefined;
      if (!groupId) {
        topLayerIds.push(layer.id);
        unitKinds.push("layer");
        continue;
      }
      // Walk to the outermost group; `visited` stops a malformed parent cycle.
      const visited = new Set<string>();
      while (!visited.has(groupId)) {
        visited.add(groupId);
        const parentId: string | undefined = groupById.get(groupId)?.parentId;
        if (!parentId || !groupById.has(parentId)) break;
        groupId = parentId;
      }
      if (!topGroupIds.includes(groupId)) topGroupIds.push(groupId);
      // Recorded per layer, not once per group: a Folder's subtree can occur
      // in more than one stretch, and each one would split the loose run.
      unitKinds.push("group");
    }

    if (topLayerIds.length + topGroupIds.length < 2) continue;
    const firstLoose = unitKinds.indexOf("layer");
    const lastLoose = unitKinds.lastIndexOf("layer");
    if (firstLoose >= 0 && lastLoose - firstLoose + 1 !== topLayerIds.length) continue;
    const store = useAppStore.getState();
    const fileGroupId = store.addLayerGroup(localFileName(path), topLayerIds);
    for (const groupId of topGroupIds) store.moveLayerGroupToGroup(groupId, fileGroupId);
    created.set(path, fileGroupId);
  }
  return created;
}
