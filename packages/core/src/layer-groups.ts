import type { GeoLibreLayer, LayerGroup } from "./types";

/** Opacity a freshly created {@link LayerGroup} starts at (fully opaque). */
export const DEFAULT_LAYER_GROUP_OPACITY = 1;

/**
 * One row in the layer panel: either a layer card or a group header together
 * with its recursively nested child items (layers and sub-groups).
 */
export type LayerTreeItem =
  | { kind: "layer"; layer: GeoLibreLayer }
  | { kind: "group"; group: LayerGroup; children: LayerTreeItem[] };

/**
 * Derive the layer-panel tree from the flat `layers` array and the group
 * definitions, supporting arbitrary nesting via `parentGroupId`.
 *
 * Items are returned **top-of-panel first** (the reverse of the store's
 * render order, where the last array element draws on top). Within a group the
 * children are likewise ordered top-first. Each group is emitted once, at the
 * panel position of its top-most (first encountered in display order)
 * descendant member.
 *
 * Empty top-level groups are pinned at the very top of the panel. Empty
 * sub-groups appear inside their parent's tree node.
 *
 * @param layers Flat layer list in store (render) order.
 * @param groups Group definitions.
 * @returns Panel rows in top-to-bottom display order.
 */
export function buildLayerTree(
  layers: GeoLibreLayer[],
  groups: LayerGroup[],
): LayerTreeItem[] {
  if (groups.length === 0) {
    return [...layers].reverse().map((layer) => ({ kind: "layer", layer }));
  }

  const groupById = new Map(groups.map((g) => [g.id, g]));
  const display = [...layers].reverse();

  // Direct child layers of each group (in display order, top-first).
  const childrenByGroupId = new Map<string, GeoLibreLayer[]>();
  for (const layer of display) {
    if (!layer.groupId || !groupById.has(layer.groupId)) continue;
    const bucket = childrenByGroupId.get(layer.groupId);
    if (bucket) bucket.push(layer);
    else childrenByGroupId.set(layer.groupId, [layer]);
  }

  // Direct child sub-groups keyed by parentGroupId (undefined = top-level).
  const subGroupsByParentId = new Map<string | undefined, LayerGroup[]>();
  for (const group of groups) {
    const key = group.parentGroupId;
    const bucket = subGroupsByParentId.get(key);
    if (bucket) bucket.push(group);
    else subGroupsByParentId.set(key, [group]);
  }

  // Position of a group's first descendant layer in `display`.
  const firstDescendantPos = new Map<string, number>();
  function computeFirstPos(groupId: string): number {
    const cached = firstDescendantPos.get(groupId);
    if (cached !== undefined) return cached;
    let min = Infinity;
    const childLayers = childrenByGroupId.get(groupId);
    if (childLayers) {
      for (const l of childLayers) {
        min = Math.min(min, display.indexOf(l));
      }
    }
    const subGroups = subGroupsByParentId.get(groupId);
    if (subGroups) {
      for (const sg of subGroups) {
        min = Math.min(min, computeFirstPos(sg.id));
      }
    }
    firstDescendantPos.set(groupId, min);
    return min;
  }

  function buildGroupItem(group: LayerGroup): LayerTreeItem {
    const directChildren = childrenByGroupId.get(group.id) ?? [];
    const subGroups = subGroupsByParentId.get(group.id) ?? [];

    const unsorted: Array<{ pos: number; item: LayerTreeItem }> = [];

    for (const layer of directChildren) {
      unsorted.push({
        pos: display.indexOf(layer),
        item: { kind: "layer", layer },
      });
    }
    for (const sg of subGroups) {
      unsorted.push({
        pos: computeFirstPos(sg.id),
        item: buildGroupItem(sg),
      });
    }

    unsorted.sort((a, b) => a.pos - b.pos);

    return {
      kind: "group",
      group,
      children: unsorted.map((u) => u.item),
    };
  }

  // Collect top-level items: ungrouped layers + top-level groups.
  const topLevelItems: Array<{ pos: number; item: LayerTreeItem }> = [];
  const emittedGroupIds = new Set<string>();

  for (const layer of display) {
    if (!layer.groupId || !groupById.has(layer.groupId)) {
      topLevelItems.push({ pos: display.indexOf(layer), item: { kind: "layer", layer } });
      continue;
    }
    let topId = layer.groupId;
    let parent = groupById.get(topId);
    while (parent?.parentGroupId && groupById.has(parent.parentGroupId)) {
      topId = parent.parentGroupId;
      parent = groupById.get(topId);
    }
    if (emittedGroupIds.has(topId)) continue;
    emittedGroupIds.add(topId);
    const topGroup = groupById.get(topId)!;
    topLevelItems.push({
      pos: computeFirstPos(topId),
      item: buildGroupItem(topGroup),
    });
  }

  // Emit any remaining top-level groups that weren't captured by the layer
  // loop (e.g. non-empty groups with sub-groups but no direct layers).
  const topLevelGroups = subGroupsByParentId.get(undefined) ?? [];
  for (const tg of topLevelGroups) {
    if (emittedGroupIds.has(tg.id)) continue;
    emittedGroupIds.add(tg.id);
    const pos = computeFirstPos(tg.id);
    const hasContent =
      (childrenByGroupId.get(tg.id)?.length ?? 0) > 0 ||
      (subGroupsByParentId.get(tg.id)?.length ?? 0) > 0;
    if (pos === Infinity && !hasContent) continue;
    topLevelItems.push({
      pos: pos === Infinity ? Number.MAX_SAFE_INTEGER : pos,
      item: buildGroupItem(tg),
    });
  }

  topLevelItems.sort((a, b) => a.pos - b.pos);

  // Truly empty top-level groups (no direct layers AND no sub-groups).
  const emptyTopGroups =
    subGroupsByParentId.get(undefined)?.filter((g) => {
      const hasLayers = (childrenByGroupId.get(g.id)?.length ?? 0) > 0;
      const hasSubs = (subGroupsByParentId.get(g.id)?.length ?? 0) > 0;
      return !hasLayers && !hasSubs;
    }) ?? [];

  const result: LayerTreeItem[] = [];

  for (const g of emptyTopGroups) {
    result.push({ kind: "group", group: g, children: [] });
  }

  for (const { item } of topLevelItems) {
    result.push(item);
  }

  return result;
}

/**
 * Fold group visibility and opacity into child layers, walking the full
 * ancestor chain so nested groups compound their effects.
 *
 * A child's effective visibility is its own `visible` ANDed with every
 * ancestor group's `visible`. Its effective opacity is its own multiplied by
 * every ancestor group's `opacity`. Layers without a group (or with a
 * dangling `groupId`) are returned unchanged, and the original object
 * reference is preserved whenever nothing changes.
 *
 * @param layers Flat layer list.
 * @param groups Group definitions.
 * @returns Layers with group effects applied.
 */
export function applyGroupEffects(
  layers: GeoLibreLayer[],
  groups: LayerGroup[],
): GeoLibreLayer[] {
  if (groups.length === 0) return layers;
  const groupById = new Map(groups.map((g) => [g.id, g]));
  return layers.map((layer) => {
    if (!layer.groupId) return layer;
    let gid: string | undefined = layer.groupId;
    let visible = layer.visible;
    let opacity = layer.opacity;
    while (gid) {
      const group = groupById.get(gid);
      if (!group) break;
      visible = visible && group.visible;
      opacity = opacity * group.opacity;
      gid = group.parentGroupId;
    }
    if (visible === layer.visible && opacity === layer.opacity) return layer;
    return { ...layer, visible, opacity };
  });
}

/**
 * Indices, in store order, of every layer whose `groupId` equals `groupId`
 * (direct children only, not descendants in nested sub-groups).
 *
 * @param layers Flat layer list.
 * @param groupId Group whose direct members to locate.
 * @returns Ascending list of member indices (empty when the group has none).
 */
export function groupMemberIndices(
  layers: GeoLibreLayer[],
  groupId: string,
): number[] {
  const indices: number[] = [];
  for (let i = 0; i < layers.length; i++) {
    if (layers[i]?.groupId === groupId) indices.push(i);
  }
  return indices;
}

/**
 * Return every descendant layer id for a group (direct children plus all
 * layers in nested sub-groups).
 */
function descendantLayerIds(
  groupId: string,
  layers: GeoLibreLayer[],
  groupById: Map<string, LayerGroup>,
): Set<string> {
  const ids = new Set<string>();
  const stack = [groupId];
  while (stack.length > 0) {
    const currentId = stack.pop()!;
    for (const layer of layers) {
      if (layer.groupId === currentId) ids.add(layer.id);
    }
    for (const g of groupById.values()) {
      if (g.parentGroupId === currentId) stack.push(g.id);
    }
  }
  return ids;
}

/**
 * Find the topmost ancestor group id for a given group by walking
 * parentGroupId links. Returns the input groupId if the group is top-level
 * or doesn't exist.
 */
export function topmostGroupId(
  groupId: string,
  groupById: Map<string, LayerGroup>,
): string {
  let current = groupId;
  let group = groupById.get(current);
  while (group?.parentGroupId && groupById.has(group.parentGroupId)) {
    current = group.parentGroupId;
    group = groupById.get(current);
  }
  return current;
}

/**
 * Reorder `layers` so that every group's members form a single contiguous block,
 * preserving the relative order of layers within each group and of the
 * top-level items. The block for a group is anchored at the position of its
 * current bottom-most (first) member — the first member encountered iterating
 * from index 0, which renders at the bottom of the layer panel.
 *
 * When `groups` is provided, nested groups are handled: for each top-level
 * group, all descendant layers (direct children and layers in nested
 * sub-groups) form one contiguous block.
 *
 * Mutating store actions call this after assigning `groupId`s to restore the
 * contiguity invariant the rest of the system relies on.
 *
 * @param layers Flat layer list, possibly with interleaved group members.
 * @param groups Group definitions (optional; needed for nesting support).
 * @returns A new array with grouped layers made contiguous.
 */
export function normalizeGroupContiguity(
  layers: GeoLibreLayer[],
  groups?: LayerGroup[],
): GeoLibreLayer[] {
  if (layers.length === 0) return [];

  // When groups are provided, handle nested hierarchy.
  if (groups && groups.length > 0) {
    const groupById = new Map(groups.map((g) => [g.id, g]));

    // For each top-level group, collect all descendant layer IDs.
    const descendantIdsByTopGroup = new Map<string, Set<string>>();
    for (const g of groups) {
      if (!g.parentGroupId) {
        descendantIdsByTopGroup.set(g.id, descendantLayerIds(g.id, layers, groupById));
      }
    }

    const result: GeoLibreLayer[] = [];
    const placed = new Set<string>();

    // Build ordered list of top-level units preserving array order.
    const topLevelUnits: Array<{
      topGroupId: string | null;
      descendantIds: Set<string>;
    }> = [];
    const seenTopGroup = new Set<string>();

    for (const layer of layers) {
      if (!layer.groupId || !groupById.has(layer.groupId)) {
        topLevelUnits.push({ topGroupId: null, descendantIds: new Set([layer.id]) });
        continue;
      }
      const topId = topmostGroupId(layer.groupId, groupById);
      if (seenTopGroup.has(topId)) continue;
      seenTopGroup.add(topId);
      topLevelUnits.push({
        topGroupId: topId,
        descendantIds: descendantIdsByTopGroup.get(topId) ?? new Set(),
      });
    }

    for (const unit of topLevelUnits) {
      for (const layer of layers) {
        if (placed.has(layer.id)) continue;
        if (unit.topGroupId === null) {
          if (layer.groupId) continue;
          result.push(layer);
          placed.add(layer.id);
        } else if (unit.descendantIds.has(layer.id)) {
          result.push(layer);
          placed.add(layer.id);
        }
      }
    }

    return result;
  }

  // Flat mode (backward compat): layers with same groupId form contiguous blocks.
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
