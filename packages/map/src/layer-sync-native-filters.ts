// Feature filters applied to the native style layers that external (plugin-owned) layers render through.

import { compileLayerFilters, ruleBasedVisibilityFilter, type GeoLibreLayer } from "@geolibre/core";
import type * as maplibregl from "maplibre-gl";

// Tracked filter state for external-native vector layers whose per-feature
// filters (a Time Slider window and/or the rule-based hide-unmatched filter)
// GeoLibre applies. `base` is the control's own filter, captured the first time
// a filter is applied so it can be combined without nesting and fully restored
// when the last filter is removed; `appliedKey` is the JSON of the combined
// filter we last pushed, compared against the next combined filter (both built
// here, so they round-trip) to avoid calling `setFilter` on every sync tick.
// Keyed first by the map instance (a WeakMap, so entries are garbage-collected
// when a map is destroyed and a fresh map never inherits stale base filters)
// then by native MapLibre layer id.
export interface NativeFilterState {
  base: maplibregl.FilterSpecification | null;
  appliedKey: string;
  liveKey: string;
}

export const externalNativeBaseFilters = new WeakMap<
  maplibregl.Map,
  Map<string, NativeFilterState>
>();

export function nativeFilterStatesFor(map: maplibregl.Map): Map<string, NativeFilterState> {
  let perLayer = externalNativeBaseFilters.get(map);
  if (!perLayer) {
    perLayer = new Map();
    externalNativeBaseFilters.set(map, perLayer);
  }
  return perLayer;
}

/**
 * Whether a MapLibre layer type accepts a `filter`. Raster/hillshade/background
 * layers do not, so a time window is never pushed onto them.
 */
export function nativeLayerSupportsFilter(type: string): boolean {
  return (
    type === "circle" ||
    type === "fill" ||
    type === "line" ||
    type === "symbol" ||
    type === "fill-extrusion" ||
    type === "heatmap"
  );
}

/**
 * The active per-feature filters GeoLibre applies on top of an external
 * layer's own filters: the transient Time-Slider window, the embed API's
 * host-set `setFilter` expression, the layer's persisted authored filters, and
 * the rule-based hide-unmatched filter (see {@link ruleBasedVisibilityFilter}).
 * Empty when none applies.
 */
export function externalFeatureFilterExtras(layer: GeoLibreLayer): unknown[] {
  const extras: unknown[] = [];
  const timeFilter = layer.timeFilter;
  if (Array.isArray(timeFilter) && timeFilter.length > 0) {
    extras.push(timeFilter);
  }
  if (Array.isArray(layer.embedFilter) && layer.embedFilter.length > 0) {
    extras.push(layer.embedFilter);
  }
  const authoredFilter = compileLayerFilters(layer);
  if (authoredFilter) extras.push(authoredFilter);
  const ruleFilter = ruleBasedVisibilityFilter(layer.style);
  if (ruleFilter) extras.push(ruleFilter);
  return extras;
}

/**
 * Whether some control-owned layer still has filters waiting for its native
 * MapLibre layers to exist.
 *
 * A control creates its layers asynchronously — the Add Vector Layer restore
 * replays a saved layer well after the sync pass that followed the project
 * load — so {@link syncLayer} finds nothing on the map and skips the filter.
 * The store layer it restores into usually matches what was saved, so no
 * further store change arrives to trigger another sync, and a persisted layer
 * filter would stay unapplied with the whole dataset on screen. Callers watch
 * for the layers appearing and sync again.
 *
 * @param map - The map the control adds its native layers to.
 * @param layers - The layers just synced.
 * @returns True while some layer's filters have nowhere to be applied yet.
 */
export function hasPendingExternalNativeFilters(
  map: maplibregl.Map,
  layers: GeoLibreLayer[],
): boolean {
  return layers.some((layer) => {
    if (layer.metadata?.externalNativeLayer !== true) return false;
    const nativeLayerIds = layer.metadata?.nativeLayerIds;
    if (!Array.isArray(nativeLayerIds) || nativeLayerIds.length === 0) return false;
    if (externalFeatureFilterExtras(layer).length === 0) return false;
    return nativeLayerIds.some((id) => typeof id === "string" && !map.getLayer(id));
  });
}

/**
 * Combine a base filter (an external layer's own filter, possibly null) with
 * the active per-feature extras into one MapLibre filter. Returns the base
 * unchanged (null stays null) when no extras apply.
 */
export function combineExternalFilters(
  base: maplibregl.FilterSpecification | null,
  extras: unknown[],
): maplibregl.FilterSpecification | null {
  if (extras.length === 0) return base;
  return (base
    ? ["all", base, ...extras]
    : extras.length === 1
      ? extras[0]
      : ["all", ...extras]) as unknown as maplibregl.FilterSpecification;
}

export function nativeFilterFromMap(
  map: maplibregl.Map,
  nativeLayerId: string,
): maplibregl.FilterSpecification | null {
  return (map.getFilter(nativeLayerId) as maplibregl.FilterSpecification | undefined) ?? null;
}

export function nativeFilterKey(filter: maplibregl.FilterSpecification | null): string {
  return JSON.stringify(filter);
}

/**
 * Apply (or clear) GeoLibre's per-feature filters — a Time-Slider window, the
 * embed API's host-set `setFilter` expression, the layer's compiled quick
 * filters, and the rule-based
 * hide-unmatched filter (see {@link ruleBasedVisibilityFilter}, and
 * {@link externalFeatureFilterExtras} for the set this reads)
 * — on an external-native vector layer that a control owns and paints itself
 * (e.g. the Add Vector Layer control). The control segregates geometry across
 * its own native layers with a base filter such as
 * `["==", ["geometry-type"], "Point"]`; this combines that base filter with the
 * active per-feature filters via `["all", ...]` so they narrow the visible
 * features without disturbing the control's paint. The control's base filter is
 * captured once and restored when the last per-feature filter is removed.
 *
 * @param map - The MapLibre map.
 * @param nativeLayerId - A control-owned native layer id.
 * @param layer - The store layer (reads `timeFilter`, `embedFilter`,
 *   `quickFilters`, and the rule filter).
 */
export function applyExternalNativeFeatureFilters(
  map: maplibregl.Map,
  nativeLayerId: string,
  layer: GeoLibreLayer,
): void {
  if (!map.getLayer(nativeLayerId)) return;
  const states = nativeFilterStatesFor(map);
  const extras = externalFeatureFilterExtras(layer);

  if (extras.length === 0) {
    // Nothing to narrow: restore the control's own filter (once) and stop
    // tracking.
    const state = states.get(nativeLayerId);
    if (state) {
      const liveFilter = nativeFilterFromMap(map, nativeLayerId);
      const liveKey = nativeFilterKey(liveFilter);
      // A control can remove and recreate a native layer under the same id.
      // If that happened, its current filter is the new base and must not be
      // replaced with the stale base captured from the previous layer.
      if (state.liveKey === liveKey) {
        map.setFilter(nativeLayerId, state.base ?? undefined);
      }
      states.delete(nativeLayerId);
    }
    return;
  }

  const liveFilter = nativeFilterFromMap(map, nativeLayerId);
  const liveKey = nativeFilterKey(liveFilter);
  // Filters active: capture the control's base filter the first time, then
  // keep reusing it so repeated ticks combine rather than nest.
  let state = states.get(nativeLayerId);
  if (!state) {
    state = { base: liveFilter, appliedKey: "", liveKey };
    states.set(nativeLayerId, state);
  } else if (state.liveKey !== liveKey) {
    // Project restore and renderer changes recreate control-owned MapLibre
    // layers without changing their ids. Treat the replacement's live filter
    // as its new base, then apply the saved extras again.
    state.base = liveFilter;
    state.appliedKey = "";
    state.liveKey = liveKey;
  }
  const combined = combineExternalFilters(state.base, extras)!;
  // Compare against the last filter we applied (not `getFilter`, which MapLibre
  // may have normalized) so an unchanged filter does not re-push on every tick.
  const combinedKey = JSON.stringify(combined);
  if (state.appliedKey !== combinedKey) {
    map.setFilter(nativeLayerId, combined);
    state.appliedKey = combinedKey;
    state.liveKey = nativeFilterKey(nativeFilterFromMap(map, nativeLayerId));
  }
}
