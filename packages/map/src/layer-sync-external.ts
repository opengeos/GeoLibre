// Sync for external (plugin- or control-owned) native and custom layers.

import { arcgisOpacity, arcgisVectorStyle } from "./vector-style";
import {
  controlRendersLayer,
  getExternalNativePaintBridge,
  pluginOwnsPaint,
  styleValue,
  type ExternalNativePaintBridge,
  type GeoLibreLayer,
} from "@geolibre/core";
import type * as maplibregl from "maplibre-gl";
import { detectGeometryProfile, sourceId } from "./geojson-loader";
import { getDynamicPaintProperty, setDynamicPaintProperty } from "./dynamic-style-property";
import { circlePaint, linePaint } from "./style-mapper";
import {
  MIN_LAYER_ZOOM,
  MAX_LAYER_ZOOM,
  managedZoomRangeLayerIdsFor,
  rememberGeoJsonData,
  setGeoJsonData,
  styleLayerZoomRange,
  stringMetadata,
  stringSource,
  ensureLayer,
  styleValuesEqual,
  setLayerZoomRange,
  moveLayer,
  getExternalNativeLayerIds,
  getExternalSourceIds,
} from "./layer-sync-common";
import {
  nativeLayerSupportsFilter,
  applyExternalNativeFeatureFilters,
} from "./layer-sync-native-filters";
import {
  setNativeLayerVisibility,
  syncExternalNativeExtrusion,
  clearExternalNativeExtrusion,
  syncVectorControlPointSymbology,
  setExternalNativeLayerPaint,
} from "./layer-sync-external-paint";
import {
  isPMTilesExternalLayer,
  ensurePMTilesExternalLayer,
  syncPMTilesLineDecorations,
  isWaybackExternalRasterLayer,
  syncWaybackExternalRasterLayer,
  isBasemapControlRasterLayer,
  isExternalRasterTileLayer,
  syncExternalRasterTileLayer,
  syncBasemapControlRasterLayer,
  isWebServiceTileRasterLayer,
  syncWebServiceTileRasterLayer,
} from "./layer-sync-external-tiles";

/**
 * Notified of the computed `beforeId` for a deck.gl-backed external custom layer
 * (a `maplibre-gl-raster` COG) whenever layers are synced. Such a layer is not a
 * real MapLibre style layer — `@deck.gl/mapbox` groups it by a `beforeId` prop —
 * so `moveLayer` cannot reorder it; the host registers a handler that pushes the
 * `beforeId` into the owning control instead. See issue #393 follow-up.
 */
export let externalDeckLayerOrderHandler:
  | ((layerId: string, beforeId: string | undefined) => void)
  | null = null;

/** Register (or clear with `null`) the deck-layer order handler. */
export function setExternalDeckLayerOrderHandler(
  handler: ((layerId: string, beforeId: string | undefined) => void) | null,
): void {
  externalDeckLayerOrderHandler = handler;
}

export function isExternalNativeLayer(layer: GeoLibreLayer): boolean {
  return getExternalNativeLayerIds(layer).length > 0;
}

export function syncExternalNativeLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  const nativeLayerIds = getExternalNativeLayerIds(layer);
  const arcgisStyle = arcgisVectorStyle(layer);
  if (arcgisStyle) {
    for (const [id, source] of Object.entries(arcgisStyle.sources)) {
      if (!map.getSource(id)) map.addSource(id, structuredClone(source));
    }
    for (const spec of arcgisStyle.layers) {
      if (!map.getLayer(spec.id)) map.addLayer(structuredClone(spec), beforeId);
      const properties =
        spec.type === "symbol"
          ? ["text-opacity", "icon-opacity"]
          : spec.type === "circle"
            ? ["circle-opacity", "circle-stroke-opacity"]
            : [`${spec.type}-opacity`];
      const paint = spec.paint as Record<string, unknown> | undefined;
      for (const property of properties) {
        const opacity = arcgisOpacity(paint?.[property], layer.opacity);
        if (!styleValuesEqual(getDynamicPaintProperty(map, spec.id, property), opacity)) {
          setDynamicPaintProperty(map, spec.id, property, opacity);
        }
      }
    }
  }
  if (isPMTilesExternalLayer(layer)) {
    ensurePMTilesExternalLayer(map, layer, nativeLayerIds, beforeId);
  }

  // A plugin-painted layer (a MapLibre CustomLayerInterface) has no paint
  // properties to set, so the panel's opacity/visibility only reach it through
  // the setters the registration supplied. Forward them before the branches
  // below, which cover the native visibility/zoom/order work the custom layer
  // still honors.
  applyExternalNativePaintBridge(layer);

  // Custom render layers (e.g. 3D Tiles) manage their own visibility, opacity,
  // and zoom behavior through the control that registered them, so the standard
  // visibility/paint/zoom-range sync below must be skipped — only ordering is
  // handled here.
  if (isExternalCustomLayer(layer)) {
    syncExternalCustomLayer(map, layer, nativeLayerIds, beforeId);
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

  if (
    !controlOwnsPaint(layer) &&
    syncExternalNativeExtrusion(map, layer, nativeLayerIds, beforeId)
  ) {
    // Extruded archives carry no line decorations; drop any left from 2D.
    syncPMTilesLineDecorations(map, layer, nativeLayerIds, beforeId);
    return;
  }

  clearExternalNativeExtrusion(map, layer, nativeLayerIds);

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

    if (!arcgisStyle && !controlOwnsPaint(layer)) {
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
    const managedIds = managedZoomRangeLayerIdsFor(map);
    if (!isDefaultRange) {
      managedIds.add(nativeLayerId);
    }
    if (managedIds.has(nativeLayerId)) {
      setLayerZoomRange(map, nativeLayerId, zoomRange);
    }

    moveLayer(map, nativeLayerId, beforeId);
  }

  // After the native layers have been moved, so the decorations land above
  // the archive's own lines.
  syncPMTilesLineDecorations(map, layer, nativeLayerIds, beforeId);
}

/**
 * The ordering-only sync {@link syncExternalNativeLayer} gives a custom render
 * layer (e.g. 3D Tiles), whose control manages its own visibility, opacity and
 * zoom behavior: GeoLibre-owned extrusion when the control opts in, then
 * order, effective visibility and feature filters on each native layer.
 */
export function syncExternalCustomLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  nativeLayerIds: string[],
  beforeId?: string,
): void {
  // Controls whose native fills are ordinary vector polygons (e.g. Overture
  // Maps buildings) opt into GeoLibre-owned 3D extrusion. The Style panel
  // offers the 3D mode to these layers, so without this the toggle would
  // silently no-op on the ordering-only path below.
  if (
    supportsNativeFillExtrusion(layer) &&
    syncExternalNativeExtrusion(map, layer, nativeLayerIds, beforeId)
  ) {
    return;
  }
  clearExternalNativeExtrusion(map, layer, nativeLayerIds);

  for (const nativeLayerId of nativeLayerIds) {
    // A store layer can legitimately outlive its map layers: a layer whose
    // restore failed keeps the `nativeLayerIds` it was saved with, and the
    // owning control has not (yet) recreated them. Styling a layer that is
    // not on the map raises "Cannot get style of non-existing layer" on the
    // map's error channel, which fills the Diagnostics panel with noise the
    // user can do nothing about, so skip those ids until the control brings
    // them back.
    const nativeLayer = map.getLayer(nativeLayerId);
    if (!nativeLayer) continue;
    moveLayer(map, nativeLayerId, beforeId);
    // The owning control mirrors direct per-layer visibility changes from
    // the store, but effective state such as a hidden parent group never
    // mutates the child's stored `visible` flag. Apply the effective value
    // to ordinary native MapLibre layers here so group visibility reaches
    // control-rendered vectors too. MapLibre custom layers also accept the
    // standard layout visibility property.
    setNativeLayerVisibility(map, nativeLayerId, layer.visible ? "visible" : "none");
    // Control-painted vector layers (e.g. Add Vector Layer's circle/fill/line
    // layers) still honor a Time Slider window and the rule-based
    // hide-unmatched filter: filtering is independent of the paint the
    // control owns. Native layers without a filter (deck.gl / 3D Tiles
    // custom layers) are skipped by the type guard.
    if (nativeLayerSupportsFilter(nativeLayer.type)) {
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
}

export function ensureExternalGeoJsonNativeLayer(
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
    rememberGeoJsonData(map, nativeSourceId, layer.geojson);
  } else {
    setGeoJsonData(map.getSource(nativeSourceId) as maplibregl.GeoJSONSource, layer.geojson);
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

export function sourceIdFromNativeLayerId(layerId: string | undefined): string | null {
  return layerId ? `${layerId}-source` : null;
}

// Delegates to core's `controlRendersLayer` so the flag this dispatch branches
// on has exactly one definition: the Layer Library's "can this be re-added and
// rendered?" gate reads the same predicate (issue #1520), and a change to what
// marks a custom-render layer cannot leave the two disagreeing.
export function isExternalCustomLayer(layer: GeoLibreLayer): boolean {
  return controlRendersLayer(layer);
}

// Opt-in for control-managed layers (`customLayerType`, the ordering-only path)
// whose native fill layers are plain vector polygons GeoLibre can re-render as
// fill-extrusions. Controls that implement extrusion themselves — Add Vector
// Layer and DuckDB push `extrusionEnabled` into their own control style — must
// leave this unset, or both would extrude the same features.
export function supportsNativeFillExtrusion(layer: GeoLibreLayer): boolean {
  return layer.metadata.nativeFillExtrusion === true;
}

// External controls that paint their native layers with data-driven MapLibre
// expressions (selection-based color, radius, opacity, ...) cannot express that
// paint through GeoLibre's flat per-layer style. They opt in with this flag so
// the sync below keeps managing visibility, zoom range, and ordering while
// leaving the control's own paint untouched. Unlike `customLayerType`, which
// drops the layer onto an ordering-only path, these layers still respond to the
// panel's show/hide and reorder controls.
export function controlOwnsPaint(layer: GeoLibreLayer): boolean {
  return layer.metadata.controlOwnsPaint === true || pluginOwnsPaint(layer);
}

// Last opacity/visibility handed to a layer's paint bridge, so a sync pass that
// changed nothing (a reorder, a basemap swap) does not call the plugin's setters
// again — each call typically triggers a WebGL repaint. Keyed by bridge identity
// as well as layer id: a re-registration (project reload, unregister →
// register) installs a new bridge whose renderer has never been told the current
// values, so it must get a fresh apply even when the store values did not move.
export const appliedBridgeState = new Map<
  string,
  { bridge: ExternalNativePaintBridge; opacity: number; visible: boolean }
>();

// Forward the panel's generic controls to a plugin-painted layer's own API. The
// setters are optional, so a plugin can bridge opacity only (the common case:
// visibility already works, MapLibre honors it on a custom layer).
export function applyExternalNativePaintBridge(layer: GeoLibreLayer): void {
  const bridge = getExternalNativePaintBridge(layer.id);
  if (!bridge) {
    appliedBridgeState.delete(layer.id);
    return;
  }

  const applied = appliedBridgeState.get(layer.id);
  const sameBridge = applied?.bridge === bridge;
  if (!sameBridge || applied.opacity !== layer.opacity) {
    bridge.setOpacity?.(layer.opacity);
  }
  if (!sameBridge || applied.visible !== layer.visible) {
    bridge.setVisibility?.(layer.visible);
  }
  appliedBridgeState.set(layer.id, { bridge, opacity: layer.opacity, visible: layer.visible });
}
