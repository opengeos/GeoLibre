/**
 * Reference scrubbing shared by the actions that delete layers (`removeLayer`
 * and `removeLayerGroup` with `removeChildren`), so a deleted layer never
 * leaves a dangling id in a story map, a secondary pane, or a join.
 */
import { cascadeLayerJoinRefresh } from "../joins";
import { removedLayerIdSet } from "../layer-ref-scrub";
import type { GeoLibreLayer, SecondaryMapView, StoryMap } from "../types";

/**
 * Strip storymap chapter enter/exit opacity rows that reference any of the
 * removed layer ids. Returns the same reference when nothing changes so
 * callers can avoid unnecessary storymap churn.
 */
export function scrubStorymapLayerRefs(
  storymap: StoryMap | null,
  layerIds: string | Iterable<string>,
): StoryMap | null {
  if (!storymap) return null;
  const removed = removedLayerIdSet(layerIds);
  if (removed.size === 0) return storymap;
  let changed = false;
  const chapters = storymap.chapters.map((chapter) => {
    const onChapterEnter = chapter.onChapterEnter.filter((change) => !removed.has(change.layerId));
    const onChapterExit = chapter.onChapterExit.filter((change) => !removed.has(change.layerId));
    if (
      onChapterEnter.length === chapter.onChapterEnter.length &&
      onChapterExit.length === chapter.onChapterExit.length
    ) {
      return chapter;
    }
    changed = true;
    return { ...chapter, onChapterEnter, onChapterExit };
  });
  return changed ? { ...storymap, chapters } : storymap;
}

/**
 * Drop per-pane visibility overrides for removed layer ids so stale keys do
 * not accumulate (or serialize) in secondary panes after deletion.
 */
export function scrubSecondaryPaneLayerVisibility(
  panes: SecondaryMapView[],
  layerIds: string | Iterable<string>,
): SecondaryMapView[] {
  const removed = removedLayerIdSet(layerIds);
  if (removed.size === 0) return panes;
  let anyChanged = false;
  const next = panes.map((pane) => {
    let changed = false;
    const layerVisibility: Record<string, boolean> = {};
    for (const [id, visible] of Object.entries(pane.layerVisibility)) {
      if (removed.has(id)) {
        changed = true;
        continue;
      }
      layerVisibility[id] = visible;
    }
    if (!changed) return pane;
    anyChanged = true;
    return { ...pane, layerVisibility };
  });
  return anyChanged ? next : panes;
}

/** Re-derive layers whose joins consumed any of the removed sources. */
export function cascadeJoinRefreshForRemoved(
  layers: GeoLibreLayer[],
  layerIds: string | Iterable<string>,
): GeoLibreLayer[] {
  let current = layers;
  for (const id of removedLayerIdSet(layerIds)) {
    current = cascadeLayerJoinRefresh(current, id);
  }
  return current;
}
