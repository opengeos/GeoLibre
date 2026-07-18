import type { GeoLibreLayer, LayerGroup } from "./types";

/** Opacity a freshly created {@link LayerGroup} starts at (fully opaque). */
export const DEFAULT_LAYER_GROUP_OPACITY = 1;

/**
 * One row in the layer panel: either a top-level (ungrouped) layer or a group
 * header together with its child layers.
 */
export type LayerTreeItem =
  | { kind: "layer"; layer: GeoLibreLayer }
  | { kind: "group"; group: LayerGroup; children: GeoLibreLayer[] };

/**
 * Derive the layer-panel tree from the flat `layers` array and the group
 * definitions.
 *
 * Items are returned **top-of-panel first** (the reverse of the store's
 * render order, where the last array element draws on top). Within a group the
 * children are likewise ordered top-first. Each group is emitted once, at the
 * panel position of its top-most member; a group's members are normally
 * contiguous in the array, but if they are not, every member is still gathered
 * under a single header. Groups with no members (empty folders) are emitted at
 * the very top of the panel, in `groups` order, ready to receive drops.
 *
 * A `groupId` that does not match any group is treated as ungrouped, so a
 * dangling reference degrades gracefully instead of dropping the layer.
 *
 * @param layers Flat layer list in store (render) order.
 * @param groups Group definitions.
 * @returns Panel rows in top-to-bottom display order.
 */
export function buildLayerTree(layers: GeoLibreLayer[], groups: LayerGroup[]): LayerTreeItem[] {
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const display = [...layers].reverse();

  // Bucket every layer's children by group id in a single pass so emitting a
  // group is an O(1) lookup rather than a per-group filter over `display`.
  const childrenByGroupId = new Map<string, GeoLibreLayer[]>();
  for (const layer of display) {
    if (!layer.groupId || !groupById.has(layer.groupId)) continue;
    const bucket = childrenByGroupId.get(layer.groupId);
    if (bucket) bucket.push(layer);
    else childrenByGroupId.set(layer.groupId, [layer]);
  }

  const items: LayerTreeItem[] = [];
  const emitted = new Set<string>();

  for (const layer of display) {
    const group = layer.groupId ? groupById.get(layer.groupId) : undefined;
    if (!group) {
      items.push({ kind: "layer", layer });
      continue;
    }
    if (emitted.has(group.id)) continue;
    emitted.add(group.id);
    items.push({
      kind: "group",
      group,
      children: childrenByGroupId.get(group.id) ?? [],
    });
  }

  const emptyGroups = groups.filter((g) => !childrenByGroupId.has(g.id));
  if (emptyGroups.length === 0) return items;
  return [
    ...emptyGroups.map((group) => ({
      kind: "group" as const,
      group,
      children: [] as GeoLibreLayer[],
    })),
    ...items,
  ];
}

/**
 * Fold each group's visibility and opacity into its child layers so the map
 * sync can keep treating every layer independently.
 *
 * A child's effective visibility is its own `visible` ANDed with the group's,
 * and its effective opacity is its own multiplied by the group's. Layers
 * without a group (or with a dangling `groupId`) are returned unchanged, and
 * the original object reference is preserved whenever nothing changes so
 * downstream memoization stays cheap.
 *
 * @param layers Flat layer list.
 * @param groups Group definitions.
 * @returns Layers with group effects applied.
 */
export function applyGroupEffects(layers: GeoLibreLayer[], groups: LayerGroup[]): GeoLibreLayer[] {
  if (groups.length === 0) return layers;
  const groupById = new Map(groups.map((g) => [g.id, g]));
  return layers.map((layer) => {
    if (!layer.groupId) return layer;
    const group = groupById.get(layer.groupId);
    if (!group) return layer;
    const visible = layer.visible && group.visible;
    const opacity = layer.opacity * group.opacity;
    if (visible === layer.visible && opacity === layer.opacity) return layer;
    return { ...layer, visible, opacity };
  });
}

/**
 * Indices, in store order, of every layer that belongs to `groupId`.
 *
 * @param layers Flat layer list.
 * @param groupId Group whose members to locate.
 * @returns Ascending list of member indices (empty when the group has none).
 */
export function groupMemberIndices(layers: GeoLibreLayer[], groupId: string): number[] {
  const indices: number[] = [];
  for (let i = 0; i < layers.length; i++) {
    if (layers[i]?.groupId === groupId) indices.push(i);
  }
  return indices;
}

/**
 * Reorder `layers` so that every group's members form a single contiguous block,
 * preserving the relative order of layers within each group and of the
 * top-level items. The block for a group is anchored at the position of its
 * current bottom-most (first) member — the first member encountered iterating
 * from index 0, which renders at the bottom of the layer panel.
 *
 * Mutating store actions call this after assigning `groupId`s to restore the
 * contiguity invariant the rest of the system relies on.
 *
 * @param layers Flat layer list, possibly with interleaved group members.
 * @returns A new array with grouped layers made contiguous.
 */
export function normalizeGroupContiguity(layers: GeoLibreLayer[]): GeoLibreLayer[] {
  const result: GeoLibreLayer[] = [];
  const placed = new Set<string>();
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (placed.has(layer.id)) continue;
    if (!layer.groupId) {
      result.push(layer);
      placed.add(layer.id);
      continue;
    }
    // Pull in every remaining member of this group, in array order, so the
    // block is anchored at the first member encountered.
    for (let j = i; j < layers.length; j++) {
      const candidate = layers[j];
      if (candidate.groupId === layer.groupId && !placed.has(candidate.id)) {
        result.push(candidate);
        placed.add(candidate.id);
      }
    }
  }
  return result;
}
