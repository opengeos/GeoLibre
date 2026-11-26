import {
  geojsonHasZCoordinates,
  shouldUseTiledRendering,
  styleValue,
  type GeoLibreLayer,
} from "@geolibre/core";
import { pmtilesLineDecorationLayerId } from "./pmtiles-layer";
import { hasZoomDependentClusterFilter } from "./cluster-input";
import type * as maplibregl from "maplibre-gl";
import { unregisterPMTilesArchive } from "./pmtiles-archive";
import { unregisterGeoJsonVtSource } from "./geojson-vt-protocol";
import {
  circleLayerId,
  clusterCountLayerId,
  clusterLayerId,
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
import { classifyLayer, hasLayerKindSupport, unhandledLayerKind } from "./layer-kind";
import { MAPLIBRE_SUPPORTED_LAYER_KINDS } from "./maplibre-layer-kinds";
import { isPlaceholderLayer } from "./placeholders";
import { getActiveMapCrs } from "./active-map-crs";
import {
  managedZoomRangeLayerIds,
  styleLayerZoomRange,
  intersectZoomRange,
  stringSource,
  textFontForMapStyle,
  styleValuesEqual,
  forgetGeoJsonSourceClusterState,
  getExternalNativeLayerIds,
  getExternalSourceIds,
} from "./layer-sync-common";
import {
  isVectorControlLayer,
  externalExtrusionLayerId,
  overriddenRadiusNativeLayerIds,
} from "./layer-sync-external-paint";
import {
  removeStalePMTilesLineDecorations,
  getPMTilesSourceLayers,
} from "./layer-sync-external-tiles";
import {
  isExternalNativeLayer,
  syncExternalNativeLayer,
  appliedBridgeState,
} from "./layer-sync-external";
import { syncGeoJsonLayer, syncGeoJsonVtLayer } from "./layer-sync-vector-render";
import {
  syncRasterTileLayer,
  syncVideoLayer,
  syncImageLayer,
  syncVectorTileLayer,
  syncMbtilesLayer,
  mbtilesAllStyleLayerIds,
  vectorTileLayerId,
  vectorTileLineLayerId,
  vectorTileCircleLayerId,
  vectorTileAllStyleLayerIds,
} from "./layer-sync-tiles";
export {
  isCornerCoordinates,
  mbtilesFillLayerId,
  mbtilesExtrusionLayerId,
  mbtilesLineLayerId,
  mbtilesCircleLayerId,
  mbtilesStyleLayerIds,
  mbtilesAllStyleLayerIds,
  vectorTileLayerId,
  vectorTileLineLayerId,
  vectorTileCircleLayerId,
  vectorTileStyleLayerIds,
} from "./layer-sync-tiles";
export { hasLineGapLabels } from "./layer-sync-labels";
export { setExternalDeckLayerOrderHandler } from "./layer-sync-external";
export { externalExtrusionLayerId } from "./layer-sync-external-paint";
export { hasPendingExternalNativeFilters } from "./layer-sync-native-filters";
export {
  styleLayerZoomRange,
  intersectZoomRange,
  invalidateTextFontForMapStyle,
  textFontForMapStyle,
  styleValuesEqual,
  externalSourceIdsFor,
} from "./layer-sync-common";

// Existing importers (MapController, tests) read it from here.
export { hasZoomDependentClusterFilter };

export function syncLayer(map: maplibregl.Map, layer: GeoLibreLayer, beforeId?: string): void {
  if (isExternalNativeLayer(layer) || isVectorControlLayer(layer)) {
    syncExternalNativeLayer(map, layer, beforeId);
    return;
  }

  if (isPlaceholderLayer(layer)) return;

  const kind = classifyLayer(layer);
  // The plugin kinds are drawn by a plugin control (the ArcGIS, Zarr, LiDAR,
  // splat, 3D Tiles, COG, vector-file, DuckDB and deck.gl controls), which
  // registers its own native or deck.gl layers; the store record alone gives
  // layer-sync nothing to add. An unknown type is not drawn either.
  if (!hasLayerKindSupport(MAPLIBRE_SUPPORTED_LAYER_KINDS, kind, "native")) return;
  switch (kind) {
    case "geojson":
      if (!layer.geojson) return;
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
      // The tiled path cuts Web Mercator tiles on the main thread; in another
      // map CRS only MapLibre's own GeoJSON source, which projects in the
      // workers, lands features in the right place.
      if (shouldUseTiledRendering(layer.geoarrow ?? layer.geojson) && !getActiveMapCrs(map)) {
        syncGeoJsonVtLayer(map, layer, beforeId);
      } else {
        syncGeoJsonLayer(map, layer, beforeId);
      }
      return;
    case "raster-tiles":
      syncRasterTileLayer(map, layer, beforeId);
      return;
    case "vector-tiles":
      // Web Mercator tiles: not drawn on a map in another CRS (map-crs.ts).
      if (!getActiveMapCrs(map)) syncVectorTileLayer(map, layer, beforeId);
      return;
    case "tile-archive":
      // A PMTiles archive is drawn by its plugin control (registered above as
      // an external native layer) or is a placeholder; MBTiles is read here,
      // except on a map in another CRS, which its Web Mercator tiles miss.
      if (layer.type === "mbtiles" && !getActiveMapCrs(map)) syncMbtilesLayer(map, layer, beforeId);
      return;
    case "video":
      syncVideoLayer(map, layer, beforeId);
      return;
    case "image":
      syncImageLayer(map, layer, beforeId);
      return;
    default:
      // Unreachable: a kind the table calls native without a case above is a
      // compile error here.
      unhandledLayerKind(kind, undefined);
  }
}

export function removeLayerFromMap(
  map: maplibregl.Map,
  layerId: string,
  layer?: GeoLibreLayer,
  survivingSourceIds?: ReadonlySet<string>,
): void {
  // Drop cached paint-bridge state so a later layer reusing this id never
  // skips a fresh opacity/visibility apply against a new bridge.
  appliedBridgeState.delete(layerId);
  // Ownership is recorded per map, so this is safe (and needed) even when the caller has no layer.
  removeStalePMTilesLineDecorations(map, layerId);
  for (const id of [
    ...getExternalNativeLayerIds(layer),
    ...getExternalNativeLayerIds(layer).map(externalExtrusionLayerId),
    ...(layer ? mbtilesAllStyleLayerIds(layer) : []),
    ...(layer?.type === "pmtiles"
      ? getPMTilesSourceLayers(layer).map((sourceLayer) =>
          pmtilesLineDecorationLayerId(layerId, sourceLayer),
        )
      : []),
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
  // An archive's source layers share one source, so it goes only once nothing draws from it. The
  // store half covers a layer that survives this sync; the map half covers its siblings inside one
  // — deleting a folder removes its children in a single pass, and MapLibre reports removing a
  // source still under a style layer as an error the user can do nothing about.
  const stillInUse = survivingSourceIds ?? new Set<string>();
  // Only an external source can be shared — the derived ids below are this layer's alone — so the
  // map is asked at most once, and only when a shareable source is actually up for removal. Walked
  // layer by layer rather than read from `getStyle()`, which serializes the whole document.
  const shareable = new Set(getExternalSourceIds(layer));
  let drawnSources: Set<string> | undefined;
  const stillDrawn = (src: string): boolean => {
    drawnSources ??= new Set(
      map
        .getLayersOrder()
        .map((styleLayerId) => map.getLayer(styleLayerId)?.source)
        .filter((source): source is string => typeof source === "string"),
    );
    return drawnSources.has(src);
  };
  for (const src of [
    ...getExternalSourceIds(layer),
    sourceId(layerId),
    labelSourceId(layerId),
    invertedSourceId(layerId),
    generatorSourceId(layerId),
  ]) {
    if (!src || stillInUse.has(src) || !map.getSource(src)) continue;
    if (shareable.has(src) && stillDrawn(src)) continue;
    map.removeSource(src);
    forgetGeoJsonSourceClusterState(map, src);
  }
  // Drop radius-override tracking for the removed layer's native ids so a
  // later layer reusing an id never inherits a stale restore.
  const overriddenRadiusIds = overriddenRadiusNativeLayerIds.get(map);
  if (overriddenRadiusIds) {
    for (const id of getExternalNativeLayerIds(layer)) {
      overriddenRadiusIds.delete(id);
    }
  }
  const managedIds = managedZoomRangeLayerIds.get(map);
  if (managedIds) {
    for (const id of getExternalNativeLayerIds(layer)) {
      managedIds.delete(id);
    }
  }
  // Free any client-side tile index built for this layer's tiled render path.
  unregisterGeoJsonVtSource(layerId, map);
  // Free an in-memory PMTiles archive (an offline basemap extract) this layer
  // referenced; a no-op for remote pmtiles:// URLs.
  //
  // Refcounted the way the shared source above is: a split archive is several layers reading one
  // set of bytes, so freeing them when the first child goes would leave its siblings resolving
  // tiles against a protocol entry that no longer exists.
  if (layer?.type === "pmtiles") {
    const url = stringSource(layer.source.url) ?? layer.sourcePath;
    const heldByASibling = getExternalSourceIds(layer).some(
      (src) => stillInUse.has(src) || stillDrawn(src),
    );
    if (typeof url === "string" && !heldByASibling) unregisterPMTilesArchive(url);
  }
}
