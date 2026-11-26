// Paint, visibility and extrusion bridging for external native layers and vector-control point symbology.

import { proportionalRadiusExpression, styleValue, type GeoLibreLayer } from "@geolibre/core";
import type * as maplibregl from "maplibre-gl";
import type { PropertyValueSpecification } from "maplibre-gl";
import { markerLayerId } from "./geojson-loader";
import { ensureGeneratedImageHandler } from "./generated-images";
import { getDynamicPaintProperty, setDynamicPaintProperty } from "./dynamic-style-property";
import { markerImageValue, markerIconSizeValue } from "./markers";
import {
  circlePaint,
  fillExtrusionPaint,
  fillPaint,
  linePaint,
  rasterPaint,
  withPaintResets,
} from "./style-mapper";
import { OwnedPaintResets } from "./owned-paint-resets";
import {
  styleLayerZoomRange,
  intersectZoomRange,
  ensureLayer,
  styleValuesEqual,
  removeIfExists,
  getExternalNativeLayerIds,
} from "./layer-sync-common";
import {
  nativeFilterStatesFor,
  externalFeatureFilterExtras,
  combineExternalFilters,
} from "./layer-sync-native-filters";

/** `metadata.sourceKind` for the layers maplibre-gl-vector owns. */
export const VECTOR_CONTROL_SOURCE_KIND = "maplibre-gl-vector";

/**
 * A layer the Add Vector Layer control owns, matched by its metadata rather
 * than by having native layer ids.
 *
 * Restoring after a style change, the control clears its retained record's
 * `layerIds` and then *awaits* re-reading the source data before it can fill
 * them back in. GeoLibre mirrors the control's layer list into the store, so a
 * sync landing inside that window sees `nativeLayerIds: []`, no longer
 * recognizes the layer as external, and rebuilds it down the ordinary GeoJSON
 * path: a second source and circle layer carrying GeoLibre's own paint,
 * stacked under the one the control restores a moment later. That is the
 * concentric point ring of opengeos/GeoLibre#1902.
 *
 * The control owns these layers in either window, so route them to the
 * external path throughout. There they take the {@link isExternalCustomLayer}
 * branch, which already tolerates an empty id list: it no-ops until the
 * control brings its layers back and the next sync reconciles them normally.
 *
 * `customLayerType` is part of the match because
 * `createVectorStoreLayer` always sets it (`vectorCustomLayerType` falls back
 * to `"custom"`), so every genuine control layer carries it at every point in
 * its lifecycle. Requiring it leaves a layer that claims the `sourceKind`
 * without it — a hand-edited or pre-`customLayerType` project file, which no
 * live control will ever hand native layer ids — on the ordinary GeoJSON path,
 * where its embedded `geojson` still renders.
 */
export function isVectorControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.metadata.sourceKind === VECTOR_CONTROL_SOURCE_KIND &&
    typeof layer.metadata.customLayerType === "string"
  );
}

export function setNativeLayerVisibility(
  map: maplibregl.Map,
  nativeLayerId: string,
  visibility: "visible" | "none",
): void {
  try {
    const canRead = typeof map.getLayoutProperty === "function";
    const current = canRead ? map.getLayoutProperty(nativeLayerId, "visibility") : undefined;
    if (current === visibility || (canRead && current === undefined && visibility === "visible"))
      return;
    map.setLayoutProperty(nativeLayerId, "visibility", visibility);
  } catch {
    // Custom layers from external controls may not accept layout updates.
  }
}

export function getStyleLayerSpec(
  map: maplibregl.Map,
  layerId: string,
): maplibregl.LayerSpecification | null {
  const live = map.getLayer(layerId) as
    | (maplibregl.StyleLayer & {
        serialize?: () => maplibregl.LayerSpecification;
        source?: string;
      })
    | undefined;
  if (live) {
    if (typeof live.serialize === "function") {
      return live.serialize();
    }
    if (
      typeof live.type === "string" &&
      (typeof live.source === "string" || live.type === "background")
    ) {
      return live as unknown as maplibregl.LayerSpecification;
    }
  }
  return map.getStyle?.()?.layers?.find((layer) => layer.id === layerId) ?? null;
}

export function isFillStyleLayerSpec(
  layer: maplibregl.LayerSpecification | null,
): layer is maplibregl.FillLayerSpecification {
  return layer?.type === "fill";
}

export function externalExtrusionLayerId(nativeLayerId: string): string {
  return `${nativeLayerId}-geolibre-extrusion`;
}

// Native layers hidden to make room for a synthetic fill-extrusion layer.
// Tracked so switching 3D extrusion back off can restore them on the
// control-managed path, which otherwise never writes visibility (the control
// owns it) and would leave the layer invisible. Keyed per map (like
// `nativeFilterStatesFor`) because native layer ids are only unique within one
// map: two live maps showing the same control would otherwise share entries,
// and one clearing extrusion would strand the other's fill hidden.
export const extrusionHiddenNativeLayerIdsByMap = new WeakMap<maplibregl.Map, Set<string>>();

export function extrusionHiddenNativeLayerIdsFor(map: maplibregl.Map): Set<string> {
  let ids = extrusionHiddenNativeLayerIdsByMap.get(map);
  if (!ids) {
    ids = new Set();
    extrusionHiddenNativeLayerIdsByMap.set(map, ids);
  }
  return ids;
}

/**
 * Render an external control's native `fill` layers as GeoLibre-owned
 * `fill-extrusion` layers built from the same source and source layer.
 *
 * The natives are hidden rather than restyled, so the control keeps owning
 * them and a later toggle back to 2D restores its rendering untouched.
 *
 * @param map: The MapLibre map to reconcile against.
 * @param layer: The store layer whose style drives the extrusion paint.
 * @param nativeLayerIds: Native layer ids registered by the control.
 * @param beforeId: Layer id the extrusion layers are inserted before.
 * @returns True when extrusion layers were applied, false when the layer is
 *     not extruded or exposes no native fill layer to extrude.
 */
export function syncExternalNativeExtrusion(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  nativeLayerIds: string[],
  beforeId?: string,
): boolean {
  if (!layer.style.extrusionEnabled) return false;

  const nativeFillLayerSpecs = nativeLayerIds
    .map((nativeLayerId) => getStyleLayerSpec(map, nativeLayerId))
    .filter(isFillStyleLayerSpec);
  if (nativeFillLayerSpecs.length === 0) return false;

  const hiddenNativeLayerIds = extrusionHiddenNativeLayerIdsFor(map);
  for (const nativeLayerId of nativeLayerIds) {
    setNativeLayerVisibility(map, nativeLayerId, "none");
    hiddenNativeLayerIds.add(nativeLayerId);
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
  return true;
}

/**
 * Drop the synthetic extrusion layers for `nativeLayerIds` and un-hide any
 * native layer {@link syncExternalNativeExtrusion} hid for them.
 *
 * @param map: The MapLibre map to reconcile against.
 * @param layer: The store layer, read for its current visibility.
 * @param nativeLayerIds: Native layer ids registered by the control.
 */
export function clearExternalNativeExtrusion(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  nativeLayerIds: string[],
): void {
  const hiddenNativeLayerIds = extrusionHiddenNativeLayerIdsFor(map);
  for (const nativeLayerId of nativeLayerIds) {
    removeIfExists(map, externalExtrusionLayerId(nativeLayerId));
    if (hiddenNativeLayerIds.delete(nativeLayerId)) {
      setNativeLayerVisibility(map, nativeLayerId, layer.visible ? "visible" : "none");
    }
  }
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
export function syncVectorControlPointSymbology(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  if (!isVectorControlLayer(layer)) return;
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
  const markerImage = markerImageValue(layer.style);

  if (markerImage && circleSpec) {
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
          "icon-image": markerImage as PropertyValueSpecification<string>,
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
    if (!styleValuesEqual(getDynamicPaintProperty(map, circleNativeId, "circle-radius"), radius)) {
      setDynamicPaintProperty(map, circleNativeId, "circle-radius", radius);
    }
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
export const overriddenRadiusNativeLayerIds = new WeakMap<maplibregl.Map, Set<string>>();

export function overriddenRadiusIdsFor(map: maplibregl.Map): Set<string> {
  let ids = overriddenRadiusNativeLayerIds.get(map);
  if (!ids) {
    ids = new Set();
    overriddenRadiusNativeLayerIds.set(map, ids);
  }
  return ids;
}

/** Hand an overridden circle-radius back to the control's flat value. */
export function restoreOverriddenCircleRadius(
  map: maplibregl.Map,
  circleNativeId: string,
  layer: GeoLibreLayer,
): void {
  if (!overriddenRadiusIdsFor(map).delete(circleNativeId)) return;
  map.setPaintProperty(circleNativeId, "circle-radius", styleValue(layer.style, "circleRadius"));
}

// The nullable paint GeoLibre wrote on plugin and control native layers, per
// map (see OwnedPaintResets).
export const ownedPaintResets = new WeakMap<maplibregl.Map, OwnedPaintResets>();

export function ownedPaintResetsFor(map: maplibregl.Map): OwnedPaintResets {
  let owned = ownedPaintResets.get(map);
  if (!owned) {
    owned = new OwnedPaintResets();
    ownedPaintResets.set(map, owned);
  }
  return owned;
}

export function setExternalNativeLayerPaint(
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

  const ownedResets = ownedPaintResetsFor(map);
  // MapLibre's getLayer returns the style's own layer object, stable for the
  // layer's life.
  const lookup = (id: string): object | undefined => map.getLayer(id) ?? undefined;
  for (const [property, value] of Object.entries(withPaintResets(nativeLayerType, paint))) {
    try {
      // On a layer a plugin or control created, a reset may hit the control's
      // own value (its dashed lines), so only one GeoLibre wrote is reset, once.
      if (value === null && !ownedResets.mayReset(lookup, nativeLayerId, property)) continue;
      if (!styleValuesEqual(getDynamicPaintProperty(map, nativeLayerId, property), value)) {
        setDynamicPaintProperty(map, nativeLayerId, property, value);
        if (value !== null) ownedResets.recordWrite(lookup, nativeLayerId, property);
      }
    } catch {
      // External controls can create heterogeneous style layers. Ignore paint
      // properties that do not apply to a specific native layer type.
    }
  }
}
