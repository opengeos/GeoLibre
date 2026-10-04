import {
  hydrateProjectLayer,
  normalizeGroupContiguity,
  type GeoLibreLayer,
  type GeoLibreProject,
  type LayerGroup,
} from "@geolibre/core";

/**
 * Build the layer list that results from restoring one layer from a project
 * snapshot, leaving every other layer as it is (Project History's "Restore
 * this layer", GeoLibre#2858).
 *
 * A layer still in the project is replaced wholesale by its snapshot record,
 * in place, so fields added since the snapshot (a filter, a popup) go away
 * too. A layer deleted since the snapshot is re-inserted directly below the
 * nearest layer that sat above it in the snapshot and still exists or, when
 * none does, directly above the nearest surviving layer that sat below it, so
 * it lands where it was relative to its surviving neighbours rather than
 * above layers added since. Group membership is kept only
 * when that group still exists, and group contiguity is re-established.
 *
 * @param current - The live store's layers and layer groups.
 * @param snapshot - The parsed snapshot project.
 * @param layerId - The id of the layer to restore.
 * @returns The new `layers` array, or `null` when the snapshot has no such layer.
 */
export function restoreLayerFromSnapshot(
  current: { layers: GeoLibreLayer[]; layerGroups: LayerGroup[] },
  snapshot: GeoLibreProject,
  layerId: string,
): GeoLibreLayer[] | null {
  const snapshotIndex = snapshot.layers.findIndex((layer) => layer.id === layerId);
  if (snapshotIndex < 0) return null;
  const hydrated = hydrateProjectLayer(snapshot, snapshot.layers[snapshotIndex]);
  const groupIds = new Set(current.layerGroups.map((group) => group.id));
  const restored: GeoLibreLayer =
    hydrated.groupId && !groupIds.has(hydrated.groupId)
      ? { ...hydrated, groupId: undefined }
      : hydrated;

  const existingIndex = current.layers.findIndex((layer) => layer.id === layerId);
  let layers: GeoLibreLayer[];
  if (existingIndex >= 0) {
    layers = current.layers.slice();
    layers[existingIndex] = restored;
  } else {
    const currentIndex = new Map(current.layers.map((layer, i) => [layer.id, i]));
    let insertAt: number | null = null;
    for (let i = snapshotIndex + 1; i < snapshot.layers.length && insertAt === null; i++) {
      const index = currentIndex.get(snapshot.layers[i].id);
      if (index !== undefined) insertAt = index;
    }
    for (let i = snapshotIndex - 1; i >= 0 && insertAt === null; i--) {
      const index = currentIndex.get(snapshot.layers[i].id);
      if (index !== undefined) insertAt = index + 1;
    }
    // No neighbour survives: put it on top, as a newly added layer would be.
    insertAt ??= current.layers.length;
    layers = [...current.layers.slice(0, insertAt), restored, ...current.layers.slice(insertAt)];
  }
  return normalizeGroupContiguity(layers);
}
