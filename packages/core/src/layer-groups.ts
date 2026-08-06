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
 * One top-level block of the layer panel, in top-of-panel-first order: either a
 * single ungrouped layer or the contiguous run of layers a group owns.
 *
 * A group that owns no layer anywhere beneath it still gets a unit, with an
 * empty `layers` array, so that empty folders have a position in the panel and
 * can be reordered like any other row.
 */
export type LayerPanelUnit = {
  /** Group the block belongs to, or `null` for a lone ungrouped layer. */
  groupId: string | null;
  /** Member layers, top-first. Empty for a group with no layers under it. */
  layers: GeoLibreLayer[];
};

/**
 * The group a group is really nested under: its `parentId`, or `null` when it
 * is top-level or its `parentId` points at a group that no longer exists. Every
 * placement rule reads the parent through here so a dangling reference behaves
 * like a top-level folder rather than falling into a branch of the tree that is
 * not there.
 */
function effectiveParentId(
  group: LayerGroup | undefined,
  groupById: ReadonlyMap<string, LayerGroup>,
): string | null {
  const parentId = group?.parentId;
  return parentId && groupById.has(parentId) ? parentId : null;
}

/**
 * Panel index range `[first, last]` each group spans, keyed by group id. A
 * group with no unit of its own (an organizer whose layers all live in child
 * groups) spans the union of its descendants' units, so it is absent only when
 * nothing under it has a position yet.
 */
function groupUnitRanges(
  units: LayerPanelUnit[],
  groupById: ReadonlyMap<string, LayerGroup>,
): Map<string, [number, number]> {
  const ranges = new Map<string, [number, number]>();
  units.forEach((unit, index) => {
    let id: string | null = unit.groupId;
    const visited = new Set<string>();
    while (id && !visited.has(id)) {
      visited.add(id);
      const range = ranges.get(id);
      if (range) ranges.set(id, [Math.min(range[0], index), Math.max(range[1], index)]);
      else ranges.set(id, [index, index]);
      // A dangling `parentId` ends the walk rather than recording a range for a
      // group that does not exist.
      id = effectiveParentId(groupById.get(id), groupById);
    }
  });
  return ranges;
}

/**
 * Group indices ordered so that a group's parent always comes first, keeping
 * the `groups` order otherwise. `moveLayerGroupToGroup` reparents in place
 * without touching the array, so a child can sit ahead of its own parent; a
 * parent has to be placed first for the child to have a block to sit under.
 * A `parentId` cycle never resolves, so what is left is emitted in array order
 * rather than dropped.
 */
function parentsFirstOrder(
  groups: LayerGroup[],
  groupById: ReadonlyMap<string, LayerGroup>,
): number[] {
  const order: number[] = [];
  const placed = new Set<string>();
  let pending = groups.map((_, index) => index);
  while (pending.length > 0) {
    const deferred: number[] = [];
    for (const index of pending) {
      const parentId = groups[index].parentId;
      if (parentId && groupById.has(parentId) && !placed.has(parentId)) deferred.push(index);
      else {
        order.push(index);
        placed.add(groups[index].id);
      }
    }
    if (deferred.length === pending.length) {
      order.push(...deferred);
      break;
    }
    pending = deferred;
  }
  return order;
}

/**
 * Split the panel into its top-level blocks, **top-of-panel first** (the
 * reverse of the store's render order, where the last array element draws on
 * top).
 *
 * Layers give every populated group a position of its own. A group with no
 * layers under it has none to derive, so it is slotted in next to its
 * **siblings** — the groups sharing its parent — in `groups` order: directly
 * below the nearest sibling above it in that array, else directly above the
 * nearest one below it. Because the neighbours are read from `groups` rather
 * than from the layer array, a folder keeps its place relative to its siblings
 * when one of them gains its first layer (GeoLibre#1739).
 *
 * Only a sibling can place it. An ancestor's range already contains the slot
 * being chosen, and an unrelated group's range covers a different branch of the
 * tree, so anchoring on either drops the folder into someone else's block —
 * which is how a nested folder used to land outside its own parent once a
 * cousin gained a layer (GeoLibre#1739 follow-up). With no sibling positioned
 * yet, a nested folder falls to the end of its parent's block and a top-level
 * one to the top of the panel.
 *
 * An *organizer* — a group with no layers of its own but with some beneath it —
 * gets no block here: the panel draws its header against its top-most
 * descendant layer instead. Only a group whose whole subtree is empty needs one.
 *
 * A `groupId` that does not match any group is treated as ungrouped, so a
 * dangling reference degrades gracefully instead of dropping the layer.
 *
 * @param layers Flat layer list in store (render) order.
 * @param groups Group definitions.
 * @returns Panel blocks in top-to-bottom display order.
 */
export function buildLayerPanelUnits(
  layers: GeoLibreLayer[],
  groups: LayerGroup[],
): LayerPanelUnit[] {
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const units: LayerPanelUnit[] = [];
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    const groupId = layer.groupId && groupById.has(layer.groupId) ? layer.groupId : null;
    const last = units[units.length - 1];
    if (groupId && last && last.groupId === groupId) last.layers.push(layer);
    else units.push({ groupId, layers: [layer] });
  }

  let ranges = groupUnitRanges(units, groupById);
  // Every group a layer reaches — the ones that own a block and the organizers
  // spanning them — already has a position. `ranges` alone cannot stand in for
  // that set once the loop starts: splicing a folder in gives its ancestors an
  // inherited range too, and an ancestor whose subtree holds no layer still
  // needs a block of its own or it renders nowhere at all.
  const positioned = new Set(ranges.keys());
  if (positioned.size === groups.length) return units;
  for (const at of parentsFirstOrder(groups, groupById)) {
    const group = groups[at];
    if (positioned.has(group.id)) continue;
    const parentId = effectiveParentId(group, groupById);
    const isSibling = (other: LayerGroup) => effectiveParentId(other, groupById) === parentId;
    let insertAt: number | undefined;
    for (let i = at - 1; insertAt === undefined && i >= 0; i--) {
      if (!isSibling(groups[i])) continue;
      const range = ranges.get(groups[i].id);
      if (range) insertAt = range[1] + 1;
    }
    for (let i = at + 1; insertAt === undefined && i < groups.length; i++) {
      if (!isSibling(groups[i])) continue;
      const range = ranges.get(groups[i].id);
      if (range) insertAt = range[0];
    }
    // No sibling to sit beside: stay inside the parent's block rather than
    // drifting to the top of the panel past groups this one is nested in.
    if (insertAt === undefined && parentId) insertAt = (ranges.get(parentId)?.[1] ?? -1) + 1;
    units.splice(insertAt ?? 0, 0, { groupId: group.id, layers: [] });
    positioned.add(group.id);
    // Placing this folder shifts the units below it, and makes the folder
    // itself an anchor for the ones still to be placed.
    ranges = groupUnitRanges(units, groupById);
  }
  return units;
}

/**
 * Where the layer panel should draw every group header, expressed against the
 * layer rows the panel already renders.
 */
export type LayerPanelGroupHeaders = {
  /** Headers drawn immediately above the keyed layer's row, in panel order. */
  aboveLayer: Map<string, LayerGroup[]>;
  /** Headers drawn below every layer row, in panel order. */
  bottom: LayerGroup[];
};

/**
 * Resolve {@link buildLayerPanelUnits} into a draw position for each group
 * header, so a panel that renders row by row from the flat layer list can place
 * them without rebuilding its whole render as a tree.
 *
 * Every header comes from the one walk: the group a layer belongs to, the
 * *organizers* above it whose own layers all live in child groups, and the
 * folders holding no layer at all. Deriving them together is what keeps them in
 * order — each is emitted the first time the walk reaches its subtree, parents
 * ahead of children, so a nested folder can never be drawn above the parent it
 * sits inside (GeoLibre#1739 follow-up).
 *
 * A group is emitted once, at its top-most block, so a group whose members are
 * scattered still gets a single header.
 *
 * @param layers Flat layer list in store (render) order.
 * @param groups Group definitions.
 * @returns The anchor layer (or the panel bottom) each header sits above.
 */
export function layerPanelGroupHeaders(
  layers: GeoLibreLayer[],
  groups: LayerGroup[],
): LayerPanelGroupHeaders {
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const units = buildLayerPanelUnits(layers, groups);
  const aboveLayer = new Map<string, LayerGroup[]>();
  const bottom: LayerGroup[] = [];
  const drawn = new Set<string>();
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (!unit.groupId) continue;
    // Walk up to the root and reverse, so an ancestor's header precedes the
    // headers of everything nested in it. A `parentId` cycle stops the walk
    // instead of hanging.
    const chain: LayerGroup[] = [];
    let id: string | null = unit.groupId;
    const visited = new Set<string>();
    while (id && !visited.has(id) && !drawn.has(id)) {
      visited.add(id);
      const group = groupById.get(id);
      if (!group) break;
      chain.unshift(group);
      id = effectiveParentId(group, groupById);
    }
    if (chain.length === 0) continue;
    // The block's own first layer anchors it; a folder with none borrows the
    // first layer below it, and falls to the panel bottom when there is none.
    let anchorId = unit.layers[0]?.id;
    for (let j = i + 1; anchorId === undefined && j < units.length; j++) {
      anchorId = units[j].layers[0]?.id;
    }
    for (const group of chain) drawn.add(group.id);
    if (anchorId === undefined) {
      bottom.push(...chain);
      continue;
    }
    const at = aboveLayer.get(anchorId);
    if (at) at.push(...chain);
    else aboveLayer.set(anchorId, chain);
  }
  return { aboveLayer, bottom };
}

/**
 * Derive the layer-panel tree from the flat `layers` array and the group
 * definitions.
 *
 * Items are returned **top-of-panel first** (the reverse of the store's
 * render order, where the last array element draws on top). Within a group the
 * children are likewise ordered top-first. Each group is emitted once, at the
 * panel position of its top-most member; a group's members are normally
 * contiguous in the array, but if they are not, every member is still gathered
 * under a single header. Groups with no members (empty folders) sit where
 * {@link buildLayerPanelUnits} places them.
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
  const items: LayerTreeItem[] = [];
  const emittedAt = new Map<string, LayerTreeItem & { kind: "group" }>();

  for (const unit of buildLayerPanelUnits(layers, groups)) {
    const group = unit.groupId ? groupById.get(unit.groupId) : undefined;
    if (!group) {
      for (const layer of unit.layers) items.push({ kind: "layer", layer });
      continue;
    }
    // A group's members are normally one contiguous run, but a scattered group
    // still gets a single header, at its top-most member.
    const existing = emittedAt.get(group.id);
    if (existing) {
      existing.children.push(...unit.layers);
      continue;
    }
    const item = { kind: "group" as const, group, children: [...unit.layers] };
    emittedAt.set(group.id, item);
    items.push(item);
  }
  return items;
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
    if (!layer.groupId || !groupById.has(layer.groupId)) return layer;
    const { visible, opacity } = foldGroupChain(layer, groupById);
    if (visible === layer.visible && opacity === layer.opacity) return layer;
    return { ...layer, visible, opacity };
  });
}

/**
 * Walk a layer's group chain upward, ANDing each group's visibility into the
 * layer's own and multiplying each group's opacity into it. The `visited` set
 * makes a corrupted `parentId` cycle terminate instead of hanging.
 */
function foldGroupChain(
  layer: GeoLibreLayer,
  groupById: ReadonlyMap<string, LayerGroup>,
): { visible: boolean; opacity: number } {
  let visible = layer.visible;
  let opacity = layer.opacity;
  let group = layer.groupId ? groupById.get(layer.groupId) : undefined;
  const visited = new Set<string>();
  while (group && !visited.has(group.id)) {
    visited.add(group.id);
    visible = visible && group.visible;
    opacity *= group.opacity;
    group = group.parentId ? groupById.get(group.parentId) : undefined;
  }
  return { visible, opacity };
}

/**
 * The single layer form of {@link applyGroupEffects}: the visibility and
 * opacity a layer should actually render at once its (possibly nested) parent
 * groups are folded in.
 *
 * Group state never mutates a child's own `visible`/`opacity` fields, so any
 * renderer that cannot read the folded array — a plugin control that owns its
 * own paint and is driven layer by layer — asks for a single layer here
 * instead.
 *
 * @param layer The layer to fold.
 * @param groups Group definitions, or an already-built id → group map. Callers
 *   in a render path that fold many layers against the same groups (the layer
 *   panel) should pass a memoized map, since the array form rebuilds one per
 *   call.
 * @returns The effective render state (the layer's own values when it is
 *   ungrouped or its `groupId` is dangling).
 */
export function effectiveLayerRenderState(
  layer: GeoLibreLayer,
  groups: LayerGroup[] | ReadonlyMap<string, LayerGroup>,
): { visible: boolean; opacity: number } {
  const size = Array.isArray(groups) ? groups.length : groups.size;
  if (size === 0 || !layer.groupId) {
    return { visible: layer.visible, opacity: layer.opacity };
  }
  return foldGroupChain(
    layer,
    Array.isArray(groups) ? new Map(groups.map((g) => [g.id, g])) : groups,
  );
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

/**
 * Which of `parentId`'s own blocks a panel unit belongs to, used to move a group
 * only among the blocks it shares a parent with:
 *
 * - the id of the child of `parentId` the unit is nested in, however deep — the
 *   sibling block a move steps over, or the moving group's own block;
 * - `parentId` itself when the unit holds that group's own layers: one more
 *   block inside the parent, which a child steps over like any other rather
 *   than a wall;
 * - `null` for an ungrouped layer at the root of the panel (`parentId` `null`);
 * - `undefined` when the unit sits outside `parentId` altogether — a wall,
 *   since a nested group has no position outside the parent holding it.
 *
 * A `parentId` cycle reads as outside rather than looping.
 */
function branchUnder(
  parentId: string | null,
  groupId: string | null,
  groupById: ReadonlyMap<string, LayerGroup>,
): string | null | undefined {
  if (groupId === null) return parentId === null ? null : undefined;
  if (groupId === parentId) return groupId;
  let id = groupId;
  const visited = new Set([id]);
  for (;;) {
    const next = effectiveParentId(groupById.get(id), groupById);
    if (next === parentId) return id;
    if (next === null || visited.has(next)) return undefined;
    visited.add(next);
    id = next;
  }
}

/**
 * How deeply a group is nested: 0 for a top-level folder, 1 for a child of one,
 * and so on. Drives the layer panel's indentation and keeps a parent ahead of
 * its children when a reorder re-sorts the group array. A corrupted `parentId`
 * cycle stops the walk instead of hanging.
 *
 * @param group Group to measure.
 * @param groupById Group lookup, so a caller folding many groups against the
 *   same set can pass a memoized map rather than rebuild one per call.
 * @returns The nesting depth.
 */
export function layerGroupDepth(
  group: LayerGroup,
  groupById: ReadonlyMap<string, LayerGroup>,
): number {
  let depth = 0;
  let parentId = group.parentId;
  const visited = new Set([group.id]);
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = groupById.get(parentId);
    if (!parent) break;
    depth += 1;
    parentId = parent.parentId;
  }
  return depth;
}

/**
 * Move a group — with everything nested inside it — one block up or down among
 * its siblings, the groups sharing its parent.
 *
 * A nested group moves inside its parent only: it steps over a whole sibling
 * block rather than into it, and the parent's boundary is the end of its
 * travel, so `null` comes back rather than a move that would take it out of the
 * folder holding it. Inside that boundary it steps over its parent's *own*
 * layers as readily as over a sibling folder, since those rows are one more
 * block of the parent and ordering a child against them is a real reorder. A
 * folder holding no layer is the exception: it has no way to record a position
 * between two layer rows, so a move that would only cross them changes nothing
 * and reports `null` — the same limit empty folders already have at the top
 * level. A top-level group moves among the other top-level groups and the
 * ungrouped layers.
 *
 * Both arrays carry part of the panel order, so both come back: `layers` holds
 * the order of every populated block, and `groups` holds the order the empty
 * folders are placed against (see {@link buildLayerPanelUnits}). Swapping two
 * folders that own no layers moves nothing in `layers`, and moving a populated
 * group past an empty one moves nothing but the group order, so a caller must
 * apply both.
 *
 * `normalizeGroupContiguity` keeps each *group's* own members together, but not
 * a whole *subtree*: nesting only rewrites `parentId`, so an unrelated block can
 * sit between two sibling child groups. The subtree still travels as one block —
 * "with everything nested inside it" — which means such an in-between block is
 * left behind on the other side of it, and the move can shift more than one row.
 * Compacting the subtree is the intended reading of the operation; the in-between
 * block landing on the far side is the accepted cost.
 *
 * @param layers Flat layer list in store (render) order.
 * @param groups Group definitions.
 * @param id Group to move.
 * @param direction `"up"` toward the top of the panel, `"down"` toward the
 *   bottom.
 * @returns The new arrays, or `null` when the group is already at that end of
 *   the panel and nothing would change.
 */
export function reorderLayerGroupInPanel(
  layers: GeoLibreLayer[],
  groups: LayerGroup[],
  id: string,
  direction: "up" | "down",
): { layers: GeoLibreLayer[]; groups: LayerGroup[] } | null {
  return moveGroupThroughUnits(buildLayerPanelUnits(layers, groups), layers, groups, id, direction);
}

/**
 * The body of {@link reorderLayerGroupInPanel}, against panel blocks the caller
 * already has, so asking about every group in turn splits the panel once rather
 * than once per question.
 */
function moveGroupThroughUnits(
  units: LayerPanelUnit[],
  layers: GeoLibreLayer[],
  groups: LayerGroup[],
  id: string,
  direction: "up" | "down",
): { layers: GeoLibreLayer[]; groups: LayerGroup[] } | null {
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const group = groupById.get(id);
  if (!group) return null;
  // Label every unit with the block it occupies among the moving group's own
  // siblings, so the move steps over a whole neighbouring block and stops at the
  // edge of the parent instead of stepping one unit at a time into it.
  const parentId = effectiveParentId(group, groupById);
  const branches = units.map((unit) => branchUnder(parentId, unit.groupId, groupById));
  const matching = new Set<number>();
  branches.forEach((branch, index) => {
    if (branch === id) matching.add(index);
  });
  if (matching.size === 0) return null;
  const indices = [...matching].sort((a, b) => a - b);
  // Units run top-first, so "up" steps over the block above the group's first.
  const neighbor = direction === "up" ? indices[0] - 1 : indices[indices.length - 1] + 1;
  if (neighbor < 0 || neighbor >= units.length) return null;
  const neighborBranch = branches[neighbor];
  // Outside the parent: the group is already at that end of its own block.
  if (neighborBranch === undefined) return null;
  // A neighbouring group travels whole, so the move clears everything nested in
  // it; an ungrouped layer is a block of one.
  const neighborUnits =
    neighborBranch === null
      ? [units[neighbor]]
      : units.filter((_, index) => branches[index] === neighborBranch);
  // The moving group's own indices need not be contiguous — sibling child groups
  // can straddle an unrelated block. Gathering them compacts the subtree, which
  // is the point of moving it as a whole; see `reorderLayerGroupInPanel`.
  const block = units.filter((_, index) => matching.has(index));
  const remaining = units.filter((_, index) => !matching.has(index));
  const edge =
    direction === "up"
      ? remaining.indexOf(neighborUnits[0])
      : remaining.indexOf(neighborUnits[neighborUnits.length - 1]) + 1;
  const reordered = [...remaining];
  reordered.splice(edge, 0, ...block);

  // Units are top-first and so are the layers inside them; the store keeps the
  // reverse, with the last element drawing on top.
  const nextLayers = reordered.flatMap((unit) => unit.layers).reverse();
  // Re-derive the group order from the new panel so the empty folders, which
  // are placed against it, follow the move. Ties (an organizer and the child
  // block it spans) keep parents first.
  const ranges = groupUnitRanges(reordered, groupById);
  const nextGroups = [...groups].sort((a, b) => {
    const byPosition = (ranges.get(a.id)?.[0] ?? 0) - (ranges.get(b.id)?.[0] ?? 0);
    return byPosition !== 0
      ? byPosition
      : layerGroupDepth(a, groupById) - layerGroupDepth(b, groupById);
  });
  const layersMoved = nextLayers.some((layer, index) => layer.id !== layers[index]?.id);
  const groupsMoved = nextGroups.some((group, index) => group.id !== groups[index]?.id);
  if (!layersMoved && !groupsMoved) return null;
  return { layers: nextLayers, groups: nextGroups };
}

/**
 * Which directions {@link reorderLayerGroupInPanel} can actually move each
 * group, so the layer panel can disable a menu item that would do nothing.
 *
 * @param layers Flat layer list in store (render) order.
 * @param groups Group definitions.
 * @returns Per-group flags, keyed by group id.
 */
export function layerGroupMoveability(
  layers: GeoLibreLayer[],
  groups: LayerGroup[],
): Map<string, { up: boolean; down: boolean }> {
  const units = buildLayerPanelUnits(layers, groups);
  const result = new Map<string, { up: boolean; down: boolean }>();
  for (const group of groups) {
    result.set(group.id, {
      up: moveGroupThroughUnits(units, layers, groups, group.id, "up") !== null,
      down: moveGroupThroughUnits(units, layers, groups, group.id, "down") !== null,
    });
  }
  return result;
}
