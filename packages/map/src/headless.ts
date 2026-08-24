/**
 * Headless entry (`@geolibre/map/headless`): data loading + layer
 * synchronization without React, the zustand store, Cesium, or map controls.
 *
 * Feed a `GeoLibreLayer[]` to {@link createLayerSync}'s `sync()` whenever the
 * layer model changes; it diffs against the previous array and drives
 * MapLibre's addSource/addLayer through the same `syncLayer()` used by the
 * full app.
 */
import type { GeoLibreLayer } from "@geolibre/core";
import { removeLayerFromMap, syncLayer } from "./layer-sync";

export interface LayerSync {
  /** Diff-sync the full layer list (bottom-to-top stacking order). */
  sync(layers: GeoLibreLayer[]): void;
  /** Remove every layer this sync previously added. */
  dispose(): void;
}

/**
 * ponytail: bottom-up re-add ordering gives correct stacking on insert and
 * append, but moving an existing layer mid-stack does not restack until it is
 * removed and re-added. Full anchor logic lives in MapController.
 * getBeforeStyleLayerId; port it here if in-place reordering matters.
 */
export function createLayerSync(map: maplibregl.Map): LayerSync {
  let synced: GeoLibreLayer[] = [];

  return {
    sync(layers) {
      const nextIds = new Set(layers.map((layer) => layer.id));
      for (const previous of synced) {
        if (!nextIds.has(previous.id)) removeLayerFromMap(map, previous.id, previous);
      }
      // Input order is bottom-to-top: each addLayer without an anchor lands on
      // top of the previous one, so the final stack matches the input order.
      for (const layer of layers) syncLayer(map, layer);
      synced = [...layers];
    },
    dispose() {
      for (const layer of synced) removeLayerFromMap(map, layer.id, layer);
      synced = [];
    },
  };
}

// Data-loading helpers (COG / PMTiles protocols must be registered before use).
export {
  registerCogDemSource,
  encodeTerrariumDem,
  CogDemError,
  type CogDemErrorCode,
} from "./cog-dem-source";
export {
  registerPMTilesArchive,
  unregisterPMTilesArchive,
  ensureRemotePMTilesArchive,
} from "./layer-sync";
export { readRemotePMTilesInfo, readPMTilesArchiveInfo } from "./pmtiles-layer";
// Style engine outputs (standard MapLibre style-spec objects).
export {
  fillPaint,
  linePaint,
  circlePaint,
  heatmapPaint,
  clusterCirclePaint,
  fillExtrusionPaint,
  rasterPaint,
} from "./style-mapper";
// Vector geometry/ID conventions shared by the paths above.
export {
  detectGeometryProfile,
  getLayerBounds,
  sourceId,
  fillLayerId,
  lineLayerId,
  circleLayerId,
} from "./geojson-loader";
export {
  buildGeneratedGeometry,
  buildInvertedMask,
  generatedGeometryKinds,
  lineDecorationColorValue,
} from "./derived-geometry";
export {
  buildMapboxStyle,
  mapboxStyleToJson,
  type ExportableLayer,
  type MapboxStyleExportOptions,
  type MapboxStyleExportResult,
} from "./mapbox-style-export";
export {
  applyMapboxStyleImport,
  parseMapboxStyle,
  type MapboxStyleImportResult,
} from "./mapbox-style-import";
export { buildGeoLibreQueryStyle, geoLibreStyleSourceName } from "./query-param-style";
export {
  buildSld,
  OGC_SCALE_DENOMINATOR_AT_ZOOM_0,
  type SldExportableLayer,
  type SldExportOptions,
  type SldExportResult,
} from "./sld-export";
export { applySldImport, parseSld, type SldImportResult } from "./sld-import";
export {
  buildQml,
  type QmlExportableLayer,
  type QmlExportOptions,
  type QmlExportResult,
} from "./qml-export";
export { applyQmlImport, parseQml, type QmlImportResult } from "./qml-import";
export {
  isMapboxStyleUrl,
  loadMapboxStyle,
  mapboxAccessTokenFromStyleUrl,
  redactMapboxStyleUrl,
  resolveMapboxInternalUrl,
  transformMapboxStyle,
} from "./mapbox-style";
export {
  buildProtomapsBasemapStyle,
  evictOfflineBasemapStyle,
  getOfflineBasemapStyle,
  isOfflineBasemapSentinel,
  registerOfflineBasemapStyle,
  OFFLINE_BASEMAP_SENTINEL_PREFIX,
  PROTOMAPS_FLAVORS,
  type ProtomapsBasemapStyleOptions,
  type ProtomapsFlavor,
} from "./protomaps-basemap";
export {
  featuresIntersectingPolygon,
  selectionModeFromModifiers,
  type FeatureSelectionRequest,
  type FeatureSelectionShape,
} from "./feature-selection";
export { isPlaceholderLayer, placeholderMessage } from "./placeholders";
