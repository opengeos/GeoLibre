import type { DashboardWidget, LegendConfig, ProjectComment } from "./types";

/**
 * Normalize the removed-layer-ids argument into a Set for uniform lookup.
 */
export function removedLayerIdSet(layerIds: string | Iterable<string>): Set<string> {
  if (typeof layerIds === "string") return new Set([layerIds]);
  if (layerIds instanceof Set) return layerIds as Set<string>;
  return new Set(layerIds);
}

/**
 * Filter out dashboard widgets whose `layerId` references a removed layer.
 * Returns the same array reference when nothing changes.
 */
export function scrubWidgetsForRemovedLayers(
  widgets: DashboardWidget[],
  layerIds: string | Iterable<string>,
): DashboardWidget[] {
  const removed = removedLayerIdSet(layerIds);
  if (removed.size === 0 || widgets.length === 0) return widgets;
  const filtered = widgets.filter((w) => !removed.has(w.layerId));
  return filtered.length === widgets.length ? widgets : filtered;
}

/**
 * Drop comments whose anchor is a feature on a removed layer.
 * Point-anchored comments are always kept.
 * Returns the same array reference when nothing changes.
 */
export function scrubCommentsForRemovedLayers(
  comments: ProjectComment[],
  layerIds: string | Iterable<string>,
): ProjectComment[] {
  const removed = removedLayerIdSet(layerIds);
  if (removed.size === 0 || comments.length === 0) return comments;
  const filtered = comments.filter(
    (c) => !(c.anchor.type === "feature" && removed.has(c.anchor.layerId)),
  );
  return filtered.length === comments.length ? comments : filtered;
}

/**
 * Scrub legend config of references to removed layers:
 * - `order`: filter out removed layer ids
 * - `overrides`: drop keys that equal a removed id OR start with `${id}::`
 * - `customEntries`: drop keys that equal a removed layer id but KEEP keys
 *   starting with `custom:`
 *
 * Returns the same reference when nothing changes.
 */
export function scrubLegendForRemovedLayers(
  legend: LegendConfig,
  layerIds: string | Iterable<string>,
): LegendConfig {
  const removed = removedLayerIdSet(layerIds);
  if (removed.size === 0) return legend;

  let changed = false;

  // --- order ---
  const order = legend.order.filter((id) => !removed.has(id));
  if (order.length !== legend.order.length) changed = true;

  // --- overrides ---
  const overrides: Record<string, (typeof legend.overrides)[string]> = {};
  for (const [key, value] of Object.entries(legend.overrides)) {
    const base = key.includes("::") ? key.slice(0, key.indexOf("::")) : key;
    if (removed.has(base)) {
      changed = true;
    } else {
      overrides[key] = value;
    }
  }

  // --- customEntries ---
  let customEntries = legend.customEntries;
  if (customEntries) {
    let customEntriesChanged = false;
    const nextCustom: Record<string, (typeof customEntries)[string]> = {};
    for (const [key, value] of Object.entries(customEntries)) {
      if (key.startsWith("custom:")) {
        nextCustom[key] = value;
      } else if (removed.has(key)) {
        customEntriesChanged = true;
      } else {
        nextCustom[key] = value;
      }
    }
    if (customEntriesChanged) {
      customEntries = Object.keys(nextCustom).length > 0 ? nextCustom : undefined;
      changed = true;
    }
  }

  if (!changed) return legend;
  return { ...legend, order, overrides, customEntries };
}
