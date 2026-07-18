import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  geojsonHasZCoordinates,
  type LayerStyle,
  proportionalRadiusExpression,
  ruleBasedVisibilityFilter,
  shouldUseTiledRendering,
  styleValue,
  validateMapExpression,
} from "@geolibre/core";
import { addProtocol, config } from "maplibre-gl";
import type maplibregl from "maplibre-gl";
import type { PropertyValueSpecification } from "maplibre-gl";
import { FileSource, PMTiles, Protocol } from "pmtiles";
import {
  ensureGeoJsonVtProtocol,
  geojsonVtTileUrl,
  hasGeoJsonVtSource,
  registerGeoJsonVtSource,
  TILE_MAX_ZOOM,
  TILE_SOURCE_LAYER,
  unregisterGeoJsonVtSource,
} from "./geojson-vt-protocol";
import {
  circleLayerId,
  clusterCountLayerId,
  clusterLayerId,
  detectGeometryProfile,
  fillExtrusionLayerId,
  fillLayerId,
  generatorCircleLayerId,
  generatorFillLayerId,
  generatorLineLayerId,
  generatorSourceId,
  heatmapLayerId,
  invertedFillLayerId,
  invertedSourceId,
  labelLayerId,
  labelSourceId,
  lineDecorationLayerId,
  lineLayerId,
  markerLayerId,
  sourceId,
  textLayerId,
} from "./geojson-loader";
import { buildDedupedLabelFeatures } from "./label-dedup";
import {
  buildGeneratedGeometry,
  buildInvertedMask,
  generatedGeometryKinds,
} from "./derived-geometry";
import { ensureGeneratedImageHandler } from "./generated-images";
import { prepareFillPattern } from "./fill-patterns";
import { prepareLineDecoration } from "./line-decorations";
import { markerIconSizeValue, prepareMarker } from "./markers";
import { isPlaceholderLayer } from "./placeholders";
import {
  circlePaint,
  clusterCirclePaint,
  fillExtrusionPaint,
  fillPaint,
  heatmapPaint,
  linePaint,
  rasterPaint,
} from "./style-mapper";

/**
 * Notified of the computed `beforeId` for a deck.gl-backed external custom layer
 * (a `maplibre-gl-raster` COG) whenever layers are synced. Such a layer is not a
 * real MapLibre style layer — `@deck.gl/mapbox` groups it by a `beforeId` prop —
 * so `moveLayer` cannot reorder it; the host registers a handler that pushes the
 * `beforeId` into the owning control instead. See issue #393 follow-up.
 */
let externalDeckLayerOrderHandler:
  | ((layerId: string, beforeId: string | undefined) => void)
  | null = null;

/** Register (or clear with `null`) the deck-layer order handler. */
export function setExternalDeckLayerOrderHandler(
  handler: ((layerId: string, beforeId: string | undefined) => void) | null,
): void {
  externalDeckLayerOrderHandler = handler;
}

const WMS_PROXY_PATH = "/__geolibre_wms_proxy";
const PMTILES_PROTOCOL = "pmtiles";
const PMTILES_PROTOCOL_GLOBAL_KEY = "__geolibrePMTilesProtocol";
const PMTILES_ARCHIVE_KEYS_GLOBAL_KEY = "__geolibrePMTilesArchiveKeys";
const MIN_LAYER_ZOOM = DEFAULT_LAYER_STYLE.minZoom;
const MAX_LAYER_ZOOM = DEFAULT_LAYER_STYLE.maxZoom;
const TEXT_MARKER_SHAPE = "text_marker";
const GEOMAN_SHAPE_PROPERTY = "__gm_shape";
const GEOMAN_TEXT_PROPERTY = "__gm_text";

const pointGeometryFilter: maplibregl.FilterSpecification = [
  "match",
  ["geometry-type"],
  ["Point", "MultiPoint"],
  true,
  false,
];

const textMarkerShapeFilter: maplibregl.FilterSpecification = [
  "any",
  ["==", ["get", GEOMAN_SHAPE_PROPERTY], TEXT_MARKER_SHAPE],
  ["==", ["get", "shape"], TEXT_MARKER_SHAPE],
];

const textMarkerFilter: maplibregl.FilterSpecification = [
  "all",
  pointGeometryFilter,
  textMarkerShapeFilter,
];

const nonTextMarkerPointFilter: maplibregl.FilterSpecification = [
  "all",
  pointGeometryFilter,
  ["!", textMarkerShapeFilter],
];

/**
 * Filter for the unclustered-point circle layer in cluster mode: every feature
 * without a `point_count`, excluding text markers when present so they render
 * only through the symbol layer rather than also as plain circles.
 */
function unclusteredPointFilter(hasTextMarkers: boolean): maplibregl.FilterSpecification {
  if (!hasTextMarkers) return ["!", ["has", "point_count"]];
  return [
    "all",
    ["!", ["has", "point_count"]],
    nonTextMarkerPointFilter,
  ] as maplibregl.FilterSpecification;
}

/**
 * Combine a sub-layer's geometry filter with the layer's per-feature filters:
 * the transient {@link GeoLibreLayer.timeFilter} (a Time-Slider-bound layer
 * only renders features inside the current timeline window) and the rule-based
 * visibility filter (a rule-based layer whose else rule is switched off hides
 * features matching no rule — see {@link ruleBasedVisibilityFilter}). Returns
 * the geometry filter unchanged when neither applies, so the common path
 * produces an identical spec and `ensureLayer` performs no filter update.
 *
 * Aggregate cluster layers (the bubble and its count) intentionally do not pass
 * through here: a cluster feature carries no time or rule property, so an
 * `["all", ...]` wrap would drop every cluster whenever a window or rule filter
 * is active. Per-feature layers (fill, line, point, heatmap, text) filter
 * correctly.
 *
 * @param layer - The store layer being synced.
 * @param geometryFilter - The sub-layer's own geometry-type filter.
 * @returns The combined filter, or the original when no extra filter applies.
 */
function withFeatureFilters(
  layer: GeoLibreLayer,
  geometryFilter: maplibregl.FilterSpecification,
): maplibregl.FilterSpecification {
  const filters: unknown[] = [];
  const timeFilter = layer.timeFilter;
  if (Array.isArray(timeFilter) && timeFilter.length > 0) {
    filters.push(timeFilter);
  }
  const ruleFilter = ruleBasedVisibilityFilter(layer.style);
  if (ruleFilter) filters.push(ruleFilter);
  if (filters.length === 0) return geometryFilter;
  return ["all", geometryFilter, ...filters] as unknown as maplibregl.FilterSpecification;
}

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
interface NativeFilterState {
  base: maplibregl.FilterSpecification | null;
  appliedKey: string;
}
const externalNativeBaseFilters = new WeakMap<maplibregl.Map, Map<string, NativeFilterState>>();

function nativeFilterStatesFor(map: maplibregl.Map): Map<string, NativeFilterState> {
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
function nativeLayerSupportsFilter(type: string): boolean {
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
 * layer's own filters: the transient Time-Slider window and the rule-based
 * hide-unmatched filter (see {@link ruleBasedVisibilityFilter}). Empty when
 * neither applies.
 */
function externalFeatureFilterExtras(layer: GeoLibreLayer): unknown[] {
  const extras: unknown[] = [];
  const timeFilter = layer.timeFilter;
  if (Array.isArray(timeFilter) && timeFilter.length > 0) {
    extras.push(timeFilter);
  }
  const ruleFilter = ruleBasedVisibilityFilter(layer.style);
  if (ruleFilter) extras.push(ruleFilter);
  return extras;
}

/**
 * Combine a base filter (an external layer's own filter, possibly null) with
 * the active per-feature extras into one MapLibre filter. Returns the base
 * unchanged (null stays null) when no extras apply.
 */
function combineExternalFilters(
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

/**
 * Apply (or clear) GeoLibre's per-feature filters — a Time-Slider window and
 * the rule-based hide-unmatched filter (see {@link ruleBasedVisibilityFilter})
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
 * @param layer - The store layer (reads `timeFilter` and the rule filter).
 */
function applyExternalNativeFeatureFilters(
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
      map.setFilter(nativeLayerId, state.base ?? undefined);
      states.delete(nativeLayerId);
    }
    return;
  }

  // Filters active: capture the control's base filter the first time, then
  // keep reusing it so repeated ticks combine rather than nest.
  let state = states.get(nativeLayerId);
  if (!state) {
    const base = (map.getFilter(nativeLayerId) as maplibregl.FilterSpecification) ?? null;
    state = { base, appliedKey: "" };
    states.set(nativeLayerId, state);
  }
  const combined = combineExternalFilters(state.base, extras)!;
  // Compare against the last filter we applied (not `getFilter`, which MapLibre
  // may have normalized) so an unchanged filter does not re-push on every tick.
  const combinedKey = JSON.stringify(combined);
  if (state.appliedKey !== combinedKey) {
    map.setFilter(nativeLayerId, combined);
    state.appliedKey = combinedKey;
  }
}

// Native layer ids whose zoom range GeoLibre has taken over. A pristine external
// layer keeps its source-declared range, but once the user sets a non-default
// range we keep applying the style range on every sync, including a later reset
// back to the full [0, 24] window.
const managedZoomRangeLayerIds = new Set<string>();

function clampLayerZoom(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_LAYER_ZOOM, Math.max(MIN_LAYER_ZOOM, value));
}

function styleLayerZoomRange(style: LayerStyle): {
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
// style range, taking the tighter bound on each end. This keeps a tile
// service's zoom floor/ceiling intact while still letting the user narrow the
// window from the Style panel. When the two ranges do not overlap the bounds
// are swapped so MapLibre never receives an inverted (minzoom > maxzoom) range.
function intersectZoomRange(
  nativeSpec: { minzoom?: number; maxzoom?: number },
  style: LayerStyle,
): { minzoom: number; maxzoom: number } {
  const styleRange = styleLayerZoomRange(style);
  const minzoom = Math.max(nativeSpec.minzoom ?? MIN_LAYER_ZOOM, styleRange.minzoom);
  const maxzoom = Math.min(nativeSpec.maxzoom ?? MAX_LAYER_ZOOM, styleRange.maxzoom);
  return {
    minzoom: Math.min(minzoom, maxzoom),
    maxzoom: Math.max(minzoom, maxzoom),
  };
}

export function syncLayer(map: maplibregl.Map, layer: GeoLibreLayer, beforeId?: string): void {
  if (isExternalNativeLayer(layer)) {
    syncExternalNativeLayer(map, layer, beforeId);
    return;
  }

  if (isPlaceholderLayer(layer)) return;

  if (layer.type === "geojson" && layer.geojson) {
    // 3D Z-value rendering hands the layer to the shared deck.gl overlay
    // (deckgl-viz plugin), which honors coordinate Z values that MapLibre's
    // flat 2D layers ignore. Drop any MapLibre rendering so the layer is not
    // drawn twice; toggling back off re-adds it through the paths below.
    // Data without real Z coordinates keeps the normal 2D render even if the
    // flag is set (e.g. a saved flag after a tool dropped the Z values), so
    // the flag never leaves a layer invisible; the Z scan is cached per
    // GeoJSON object.
    if (
      styleValue(layer.style, "elevation3dEnabled") === true &&
      geojsonHasZCoordinates(layer.geojson)
    ) {
      removeLayerFromMap(map, layer.id, layer);
      return;
    }
    if (shouldUseTiledRendering(layer.geojson)) {
      syncGeoJsonVtLayer(map, layer, beforeId);
    } else {
      syncGeoJsonLayer(map, layer, beforeId);
    }
    return;
  }

  if (
    layer.type === "raster" ||
    layer.type === "wms" ||
    layer.type === "wmts" ||
    layer.type === "xyz"
  ) {
    syncRasterTileLayer(map, layer, beforeId);
    return;
  }

  if (layer.type === "vector-tiles") {
    syncVectorTileLayer(map, layer, beforeId);
    return;
  }

  if (layer.type === "mbtiles") {
    syncMbtilesLayer(map, layer, beforeId);
    return;
  }

  if (layer.type === "video") {
    syncVideoLayer(map, layer, beforeId);
    return;
  }

  if (layer.type === "image") {
    syncImageLayer(map, layer, beforeId);
    return;
  }
}

function isExternalNativeLayer(layer: GeoLibreLayer): boolean {
  return getExternalNativeLayerIds(layer).length > 0;
}

function syncExternalNativeLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  const nativeLayerIds = getExternalNativeLayerIds(layer);
  if (isPMTilesExternalLayer(layer)) {
    ensurePMTilesExternalLayer(map, layer, nativeLayerIds, beforeId);
  }

  // Custom render layers (e.g. 3D Tiles) manage their own visibility, opacity,
  // and zoom behavior through the control that registered them, so the standard
  // visibility/paint/zoom-range sync below must be skipped — only ordering is
  // handled here.
  if (isExternalCustomLayer(layer)) {
    for (const nativeLayerId of nativeLayerIds) {
      moveLayer(map, nativeLayerId, beforeId);
      // Control-painted vector layers (e.g. Add Vector Layer's circle/fill/line
      // layers) still honor a Time Slider window and the rule-based
      // hide-unmatched filter: filtering is independent of the paint the
      // control owns. Native layers without a filter (deck.gl / 3D Tiles
      // custom layers) are skipped by the type guard.
      const nativeLayer = map.getLayer(nativeLayerId);
      if (nativeLayer && nativeLayerSupportsFilter(nativeLayer.type)) {
        applyExternalNativeFeatureFilters(map, nativeLayerId, layer);
      }
    }
    syncVectorControlPointSymbology(map, layer, beforeId);
    // A deck.gl raster has no real MapLibre style layer to move (it renders in a
    // `deck-layer-group-*` keyed by its beforeId prop), so forward the computed
    // beforeId to the control that owns it.
    if (layer.metadata.externalDeckLayer === true) {
      externalDeckLayerOrderHandler?.(layer.id, beforeId);
    }
    return;
  }

  if (isWaybackExternalRasterLayer(layer)) {
    syncWaybackExternalRasterLayer(map, layer, nativeLayerIds, beforeId);
    return;
  }

  if (isBasemapControlRasterLayer(layer)) {
    syncBasemapControlRasterLayer(map, layer, nativeLayerIds, beforeId);
    return;
  }

  if (isWebServiceTileRasterLayer(layer)) {
    syncWebServiceTileRasterLayer(map, layer, nativeLayerIds, beforeId);
    return;
  }

  // Generic external raster tiles registered by third-party plugins (e.g. a
  // titiler-served XYZ source) carry no recognized sourceKind, so they match
  // none of the handlers above. Honor the documented external-layer contract
  // (a `source` with `tiles` and `type: "raster"`) by building the source and
  // raster layer here instead of dropping through to the GeoJSON path below.
  // IMPORTANT: this is a structural catch-all, so add any new named raster
  // handler (new sourceKind) BEFORE this check — placing it after would let a
  // layer that also has `source.tiles` be intercepted by the generic path.
  if (isExternalRasterTileLayer(layer)) {
    syncExternalRasterTileLayer(map, layer, nativeLayerIds, beforeId);
    return;
  }

  ensureExternalGeoJsonNativeLayer(map, layer, nativeLayerIds, beforeId);

  const nativeFillLayerSpecs = nativeLayerIds
    .map((nativeLayerId) => getStyleLayerSpec(map, nativeLayerId))
    .filter(isFillStyleLayerSpec);

  if (layer.style.extrusionEnabled && nativeFillLayerSpecs.length > 0 && !controlOwnsPaint(layer)) {
    for (const nativeLayerId of nativeLayerIds) {
      setNativeLayerVisibility(map, nativeLayerId, "none");
    }

    for (const fillLayerSpec of nativeFillLayerSpecs) {
      const extrusionLayerId = externalExtrusionLayerId(fillLayerSpec.id);
      // The synthetic extrusion layer must honor the same per-feature filters
      // (Time Slider window, rule-based hide-unmatched) as the fill it
      // replaces. The copied fill filter may still carry a previously pushed
      // combined filter, so prefer the tracked base — the fill's own filter —
      // and re-apply the current extras on top so they never compound or go
      // stale.
      const tracked = nativeFilterStatesFor(map).get(fillLayerSpec.id);
      const baseFilter = tracked
        ? tracked.base
        : ((fillLayerSpec.filter as maplibregl.FilterSpecification) ?? null);
      const filter = combineExternalFilters(baseFilter, externalFeatureFilterExtras(layer));
      ensureLayer(
        map,
        extrusionLayerId,
        {
          id: extrusionLayerId,
          type: "fill-extrusion",
          source: fillLayerSpec.source,
          "source-layer": fillLayerSpec["source-layer"],
          filter: filter ?? undefined,
          ...intersectZoomRange(fillLayerSpec, layer.style),
          paint: fillExtrusionPaint(layer.style, layer.opacity),
          layout: { visibility: layer.visible ? "visible" : "none" },
        },
        beforeId,
      );
    }
    return;
  }

  for (const nativeLayerId of nativeLayerIds) {
    removeIfExists(map, externalExtrusionLayerId(nativeLayerId));
  }

  for (const nativeLayerId of nativeLayerIds) {
    const nativeLayer = map.getLayer(nativeLayerId);
    if (!nativeLayer) continue;

    setNativeLayerVisibility(map, nativeLayerId, layer.visible ? "visible" : "none");

    // Narrow the control-painted features to the Time Slider window (if the
    // layer is bound) and to the rule-based hide-unmatched filter (if the else
    // rule is switched off). Filtering is independent of paint, so this
    // applies even when the control owns the paint.
    if (nativeLayerSupportsFilter(nativeLayer.type)) {
      applyExternalNativeFeatureFilters(map, nativeLayerId, layer);
    }

    if (!controlOwnsPaint(layer)) {
      setExternalNativeLayerPaint(map, nativeLayerId, nativeLayer.type, layer);
    }
    // External layers carry their own zoom range from the control or tile
    // service that registered them, so we leave a pristine layer's native range
    // alone. Once the user moves off the defaults GeoLibre owns the range and
    // keeps applying it, so a later reset to the full [0, 24] window still takes
    // effect rather than stranding the layer at the narrowed range.
    const zoomRange = styleLayerZoomRange(layer.style);
    const isDefaultRange =
      zoomRange.minzoom === MIN_LAYER_ZOOM && zoomRange.maxzoom === MAX_LAYER_ZOOM;
    if (!isDefaultRange) {
      managedZoomRangeLayerIds.add(nativeLayerId);
    }
    if (managedZoomRangeLayerIds.has(nativeLayerId)) {
      setLayerZoomRange(map, nativeLayerId, zoomRange);
    }

    moveLayer(map, nativeLayerId, beforeId);
  }
}

function ensureExternalGeoJsonNativeLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  nativeLayerIds: string[],
  beforeId?: string,
): void {
  if (!layer.geojson) return;

  if (nativeLayerIds.length === 0) {
    console.warn(
      `[layer-sync] external native GeoJSON layer "${layer.id}" has no nativeLayerIds; skipping native layer creation`,
    );
    return;
  }

  const nativeSourceId =
    getExternalSourceIds(layer)[0] ??
    stringSource(layer.source.sourceId) ??
    sourceIdFromNativeLayerId(nativeLayerIds[0]) ??
    sourceId(layer.id);

  // Always refresh the source so re-registration with new geojson data takes
  // effect, then short-circuit only the layer creation when the native layers
  // already exist.
  if (!map.getSource(nativeSourceId)) {
    map.addSource(nativeSourceId, {
      type: "geojson",
      data: layer.geojson,
    });
  } else {
    (map.getSource(nativeSourceId) as maplibregl.GeoJSONSource).setData(layer.geojson);
  }

  if (nativeLayerIds.every((id) => map.getLayer(id))) return;

  const visibility = layer.visible ? "visible" : "none";
  const zoomRange = styleLayerZoomRange(layer.style);
  const geometryType = stringMetadata(layer.metadata.geometryType);
  const symbolLayer = layer.metadata.symbolLayer === true;
  const profile = detectGeometryProfile(layer.geojson);
  const primaryLayerId = nativeLayerIds[0];

  // Each registration is rendered with a single representative native layer
  // (the first nativeLayerId), chosen by the dominant geometry below. A
  // FeatureCollection mixing geometry types only renders the representative
  // one; callers that need every type drawn should register one entry per
  // geometry type (one nativeLayerId each).
  if (symbolLayer) {
    ensureLayer(
      map,
      primaryLayerId,
      {
        id: primaryLayerId,
        type: "symbol",
        source: nativeSourceId,
        ...zoomRange,
        layout: {
          "text-allow-overlap": true,
          // Literal glyph rendered at every feature as a sprite-free point
          // marker (an asterisk, not a property lookup). Symbol registrations
          // here carry no label field, so this is intentional placeholder text.
          "text-field": "*",
          "text-ignore-placement": true,
          "text-size": Math.max(8, styleValue(layer.style, "circleRadius") * 2.5),
          visibility,
        },
        paint: {
          "text-color": styleValue(layer.style, "fillColor"),
          "text-halo-color": styleValue(layer.style, "strokeColor"),
          "text-halo-width": styleValue(layer.style, "strokeWidth"),
          "text-opacity": layer.opacity,
        },
      },
      beforeId,
    );
    return;
  }

  if (geometryType === "point" || profile.hasPoint) {
    ensureLayer(
      map,
      primaryLayerId,
      {
        id: primaryLayerId,
        type: "circle",
        source: nativeSourceId,
        ...zoomRange,
        filter: ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
        paint: circlePaint(layer.style, layer.opacity),
        layout: { visibility },
      },
      beforeId,
    );
    return;
  }

  if (geometryType === "line" || profile.hasLine || profile.hasPolygon) {
    ensureLayer(
      map,
      primaryLayerId,
      {
        id: primaryLayerId,
        type: "line",
        source: nativeSourceId,
        ...zoomRange,
        filter: [
          "match",
          ["geometry-type"],
          ["LineString", "MultiLineString", "Polygon", "MultiPolygon"],
          true,
          false,
        ],
        paint: linePaint(layer.style, layer.opacity),
        layout: { visibility },
      },
      beforeId,
    );
  }
}

function sourceIdFromNativeLayerId(layerId: string | undefined): string | null {
  return layerId ? `${layerId}-source` : null;
}

function isPMTilesExternalLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "pmtiles" &&
    layer.metadata.sourceKind === "pmtiles-url" &&
    layer.metadata.externalNativeLayer === true
  );
}

function isExternalCustomLayer(layer: GeoLibreLayer): boolean {
  return typeof layer.metadata.customLayerType === "string";
}

// External controls that paint their native layers with data-driven MapLibre
// expressions (selection-based color, radius, opacity, ...) cannot express that
// paint through GeoLibre's flat per-layer style. They opt in with this flag so
// the sync below keeps managing visibility, zoom range, and ordering while
// leaving the control's own paint untouched. Unlike `customLayerType`, which
// drops the layer onto an ordering-only path, these layers still respond to the
// panel's show/hide and reorder controls.
function controlOwnsPaint(layer: GeoLibreLayer): boolean {
  return layer.metadata.controlOwnsPaint === true;
}

function ensurePMTilesExternalLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  nativeLayerIds: string[],
  beforeId?: string,
): void {
  const rawUrl = stringSource(layer.source.url) ?? layer.sourcePath;
  const sourceId = getPMTilesSourceId(layer);
  if (!rawUrl || !sourceId) return;

  ensurePMTilesProtocol(rawUrl);

  if (!map.getSource(sourceId)) {
    const tileUrl = normalizePMTilesUrl(rawUrl);
    if (getPMTilesTileType(layer) === "raster") {
      map.addSource(sourceId, {
        type: "raster",
        url: tileUrl,
        tileSize: 256,
      });
    } else {
      map.addSource(sourceId, {
        type: "vector",
        url: tileUrl,
      });
    }
  }

  if (getPMTilesTileType(layer) === "raster") {
    ensureLayer(
      map,
      nativeLayerIds[0] ?? `${sourceId}-raster`,
      {
        id: nativeLayerIds[0] ?? `${sourceId}-raster`,
        type: "raster",
        source: sourceId,
        ...styleLayerZoomRange(layer.style),
        paint: rasterPaint(layer.style, layer.opacity),
        layout: { visibility: layer.visible ? "visible" : "none" },
      },
      beforeId,
    );
    return;
  }

  const sourceLayers = getPMTilesRenderableSourceLayers(layer, sourceId, nativeLayerIds);

  if (sourceLayers.length === 0) {
    // Vector tile sources require a `source-layer` on every layer. With no
    // known source layer there is nothing valid to render, so skip rather
    // than add a layer MapLibre would reject at runtime.
    return;
  }

  for (const sourceLayer of sourceLayers) {
    const fillId = getPMTilesNativeLayerId(
      nativeLayerIds,
      pmtilesVectorLayerId(sourceId, sourceLayer, "fill"),
    );
    const lineId = getPMTilesNativeLayerId(
      nativeLayerIds,
      pmtilesVectorLayerId(sourceId, sourceLayer, "line"),
    );
    const circleId = getPMTilesNativeLayerId(
      nativeLayerIds,
      pmtilesVectorLayerId(sourceId, sourceLayer, "circle"),
    );

    ensureLayer(
      map,
      fillId,
      {
        id: fillId,
        type: "fill",
        source: sourceId,
        "source-layer": sourceLayer,
        ...styleLayerZoomRange(layer.style),
        filter: withFeatureFilters(layer, ["==", ["geometry-type"], "Polygon"]),
        paint: fillPaint(layer.style, layer.opacity),
        layout: { visibility: layer.visible ? "visible" : "none" },
      },
      beforeId,
    );

    ensureLayer(
      map,
      lineId,
      {
        id: lineId,
        type: "line",
        source: sourceId,
        "source-layer": sourceLayer,
        ...styleLayerZoomRange(layer.style),
        filter: withFeatureFilters(layer, [
          "any",
          ["==", ["geometry-type"], "LineString"],
          ["==", ["geometry-type"], "Polygon"],
        ]),
        paint: linePaint(layer.style, layer.opacity),
        layout: { visibility: layer.visible ? "visible" : "none" },
      },
      beforeId,
    );

    ensureLayer(
      map,
      circleId,
      {
        id: circleId,
        type: "circle",
        source: sourceId,
        "source-layer": sourceLayer,
        ...styleLayerZoomRange(layer.style),
        filter: withFeatureFilters(layer, ["==", ["geometry-type"], "Point"]),
        paint: circlePaint(layer.style, layer.opacity),
        layout: { visibility: layer.visible ? "visible" : "none" },
      },
      beforeId,
    );
  }
}

function ensurePMTilesProtocol(url: string): void {
  const protocol = getSharedPMTilesProtocol();

  // Register the same instance we add archives to so MapLibre routes tile
  // requests through it. isMapLibreProtocolRegistered() reflects MapLibre's
  // live state, so this also re-registers after setStyle() clears protocols.
  if (!isMapLibreProtocolRegistered()) {
    addProtocol(PMTILES_PROTOCOL, protocol.tile);
  }

  // A key may already be backed by an in-memory archive from
  // registerPMTilesArchive(); re-adding would silently replace it with a
  // FetchSource for a URL that does not exist.
  const key = stripPMTilesProtocol(url);
  if (!protocol.tiles.has(key)) {
    protocol.add(new PMTiles(key));
  }
}

/**
 * The MapLibre layer ids `syncLayers` creates for a `pmtiles` store layer, in
 * the exact naming scheme `ensurePMTilesExternalLayer` uses. A layer built
 * outside the PMTiles control (e.g. the offline basemap extract dialog) must
 * put these in `metadata.nativeLayerIds` — a non-empty list is what marks the
 * layer renderable rather than a placeholder.
 */
export function pmtilesNativeLayerIds(
  sourceId: string,
  tileType: "vector" | "raster",
  sourceLayers: readonly string[],
): string[] {
  if (tileType === "raster") {
    return [`${sourceId}-raster`];
  }
  return sourceLayers.flatMap((sourceLayer) =>
    ["fill", "line", "circle"].map((kind) => pmtilesVectorLayerId(sourceId, sourceLayer, kind)),
  );
}

/** Facts about a PMTiles archive needed to build a GeoLibre layer for it. */
export interface PMTilesArchiveInfo {
  tileType: "vector" | "raster";
  /** Vector-tile layer ids from the archive metadata (empty for raster). */
  sourceLayers: string[];
  /** `[minLon, minLat, maxLon, maxLat]` from the archive header. */
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
}

/**
 * Reads the header (and, for vector archives, the metadata's `vector_layers`)
 * of an in-memory PMTiles archive, so callers can construct a properly-shaped
 * `pmtiles` store layer for it.
 */
export async function readPMTilesArchiveInfo(bytes: Uint8Array): Promise<PMTilesArchiveInfo> {
  const file = new File([bytes as BlobPart], "archive.pmtiles", {
    type: "application/octet-stream",
  });
  const archive = new PMTiles(new FileSource(file));
  const header = await archive.getHeader();
  // PMTiles TileType: 1 = MVT (vector); everything else renders as raster.
  const tileType = header.tileType === 1 ? "vector" : "raster";
  let sourceLayers: string[] = [];
  if (tileType === "vector") {
    try {
      const metadata = (await archive.getMetadata()) as {
        vector_layers?: Array<{ id?: unknown }>;
      };
      sourceLayers = (metadata.vector_layers ?? [])
        .map((layer) => layer.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    } catch {
      // Metadata is optional; a vector archive without it still renders once
      // the user knows its layer names.
    }
  }
  return {
    tileType,
    sourceLayers,
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
  };
}

/**
 * Registers an in-memory PMTiles archive (e.g. an offline basemap extract)
 * under a synthetic key so store layers can reference it like any remote
 * archive. Returns the `pmtiles://<key>` URL to use as the layer's
 * `source.url` / `sourcePath`.
 *
 * Re-registering the same key replaces the previous bytes. The archive is
 * freed when its layer is removed (see {@link unregisterPMTilesArchive},
 * invoked from {@link removeLayerFromMap}), so repeated extract-and-remove
 * cycles don't pin every archive's bytes for the page session.
 */
export function registerPMTilesArchive(key: string, bytes: Uint8Array): string {
  const protocol = getSharedPMTilesProtocol();
  if (!isMapLibreProtocolRegistered()) {
    addProtocol(PMTILES_PROTOCOL, protocol.tile);
  }
  const name = stripPMTilesProtocol(key);
  const file = new File([bytes as BlobPart], name, {
    type: "application/octet-stream",
  });
  // Keyed explicitly (not via protocol.add) so the lookup key is exactly the
  // name embedded in the layer URL, independent of FileSource.getKey().
  protocol.tiles.set(name, new PMTiles(new FileSource(file)));
  getRegisteredPMTilesArchiveKeys().add(name);
  return `${PMTILES_PROTOCOL}://${name}`;
}

/**
 * Frees an in-memory archive registered by {@link registerPMTilesArchive}.
 *
 * Only keys this module registered are removed, so passing a remote
 * `pmtiles://` URL (a lightweight `FetchSource` that may be shared by other
 * layers) is a safe no-op. Returns whether an archive was actually removed.
 */
export function unregisterPMTilesArchive(key: string): boolean {
  const name = stripPMTilesProtocol(key);
  const registered = getRegisteredPMTilesArchiveKeys();
  if (!registered.has(name)) return false;
  registered.delete(name);
  return getSharedPMTilesProtocol().tiles.delete(name);
}

/** Whether an in-memory archive was registered under `key` this session — lets
 * a caller decide between reusing it and reloading its bytes from disk. */
export function hasPMTilesArchive(key: string): boolean {
  return getRegisteredPMTilesArchiveKeys().has(stripPMTilesProtocol(key));
}

/**
 * Ensures the `pmtiles://` protocol is registered with MapLibre and a *remote*
 * archive at `url` is available to it, backed by a lightweight FetchSource over
 * HTTP range requests. Needed when a basemap *style* (not a store layer)
 * references `pmtiles://<remote-url>` — the layer-sync path that normally
 * registers the protocol never runs for a raw style. Idempotent and safe to
 * call before the style is applied; accepts a bare `https://…` URL or a
 * `pmtiles://…` URL.
 */
export function ensureRemotePMTilesArchive(url: string): void {
  ensurePMTilesProtocol(url);
}

// The set of in-memory-archive keys lives on globalThis alongside the shared
// Protocol, so the two share a lifetime across module reloads (HMR) and never
// drift — a stale module-level set could otherwise refuse to free archives the
// live protocol still holds.
function getRegisteredPMTilesArchiveKeys(): Set<string> {
  const globalScope = globalThis as typeof globalThis & {
    [PMTILES_ARCHIVE_KEYS_GLOBAL_KEY]?: Set<string>;
  };
  if (!globalScope[PMTILES_ARCHIVE_KEYS_GLOBAL_KEY]) {
    globalScope[PMTILES_ARCHIVE_KEYS_GLOBAL_KEY] = new Set<string>();
  }
  return globalScope[PMTILES_ARCHIVE_KEYS_GLOBAL_KEY];
}

function getSharedPMTilesProtocol(): Protocol {
  const globalScope = globalThis as typeof globalThis & {
    [PMTILES_PROTOCOL_GLOBAL_KEY]?: Protocol;
  };
  if (!globalScope[PMTILES_PROTOCOL_GLOBAL_KEY]) {
    globalScope[PMTILES_PROTOCOL_GLOBAL_KEY] = new Protocol();
  }
  return globalScope[PMTILES_PROTOCOL_GLOBAL_KEY];
}

function isMapLibreProtocolRegistered(): boolean {
  return Boolean(
    (
      config as {
        REGISTERED_PROTOCOLS?: Record<string, unknown>;
      }
    ).REGISTERED_PROTOCOLS?.[PMTILES_PROTOCOL],
  );
}

function normalizePMTilesUrl(url: string): string {
  return url.startsWith(`${PMTILES_PROTOCOL}://`) ? url : `${PMTILES_PROTOCOL}://${url}`;
}

function stripPMTilesProtocol(url: string): string {
  return url.startsWith(`${PMTILES_PROTOCOL}://`)
    ? url.slice(`${PMTILES_PROTOCOL}://`.length)
    : url;
}

function getPMTilesSourceId(layer: GeoLibreLayer): string | undefined {
  return stringMetadata(layer.metadata.sourceId) ?? stringSource(layer.source.sourceId) ?? layer.id;
}

function getPMTilesTileType(layer: GeoLibreLayer): "raster" | "vector" {
  return layer.metadata.tileType === "raster" || layer.source.type === "raster"
    ? "raster"
    : "vector";
}

function getPMTilesRenderableSourceLayers(
  layer: GeoLibreLayer,
  sourceId: string,
  nativeLayerIds: string[],
): string[] {
  const sourceLayers = getPMTilesSourceLayers(layer);
  const savedSourceLayers = sourceLayers.filter((sourceLayer) =>
    hasPMTilesNativeSourceLayer(nativeLayerIds, sourceId, sourceLayer),
  );

  return savedSourceLayers.length > 0 ? savedSourceLayers : sourceLayers;
}

function hasPMTilesNativeSourceLayer(
  nativeLayerIds: string[],
  sourceId: string,
  sourceLayer: string,
): boolean {
  return ["fill", "line", "circle"].some((kind) =>
    nativeLayerIds.includes(pmtilesVectorLayerId(sourceId, sourceLayer, kind)),
  );
}

function pmtilesVectorLayerId(sourceId: string, sourceLayer: string, kind: string): string {
  return `${sourceId}-${encodeVectorTileLayerPart(sourceLayer)}-${kind}`;
}

function getPMTilesSourceLayers(layer: GeoLibreLayer): string[] {
  const sourceLayers = layer.source.sourceLayers ?? layer.metadata.sourceLayers;
  return Array.isArray(sourceLayers)
    ? sourceLayers.filter(
        (sourceLayer): sourceLayer is string =>
          typeof sourceLayer === "string" && sourceLayer.length > 0,
      )
    : [];
}

function getPMTilesNativeLayerId(nativeLayerIds: string[], fallbackId: string): string {
  return nativeLayerIds.find((nativeLayerId) => nativeLayerId === fallbackId) ?? fallbackId;
}

function isWaybackExternalRasterLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "raster" &&
    (layer.metadata.sourceKind === "esri-wayback-current" ||
      layer.metadata.sourceKind === "esri-wayback-persistent") &&
    layer.metadata.externalNativeLayer === true
  );
}

function syncWaybackExternalRasterLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  nativeLayerIds: string[],
  beforeId?: string,
): void {
  const nativeLayerId = nativeLayerIds[0] ?? layer.id;
  const sourceId = getExternalSourceIds(layer)[0] ?? `${nativeLayerId}-source`;
  const tileUrl = getWaybackTileUrl(layer);
  if (!tileUrl) return;

  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, {
      type: "raster",
      tiles: [tileUrl],
      tileSize: 256,
      maxzoom: 23,
    });
  }

  ensureLayer(
    map,
    nativeLayerId,
    {
      id: nativeLayerId,
      type: "raster",
      source: sourceId,
      ...styleLayerZoomRange(layer.style),
      paint: rasterPaint(layer.style, layer.opacity),
      layout: { visibility: layer.visible ? "visible" : "none" },
    },
    beforeId,
  );
}

function isBasemapControlRasterLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "raster" &&
    layer.metadata.sourceKind === "maplibre-basemap-control" &&
    layer.metadata.externalNativeLayer === true
  );
}

// A raster layer registered by a third-party plugin through
// registerExternalNativeLayer that supplies its own XYZ tile template(s) in
// `source.tiles`. Unlike the basemap/web-service/PMTiles raster paths above it
// carries no GeoLibre-internal sourceKind, so it is matched structurally: any
// external raster layer with concrete tiles and no dedicated handler.
function isExternalRasterTileLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "raster" &&
    layer.metadata.externalNativeLayer === true &&
    getSourceTiles(layer).length > 0
  );
}

// Build the MapLibre source and raster layer for a generic external raster tile
// registration. Mirrors syncBasemapControlRasterLayer/syncWebServiceTileRasterLayer
// but reads everything from the registration's own `source`, so any plugin that
// hands GeoLibre an XYZ raster source renders without needing a bespoke handler.
function syncExternalRasterTileLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  nativeLayerIds: string[],
  beforeId?: string,
): void {
  const nativeLayerId = nativeLayerIds[0] ?? layer.id;
  const sourceId = getExternalSourceIds(layer)[0] ?? `${nativeLayerId}-source`;
  const tiles = getSourceTiles(layer);
  if (tiles.length === 0) return;

  // The source is built once and never rebuilt while it exists, matching the
  // other raster handlers above. A plugin that re-registers the same sourceId
  // with a different `tiles` array will keep serving the original tiles; to
  // switch tile URLs it must register under a new sourceId.
  if (!map.getSource(sourceId)) {
    const bounds = boundsSource(layer.source.bounds);
    map.addSource(sourceId, {
      type: "raster",
      tiles,
      tileSize: numberSource(layer.source.tileSize) ?? 256,
      ...(numberSource(layer.source.minzoom) !== undefined
        ? { minzoom: numberSource(layer.source.minzoom) }
        : {}),
      ...(numberSource(layer.source.maxzoom) !== undefined
        ? { maxzoom: numberSource(layer.source.maxzoom) }
        : {}),
      ...(bounds ? { bounds } : {}),
      ...(layer.source.scheme === "tms" ? { scheme: "tms" as const } : {}),
      ...(stringSource(layer.source.attribution)
        ? { attribution: stringSource(layer.source.attribution) }
        : {}),
    });
  }

  ensureLayer(
    map,
    nativeLayerId,
    {
      id: nativeLayerId,
      type: "raster",
      source: sourceId,
      ...styleLayerZoomRange(layer.style),
      paint: rasterPaint(layer.style, layer.opacity),
      layout: { visibility: layer.visible ? "visible" : "none" },
    },
    beforeId,
  );
}

// Raster basemaps selected in the basemap control are normally rendered by the
// control itself. Rebuilding them here too keeps them on the map after a style
// reload (e.g. reopening a project), where the control does not replay them.
// The native source/layer ids match the control's deterministic ids, so this
// is idempotent during a live session.
function syncBasemapControlRasterLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  nativeLayerIds: string[],
  beforeId?: string,
): void {
  const nativeLayerId = nativeLayerIds[0] ?? layer.id;
  const sourceId = getExternalSourceIds(layer)[0] ?? `${nativeLayerId}-source`;
  const tiles = getBasemapControlTiles(layer);
  if (tiles.length === 0) return;

  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, {
      type: "raster",
      tiles,
      tileSize: numberSource(layer.source.tileSize) ?? 256,
      ...(numberSource(layer.source.minzoom) !== undefined
        ? { minzoom: numberSource(layer.source.minzoom) }
        : {}),
      ...(numberSource(layer.source.maxzoom) !== undefined
        ? { maxzoom: numberSource(layer.source.maxzoom) }
        : {}),
      ...(layer.source.scheme === "tms" ? { scheme: "tms" as const } : {}),
      ...(stringSource(layer.source.attribution)
        ? { attribution: stringSource(layer.source.attribution) }
        : {}),
    });
  }

  ensureLayer(
    map,
    nativeLayerId,
    {
      id: nativeLayerId,
      type: "raster",
      source: sourceId,
      ...styleLayerZoomRange(layer.style),
      paint: rasterPaint(layer.style, layer.opacity),
      layout: { visibility: layer.visible ? "visible" : "none" },
    },
    beforeId,
  );
}

// Store-layer metadata.sourceKind values written by the Web Services
// plugins. Each entry pairs with a plugin id in WEB_SERVICE_PLUGIN_IDS in
// @geolibre/plugins' web-service-sync; keep the two lists in step when
// adding a web service plugin.
const WEB_SERVICE_SOURCE_KINDS = new Set([
  "fema-wms",
  "nasa-earthdata",
  "enviroatlas",
  "national-map",
]);

function isWebServiceTileRasterLayer(layer: GeoLibreLayer): boolean {
  return (
    (layer.type === "raster" || layer.type === "wms") &&
    typeof layer.metadata.sourceKind === "string" &&
    WEB_SERVICE_SOURCE_KINDS.has(layer.metadata.sourceKind) &&
    layer.metadata.externalNativeLayer === true
  );
}

// Web service layers (FEMA NFHL, NASA Earthdata, US EPA EnviroAtlas, USGS
// National Map) are normally rendered by their panel controls. Rebuilding
// them here keeps them on the map after a style reload (e.g. reopening a
// project), where the controls do not replay them. The native source/layer
// ids match the controls' deterministic ids, so this is idempotent during a
// live session.
function syncWebServiceTileRasterLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  nativeLayerIds: string[],
  beforeId?: string,
): void {
  const nativeLayerId = nativeLayerIds[0] ?? layer.id;
  const sourceId = getExternalSourceIds(layer)[0] ?? `${nativeLayerId}-source`;
  const tiles = getWebServiceTiles(layer);
  if (tiles.length === 0) return;

  if (!map.getSource(sourceId)) {
    const bounds = boundsSource(layer.source.bounds);
    map.addSource(sourceId, {
      type: "raster",
      tiles,
      tileSize: numberSource(layer.source.tileSize) ?? 256,
      ...(numberSource(layer.source.minzoom) !== undefined
        ? { minzoom: numberSource(layer.source.minzoom) }
        : {}),
      ...(numberSource(layer.source.maxzoom) !== undefined
        ? { maxzoom: numberSource(layer.source.maxzoom) }
        : {}),
      ...(bounds ? { bounds } : {}),
      ...(stringSource(layer.source.attribution)
        ? { attribution: stringSource(layer.source.attribution) }
        : {}),
    });
  }

  ensureLayer(
    map,
    nativeLayerId,
    {
      id: nativeLayerId,
      type: "raster",
      source: sourceId,
      ...styleLayerZoomRange(layer.style),
      paint: rasterPaint(layer.style, layer.opacity),
      layout: { visibility: layer.visible ? "visible" : "none" },
    },
    beforeId,
  );
}

// WMS-style web service tiles carry a {bbox-epsg-3857} placeholder and hit
// federal endpoints without permissive CORS headers, so the dev server
// routes them through the WMS proxy. The external-native path bypasses
// getRenderableRasterTiles, hence the dedicated proxying here.
function getWebServiceTiles(layer: GeoLibreLayer): string[] {
  const tiles = getBasemapControlTiles(layer);
  if (layer.type !== "wms" || !isViteDevServer()) return tiles;
  return tiles.map((tile) =>
    // Skip already proxied templates so repeated sync passes cannot nest
    // proxy URLs.
    tile.includes("{bbox-epsg-3857}") && !tile.startsWith(WMS_PROXY_PATH)
      ? proxyWmsTileUrl(tile)
      : tile,
  );
}

function boundsSource(value: unknown): [number, number, number, number] | undefined {
  return Array.isArray(value) &&
    value.length === 4 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
    ? (value as [number, number, number, number])
    : undefined;
}

// Concrete XYZ tile templates from the registration's own `source.tiles`. This
// is the documented external-raster contract and the only source the generic
// external-raster path reads — it deliberately does not look at
// metadata.tileUrl (see getBasemapControlTiles for that basemap-internal key).
function getSourceTiles(layer: GeoLibreLayer): string[] {
  const tiles = layer.source.tiles;
  if (!Array.isArray(tiles)) return [];
  return tiles.filter((tile): tile is string => typeof tile === "string" && tile.length > 0);
}

function getBasemapControlTiles(layer: GeoLibreLayer): string[] {
  const tiles = getSourceTiles(layer);
  if (tiles.length > 0) return tiles;
  // The basemap control stores its single tile template under this internal
  // metadata key rather than source.tiles; that fallback is specific to the
  // basemap/web-service paths and intentionally not part of getSourceTiles.
  const tileUrl = stringMetadata(layer.metadata.tileUrl);
  return tileUrl ? [tileUrl] : [];
}

function numberSource(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getWaybackTileUrl(layer: GeoLibreLayer): string | null {
  const rawUrl =
    stringMetadata(layer.metadata.waybackItemUrl) ??
    stringSource(layer.source.url) ??
    layer.sourcePath;
  if (!rawUrl) return null;
  return rawUrl
    .replace(/\{level\}/g, "{z}")
    .replace(/\{row\}/g, "{y}")
    .replace(/\{col\}/g, "{x}");
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringSource(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function setNativeLayerVisibility(
  map: maplibregl.Map,
  nativeLayerId: string,
  visibility: "visible" | "none",
): void {
  try {
    map.setLayoutProperty(nativeLayerId, "visibility", visibility);
  } catch {
    // Custom layers from external controls may not accept layout updates.
  }
}

function getStyleLayerSpec(
  map: maplibregl.Map,
  layerId: string,
): maplibregl.LayerSpecification | null {
  return map.getStyle().layers?.find((layer) => layer.id === layerId) ?? null;
}

function isFillStyleLayerSpec(
  layer: maplibregl.LayerSpecification | null,
): layer is maplibregl.FillLayerSpecification {
  return layer?.type === "fill";
}

export function externalExtrusionLayerId(nativeLayerId: string): string {
  return `${nativeLayerId}-geolibre-extrusion`;
}

/**
 * Marker-icon and proportional-size rendering for a point layer owned by the
 * Add Vector Layer control (maplibre-gl-vector). The control's VectorLayerStyle
 * carries no marker or data-driven-radius concept, so those Style-panel
 * options would otherwise silently no-op on control-managed layers. Following
 * the synthetic-extrusion pattern in {@link syncExternalNativeLayer}, GeoLibre
 * renders them itself on top of the control's own source:
 *
 * - Marker enabled: the control's circle layer is hidden and a GeoLibre-owned
 *   symbol layer ({@link markerLayerId}) draws the baked sprite per point,
 *   honoring proportional sizing through its `icon-size` interpolate.
 * - Proportional size without a marker: the control circle's `circle-radius`
 *   is overridden with the shared interpolate; when proportional sizing turns
 *   off the flat radius is restored and the control owns the paint again.
 *
 * Scoped to the control's single-point render (GeoLibre's "single" renderer /
 * the control's "circle" pointMode); the cluster and heatmap renderers keep
 * the control's own layers untouched.
 */
function syncVectorControlPointSymbology(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  if (layer.metadata.sourceKind !== "maplibre-gl-vector") return;
  const syntheticMarkerId = markerLayerId(layer.id);
  const singleRenderer = styleValue(layer.style, "pointRenderer") === "single";
  const circleNativeId = getExternalNativeLayerIds(layer).find(
    (id) => map.getLayer(id)?.type === "circle",
  );
  if (!singleRenderer || !circleNativeId) {
    // Cluster/heatmap modes rebuild the control's native layers, so the old
    // overlay (if any) just needs dropping. If the control ever reused a
    // still-live circle id across the mode switch, also hand back its radius
    // so a stale proportional interpolate cannot bleed into the new renderer.
    removeIfExists(map, syntheticMarkerId);
    if (circleNativeId) {
      restoreOverriddenCircleRadius(map, circleNativeId, layer);
    }
    return;
  }

  const circleSpec = getStyleLayerSpec(map, circleNativeId);
  ensureGeneratedImageHandler(map);
  const markerImageId = prepareMarker(layer.style);

  if (markerImageId && circleSpec) {
    // Reuse the control's own base filter (the tracked base when Time-Slider /
    // rule extras are active, so they never nest) combined with the current
    // extras, mirroring applyExternalNativeFeatureFilters.
    const tracked = nativeFilterStatesFor(map).get(circleNativeId);
    const base = tracked
      ? tracked.base
      : (("filter" in circleSpec ? (circleSpec.filter as maplibregl.FilterSpecification) : null) ??
        null);
    const filter = combineExternalFilters(base, externalFeatureFilterExtras(layer));
    const sourceLayer = "source-layer" in circleSpec ? circleSpec["source-layer"] : undefined;
    ensureLayer(
      map,
      syntheticMarkerId,
      {
        id: syntheticMarkerId,
        type: "symbol",
        source: (circleSpec as { source: string }).source,
        ...(sourceLayer ? { "source-layer": sourceLayer } : {}),
        ...styleLayerZoomRange(layer.style),
        // Always present so clearing the extras also clears the layer filter
        // on the update path (ensureLayer only diffs keys that exist).
        filter: filter ?? undefined,
        layout: {
          "icon-image": markerImageId,
          "icon-size": markerIconSizeValue(layer.style) as PropertyValueSpecification<number>,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          visibility: layer.visible ? "visible" : "none",
        },
        paint: { "icon-opacity": layer.opacity },
      },
      beforeId,
    );
    // The control keeps managing its circle's visibility (and re-shows it on
    // its own toggles), but every sync re-hides it while the marker overlay is
    // active, so the points never render twice.
    setNativeLayerVisibility(map, circleNativeId, "none");
    return;
  }

  // No marker: drop the overlay and hand the point render back to the control.
  if (map.getLayer(syntheticMarkerId)) {
    removeIfExists(map, syntheticMarkerId);
    setNativeLayerVisibility(map, circleNativeId, layer.visible ? "visible" : "none");
  }

  // Proportional size on the control's flat circle: hold the override while
  // active; once off, restore the flat radius and leave the paint to the
  // control again. Deliberately proportional-only (not circleRadiusValue):
  // rule-based per-rule sizes stay a store-managed-layer feature, since none
  // of the other rule-based paint overrides apply to control-owned layers.
  const radius = proportionalRadiusExpression(layer.style);
  if (radius) {
    map.setPaintProperty(circleNativeId, "circle-radius", radius);
    overriddenRadiusIdsFor(map).add(circleNativeId);
  } else {
    restoreOverriddenCircleRadius(map, circleNativeId, layer);
  }
}

// Control-owned circle layers whose circle-radius GeoLibre has overridden with
// the proportional interpolate. Tracked (like externalNativeBaseFilters, keyed
// per map so two maps sharing a native layer id never see each other's state)
// so the restore only ever touches a layer this module actually overrode —
// never a control-authored expression such as the cluster renderer's stepped
// radius.
const overriddenRadiusNativeLayerIds = new WeakMap<maplibregl.Map, Set<string>>();

function overriddenRadiusIdsFor(map: maplibregl.Map): Set<string> {
  let ids = overriddenRadiusNativeLayerIds.get(map);
  if (!ids) {
    ids = new Set();
    overriddenRadiusNativeLayerIds.set(map, ids);
  }
  return ids;
}

/** Hand an overridden circle-radius back to the control's flat value. */
function restoreOverriddenCircleRadius(
  map: maplibregl.Map,
  circleNativeId: string,
  layer: GeoLibreLayer,
): void {
  if (!overriddenRadiusIdsFor(map).delete(circleNativeId)) return;
  map.setPaintProperty(circleNativeId, "circle-radius", styleValue(layer.style, "circleRadius"));
}

function setExternalNativeLayerPaint(
  map: maplibregl.Map,
  nativeLayerId: string,
  nativeLayerType: string,
  layer: GeoLibreLayer,
): void {
  const paint =
    nativeLayerType === "fill"
      ? fillPaint(layer.style, layer.opacity)
      : nativeLayerType === "line"
        ? linePaint(layer.style, layer.opacity)
        : nativeLayerType === "circle"
          ? circlePaint(layer.style, layer.opacity)
          : nativeLayerType === "raster"
            ? rasterPaint(layer.style, layer.opacity)
            : null;

  if (!paint) return;

  for (const [property, value] of Object.entries(paint)) {
    try {
      map.setPaintProperty(nativeLayerId, property, value);
    } catch {
      // External controls can create heterogeneous style layers. Ignore paint
      // properties that do not apply to a specific native layer type.
    }
  }
}

// Resolve the point renderer and clustering parameters from a layer's style.
// The heatmap and cluster renderers only make sense for point geometry, so the
// setting is ignored on layers that also carry lines/polygons. Shared by the
// inline and tiled geojson paths so renderer detection lives in one place.
function resolveVectorRenderMode(
  layer: GeoLibreLayer,
  profile: ReturnType<typeof detectGeometryProfile>,
): {
  renderer: string;
  wantCluster: boolean;
  clusterRadius: number;
  clusterMaxZoom: number;
} {
  const pointOnly = profile.hasPoint && !profile.hasLine && !profile.hasPolygon;
  const renderer = pointOnly ? styleValue(layer.style, "pointRenderer") : "single";
  return {
    renderer,
    wantCluster: renderer === "cluster",
    clusterRadius: styleValue(layer.style, "clusterRadius"),
    clusterMaxZoom: styleValue(layer.style, "clusterMaxZoom"),
  };
}

function syncGeoJsonLayer(map: maplibregl.Map, layer: GeoLibreLayer, beforeId?: string): void {
  const src = sourceId(layer.id);
  const profile = detectGeometryProfile(layer.geojson!);
  const { renderer, wantCluster, clusterRadius, clusterMaxZoom } = resolveVectorRenderMode(
    layer,
    profile,
  );

  // A layer can drop below the tiling threshold (e.g. a processing tool shrinks
  // it), or some other code may have left a non-geojson source under this id.
  // Either way it must be removed before the inline path's setData runs, since
  // setData only works on a geojson source. Only free a tile index we actually
  // own (unregister is otherwise a harmless no-op).
  const existingSource = map.getSource(src) as maplibregl.Source | undefined;
  if (existingSource && existingSource.type !== "geojson") {
    removeGeoJsonRenderLayers(map, layer.id);
    map.removeSource(src);
    if (hasGeoJsonVtSource(layer.id)) unregisterGeoJsonVtSource(layer.id);
  }

  // Clustering is a source-level option, so toggling it (or changing its params)
  // means recreating the source — which first requires dropping every layer that
  // references it. MapLibre forbids removing a source still in use.
  const existingCluster = geojsonSourceClusterState(map, src);
  const needsSourceRecreate =
    existingCluster !== null &&
    (existingCluster.cluster !== wantCluster ||
      (wantCluster &&
        (existingCluster.radius !== clusterRadius || existingCluster.maxZoom !== clusterMaxZoom)));
  if (needsSourceRecreate) {
    removeGeoJsonRenderLayers(map, layer.id);
    map.removeSource(src);
  }

  if (!map.getSource(src)) {
    // Carry a source attribution (e.g. an ArcGIS service's copyrightText) into
    // MapLibre's attribution control when the layer declares one.
    const attribution = stringSource(layer.source.attribution);
    map.addSource(
      src,
      wantCluster
        ? {
            type: "geojson",
            data: layer.geojson!,
            cluster: true,
            clusterRadius,
            clusterMaxZoom,
            ...(attribution ? { attribution } : {}),
          }
        : {
            type: "geojson",
            data: layer.geojson!,
            ...(attribution ? { attribution } : {}),
          },
    );
  } else {
    (map.getSource(src) as maplibregl.GeoJSONSource).setData(layer.geojson!);
  }

  applyVectorDataRenderLayers(map, layer, src, profile, renderer, beforeId);
}

/**
 * Render local vector layers above {@link LARGE_VECTOR_FEATURE_THRESHOLD}
 * features through client-side vector tiles instead of one in-memory geojson
 * source. Reuses the same source id and render-layer ids as
 * {@link syncGeoJsonLayer}; only the source becomes `type:"vector"` (its tiles
 * served by the geojson-vt protocol) and render layers carry a `source-layer`.
 */
function syncGeoJsonVtLayer(map: maplibregl.Map, layer: GeoLibreLayer, beforeId?: string): void {
  const src = sourceId(layer.id);
  const profile = detectGeometryProfile(layer.geojson!);
  const { renderer, wantCluster, clusterRadius, clusterMaxZoom } = resolveVectorRenderMode(
    layer,
    profile,
  );

  ensureGeoJsonVtProtocol();

  // (Re)build the tile index when the data or clustering config changed. A
  // rebuild also means cached tiles are stale, so drop the source to force
  // MapLibre to refetch them.
  const rebuilt = registerGeoJsonVtSource(layer.id, layer.geojson!, {
    cluster: wantCluster,
    clusterRadius,
    clusterMaxZoom,
  });

  const existing = map.getSource(src) as maplibregl.Source | undefined;
  // The source must be recreated when switching in from the inline geojson path
  // (different source type) or when the index was rebuilt.
  if (existing && (existing.type !== "vector" || rebuilt)) {
    removeGeoJsonRenderLayers(map, layer.id);
    map.removeSource(src);
  }

  if (!map.getSource(src)) {
    map.addSource(src, {
      type: "vector",
      tiles: [geojsonVtTileUrl(layer.id)],
      minzoom: 0,
      maxzoom: TILE_MAX_ZOOM,
    });
  }

  applyVectorDataRenderLayers(map, layer, src, profile, renderer, beforeId, TILE_SOURCE_LAYER);
}

/**
 * Create/update the fill, line, circle, heatmap, cluster, and text render layers
 * for a vector data layer. Shared by the inline geojson path
 * ({@link syncGeoJsonLayer}, `sourceLayer` undefined) and the tiled path
 * ({@link syncGeoJsonVtLayer}, `sourceLayer` set), which differ only in whether
 * the underlying source is a geojson source or a vector-tile source. When
 * `sourceLayer` is provided, every render layer references it via `source-layer`.
 */
function applyVectorDataRenderLayers(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  src: string,
  profile: ReturnType<typeof detectGeometryProfile>,
  renderer: string,
  beforeId?: string,
  sourceLayer?: string,
): void {
  const sourceSpec: { source: string; "source-layer"?: string } = sourceLayer
    ? { source: src, "source-layer": sourceLayer }
    : { source: src };

  const visibility = layer.visible ? "visible" : "none";
  const opacity = layer.opacity;
  const hasTextMarkers = hasTextMarkerFeatures(layer.geojson!);
  // Lazy sprite generation for fill patterns and marker icons relies on the
  // map's styleimagemissing handler being installed before any layer references
  // a generated image id.
  ensureGeneratedImageHandler(map);
  const fillPatternId = prepareFillPattern(layer.style);
  const markerImageId = prepareMarker(layer.style);
  // Derived companion symbology (inverted mask, geometry generator, dedup
  // labels) is built from the raw features, so no MapLibre filter applies to
  // it. While a Time Slider window or a rule-based visibility filter is
  // active, those derivations would disagree with the visible data — skip
  // them for the duration, mirroring the dedup-label behavior.
  const hasFeatureFilter =
    (Array.isArray(layer.timeFilter) && layer.timeFilter.length > 0) ||
    ruleBasedVisibilityFilter(layer.style) !== null;

  if (profile.hasPolygon) {
    if (layer.style.extrusionEnabled) {
      removeIfExists(map, fillLayerId(layer.id));
      ensureLayer(
        map,
        fillExtrusionLayerId(layer.id),
        {
          id: fillExtrusionLayerId(layer.id),
          type: "fill-extrusion",
          ...sourceSpec,
          ...styleLayerZoomRange(layer.style),
          filter: withFeatureFilters(layer, [
            "match",
            ["geometry-type"],
            ["Polygon", "MultiPolygon"],
            true,
            false,
          ]),
          paint: fillExtrusionPaint(layer.style, opacity),
          layout: { visibility },
        },
        beforeId,
      );
    } else {
      removeIfExists(map, fillExtrusionLayerId(layer.id));
      const fillPaintSpec = {
        ...fillPaint(layer.style, opacity),
        // A set fill-pattern replaces fill-color with the recolorable
        // sprite tile; null resets it on the setPaintProperty update path in
        // ensureLayer (MapLibre documents null, not undefined, as the value
        // that removes a paint property — undefined can silently no-op and
        // leave a stale pattern rendered after the user selects "None"). The
        // cast is needed because FillLayerSpecification's paint type omits
        // null even though setPaintProperty accepts it as the reset value.
        "fill-pattern": (fillPatternId ?? null) as unknown as string,
      };
      // Inverted fill (QGIS "Inverted polygons"): the mask — everything
      // outside the features — takes the layer's fill, and the normal fill
      // layer is dropped so the features read as holes. The mask derives from
      // the raw features (no MapLibre filter applies to it), so while a
      // time-slider / rule-visibility filter is active — or when the mask
      // cannot be built (no polygons, oversized layer, clipper failure) — it
      // falls back to the normal filtered fill rather than disagreeing with
      // the visible data or rendering nothing.
      const invertedMask =
        styleValue(layer.style, "invertedFillEnabled") && !hasFeatureFilter && layer.geojson
          ? buildInvertedMask(layer.geojson)
          : null;
      if (invertedMask) {
        removeIfExists(map, fillLayerId(layer.id));
        const maskSrc = invertedSourceId(layer.id);
        if (map.getSource(maskSrc)) {
          (map.getSource(maskSrc) as maplibregl.GeoJSONSource).setData(invertedMask);
        } else {
          map.addSource(maskSrc, { type: "geojson", data: invertedMask });
        }
        ensureLayer(
          map,
          invertedFillLayerId(layer.id),
          {
            id: invertedFillLayerId(layer.id),
            type: "fill",
            source: maskSrc,
            ...styleLayerZoomRange(layer.style),
            metadata: { "geolibre:internal": true },
            paint: {
              ...fillPaintSpec,
              // The mask's outer ring is the world rectangle; its hairline
              // outline would draw a visible seam at the antimeridian/poles.
              // Hole edges are already outlined by the layer's line layer.
              "fill-outline-color": "rgba(0, 0, 0, 0)",
            },
            layout: { visibility },
          },
          beforeId,
        );
      } else {
        removeIfExists(map, invertedFillLayerId(layer.id));
        removeSourceIfExists(map, invertedSourceId(layer.id));
        ensureLayer(
          map,
          fillLayerId(layer.id),
          {
            id: fillLayerId(layer.id),
            type: "fill",
            ...sourceSpec,
            ...styleLayerZoomRange(layer.style),
            filter: withFeatureFilters(layer, [
              "match",
              ["geometry-type"],
              ["Polygon", "MultiPolygon"],
              true,
              false,
            ]),
            paint: fillPaintSpec,
            layout: { visibility },
          },
          beforeId,
        );
      }
    }
  } else {
    removeIfExists(map, fillLayerId(layer.id));
    removeIfExists(map, fillExtrusionLayerId(layer.id));
  }
  if (
    !profile.hasPolygon ||
    layer.style.extrusionEnabled ||
    !styleValue(layer.style, "invertedFillEnabled")
  ) {
    removeIfExists(map, invertedFillLayerId(layer.id));
    removeSourceIfExists(map, invertedSourceId(layer.id));
  }

  if (!layer.style.extrusionEnabled && (profile.hasLine || profile.hasPolygon)) {
    ensureLayer(
      map,
      lineLayerId(layer.id),
      {
        id: lineLayerId(layer.id),
        type: "line",
        ...sourceSpec,
        ...styleLayerZoomRange(layer.style),
        filter: withFeatureFilters(layer, [
          "match",
          ["geometry-type"],
          ["LineString", "MultiLineString", "Polygon", "MultiPolygon"],
          true,
          false,
        ]),
        paint: linePaint(layer.style, opacity),
        layout: { visibility },
      },
      beforeId,
    );
  } else {
    removeIfExists(map, lineLayerId(layer.id));
  }

  // Line decorations (QGIS marker-line / arrow lines): a symbol layer that
  // repeats the generated decoration icon along line features and polygon
  // outlines. With line placement MapLibre rotates the icon to follow the
  // line, so the arrow shape points along the feature's direction.
  const decorationImageId = prepareLineDecoration(layer.style);
  if (
    !layer.style.extrusionEnabled &&
    decorationImageId &&
    (profile.hasLine || profile.hasPolygon)
  ) {
    ensureLayer(
      map,
      lineDecorationLayerId(layer.id),
      {
        id: lineDecorationLayerId(layer.id),
        type: "symbol",
        ...sourceSpec,
        ...styleLayerZoomRange(layer.style),
        metadata: { "geolibre:internal": true },
        filter: withFeatureFilters(layer, [
          "match",
          ["geometry-type"],
          ["LineString", "MultiLineString", "Polygon", "MultiPolygon"],
          true,
          false,
        ]),
        layout: {
          "icon-image": decorationImageId,
          // The sprite is baked at its display size, matching the marker path.
          "icon-size": 1,
          "symbol-placement": "line",
          "symbol-spacing": Math.max(1, styleValue(layer.style, "lineDecorationSpacing")),
          // Decorations are deliberate symbology, so they must not thin out
          // under MapLibre's collision placement.
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-rotation-alignment": "map",
          visibility,
        },
        paint: { "icon-opacity": opacity },
      },
      beforeId,
    );
  } else {
    removeIfExists(map, lineDecorationLayerId(layer.id));
  }

  if (!layer.style.extrusionEnabled && profile.hasPoint && renderer === "heatmap") {
    // Heatmap renderer: one density layer, no circle/cluster/marker layers.
    removeIfExists(map, circleLayerId(layer.id));
    removeIfExists(map, markerLayerId(layer.id));
    removeIfExists(map, clusterLayerId(layer.id));
    removeIfExists(map, clusterCountLayerId(layer.id));
    ensureLayer(
      map,
      heatmapLayerId(layer.id),
      {
        id: heatmapLayerId(layer.id),
        type: "heatmap",
        ...sourceSpec,
        ...styleLayerZoomRange(layer.style),
        // Keep text-marker points out of the density, mirroring single mode;
        // they still render through the text symbol layer below.
        filter: withFeatureFilters(
          layer,
          hasTextMarkers ? nonTextMarkerPointFilter : pointGeometryFilter,
        ),
        paint: heatmapPaint(layer.style, opacity),
        layout: { visibility },
      },
      beforeId,
    );
  } else if (!layer.style.extrusionEnabled && profile.hasPoint && renderer === "cluster") {
    // Cluster renderer: a bubble + count for aggregated clusters, plus a circle
    // for the individual (unclustered) points. The source carries clusters
    // (geojson source-level clustering, or supercluster tiles on the tiled path).
    removeIfExists(map, heatmapLayerId(layer.id));
    removeIfExists(map, markerLayerId(layer.id));
    ensureLayer(
      map,
      clusterLayerId(layer.id),
      {
        id: clusterLayerId(layer.id),
        type: "circle",
        ...sourceSpec,
        ...styleLayerZoomRange(layer.style),
        filter: ["has", "point_count"],
        paint: clusterCirclePaint(layer.style, opacity),
        layout: { visibility },
      },
      beforeId,
    );
    ensureLayer(
      map,
      clusterCountLayerId(layer.id),
      {
        id: clusterCountLayerId(layer.id),
        type: "symbol",
        ...sourceSpec,
        ...styleLayerZoomRange(layer.style),
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": textFontForMapStyle(map),
          "text-size": 12,
          "text-allow-overlap": true,
          "text-ignore-placement": true,
          visibility,
        },
        paint: {
          "text-color": styleValue(layer.style, "textColor"),
          "text-opacity": opacity,
        },
      },
      beforeId,
    );
    ensureLayer(
      map,
      circleLayerId(layer.id),
      {
        id: circleLayerId(layer.id),
        type: "circle",
        ...sourceSpec,
        ...styleLayerZoomRange(layer.style),
        // Unclustered points, excluding text markers (which the symbol layer
        // renders) so they don't also appear as plain circles.
        filter: withFeatureFilters(layer, unclusteredPointFilter(hasTextMarkers)),
        paint: circlePaint(layer.style, opacity),
        layout: { visibility },
      },
      beforeId,
    );
  } else if (!layer.style.extrusionEnabled && profile.hasPoint) {
    // Single (default) renderer: a marker icon per point when a marker is
    // configured, otherwise one circle per point.
    removeIfExists(map, heatmapLayerId(layer.id));
    removeIfExists(map, clusterLayerId(layer.id));
    removeIfExists(map, clusterCountLayerId(layer.id));
    const pointFilter = withFeatureFilters(
      layer,
      hasTextMarkers ? nonTextMarkerPointFilter : pointGeometryFilter,
    );
    if (markerImageId) {
      removeIfExists(map, circleLayerId(layer.id));
      ensureLayer(
        map,
        markerLayerId(layer.id),
        {
          id: markerLayerId(layer.id),
          type: "symbol",
          ...sourceSpec,
          ...styleLayerZoomRange(layer.style),
          filter: pointFilter,
          layout: {
            "icon-image": markerImageId,
            // The sprite is baked at its display size, so icon-size stays 1
            // unless proportional sizing scales it per feature.
            "icon-size": markerIconSizeValue(layer.style) as PropertyValueSpecification<number>,
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            visibility,
          },
          paint: { "icon-opacity": opacity },
        },
        beforeId,
      );
    } else {
      removeIfExists(map, markerLayerId(layer.id));
      ensureLayer(
        map,
        circleLayerId(layer.id),
        {
          id: circleLayerId(layer.id),
          type: "circle",
          ...sourceSpec,
          ...styleLayerZoomRange(layer.style),
          filter: pointFilter,
          paint: circlePaint(layer.style, opacity),
          layout: { visibility },
        },
        beforeId,
      );
    }
  } else {
    removeIfExists(map, circleLayerId(layer.id));
    removeIfExists(map, markerLayerId(layer.id));
    removeIfExists(map, heatmapLayerId(layer.id));
    removeIfExists(map, clusterLayerId(layer.id));
    removeIfExists(map, clusterCountLayerId(layer.id));
  }

  if (!layer.style.extrusionEnabled && hasTextMarkers) {
    ensureLayer(
      map,
      textLayerId(layer.id),
      {
        id: textLayerId(layer.id),
        type: "symbol",
        ...sourceSpec,
        ...styleLayerZoomRange(layer.style),
        filter: withFeatureFilters(layer, textMarkerFilter),
        layout: {
          "text-allow-overlap": true,
          "text-font": textFontForMapStyle(map),
          "text-field": [
            "to-string",
            ["coalesce", ["get", GEOMAN_TEXT_PROPERTY], ["get", "text"], ""],
          ],
          "text-ignore-placement": true,
          "text-size": Math.max(1, styleValue(layer.style, "textSize")),
          visibility,
        },
        paint: {
          // Honor an optional per-feature `text-color` (used by annotation text
          // labels so each can keep its own color); text markers without it fall
          // back to the layer's text color.
          "text-color": ["coalesce", ["get", "text-color"], styleValue(layer.style, "textColor")],
          "text-halo-color": styleValue(layer.style, "textHaloColor"),
          "text-halo-width": Math.max(0, styleValue(layer.style, "textHaloWidth")),
          "text-opacity": opacity,
        },
      },
      beforeId,
    );
  } else {
    removeIfExists(map, textLayerId(layer.id));
  }

  // Attribute-driven labels: a symbol layer that renders the configured field
  // (or expression) for every feature. Distinct from the geoman text-marker
  // layer above, which only renders annotation features.
  const labels = {
    ...DEFAULT_LAYER_STYLE.labels,
    ...styleValue(layer.style, "labels"),
  };
  // Unique/concatenate labels collapse co-located points into a single label.
  // Only the inline GeoJSON path (no source-layer) can build the aggregated
  // source, and dedup keys off the field value rather than the expression. It is
  // gated to point-only layers: the aggregated source holds just points, so a
  // mixed-geometry layer would silently lose its line/polygon labels. It is also
  // skipped while a Time Slider filter or a rule-based visibility filter is
  // active (`hasFeatureFilter`, computed at the top of this function): the
  // aggregated source is built from the raw features (no MapLibre filter
  // applies to it), so dedup labels would otherwise ignore the time window /
  // hidden features and disagree with the visible data.
  const dedupedLabelFc =
    labels.enabled &&
    labels.dedupe !== "off" &&
    !sourceLayer &&
    !hasFeatureFilter &&
    layer.geojson &&
    labels.field &&
    profile.hasPoint &&
    !profile.hasLine &&
    !profile.hasPolygon
      ? getDedupedLabelFeatures(layer.geojson, labels.field, labels.dedupe)
      : null;
  if (
    !layer.style.extrusionEnabled &&
    renderer !== "heatmap" &&
    labels.enabled &&
    (dedupedLabelFc || labels.expression.trim() || labels.field)
  ) {
    const fieldTextField = (labels.field
      ? ["to-string", ["coalesce", ["get", labels.field], ""]]
      : "") as unknown as maplibregl.ExpressionSpecification | string;
    let textField: maplibregl.ExpressionSpecification | string;
    if (dedupedLabelFc) {
      // The aggregated source carries the resolved label in `__geolibre_label`.
      textField = ["get", "__geolibre_label"] as unknown as maplibregl.ExpressionSpecification;
    } else {
      try {
        if (labels.expression.trim()) {
          const parsed = JSON.parse(labels.expression);
          // JSON.parse accepts non-expressions (numbers, objects, null); only an
          // array is a usable MapLibre expression, so reject anything else and
          // fall back to the field.
          if (!Array.isArray(parsed)) throw new Error("not an expression");
          textField = parsed as maplibregl.ExpressionSpecification;
        } else {
          textField = fieldTextField;
        }
      } catch {
        // A typo'd or non-expression value must not break the whole layer sync.
        textField = fieldTextField;
      }
    }
    if (textField === "") {
      // An invalid expression with no field falls back to an empty text-field,
      // which would create an invisible label layer that still consumes
      // renderer resources. Remove it instead of adding an empty one.
      removeIfExists(map, labelLayerId(layer.id));
      removeSourceIfExists(map, labelSourceId(layer.id));
    } else {
      const labelZoom = intersectZoomRange(
        {
          minzoom: clampLayerZoom(labels.minZoom, MIN_LAYER_ZOOM),
          maxzoom: clampLayerZoom(labels.maxZoom, MAX_LAYER_ZOOM),
        },
        layer.style,
      );
      const dedupSourceId = labelSourceId(layer.id);
      // The aggregated label features live in their own GeoJSON source so the
      // symbol layer can read one-per-point labels without altering the data the
      // other render layers draw.
      if (dedupedLabelFc) {
        if (map.getSource(dedupSourceId)) {
          (map.getSource(dedupSourceId) as maplibregl.GeoJSONSource).setData(dedupedLabelFc);
        } else {
          map.addSource(dedupSourceId, {
            type: "geojson",
            data: dedupedLabelFc,
          });
        }
      }
      // A layer's source is immutable, so when the label source switches between
      // the shared source and the dedup source the layer must be recreated.
      const targetSource = dedupedLabelFc ? dedupSourceId : src;
      const existingLabel = map.getLayer(labelLayerId(layer.id)) as { source?: string } | undefined;
      if (existingLabel && existingLabel.source !== targetSource) {
        removeIfExists(map, labelLayerId(layer.id));
      }
      // Skip geoman text-marker points (they carry their own annotation text),
      // reusing the same two-property predicate the circle/text layers use. The
      // dedup source holds only synthetic points, so it needs neither that
      // filter nor the time filter.
      const nonMarkerFilter = [
        "!",
        textMarkerShapeFilter,
      ] as unknown as maplibregl.FilterSpecification;
      // Data-defined overrides (GH #1320): expression-driven size / color /
      // opacity, per-feature placement priority (symbol-sort-key), and
      // attribute-gated visibility. They read source feature attributes, so
      // they are skipped on the dedup path, whose synthetic features carry
      // only the aggregated label value. An override that is invalid for its
      // destination — malformed JSON, not an expression, or the wrong result
      // type — parses to null and falls back to the literal control; the
      // style-spec check matters because addLayer validates the whole layer
      // spec, so an unchecked type-mismatched value would reject the entire
      // label layer on first add rather than just that property.
      const labelOverride = (source: string, expectedType: "number" | "color" | "boolean") =>
        dedupedLabelFc ? null : parseLabelOverride(source, expectedType);
      const sizeOverride = labelOverride(labels.sizeExpression, "number");
      const colorOverride = labelOverride(labels.colorExpression, "color");
      const opacityOverride = labelOverride(labels.opacityExpression, "number");
      const priorityOverride = labelOverride(labels.priorityExpression, "number");
      const visibilityOverride = labelOverride(labels.visibilityExpression, "boolean");
      // The visibility expression joins the marker exclusion before the
      // layer-wide feature filters, so a feature evaluating false simply gets
      // no label.
      const labelBaseFilter = visibilityOverride
        ? ([
            "all",
            nonMarkerFilter,
            visibilityOverride,
          ] as unknown as maplibregl.FilterSpecification)
        : nonMarkerFilter;
      const sourceRef = dedupedLabelFc ? { source: dedupSourceId } : sourceSpec;
      ensureLayer(
        map,
        labelLayerId(layer.id),
        {
          id: labelLayerId(layer.id),
          type: "symbol",
          ...sourceRef,
          ...labelZoom,
          ...(dedupedLabelFc ? {} : { filter: withFeatureFilters(layer, labelBaseFilter) }),
          layout: {
            "text-field": textField,
            "text-font": textFontForMapStyle(map),
            "text-size": sizeOverride ?? Math.max(1, labels.size),
            // The dedup source is points, so it cannot use line placement.
            "symbol-placement": !dedupedLabelFc && labels.placement === "line" ? "line" : "point",
            "text-allow-overlap": labels.allowOverlap,
            "text-ignore-placement": labels.allowOverlap,
            "text-anchor": labels.anchor,
            "text-offset": [labels.offsetX, labels.offsetY],
            "text-rotate": labels.rotation,
            "text-max-width": Math.max(1, labels.maxWidth),
            "text-transform": labels.transform,
            // Lower sort keys place first, so they win when space is tight.
            // `null` resets a previously applied priority (stripped on first
            // add by ensureLayer).
            "symbol-sort-key": priorityOverride as unknown as PropertyValueSpecification<number>,
            visibility,
          },
          paint: {
            "text-color": colorOverride ?? labels.color,
            "text-halo-color": labels.haloColor,
            "text-halo-width": Math.max(0, labels.haloWidth),
            // The opacity override replaces the layer opacity rather than
            // multiplying into it: wrapping the expression would invalidate
            // top-level `["zoom"]` interpolations.
            "text-opacity": opacityOverride ?? opacity,
          },
        },
        beforeId,
      );
      // Drop the dedup source once the label layer no longer references it (it is
      // recreated on the shared source above before this runs).
      if (!dedupedLabelFc) {
        removeSourceIfExists(map, dedupSourceId);
      }
    }
  } else {
    removeIfExists(map, labelLayerId(layer.id));
    removeSourceIfExists(map, labelSourceId(layer.id));
  }

  applyGeometryGeneratorLayers(map, layer, visibility, opacity, hasFeatureFilter, beforeId);
}

/**
 * Geometry generator (QGIS geometry-generator symbol layers): renders each
 * feature's derived geometry — centroid, bounding box, convex hull, or buffer
 * — as extra symbology over the layer's normal rendering, through a companion
 * GeoJSON source. Derived from the raw features (no MapLibre filter applies),
 * so, like dedup labels, it is suppressed while a time-slider /
 * rule-visibility filter is active rather than rendering hidden features.
 */
function applyGeometryGeneratorLayers(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  visibility: "visible" | "none",
  opacity: number,
  hasFeatureFilter: boolean,
  beforeId?: string,
): void {
  // Match inverted fill and line decorations: no flat companion symbology
  // while the layer renders as a 3D extrusion. The Style Panel hides the
  // generator controls in extrusion mode without resetting the setting, so
  // this guard is what actually turns the layers off.
  const generatorType =
    layer.style.extrusionEnabled || hasFeatureFilter
      ? "none"
      : styleValue(layer.style, "geometryGenerator");
  const generated =
    generatorType !== "none" && layer.geojson
      ? buildGeneratedGeometry(
          layer.geojson,
          generatorType,
          styleValue(layer.style, "geometryGeneratorBufferDistance"),
        )
      : null;
  if (!generated || generated.features.length === 0) {
    removeIfExists(map, generatorFillLayerId(layer.id));
    removeIfExists(map, generatorLineLayerId(layer.id));
    removeIfExists(map, generatorCircleLayerId(layer.id));
    removeSourceIfExists(map, generatorSourceId(layer.id));
    return;
  }

  const genSrc = generatorSourceId(layer.id);
  if (map.getSource(genSrc)) {
    (map.getSource(genSrc) as maplibregl.GeoJSONSource).setData(generated);
  } else {
    map.addSource(genSrc, { type: "geojson", data: generated });
  }

  const kinds = generatedGeometryKinds(generated);
  const fillColor = styleValue(layer.style, "geometryGeneratorFillColor");
  const strokeColor = styleValue(layer.style, "geometryGeneratorStrokeColor");
  const strokeWidth = Math.max(0, styleValue(layer.style, "geometryGeneratorStrokeWidth"));
  const genOpacity =
    Math.min(1, Math.max(0, styleValue(layer.style, "geometryGeneratorOpacity"))) * opacity;

  if (kinds.hasPolygon) {
    ensureLayer(
      map,
      generatorFillLayerId(layer.id),
      {
        id: generatorFillLayerId(layer.id),
        type: "fill",
        source: genSrc,
        ...styleLayerZoomRange(layer.style),
        metadata: { "geolibre:internal": true },
        filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
        paint: { "fill-color": fillColor, "fill-opacity": genOpacity },
        layout: { visibility },
      },
      beforeId,
    );
    ensureLayer(
      map,
      generatorLineLayerId(layer.id),
      {
        id: generatorLineLayerId(layer.id),
        type: "line",
        source: genSrc,
        ...styleLayerZoomRange(layer.style),
        metadata: { "geolibre:internal": true },
        filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
        paint: {
          "line-color": strokeColor,
          "line-width": strokeWidth,
          "line-opacity": opacity,
        },
        layout: { visibility },
      },
      beforeId,
    );
  } else {
    removeIfExists(map, generatorFillLayerId(layer.id));
    removeIfExists(map, generatorLineLayerId(layer.id));
  }

  if (kinds.hasPoint) {
    ensureLayer(
      map,
      generatorCircleLayerId(layer.id),
      {
        id: generatorCircleLayerId(layer.id),
        type: "circle",
        source: genSrc,
        ...styleLayerZoomRange(layer.style),
        metadata: { "geolibre:internal": true },
        filter: ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
        paint: {
          "circle-color": fillColor,
          "circle-radius": Math.max(1, styleValue(layer.style, "geometryGeneratorCircleRadius")),
          "circle-opacity": genOpacity,
          "circle-stroke-color": strokeColor,
          "circle-stroke-width": strokeWidth,
          "circle-stroke-opacity": opacity,
        },
        layout: { visibility },
      },
      beforeId,
    );
  } else {
    removeIfExists(map, generatorCircleLayerId(layer.id));
  }
}

// syncs can fire rapidly (e.g. dragging an opacity slider), and this is an O(n)
// scan that the tiled path now runs against 50k+ feature collections. Memoize by
// collection reference — the store replaces the object on every mutation.
const textMarkerCache = new WeakMap<GeoJSON.FeatureCollection, boolean>();

// Deduplicated label features are also O(n) over the source, so memoize them by
// collection reference (keyed by the field + mode, since both change the result)
// to avoid rebuilding on every rapid sync.
const dedupedLabelCache = new WeakMap<
  GeoJSON.FeatureCollection,
  Map<string, GeoJSON.FeatureCollection | null>
>();

function getDedupedLabelFeatures(
  collection: GeoJSON.FeatureCollection,
  field: string,
  mode: "off" | "unique" | "concatenate",
): GeoJSON.FeatureCollection | null {
  let byKey = dedupedLabelCache.get(collection);
  if (!byKey) {
    byKey = new Map();
    dedupedLabelCache.set(collection, byKey);
  }
  const key = `${mode}:${field}`;
  if (byKey.has(key)) return byKey.get(key) ?? null;
  const result = buildDedupedLabelFeatures(collection, field, mode);
  byKey.set(key, result);
  return result;
}

function removeSourceIfExists(map: maplibregl.Map, id: string): void {
  if (map.getSource(id)) map.removeSource(id);
}

// Data-defined label overrides are re-read on every sync (which can fire per
// frame, e.g. while dragging the opacity slider), and validating through the
// style spec is far more expensive than the reads, so results are memoized by
// expected type + source. Bounded so a pathological stream of distinct
// expressions cannot grow it without limit.
const labelOverrideCache = new Map<string, maplibregl.ExpressionSpecification | null>();
const LABEL_OVERRIDE_CACHE_MAX = 256;

/**
 * Parses and validates a data-defined label override (a MapLibre expression
 * stored as a JSON string) against its destination's expected result type.
 * Returns null — falling back to the literal control — for anything invalid:
 * malformed JSON, a non-expression value, or a type the destination cannot
 * accept. The `|| ""` guards against a hand-edited project file storing null
 * for an expression field (the type says string, but the value comes from
 * untrusted JSON).
 */
function parseLabelOverride(
  source: string,
  expectedType: "number" | "color" | "boolean",
): maplibregl.ExpressionSpecification | null {
  const trimmed = (source || "").trim();
  if (!trimmed) return null;
  const key = `${expectedType}:${trimmed}`;
  const cached = labelOverrideCache.get(key);
  if (cached !== undefined) return cached;
  const validation = validateMapExpression(trimmed, { expectedType });
  const result =
    validation.ok && validation.parsed
      ? (validation.parsed as unknown as maplibregl.ExpressionSpecification)
      : null;
  if (labelOverrideCache.size >= LABEL_OVERRIDE_CACHE_MAX) {
    labelOverrideCache.clear();
  }
  labelOverrideCache.set(key, result);
  return result;
}

// Keep this predicate aligned with textMarkerFilter: any text-marker-shaped
// point routes to the symbol layer, even with empty text, so features are
// never excluded from the circle layer without a matching symbol entry.
function hasTextMarkerFeatures(collection: GeoJSON.FeatureCollection): boolean {
  const cached = textMarkerCache.get(collection);
  if (cached !== undefined) return cached;
  const result = computeHasTextMarkerFeatures(collection);
  textMarkerCache.set(collection, result);
  return result;
}

function computeHasTextMarkerFeatures(collection: GeoJSON.FeatureCollection): boolean {
  return collection.features.some((feature) => {
    if (feature.geometry?.type !== "Point" && feature.geometry?.type !== "MultiPoint") {
      return false;
    }
    const properties = feature.properties;
    if (!properties) return false;
    return (
      properties[GEOMAN_SHAPE_PROPERTY] === TEXT_MARKER_SHAPE ||
      properties.shape === TEXT_MARKER_SHAPE
    );
  });
}

// getStyle() deep-clones the whole style, and syncs can fire rapidly (e.g.
// while dragging an opacity slider), so cache the resolved font per map and
// invalidate when a new basemap style loads.
const textFontCache = new WeakMap<maplibregl.Map, string[]>();

function textFontForMapStyle(map: maplibregl.Map): string[] {
  const cached = textFontCache.get(map);
  if (cached) return cached;
  const fonts = resolveTextFontFromStyle(map);
  textFontCache.set(map, fonts);
  map.once("style.load", () => textFontCache.delete(map));
  return fonts;
}

// Operators that can start a data-driven text-font expression. A bare
// ["get", "font"] is all strings, so an every(typeof === "string") check
// alone would mistake it for a font stack.
const FONT_EXPRESSION_OPERATORS = new Set([
  "literal",
  "get",
  "has",
  "at",
  "in",
  "case",
  "match",
  "coalesce",
  "step",
  "interpolate",
  "let",
  "var",
  "concat",
  "to-string",
  "string",
  "array",
  "format",
]);

function resolveTextFontFromStyle(map: maplibregl.Map): string[] {
  for (const styleLayer of map.getStyle().layers ?? []) {
    if (styleLayer.type !== "symbol") continue;
    // Icon-only symbol layers may carry a glyph/sprite font unsuited to text.
    if (!styleLayer.layout?.["text-field"]) continue;
    const textFont = styleLayer.layout?.["text-font"];
    if (!Array.isArray(textFont)) continue;
    // Unwrap the ["literal", ["Font A", "Font B"]] expression form used by
    // many popular styles.
    const fonts =
      textFont[0] === "literal" && Array.isArray(textFont[1])
        ? (textFont[1] as unknown[])
        : (textFont as unknown[]);
    if (
      fonts.length > 0 &&
      fonts.every((font) => typeof font === "string") &&
      !FONT_EXPRESSION_OPERATORS.has(fonts[0] as string)
    ) {
      return fonts as string[];
    }
  }
  return ["Noto Sans Regular"];
}

function syncRasterTileLayer(map: maplibregl.Map, layer: GeoLibreLayer, beforeId?: string): void {
  const src = sourceId(layer.id);
  const lid = `layer-${layer.id}-raster`;
  const tiles = getRenderableRasterTiles(layer);
  const tileSize = numberSource(layer.source.tileSize) ?? 256;
  if (tiles.length === 0) return;
  if (!map.getSource(src)) {
    const bounds = boundsSource(layer.source.bounds);
    const minzoom = numberSource(layer.source.minzoom);
    const maxzoom = numberSource(layer.source.maxzoom);
    const attribution = stringSource(layer.source.attribution);
    map.addSource(src, {
      type: "raster",
      tiles,
      tileSize,
      ...(minzoom !== undefined ? { minzoom } : {}),
      ...(maxzoom !== undefined ? { maxzoom } : {}),
      ...(bounds ? { bounds } : {}),
      ...(layer.source.scheme === "tms" ? { scheme: "tms" as const } : {}),
      ...(attribution ? { attribution } : {}),
    });
  }
  ensureLayer(
    map,
    lid,
    {
      id: lid,
      type: "raster",
      source: src,
      ...styleLayerZoomRange(layer.style),
      paint: rasterPaint(layer.style, layer.opacity),
      layout: { visibility: layer.visible ? "visible" : "none" },
    },
    beforeId,
  );
}

type CornerCoordinates = [[number, number], [number, number], [number, number], [number, number]];

/** Validate persisted overlay corners (video/image): four in-range [lng, lat] pairs. */
function isCornerCoordinates(value: unknown): value is CornerCoordinates {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(
      (corner) =>
        Array.isArray(corner) &&
        corner.length === 2 &&
        Number.isFinite(corner[0]) &&
        Number.isFinite(corner[1]) &&
        corner[0] >= -180 &&
        corner[0] <= 180 &&
        corner[1] >= -90 &&
        corner[1] <= 90,
    )
  );
}

/**
 * A georeferenced video overlay (MapLibre `type: "video"` source rendered as a
 * raster layer). The source carries the media `urls` (format fallbacks) and the
 * four corner `coordinates` in [lng, lat] order: top-left, top-right,
 * bottom-right, bottom-left. The video host must send CORS headers so MapLibre
 * can read its frames into the map texture.
 */
function syncVideoLayer(map: maplibregl.Map, layer: GeoLibreLayer, beforeId?: string): void {
  const src = sourceId(layer.id);
  const lid = `layer-${layer.id}-video`;
  // Validate the persisted source payload — a malformed project must not make
  // map.addSource throw and abort the rest of the layer-sync pass.
  const urls = Array.isArray(layer.source.urls)
    ? layer.source.urls.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  const coordinates = isCornerCoordinates(layer.source.coordinates)
    ? layer.source.coordinates
    : undefined;
  if (urls.length === 0 || !coordinates) return;
  if (!map.getSource(src)) {
    map.addSource(src, { type: "video", urls, coordinates });
    // MapLibre's VideoSource exposes setCoordinates() but no URL setter, so a
    // future edit-layer flow would need to remove + re-add to change urls.
  }
  ensureLayer(
    map,
    lid,
    {
      id: lid,
      type: "raster",
      source: src,
      ...styleLayerZoomRange(layer.style),
      paint: rasterPaint(layer.style, layer.opacity),
      layout: { visibility: layer.visible ? "visible" : "none" },
    },
    beforeId,
  );
}

/**
 * A georeferenced image overlay (MapLibre `type: "image"` source rendered as a
 * raster layer), produced by the Raster Georeferencer. The source carries a
 * single image `url` (an http(s) or data URL) and the four corner `coordinates`
 * in [lng, lat] order: top-left, top-right, bottom-right, bottom-left.
 */
function syncImageLayer(map: maplibregl.Map, layer: GeoLibreLayer, beforeId?: string): void {
  const src = sourceId(layer.id);
  const lid = `layer-${layer.id}-image`;
  const url =
    typeof layer.source.url === "string" && layer.source.url.length > 0
      ? layer.source.url
      : undefined;
  const coordinates = isCornerCoordinates(layer.source.coordinates)
    ? layer.source.coordinates
    : undefined;
  if (!url || !coordinates) return;
  const existing = map.getSource(src);
  if (!existing) {
    map.addSource(src, { type: "image", url, coordinates });
  } else if (existing.type === "image") {
    // Unlike VideoSource, MapLibre's ImageSource can replace both the url and
    // the corners in place, so a re-render (e.g. a future edit-GCPs flow) keeps
    // the overlay in sync instead of leaving the old image pinned.
    (existing as maplibregl.ImageSource).updateImage({ url, coordinates });
  }
  ensureLayer(
    map,
    lid,
    {
      id: lid,
      type: "raster",
      source: src,
      ...styleLayerZoomRange(layer.style),
      paint: rasterPaint(layer.style, layer.opacity),
      layout: { visibility: layer.visible ? "visible" : "none" },
    },
    beforeId,
  );
}

function getRenderableRasterTiles(layer: GeoLibreLayer): string[] {
  const tiles = (layer.source.tiles as string[]) ?? [];
  if (layer.type !== "wms" || !isViteDevServer()) return tiles;
  return tiles.map(proxyWmsTileUrl);
}

function isViteDevServer(): boolean {
  return Boolean(
    (
      import.meta as ImportMeta & {
        env?: { DEV?: boolean };
      }
    ).env?.DEV,
  );
}

function proxyWmsTileUrl(tileUrl: string): string {
  const encodedUrl = encodeURIComponent(tileUrl).replaceAll(
    "%7Bbbox-epsg-3857%7D",
    "{bbox-epsg-3857}",
  );
  return `${WMS_PROXY_PATH}?url=${encodedUrl}`;
}

function syncVectorTileLayer(map: maplibregl.Map, layer: GeoLibreLayer, beforeId?: string): void {
  const src = sourceId(layer.id);
  const url = layer.source.url as string | undefined;
  // OGC API tilesets (and any raw tile template) are added from `tiles` when no
  // TileJSON URL is available; MapLibre then needs the zoom range up front so it
  // does not request tiles outside the tileset's advertised levels.
  const tiles = Array.isArray(layer.source.tiles)
    ? (layer.source.tiles as unknown[]).filter(
        (tile): tile is string => typeof tile === "string" && tile.length > 0,
      )
    : undefined;
  if (!url && !(tiles && tiles.length > 0)) return;
  if (!map.getSource(src)) {
    if (url) {
      map.addSource(src, { type: "vector", url });
    } else {
      const bounds = layer.source.bounds;
      map.addSource(src, {
        type: "vector",
        tiles: tiles as string[],
        ...(typeof layer.source.minzoom === "number" ? { minzoom: layer.source.minzoom } : {}),
        ...(typeof layer.source.maxzoom === "number" ? { maxzoom: layer.source.maxzoom } : {}),
        ...(Array.isArray(bounds) && bounds.length === 4
          ? { bounds: bounds as [number, number, number, number] }
          : {}),
      });
    }
  }
  const visibility = layer.visible ? "visible" : "none";
  const sourceLayers = getVectorTileSourceLayers(layer);
  const currentLayerIds = new Set(vectorTileStyleLayerIds(layer));

  for (const sourceLayer of sourceLayers) {
    const layerPart = vectorTileScopedSourceLayer(layer, sourceLayer);
    if (layer.style.extrusionEnabled) {
      removeIfExists(map, vectorTileLayerId(layer.id, false, layerPart));
      removeIfExists(map, vectorTileLineLayerId(layer.id, layerPart));
      removeIfExists(map, vectorTileCircleLayerId(layer.id, layerPart));
      ensureLayer(
        map,
        vectorTileLayerId(layer.id, true, layerPart),
        {
          id: vectorTileLayerId(layer.id, true, layerPart),
          type: "fill-extrusion",
          source: src,
          "source-layer": sourceLayer,
          ...styleLayerZoomRange(layer.style),
          filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
          paint: fillExtrusionPaint(layer.style, layer.opacity),
          layout: { visibility },
        },
        beforeId,
      );
    } else {
      removeIfExists(map, vectorTileLayerId(layer.id, true, layerPart));
      ensureLayer(
        map,
        vectorTileLayerId(layer.id, false, layerPart),
        {
          id: vectorTileLayerId(layer.id, false, layerPart),
          type: "fill",
          source: src,
          "source-layer": sourceLayer,
          ...styleLayerZoomRange(layer.style),
          filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
          paint: fillPaint(layer.style, layer.opacity),
          layout: { visibility },
        },
        beforeId,
      );
      ensureLayer(
        map,
        vectorTileLineLayerId(layer.id, layerPart),
        {
          id: vectorTileLineLayerId(layer.id, layerPart),
          type: "line",
          source: src,
          "source-layer": sourceLayer,
          ...styleLayerZoomRange(layer.style),
          filter: [
            "match",
            ["geometry-type"],
            ["LineString", "MultiLineString", "Polygon", "MultiPolygon"],
            true,
            false,
          ],
          paint: linePaint(layer.style, layer.opacity),
          layout: { visibility },
        },
        beforeId,
      );
      ensureLayer(
        map,
        vectorTileCircleLayerId(layer.id, layerPart),
        {
          id: vectorTileCircleLayerId(layer.id, layerPart),
          type: "circle",
          source: src,
          "source-layer": sourceLayer,
          ...styleLayerZoomRange(layer.style),
          filter: ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
          paint: circlePaint(layer.style, layer.opacity),
          layout: { visibility },
        },
        beforeId,
      );
    }
  }

  removeStaleVectorTileLayers(map, layer.id, currentLayerIds);
}

function syncMbtilesLayer(map: maplibregl.Map, layer: GeoLibreLayer, beforeId?: string): void {
  if (layer.metadata.tileType === "raster" || layer.source.type === "raster") {
    syncRasterTileLayer(map, layer, beforeId);
    return;
  }

  syncMbtilesVectorLayer(map, layer, beforeId);
}

function syncMbtilesVectorLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  const src = sourceId(layer.id);
  const tiles = (layer.source.tiles as string[] | undefined) ?? [];
  if (tiles.length === 0) return;

  if (!map.getSource(src)) {
    map.addSource(src, {
      type: "vector",
      tiles,
      bounds: layer.source.bounds as [number, number, number, number] | undefined,
      maxzoom: layer.source.maxzoom as number | undefined,
      minzoom: layer.source.minzoom as number | undefined,
    });
  }

  const visibility = layer.visible ? "visible" : "none";
  const sourceLayers = getMbtilesSourceLayers(layer);
  const currentLayerIds = new Set(mbtilesStyleLayerIds(layer));

  for (const sourceLayer of sourceLayers) {
    const fillId = mbtilesFillLayerId(layer.id, sourceLayer);
    const extrusionId = mbtilesExtrusionLayerId(layer.id, sourceLayer);

    if (layer.style.extrusionEnabled) {
      removeIfExists(map, fillId);
      ensureLayer(
        map,
        extrusionId,
        {
          id: extrusionId,
          type: "fill-extrusion",
          source: src,
          "source-layer": sourceLayer,
          ...styleLayerZoomRange(layer.style),
          filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
          paint: fillExtrusionPaint(layer.style, layer.opacity),
          layout: { visibility },
        },
        beforeId,
      );
    } else {
      removeIfExists(map, extrusionId);
      ensureLayer(
        map,
        fillId,
        {
          id: fillId,
          type: "fill",
          source: src,
          "source-layer": sourceLayer,
          ...styleLayerZoomRange(layer.style),
          filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
          paint: fillPaint(layer.style, layer.opacity),
          layout: { visibility },
        },
        beforeId,
      );
    }
    if (layer.style.extrusionEnabled) {
      removeIfExists(map, mbtilesLineLayerId(layer.id, sourceLayer));
      removeIfExists(map, mbtilesCircleLayerId(layer.id, sourceLayer));
    } else {
      ensureLayer(
        map,
        mbtilesLineLayerId(layer.id, sourceLayer),
        {
          id: mbtilesLineLayerId(layer.id, sourceLayer),
          type: "line",
          source: src,
          "source-layer": sourceLayer,
          ...styleLayerZoomRange(layer.style),
          filter: [
            "match",
            ["geometry-type"],
            ["LineString", "MultiLineString", "Polygon", "MultiPolygon"],
            true,
            false,
          ],
          paint: linePaint(layer.style, layer.opacity),
          layout: { visibility },
        },
        beforeId,
      );
      ensureLayer(
        map,
        mbtilesCircleLayerId(layer.id, sourceLayer),
        {
          id: mbtilesCircleLayerId(layer.id, sourceLayer),
          type: "circle",
          source: src,
          "source-layer": sourceLayer,
          ...styleLayerZoomRange(layer.style),
          filter: ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
          paint: circlePaint(layer.style, layer.opacity),
          layout: { visibility },
        },
        beforeId,
      );
    }
  }

  removeStaleMbtilesLayers(map, layer.id, currentLayerIds);
}

function getMbtilesSourceLayers(layer: GeoLibreLayer): string[] {
  const sourceLayers = layer.source.sourceLayers ?? layer.metadata.sourceLayers;
  return Array.isArray(sourceLayers)
    ? sourceLayers.filter(
        (sourceLayer): sourceLayer is string =>
          typeof sourceLayer === "string" && sourceLayer.length > 0,
      )
    : [];
}

function removeStaleMbtilesLayers(
  map: maplibregl.Map,
  layerId: string,
  currentLayerIds: Set<string>,
): void {
  const prefix = `layer-${layerId}-mbtiles-`;
  for (const styleLayer of map.getStyle().layers ?? []) {
    if (styleLayer.id.startsWith(prefix) && !currentLayerIds.has(styleLayer.id)) {
      removeIfExists(map, styleLayer.id);
    }
  }
}

function encodeMbtilesLayerPart(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "_");
}

function encodeVectorTileLayerPart(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "_");
}

export function mbtilesFillLayerId(layerId: string, sourceLayer: string): string {
  return `layer-${layerId}-mbtiles-${encodeMbtilesLayerPart(sourceLayer)}-fill`;
}

export function mbtilesExtrusionLayerId(layerId: string, sourceLayer: string): string {
  return `layer-${layerId}-mbtiles-${encodeMbtilesLayerPart(sourceLayer)}-extrusion`;
}

export function mbtilesLineLayerId(layerId: string, sourceLayer: string): string {
  return `layer-${layerId}-mbtiles-${encodeMbtilesLayerPart(sourceLayer)}-line`;
}

export function mbtilesCircleLayerId(layerId: string, sourceLayer: string): string {
  return `layer-${layerId}-mbtiles-${encodeMbtilesLayerPart(sourceLayer)}-circle`;
}

export function mbtilesStyleLayerIds(layer: GeoLibreLayer): string[] {
  if (layer.type !== "mbtiles") return [];
  if (layer.metadata.tileType === "raster" || layer.source.type === "raster") {
    return [`layer-${layer.id}-raster`];
  }

  return getMbtilesSourceLayers(layer).flatMap((sourceLayer) => [
    mbtilesCircleLayerId(layer.id, sourceLayer),
    mbtilesLineLayerId(layer.id, sourceLayer),
    layer.style.extrusionEnabled
      ? mbtilesExtrusionLayerId(layer.id, sourceLayer)
      : mbtilesFillLayerId(layer.id, sourceLayer),
  ]);
}

export function mbtilesAllStyleLayerIds(layer: GeoLibreLayer): string[] {
  if (layer.type !== "mbtiles") return [];
  if (layer.metadata.tileType === "raster" || layer.source.type === "raster") {
    return [`layer-${layer.id}-raster`];
  }

  return getMbtilesSourceLayers(layer).flatMap((sourceLayer) => [
    mbtilesCircleLayerId(layer.id, sourceLayer),
    mbtilesLineLayerId(layer.id, sourceLayer),
    mbtilesFillLayerId(layer.id, sourceLayer),
    mbtilesExtrusionLayerId(layer.id, sourceLayer),
  ]);
}

export function vectorTileLayerId(
  layerId: string,
  extrusionEnabled = false,
  sourceLayer?: string,
): string {
  if (sourceLayer) {
    return `layer-${layerId}-vector-${encodeVectorTileLayerPart(sourceLayer)}-${extrusionEnabled ? "extrusion" : "fill"}`;
  }
  return `layer-${layerId}-${extrusionEnabled ? "vector-extrusion" : "vector"}`;
}

export function vectorTileLineLayerId(layerId: string, sourceLayer?: string): string {
  if (sourceLayer) {
    return `layer-${layerId}-vector-${encodeVectorTileLayerPart(sourceLayer)}-line`;
  }
  return `layer-${layerId}-vector-line`;
}

export function vectorTileCircleLayerId(layerId: string, sourceLayer?: string): string {
  if (sourceLayer) {
    return `layer-${layerId}-vector-${encodeVectorTileLayerPart(sourceLayer)}-circle`;
  }
  return `layer-${layerId}-vector-circle`;
}

export function vectorTileStyleLayerIds(layer: GeoLibreLayer): string[] {
  if (layer.type !== "vector-tiles") return [];
  return getVectorTileSourceLayers(layer).flatMap((sourceLayer) => {
    const layerPart = vectorTileScopedSourceLayer(layer, sourceLayer);
    if (layer.style.extrusionEnabled) {
      return [vectorTileLayerId(layer.id, true, layerPart)];
    }
    return [
      vectorTileCircleLayerId(layer.id, layerPart),
      vectorTileLineLayerId(layer.id, layerPart),
      vectorTileLayerId(layer.id, false, layerPart),
    ];
  });
}

function vectorTileAllStyleLayerIds(layer: GeoLibreLayer): string[] {
  if (layer.type !== "vector-tiles") return [];
  return getVectorTileSourceLayers(layer).flatMap((sourceLayer) => {
    const layerPart = vectorTileScopedSourceLayer(layer, sourceLayer);
    return [
      vectorTileCircleLayerId(layer.id, layerPart),
      vectorTileLineLayerId(layer.id, layerPart),
      vectorTileLayerId(layer.id, false, layerPart),
      vectorTileLayerId(layer.id, true, layerPart),
    ];
  });
}

function getVectorTileSourceLayers(layer: GeoLibreLayer): string[] {
  const sourceLayers = layer.source.sourceLayers ?? layer.metadata.sourceLayers;
  if (Array.isArray(sourceLayers)) {
    return sourceLayers.filter(
      (sourceLayer): sourceLayer is string =>
        typeof sourceLayer === "string" && sourceLayer.length > 0,
    );
  }

  const sourceLayer = layer.source.sourceLayer;
  return typeof sourceLayer === "string" && sourceLayer.length > 0 ? [sourceLayer] : [];
}

function vectorTileScopedSourceLayer(
  layer: GeoLibreLayer,
  sourceLayer: string,
): string | undefined {
  return getVectorTileSourceLayers(layer).length > 1 ? sourceLayer : undefined;
}

function removeStaleVectorTileLayers(
  map: maplibregl.Map,
  layerId: string,
  currentLayerIds: Set<string>,
): void {
  const prefix = `layer-${layerId}-vector`;
  for (const styleLayer of map.getStyle().layers ?? []) {
    if (styleLayer.id.startsWith(prefix) && !currentLayerIds.has(styleLayer.id)) {
      removeIfExists(map, styleLayer.id);
    }
  }
}

function ensureLayer(
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
      for (const [key, value] of Object.entries(spec.paint)) {
        map.setPaintProperty(id, key, value);
      }
    }
    if (spec.layout) {
      for (const [key, value] of Object.entries(spec.layout)) {
        map.setLayoutProperty(id, key, value);
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
  map.addLayer(addSpec, validBeforeId);
}

function setLayerZoomRange(
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

function removeIfExists(map: maplibregl.Map, id: string): void {
  if (map.getLayer(id)) map.removeLayer(id);
}

/**
 * Read a GeoJSON source's clustering config from the current style, or null if
 * the source doesn't exist yet (or isn't a GeoJSON source). Used to decide
 * whether a cluster toggle requires recreating the source.
 */
function geojsonSourceClusterState(
  map: maplibregl.Map,
  src: string,
): { cluster: boolean; radius: number; maxZoom: number } | null {
  const spec = map.getStyle()?.sources?.[src];
  if (!spec || spec.type !== "geojson") return null;
  const clusterSpec = spec as {
    cluster?: boolean;
    clusterRadius?: number;
    clusterMaxZoom?: number;
  };
  return {
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
}

/** Remove every style layer a GeoJSON layer can own (all renderer variants). */
function removeGeoJsonRenderLayers(map: maplibregl.Map, layerId: string): void {
  for (const id of [
    fillLayerId(layerId),
    fillExtrusionLayerId(layerId),
    lineLayerId(layerId),
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

function moveLayer(map: maplibregl.Map, id: string, beforeId?: string): void {
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

export function removeLayerFromMap(
  map: maplibregl.Map,
  layerId: string,
  layer?: GeoLibreLayer,
): void {
  for (const id of [
    ...getExternalNativeLayerIds(layer),
    ...getExternalNativeLayerIds(layer).map(externalExtrusionLayerId),
    ...(layer ? mbtilesAllStyleLayerIds(layer) : []),
    fillLayerId(layerId),
    fillExtrusionLayerId(layerId),
    lineLayerId(layerId),
    circleLayerId(layerId),
    heatmapLayerId(layerId),
    clusterLayerId(layerId),
    clusterCountLayerId(layerId),
    textLayerId(layerId),
    markerLayerId(layerId),
    labelLayerId(layerId),
    invertedFillLayerId(layerId),
    lineDecorationLayerId(layerId),
    generatorFillLayerId(layerId),
    generatorLineLayerId(layerId),
    generatorCircleLayerId(layerId),
    `layer-${layerId}-raster`,
    `layer-${layerId}-video`,
    `layer-${layerId}-image`,
    ...(layer ? vectorTileAllStyleLayerIds(layer) : []),
    vectorTileCircleLayerId(layerId),
    vectorTileLineLayerId(layerId),
    vectorTileLayerId(layerId),
    vectorTileLayerId(layerId, true),
  ]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const src of [
    ...getExternalSourceIds(layer),
    sourceId(layerId),
    labelSourceId(layerId),
    invertedSourceId(layerId),
    generatorSourceId(layerId),
  ]) {
    if (src && map.getSource(src)) map.removeSource(src);
  }
  // Drop radius-override tracking for the removed layer's native ids so a
  // later layer reusing an id never inherits a stale restore.
  const overriddenRadiusIds = overriddenRadiusNativeLayerIds.get(map);
  if (overriddenRadiusIds) {
    for (const id of getExternalNativeLayerIds(layer)) {
      overriddenRadiusIds.delete(id);
    }
  }
  // Free any client-side tile index built for this layer's tiled render path.
  unregisterGeoJsonVtSource(layerId);
  // Free an in-memory PMTiles archive (an offline basemap extract) this layer
  // referenced; a no-op for remote pmtiles:// URLs.
  if (layer?.type === "pmtiles") {
    const url = stringSource(layer.source.url) ?? layer.sourcePath;
    if (typeof url === "string") unregisterPMTilesArchive(url);
  }
}

function getExternalNativeLayerIds(layer?: GeoLibreLayer): string[] {
  const nativeLayerIds = layer?.metadata.nativeLayerIds;
  return Array.isArray(nativeLayerIds)
    ? nativeLayerIds.filter((id): id is string => typeof id === "string")
    : [];
}

function getExternalSourceIds(layer?: GeoLibreLayer): string[] {
  const sourceIds = layer?.metadata.sourceIds;
  if (Array.isArray(sourceIds)) {
    return sourceIds.filter((id): id is string => typeof id === "string");
  }

  return typeof layer?.metadata.sourceId === "string" ? [layer.metadata.sourceId] : [];
}
