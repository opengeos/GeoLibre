/**
 * Layer-panel folders: create, rename, nest, reorder, sort and delete groups,
 * and move layers between them. `layerGroups` is tracked by undo history
 * except for the `collapsed` flag (see `undo-history.ts`).
 */
import { v4 as uuidv4 } from "uuid";
import {
  DEFAULT_LAYER_GROUP_OPACITY,
  normalizeGroupContiguity,
  reorderLayerGroupInPanel,
  sortLayerGroupInPanel,
  type LayerGroupSortOrder,
} from "../layer-groups";
import {
  scrubCommentsForRemovedLayers,
  scrubLegendForRemovedLayers,
  scrubWidgetsForRemovedLayers,
} from "../layer-ref-scrub";
import { scrubPrintLayoutForRemovedLayers } from "../print-layout-config";
import type { LayerGroup } from "../types";
import {
  cascadeJoinRefreshForRemoved,
  scrubSecondaryPaneLayerVisibility,
  scrubStorymapLayerRefs,
} from "./layer-removal";
import type { SliceCreator } from "./types";

/**
 * Pick the lowest `Group N` name not already taken, so default names stay
 * unique while still preferring small numbers — starting the search at 1 (not
 * `length + 1`) avoids skipping free low numbers when some groups carry custom
 * names. Group counts are small, so the linear scan is negligible.
 */
function nextDefaultGroupName(groups: LayerGroup[]): string {
  const existing = new Set(groups.map((g) => g.name));
  let n = 1;
  while (existing.has(`Group ${n}`)) n++;
  return `Group ${n}`;
}

export interface LayerGroupsSlice {
  layerGroups: LayerGroup[];

  addLayerGroup: (name?: string, layerIds?: string[]) => string;
  removeLayerGroup: (id: string, options?: { removeChildren?: boolean }) => void;
  renameLayerGroup: (id: string, name: string) => void;
  setLayerGroupVisibility: (id: string, visible: boolean) => void;
  setLayerGroupOpacity: (id: string, opacity: number) => void;
  toggleLayerGroupCollapsed: (id: string) => void;
  moveLayerToGroup: (
    layerId: string,
    groupId: string | null,
    beforeLayerId?: string | null,
  ) => void;
  moveLayersToGroup: (
    layerIds: string[],
    groupId: string | null,
    beforeLayerId?: string | null,
  ) => void;
  moveLayerGroupToGroup: (id: string, parentId: string | null) => void;
  reorderLayerGroup: (id: string, direction: "up" | "down") => void;
  /**
   * Sort a group's direct children by name, A to Z or Z to A (top of panel
   * first), collating by `locale` (the app's display language) when given.
   */
  sortLayerGroup: (id: string, order: LayerGroupSortOrder, locale?: string) => void;
}

export const createLayerGroupsSlice: SliceCreator<LayerGroupsSlice> = (set, get) => ({
  layerGroups: [],

  addLayerGroup: (name, layerIds) => {
    const id = uuidv4();
    set((s) => {
      const group: LayerGroup = {
        id,
        name: name?.trim() || nextDefaultGroupName(s.layerGroups),
        collapsed: false,
        visible: true,
        opacity: DEFAULT_LAYER_GROUP_OPACITY,
      };
      const ids = new Set(layerIds ?? []);
      const layers =
        ids.size > 0
          ? normalizeGroupContiguity(
              s.layers.map((l) => (ids.has(l.id) ? { ...l, groupId: id } : l)),
            )
          : s.layers;
      return {
        layers,
        layerGroups: [...s.layerGroups, group],
        isDirty: true,
      };
    });
    return id;
  },

  removeLayerGroup: (id, options) =>
    set((s) => {
      const removeChildren = options?.removeChildren ?? false;
      const removedGroup = s.layerGroups.find((g) => g.id === id);
      if (!removedGroup) return s;
      const groupIds = new Set([id]);
      if (removeChildren) {
        let changed = true;
        while (changed) {
          changed = false;
          for (const group of s.layerGroups) {
            if (group.parentId && groupIds.has(group.parentId) && !groupIds.has(group.id)) {
              groupIds.add(group.id);
              changed = true;
            }
          }
        }
      }
      const removedIds = new Set(
        s.layers.filter((l) => l.groupId && groupIds.has(l.groupId)).map((l) => l.id),
      );
      let layers = removeChildren
        ? s.layers.filter((l) => !l.groupId || !groupIds.has(l.groupId))
        : s.layers.map((l) => (l.groupId === id ? { ...l, groupId: undefined } : l));
      // Match removeLayer: refreshing joins and scrubbing secondary-pane /
      // storymap refs for every deleted child so group delete cannot leave
      // stale joined columns or dangling visibility overrides behind.
      if (removeChildren && removedIds.size > 0) {
        layers = cascadeJoinRefreshForRemoved(layers, removedIds);
      }
      const selectionRemoved =
        removeChildren && s.selectedLayerId !== null && removedIds.has(s.selectedLayerId);
      return {
        layers,
        layerGroups: s.layerGroups
          .filter((g) => !groupIds.has(g.id))
          .map((g) => (g.parentId === id ? { ...g, parentId: removedGroup.parentId } : g)),
        secondaryMapViews: removeChildren
          ? scrubSecondaryPaneLayerVisibility(s.secondaryMapViews, removedIds)
          : s.secondaryMapViews,
        storymap: removeChildren ? scrubStorymapLayerRefs(s.storymap, removedIds) : s.storymap,
        widgets: removeChildren ? scrubWidgetsForRemovedLayers(s.widgets, removedIds) : s.widgets,
        comments: removeChildren
          ? scrubCommentsForRemovedLayers(s.comments, removedIds)
          : s.comments,
        legend: removeChildren ? scrubLegendForRemovedLayers(s.legend, removedIds) : s.legend,
        printLayout: removeChildren
          ? scrubPrintLayoutForRemovedLayers(s.printLayout, removedIds)
          : s.printLayout,
        selectedLayerId: selectionRemoved
          ? (layers[layers.length - 1]?.id ?? null)
          : s.selectedLayerId,
        selectedFeatureId: selectionRemoved ? null : s.selectedFeatureId,
        selectedFeatureIds: selectionRemoved ? [] : s.selectedFeatureIds,
        identifyLayerId:
          s.identifyLayerId !== null && removedIds.has(s.identifyLayerId)
            ? null
            : s.identifyLayerId,
        ui: removeChildren
          ? {
              ...s.ui,
              selectByExpressionLayerId:
                s.ui.selectByExpressionLayerId !== null &&
                removedIds.has(s.ui.selectByExpressionLayerId)
                  ? null
                  : s.ui.selectByExpressionLayerId,
              selectByLocationLayerId:
                s.ui.selectByLocationLayerId !== null &&
                removedIds.has(s.ui.selectByLocationLayerId)
                  ? null
                  : s.ui.selectByLocationLayerId,
              loadEditorFeaturesLayerId:
                s.ui.loadEditorFeaturesLayerId !== null &&
                removedIds.has(s.ui.loadEditorFeaturesLayerId)
                  ? null
                  : s.ui.loadEditorFeaturesLayerId,
            }
          : s.ui,
        isDirty: true,
      };
    }),

  renameLayerGroup: (id, name) =>
    set((s) => ({
      layerGroups: s.layerGroups.map((g) => (g.id === id ? { ...g, name } : g)),
      isDirty: true,
    })),

  setLayerGroupVisibility: (id, visible) =>
    set((s) => ({
      layerGroups: s.layerGroups.map((g) => (g.id === id ? { ...g, visible } : g)),
      isDirty: true,
    })),

  setLayerGroupOpacity: (id, opacity) =>
    set((s) => ({
      layerGroups: s.layerGroups.map((g) =>
        g.id === id ? { ...g, opacity: Math.min(Math.max(opacity, 0), 1) } : g,
      ),
      isDirty: true,
    })),

  // Collapsing/expanding a folder is a UI-panel preference, not a data
  // edit: it is still persisted in the project (folders reopen collapsed),
  // but it does not mark the project dirty and is excluded from undo (see
  // the equality comparator in undo-history.ts) so Ctrl-Z never toggles a
  // folder.
  toggleLayerGroupCollapsed: (id) =>
    set((s) => ({
      layerGroups: s.layerGroups.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)),
    })),

  moveLayerToGroup: (layerId, groupId, beforeLayerId = null) =>
    get().moveLayersToGroup([layerId], groupId, beforeLayerId),

  moveLayersToGroup: (layerIds, groupId, beforeLayerId = null) =>
    set((s) => {
      if (groupId && !s.layerGroups.some((g) => g.id === groupId)) return s;
      const requestedIds = new Set(layerIds);
      const moving = s.layers.filter(
        (layer) =>
          requestedIds.has(layer.id) &&
          (beforeLayerId !== null || (layer.groupId ?? null) !== groupId),
      );
      if (moving.length === 0) return s;
      const movingIds = new Set(moving.map((layer) => layer.id));
      const without = s.layers.filter((layer) => !movingIds.has(layer.id));
      const updated = moving.map((layer) => ({
        ...layer,
        groupId: groupId ?? undefined,
      }));
      let index: number;
      if (beforeLayerId && !movingIds.has(beforeLayerId)) {
        const at = without.findIndex((layer) => layer.id === beforeLayerId);
        index = at < 0 ? without.length : at;
      } else if (groupId) {
        let last = -1;
        without.forEach((layer, layerIndex) => {
          if (layer.groupId === groupId) last = layerIndex;
        });
        index = last < 0 ? without.length : last + 1;
      } else {
        index = without.length;
      }
      const next = [...without];
      next.splice(index, 0, ...updated);
      const normalized = normalizeGroupContiguity(next);
      const unchanged = normalized.every(
        (layer, layerIndex) =>
          layer.id === s.layers[layerIndex]?.id && layer.groupId === s.layers[layerIndex]?.groupId,
      );
      if (unchanged) return s;
      return { layers: normalized, isDirty: true };
    }),

  moveLayerGroupToGroup: (id, parentId) =>
    set((s) => {
      if (parentId === id) return s;
      const group = s.layerGroups.find((g) => g.id === id);
      if (!group) return s;
      if (parentId && !s.layerGroups.some((g) => g.id === parentId)) return s;
      // Walking upward from the proposed parent must never reach the group
      // being moved, otherwise the assignment would create a cycle.
      const byId = new Map(s.layerGroups.map((g) => [g.id, g]));
      let ancestorId = parentId ?? undefined;
      const visited = new Set<string>();
      while (ancestorId && !visited.has(ancestorId)) {
        if (ancestorId === id) return s;
        visited.add(ancestorId);
        ancestorId = byId.get(ancestorId)?.parentId;
      }
      const nextParentId = parentId ?? undefined;
      if (group.parentId === nextParentId) return s;
      return {
        layerGroups: s.layerGroups.map((g) => (g.id === id ? { ...g, parentId: nextParentId } : g)),
        isDirty: true,
      };
    }),

  // A folder that owns no layers has no position in `layers` to move, so
  // the panel order it takes part in lives across both arrays and the move
  // writes both (GeoLibre#1739).
  reorderLayerGroup: (id, direction) =>
    set((s) => {
      const moved = reorderLayerGroupInPanel(s.layers, s.layerGroups, id, direction);
      if (!moved) return s;
      return { layers: moved.layers, layerGroups: moved.groups, isDirty: true };
    }),

  sortLayerGroup: (id, order, locale) =>
    set((s) => {
      const sorted = sortLayerGroupInPanel(s.layers, s.layerGroups, id, order, locale);
      if (!sorted) return s;
      return { layers: sorted.layers, layerGroups: sorted.groups, isDirty: true };
    }),
});
