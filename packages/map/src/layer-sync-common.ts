// Shared helpers for MapLibre layer sync: feature filters, zoom ranges, layer ensure/remove and GeoJSON source state.

import { updateGeoJsonSourceData } from "./geojson-source-data";
import {
  compileLayerFilters,
  DEFAULT_LAYER_STYLE,
  ruleBasedVisibilityFilter,
  styleValue,
  type GeoLibreLayer,
  type LayerStyle,
} from "@geolibre/core";
import { TEXT_MARKER_SHAPE_FILTER } from "./label-style";
import type { GeoJSON } from "geojson";
import type * as maplibregl from "maplibre-gl";
import {
  circleLayerId,
  clusterCountLayerId,
  clusterLayerId,
  detectGeometryProfile,
  fillExtrusionLayerId,
  fillLayerId,
  heatmapLayerId,
  labelLayerId,
  lineDecorationLayerId,
  lineLayerId,
  markerLayerId,
  textLayerId,
} from "./geojson-loader";
import {
  getDynamicLayoutProperty,
  getDynamicPaintProperty,
  setDynamicLayoutProperty,
  setDynamicPaintProperty,
} from "./dynamic-style-property";
import { withPaintResets } from "./style-mapper";
import { resolveTextFontFromStyleLayers } from "./text-font";
import type { LineGapLabelResult } from "./line-gap-labels";

export const MIN_LAYER_ZOOM = DEFAULT_LAYER_STYLE.minZoom;

export const MAX_LAYER_ZOOM = DEFAULT_LAYER_STYLE.maxZoom;

export const pointGeometryFilter: maplibregl.FilterSpecification = [
  "match",
  ["geometry-type"],
  ["Point", "MultiPoint"],
  true,
  false,
];

export const textMarkerShapeFilter = TEXT_MARKER_SHAPE_FILTER as maplibregl.ExpressionSpecification;

export const textMarkerFilter: maplibregl.FilterSpecification = [
  "all",
  pointGeometryFilter,
  textMarkerShapeFilter,
];

export const nonTextMarkerPointFilter: maplibregl.FilterSpecification = [
  "all",
  pointGeometryFilter,
  ["!", textMarkerShapeFilter],
];

/**
 * Filter for the unclustered-point circle layer in cluster mode: every feature
 * without a `point_count`, excluding text markers when present so they render
 * only through the symbol layer rather than also as plain circles.
 */
export function unclusteredPointFilter(hasTextMarkers: boolean): maplibregl.FilterSpecification {
  if (!hasTextMarkers) return ["!", ["has", "point_count"]];
  return [
    "all",
    ["!", ["has", "point_count"]],
    nonTextMarkerPointFilter,
  ] as maplibregl.FilterSpecification;
}

/**
 * Whether any per-feature filter {@link withFeatureFilters} combines is
 * active. Symbology derived from the raw features cannot see these filters.
 *
 * @param layer - The store layer being synced.
 * @returns True while a time, embed, authored or rule filter applies, or an
 *   annotation layer hides any of its features.
 */
export function layerHasFeatureFilter(layer: GeoLibreLayer): boolean {
  return (
    (Array.isArray(layer.timeFilter) && layer.timeFilter.length > 0) ||
    (Array.isArray(layer.embedFilter) && layer.embedFilter.length > 0) ||
    compileLayerFilters(layer) !== null ||
    ruleBasedVisibilityFilter(layer.style) !== null ||
    annotationHidesFeatures(layer)
  );
}

/**
 * Whether an annotation layer hides any feature through the `visible: false`
 * predicate {@link withFeatureFilters} adds. The predicate is always on for
 * annotation layers, but it only filters anything once a feature is hidden.
 *
 * @param layer - The store layer being synced.
 * @returns True when the layer is an annotation layer with a hidden feature.
 */
function annotationHidesFeatures(layer: GeoLibreLayer): boolean {
  return (
    layer.metadata?.sourceKind === "annotation" &&
    (layer.geojson?.features.some((feature) => feature.properties?.visible === false) ?? false)
  );
}

/**
 * Combine a sub-layer's geometry filter with the layer's per-feature filters:
 * the transient {@link GeoLibreLayer.timeFilter} (a Time-Slider-bound layer
 * only renders features inside the current timeline window), the transient
 * {@link GeoLibreLayer.embedFilter} (the embed API's `setFilter`, set by the
 * host page that frames the app), the persisted expression and Quick Filter
 * controls compiled by `compileLayerFilters`, and the rule-based visibility
 * filter (a rule-based layer whose else rule is switched off hides features
 * matching no rule — see {@link ruleBasedVisibilityFilter}). They are combined
 * with `all`, so a host page's filter and a user's quick filter narrow the
 * layer together instead of clobbering each other. Returns the geometry filter
 * unchanged when none applies, so the common path
 * produces an identical spec and `ensureLayer` performs no filter update.
 *
 * Aggregate cluster layers (the bubble and its count) intentionally do not pass
 * through here: a cluster feature carries no time or rule property, so an
 * `["all", ...]` wrap would drop every cluster whenever a window or rule filter
 * is active. Per-feature layers (fill, line, point, heatmap, text) filter
 * correctly.
 *
 * MapLibre clusters at the source, before evaluating style-layer filters.
 * `authoredClusterInput` therefore narrows clustered source data by the
 * persisted expression and Quick Filters so hidden features do not contribute
 * to bubbles or counts. Transient time, embed, and rule filters remain
 * per-render-layer filters and cannot change an already-built cluster.
 *
 * Tile-backed layers (vector tiles, vector MBTiles) use this too. The filter is
 * an expression evaluated per feature as each tile decodes, so it needs no local
 * copy of the data and stays correct for tiles loaded later; control-owned
 * PMTiles layers reach the same behavior through
 * `applyExternalNativeFeatureFilters`.
 *
 * @param layer - The store layer being synced.
 * @param geometryFilter - The sub-layer's own geometry-type filter.
 * @returns The combined filter, or the original when no extra filter applies.
 */
export function withFeatureFilters(
  layer: GeoLibreLayer,
  geometryFilter: maplibregl.FilterSpecification,
): maplibregl.FilterSpecification {
  const filters: unknown[] = [];
  const timeFilter = layer.timeFilter;
  if (Array.isArray(timeFilter) && timeFilter.length > 0) {
    filters.push(timeFilter);
  }
  if (Array.isArray(layer.embedFilter) && layer.embedFilter.length > 0) {
    filters.push(layer.embedFilter);
  }
  const authoredFilter = compileLayerFilters(layer);
  if (authoredFilter) filters.push(authoredFilter);
  const ruleFilter = ruleBasedVisibilityFilter(layer.style);
  if (ruleFilter) filters.push(ruleFilter);
  if (layer.metadata?.sourceKind === "annotation") {
    filters.push(["!=", ["get", "visible"], false]);
  }
  if (filters.length === 0) return geometryFilter;
  return ["all", geometryFilter, ...filters] as unknown as maplibregl.FilterSpecification;
}

// Native layer ids whose zoom range GeoLibre has taken over, scoped per map so
// split-pane maps and project reloads never leak or cross-contaminate ids.
export const managedZoomRangeLayerIds = new WeakMap<maplibregl.Map, Set<string>>();

export function managedZoomRangeLayerIdsFor(map: maplibregl.Map): Set<string> {
  let ids = managedZoomRangeLayerIds.get(map);
  if (!ids) {
    ids = new Set<string>();
    managedZoomRangeLayerIds.set(map, ids);
  }
  return ids;
}

const geoJsonSourceData = new WeakMap<maplibregl.GeoJSONSource, GeoJSON>();

export function rememberGeoJsonData(map: maplibregl.Map, sourceId: string, data: GeoJSON): void {
  const source = map.getSource(sourceId);
  if (source?.type === "geojson") geoJsonSourceData.set(source as maplibregl.GeoJSONSource, data);
}

export function setGeoJsonData(source: maplibregl.GeoJSONSource, data: GeoJSON): void {
  if (geoJsonSourceData.get(source) === data) return;
  updateGeoJsonSourceData(source, data);
  geoJsonSourceData.set(source, data);
}

export function clampLayerZoom(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_LAYER_ZOOM, Math.max(MIN_LAYER_ZOOM, value));
}

export function styleLayerZoomRange(style: LayerStyle): {
  maxzoom: number;
  minzoom: number;
} {
  const minzoom = clampLayerZoom(styleValue(style, "minZoom"), MIN_LAYER_ZOOM);
  const maxzoom = clampLayerZoom(styleValue(style, "maxZoom"), MAX_LAYER_ZOOM);
  return {
    minzoom: Math.min(minzoom, maxzoom),
    maxzoom: Math.max(minzoom, maxzoom),
  };
}

// Intersect a native layer's source-declared zoom range with the user-configured
// style range, taking the tighter bound on each end. When the two ranges do not
// overlap (minzoom > maxzoom), collapse to an empty half-open interval
// `[minzoom, minzoom)` rather than swapping bounds into the excluded gap.
export function intersectZoomRange(
  nativeSpec: { minzoom?: number; maxzoom?: number },
  style: LayerStyle,
): { minzoom: number; maxzoom: number } {
  const styleRange = styleLayerZoomRange(style);
  const minzoom = Math.max(nativeSpec.minzoom ?? MIN_LAYER_ZOOM, styleRange.minzoom);
  const maxzoom = Math.min(nativeSpec.maxzoom ?? MAX_LAYER_ZOOM, styleRange.maxzoom);
  if (minzoom > maxzoom) {
    const emptyZoom = Math.min(MAX_LAYER_ZOOM, minzoom);
    return { minzoom: emptyZoom, maxzoom: emptyZoom };
  }
  return { minzoom, maxzoom };
}

export function boundsSource(value: unknown): [number, number, number, number] | undefined {
  return Array.isArray(value) &&
    value.length === 4 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
    ? (value as [number, number, number, number])
    : undefined;
}

export function numberSource(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function stringSource(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Everything the vector render-layer builders below share for one sync pass of
 * one store layer: the map, the layer, where its features live, how it
 * renders, and the flags derived once up front in
 * `applyVectorDataRenderLayers`.
 */
export interface VectorRenderContext {
  map: maplibregl.Map;
  layer: GeoLibreLayer;
  /** The id of the source every render layer draws from. */
  src: string;
  /** `{ source }`, plus `source-layer` on the tiled path. */
  sourceSpec: { source: string; "source-layer"?: string };
  /** The tiled path's source layer; undefined on the inline geojson path. */
  sourceLayer?: string;
  profile: ReturnType<typeof detectGeometryProfile>;
  renderer: string;
  beforeId?: string;
  visibility: "visible" | "none";
  opacity: number;
  hasTextMarkers: boolean;
  /**
   * Whether a Time Slider window, an embed filter, a layer filter or a
   * rule-based visibility filter is active, which suppresses the derived
   * companion symbology (see `applyVectorDataRenderLayers`).
   */
  hasFeatureFilter: boolean;
  /**
   * The contour-style placement when the layer's line labels cut gaps in
   * their lines: the source already holds its cut lines, and the label layer
   * draws its label points (see `lineGapPlacement`).
   */
  lineGap?: LineGapLabelResult | null;
}

export function removeSourceIfExists(map: maplibregl.Map, id: string): void {
  if (map.getSource(id)) {
    map.removeSource(id);
    forgetGeoJsonSourceClusterState(map, id);
  }
}

// getStyle() deep-clones the whole style, and syncs can fire rapidly (e.g.
// while dragging an opacity slider), so cache the resolved font per map and
// invalidate when a new basemap style loads.
const textFontCache = new WeakMap<maplibregl.Map, string[]>();

/** Invalidate before restoring labels in a persistent style-load listener. */
export function invalidateTextFontForMapStyle(map: maplibregl.Map): void {
  textFontCache.delete(map);
}

/** A label font stack the map's current style serves glyphs for (cached per style). */
export function textFontForMapStyle(map: maplibregl.Map): string[] {
  const cached = textFontCache.get(map);
  if (cached) return cached;
  const fonts = resolveTextFontFromStyle(map);
  textFontCache.set(map, fonts);
  map.once("style.load", () => textFontCache.delete(map));
  return fonts;
}

function resolveTextFontFromStyle(map: maplibregl.Map): string[] {
  return resolveTextFontFromStyleLayers(map.getStyle().layers, ["Noto Sans Regular"]);
}

export function ensureLayer(
  map: maplibregl.Map,
  id: string,
  spec: maplibregl.AddLayerObject & {
    // Required so every caller supplies an explicit zoom range; omitting it
    // would silently reset an existing layer's range to the full [0, 24]
    // window on the next sync.
    maxzoom: number;
    minzoom: number;
    paint?: Record<string, unknown>;
    layout?: Record<string, unknown>;
  },
  beforeId?: string,
): void {
  if (map.getLayer(id)) {
    if (spec.paint) {
      // Clear a dash, blur or hairline the layer's previous paint set and this
      // one leaves out (see withPaintResets).
      for (const [key, value] of Object.entries(withPaintResets(spec.type, spec.paint))) {
        const current = getDynamicPaintProperty(map, id, key);
        // A `null` reset of a property that already reads back unset is done:
        // re-sending it would trigger a style update on every sync.
        if (value === null && current === undefined) continue;
        if (!styleValuesEqual(current, value)) {
          setDynamicPaintProperty(map, id, key, value);
        }
      }
    }
    if (spec.layout) {
      for (const [key, value] of Object.entries(spec.layout)) {
        if (!styleValuesEqual(getDynamicLayoutProperty(map, id, key), value)) {
          setDynamicLayoutProperty(map, id, key, value);
        }
      }
    }
    if ("filter" in spec) {
      // setFilter invalidates the layer, so skip no-op updates.
      const current = map.getFilter(id);
      if (JSON.stringify(current ?? null) !== JSON.stringify(spec.filter ?? null)) {
        map.setFilter(id, spec.filter);
      }
    }
    setLayerZoomRange(map, id, {
      minzoom: spec.minzoom,
      maxzoom: spec.maxzoom,
    });
    moveLayer(map, id, beforeId);
    return;
  }
  const validBeforeId = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
  // MapLibre's addLayer rejects (and silently drops, without throwing) a layer
  // whose paint or layout carries an explicit `null`. `null` is only valid as
  // a set*Property reset, which the update branch above uses (`fill-pattern`
  // in paint, `symbol-sort-key` in layout); on first add it must be stripped
  // so a reset value does not blank the whole layer. Properties simply absent
  // default correctly.
  const stripNulls = (
    record: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined =>
    record && Object.values(record).some((value) => value === null)
      ? Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null))
      : record;
  const strippedPaint = stripNulls(spec.paint);
  const strippedLayout = stripNulls(spec.layout);
  const addSpec =
    strippedPaint !== spec.paint || strippedLayout !== spec.layout
      ? {
          ...spec,
          ...(strippedPaint ? { paint: strippedPaint } : {}),
          ...(strippedLayout ? { layout: strippedLayout } : {}),
        }
      : spec;
  // An explicit `filter: undefined` key fails MapLibre's add-time validation
  // ("array expected, undefined found") and the layer is dropped without
  // throwing — only an `error` event reports it. Callers that compute an
  // optional filter still need the key present on the update branch above, so
  // it is dropped here, on first add, where "no filter" must mean "absent".
  const hasUndefinedFilter = "filter" in addSpec && addSpec.filter === undefined;
  if (hasUndefinedFilter) {
    const { filter: _filter, ...withoutFilter } = addSpec;
    map.addLayer(withoutFilter as typeof addSpec, validBeforeId);
    return;
  }
  map.addLayer(addSpec, validBeforeId);
}

export function styleValuesEqual(current: unknown, next: unknown): boolean {
  return Object.is(current, next) || JSON.stringify(current) === JSON.stringify(next);
}

export function setLayerZoomRange(
  map: maplibregl.Map,
  id: string,
  range: { minzoom?: number; maxzoom?: number },
): void {
  const minzoom = range.minzoom ?? MIN_LAYER_ZOOM;
  const maxzoom = range.maxzoom ?? MAX_LAYER_ZOOM;
  const current = map.getLayer(id) as { minzoom?: number; maxzoom?: number } | undefined;
  // setLayerZoomRange invalidates MapLibre's style internally, so skip no-op
  // calls. syncLayer runs this for every layer on every pass.
  if (current?.minzoom === minzoom && current?.maxzoom === maxzoom) {
    return;
  }
  try {
    map.setLayerZoomRange(id, minzoom, maxzoom);
  } catch (error) {
    // Custom layers from external controls do not support zoom range updates,
    // so that failure is expected and ignored. Surface anything else (e.g. an
    // error on a GeoLibre-owned layer) so a real invariant violation is not
    // silently swallowed.
    if (map.getLayer(id)?.type !== "custom") {
      console.warn("[GeoLibre] setLayerZoomRange failed for layer", id, error);
    }
  }
}

export function removeIfExists(map: maplibregl.Map, id: string): void {
  if (map.getLayer(id)) map.removeLayer(id);
}

type GeoJsonClusterState = { cluster: boolean; radius: number; maxZoom: number };

const geojsonSourceClusterStates = new WeakMap<maplibregl.Map, Map<string, GeoJsonClusterState>>();

export function rememberGeoJsonSourceClusterState(
  map: maplibregl.Map,
  src: string,
  state: GeoJsonClusterState,
): void {
  let bySource = geojsonSourceClusterStates.get(map);
  if (!bySource) {
    bySource = new Map();
    geojsonSourceClusterStates.set(map, bySource);
  }
  bySource.set(src, state);
}

export function forgetGeoJsonSourceClusterState(map: maplibregl.Map, src: string): void {
  geojsonSourceClusterStates.get(map)?.delete(src);
}

/**
 * Read a GeoJSON source's clustering config without cloning the whole style on
 * every sync. Uses the tracked per-map cluster state (falling back to
 * `source.serialize()` or `map.getStyle()` only on cache miss).
 */
export function geojsonSourceClusterState(
  map: maplibregl.Map,
  src: string,
): GeoJsonClusterState | null {
  const liveSource = map.getSource(src) as
    | (maplibregl.Source & { serialize?: () => maplibregl.SourceSpecification })
    | undefined;
  if (!liveSource) {
    forgetGeoJsonSourceClusterState(map, src);
    return null;
  }
  if (liveSource.type !== "geojson") {
    forgetGeoJsonSourceClusterState(map, src);
    return null;
  }
  const cached = geojsonSourceClusterStates.get(map)?.get(src);
  if (cached) return cached;

  const spec =
    typeof liveSource.serialize === "function"
      ? liveSource.serialize()
      : map.getStyle?.()?.sources?.[src];
  if (!spec || spec.type !== "geojson") return null;
  const clusterSpec = spec as {
    cluster?: boolean;
    clusterRadius?: number;
    clusterMaxZoom?: number;
  };
  const state: GeoJsonClusterState = {
    cluster: Boolean(clusterSpec.cluster),
    radius:
      typeof clusterSpec.clusterRadius === "number"
        ? clusterSpec.clusterRadius
        : DEFAULT_LAYER_STYLE.clusterRadius,
    maxZoom:
      typeof clusterSpec.clusterMaxZoom === "number"
        ? clusterSpec.clusterMaxZoom
        : DEFAULT_LAYER_STYLE.clusterMaxZoom,
  };
  rememberGeoJsonSourceClusterState(map, src, state);
  return state;
}

/** Remove every style layer a GeoJSON layer can own (all renderer variants). */
export function removeGeoJsonRenderLayers(map: maplibregl.Map, layerId: string): void {
  for (const id of [
    fillLayerId(layerId),
    fillExtrusionLayerId(layerId),
    lineLayerId(layerId),
    lineDecorationLayerId(layerId),
    circleLayerId(layerId),
    heatmapLayerId(layerId),
    clusterLayerId(layerId),
    clusterCountLayerId(layerId),
    textLayerId(layerId),
    markerLayerId(layerId),
    labelLayerId(layerId),
  ]) {
    removeIfExists(map, id);
  }
}

export function moveLayer(map: maplibregl.Map, id: string, beforeId?: string): void {
  if (!map.getLayer(id)) return;

  try {
    if (beforeId && beforeId !== id && map.getLayer(beforeId)) {
      map.moveLayer(id, beforeId);
      return;
    }
    map.moveLayer(id);
  } catch {
    // Reordering can race style reloads; the next sync pass will retry.
  }
}

/** The external sources a set of layers draws from — what a removal must not pull out from under. */
export function externalSourceIdsFor(layers: readonly GeoLibreLayer[]): Set<string> {
  return new Set(layers.flatMap((layer) => getExternalSourceIds(layer)));
}

export function getExternalNativeLayerIds(layer?: GeoLibreLayer): string[] {
  const nativeLayerIds = layer?.metadata.nativeLayerIds;
  return Array.isArray(nativeLayerIds)
    ? nativeLayerIds.filter((id): id is string => typeof id === "string")
    : [];
}

export function getExternalSourceIds(layer?: GeoLibreLayer): string[] {
  const sourceIds = layer?.metadata.sourceIds;
  if (Array.isArray(sourceIds)) {
    return sourceIds.filter((id): id is string => typeof id === "string");
  }

  return typeof layer?.metadata.sourceId === "string" ? [layer.metadata.sourceId] : [];
}
