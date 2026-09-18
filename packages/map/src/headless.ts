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
import type * as maplibregl from "maplibre-gl";
import { externalSourceIdsFor, removeLayerFromMap, syncLayer } from "./layer-sync";
import { installMapTransformCompat as _installMapTransformCompat } from "./map-transform-compat";
export { installMapTransformCompat } from "./map-transform-compat";

// Before any `Map` is constructed: re-expose `map.transform` for third-party
// code (notably @deck.gl/mapbox) that still reads it.
_installMapTransformCompat();

export interface LayerSync {
  /** Diff-sync the full layer list (bottom-to-top stacking order). */
  sync(layers: GeoLibreLayer[]): void;
  /** Remove every layer this sync previously added. */
  dispose(): void;
}

/**
 * Reapplies the input order among synchronized layers. Unlike MapController,
 * this headless sync does not compute style-layer anchors, so it cannot preserve
 * their placement relative to unmanaged or asynchronously inserted layers.
 */
export function createLayerSync(map: maplibregl.Map): LayerSync {
  let synced: GeoLibreLayer[] = [];

  return {
    sync(layers) {
      const nextIds = new Set(layers.map((layer) => layer.id));
      const previousById = new Map(synced.map((layer) => [layer.id, layer]));
      // Every layer in `layers` is on the map when this sync ends — including the ones the reorder
      // loop below takes off and puts straight back — so a source any of them draws from stays.
      const survivingSourceIds = externalSourceIdsFor(layers);
      for (const previous of synced) {
        if (!nextIds.has(previous.id)) {
          removeLayerFromMap(map, previous.id, previous, survivingSourceIds);
        }
      }

      // Input order is bottom-to-top: each addLayer without an anchor lands on
      // top of the previous one, so re-adding the whole tail in order rebuilds
      // the stack. MapLibre leaves an existing layer exactly where it is, so a
      // layer that only moved has to be removed first or it keeps its old
      // position and the documented order silently stops holding. Find the
      // lowest position whose occupant changed -- a layer that moved, or a new
      // layer inserted below existing ones -- and rebuild from there up.
      const keptIds = synced.map((layer) => layer.id).filter((id) => nextIds.has(id));
      let rebuildFrom = layers.length;
      let keptIndex = 0;
      for (let index = 0; index < layers.length; index += 1) {
        const id = layers[index].id;
        if (!previousById.has(id) || id !== keptIds[keptIndex]) {
          rebuildFrom = index;
          break;
        }
        keptIndex += 1;
      }
      for (let index = rebuildFrom; index < layers.length; index += 1) {
        const previous = previousById.get(layers[index].id);
        if (previous) removeLayerFromMap(map, layers[index].id, previous, survivingSourceIds);
      }

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
