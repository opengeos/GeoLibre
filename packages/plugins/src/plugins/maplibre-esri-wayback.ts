import { DEFAULT_LAYER_STYLE, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  DEFAULT_LAYER_ID,
  DEFAULT_SOURCE_ID,
  EsriWaybackControl,
  PERSISTENT_LAYER_PREFIX,
  getPersistentWaybackLayerId,
  type EsriWaybackControlEventHandler,
  type EsriWaybackControlOptions,
  type EsriWaybackRelease,
} from "maplibre-gl-esri-wayback";
import type { LayerSpecification } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "../types";

let esriWaybackPosition: GeoLibreMapControlPosition = "top-left";

const ESRI_WAYBACK_OPTIONS = {
  collapsed: false,
  title: "Esri Wayback",
  panelWidth: 340,
  className: "geolibre-esri-wayback-control",
  metadataOnClick: true,
} satisfies Omit<EsriWaybackControlOptions, "position">;

let esriWaybackControl: EsriWaybackControl | null = null;
let releaseChangeHandler: EsriWaybackControlEventHandler | null = null;
let stateChangeHandler: EsriWaybackControlEventHandler | null = null;

export const maplibreEsriWaybackPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-esri-wayback",
  name: "Historical Imagery",
  version: "0.2.0",
  activate: (app: GeoLibreAppAPI) => {
    if (!esriWaybackControl) {
      esriWaybackControl = new EsriWaybackControl(getEsriWaybackControlOptions());
      attachStoreSync(esriWaybackControl);
    }

    const added = app.addMapControl(esriWaybackControl, esriWaybackPosition);
    if (!added) {
      detachStoreSync(esriWaybackControl);
      esriWaybackControl = null;
      return false;
    }
    setTimeout(() => {
      esriWaybackControl?.expand();
      syncCurrentWaybackLayer(esriWaybackControl);
      syncPersistentWaybackLayers(esriWaybackControl);
    }, 0);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (!esriWaybackControl) return;
    detachStoreSync(esriWaybackControl);
    app.removeMapControl(esriWaybackControl);
    esriWaybackControl = null;
    removeCurrentWaybackStoreLayer();
  },
  getMapControlPosition: () => esriWaybackPosition,
  setMapControlPosition: (app: GeoLibreAppAPI, position: GeoLibreMapControlPosition) => {
    esriWaybackPosition = position;
    if (!esriWaybackControl) return;
    app.removeMapControl(esriWaybackControl);
    const added = app.addMapControl(esriWaybackControl, esriWaybackPosition);
    if (!added) {
      detachStoreSync(esriWaybackControl);
      esriWaybackControl = null;
      return false;
    }
    setTimeout(() => esriWaybackControl?.expand(), 0);
  },
};

function getEsriWaybackControlOptions(): EsriWaybackControlOptions {
  return {
    ...ESRI_WAYBACK_OPTIONS,
    position: esriWaybackPosition,
  };
}

function attachStoreSync(control: EsriWaybackControl): void {
  releaseChangeHandler = () => syncCurrentWaybackLayer(control);
  stateChangeHandler = () => syncPersistentWaybackLayers(control);
  control.on("releasechange", releaseChangeHandler);
  control.on("statechange", stateChangeHandler);
}

function detachStoreSync(control: EsriWaybackControl): void {
  if (releaseChangeHandler) {
    control.off("releasechange", releaseChangeHandler);
    releaseChangeHandler = null;
  }
  if (stateChangeHandler) {
    control.off("statechange", stateChangeHandler);
    stateChangeHandler = null;
  }
}

// Esri's usage terms require crediting the World Imagery (Wayback) tiles. The
// upstream control adds its raster source without an `attribution`, so set one
// so MapLibre's attribution control shows it (see applyWaybackAttribution).
const ESRI_WAYBACK_ATTRIBUTION =
  'Powered by <a href="https://www.esri.com/" target="_blank" rel="noreferrer">Esri</a> — Esri, Maxar, Earthstar Geographics, and the GIS User Community';

type WaybackMap = NonNullable<ReturnType<EsriWaybackControl["getMap"]>>;

/**
 * Attach Esri's attribution to a Wayback raster source and refresh the map's
 * attribution control. The upstream control owns the source and adds it without
 * an `attribution`, so we set it on the live source (which the attribution
 * control reads) and fire a `sourcedata` metadata event — the control only
 * re-reads attributions on source-metadata/style changes, never on tile loads.
 */
function applyWaybackAttribution(map: WaybackMap, sourceId: string): void {
  const source = map.getSource(sourceId) as unknown as { attribution?: string } | undefined;
  if (!source || source.attribution === ESRI_WAYBACK_ATTRIBUTION) return;
  source.attribution = ESRI_WAYBACK_ATTRIBUTION;
  map.fire("sourcedata", { sourceDataType: "metadata", sourceId });
}

function syncCurrentWaybackLayer(control: EsriWaybackControl | null): void {
  const map = control?.getMap();
  const release = control?.getState().selectedRelease;
  if (!map?.getLayer(DEFAULT_LAYER_ID) || !release) return;
  applyWaybackAttribution(map, DEFAULT_SOURCE_ID);
  addOrUpdateWaybackStoreLayer(createCurrentWaybackStoreLayer(release));
}

function syncPersistentWaybackLayers(control: EsriWaybackControl | null): void {
  const map = control?.getMap();
  const state = control?.getState();
  if (!map || !state) return;

  const activePersistentIds = new Set<string>();
  for (const styleLayer of map.getStyle().layers ?? []) {
    if (!styleLayer.id.startsWith(`${PERSISTENT_LAYER_PREFIX}-`)) continue;
    activePersistentIds.add(styleLayer.id);
    const persistentSourceId = getStyleLayerSourceId(styleLayer);
    if (persistentSourceId) applyWaybackAttribution(map, persistentSourceId);
    const release = state.releases.find(
      (item) => getPersistentWaybackLayerId(item) === styleLayer.id,
    );
    addOrUpdateWaybackStoreLayer(createPersistentWaybackStoreLayer(styleLayer, release));
  }

  const store = useAppStore.getState();
  const stalePersistentIds = store.layers
    .filter(
      (layer) =>
        layer.metadata.sourceKind === "esri-wayback-persistent" &&
        !activePersistentIds.has(layer.id),
    )
    .map((layer) => layer.id);
  for (const id of stalePersistentIds) {
    store.removeLayer(id);
  }
}

function addOrUpdateWaybackStoreLayer(layer: GeoLibreLayer): void {
  const store = useAppStore.getState();
  const existingLayer = store.layers.find((item) => item.id === layer.id);
  if (!existingLayer) {
    store.addLayer(layer);
    return;
  }

  if (!shouldUpdateWaybackStoreLayer(existingLayer, layer)) return;

  store.updateLayer(layer.id, {
    metadata: layer.metadata,
    name: layer.name,
    source: layer.source,
    sourcePath: layer.sourcePath,
  });
}

function shouldUpdateWaybackStoreLayer(
  existingLayer: GeoLibreLayer,
  nextLayer: GeoLibreLayer,
): boolean {
  return (
    existingLayer.name !== nextLayer.name ||
    existingLayer.sourcePath !== nextLayer.sourcePath ||
    JSON.stringify(existingLayer.metadata) !== JSON.stringify(nextLayer.metadata) ||
    JSON.stringify(existingLayer.source) !== JSON.stringify(nextLayer.source)
  );
}

function removeCurrentWaybackStoreLayer(): void {
  const store = useAppStore.getState();
  if (store.layers.some((layer) => layer.id === DEFAULT_LAYER_ID)) {
    store.removeLayer(DEFAULT_LAYER_ID);
  }
}

function createCurrentWaybackStoreLayer(release: EsriWaybackRelease): GeoLibreLayer {
  return createWaybackStoreLayer({
    id: DEFAULT_LAYER_ID,
    name: `Esri Wayback ${release.releaseDateLabel}`,
    nativeLayerId: DEFAULT_LAYER_ID,
    release,
    sourceId: DEFAULT_SOURCE_ID,
    sourceKind: "esri-wayback-current",
  });
}

function createPersistentWaybackStoreLayer(
  styleLayer: LayerSpecification,
  release: EsriWaybackRelease | undefined,
): GeoLibreLayer {
  return createWaybackStoreLayer({
    id: styleLayer.id,
    name: release
      ? `Esri Wayback ${release.releaseDateLabel}`
      : layerNameFromPersistentWaybackId(styleLayer.id),
    nativeLayerId: styleLayer.id,
    release,
    sourceId: getStyleLayerSourceId(styleLayer) ?? `${styleLayer.id}-source`,
    sourceKind: "esri-wayback-persistent",
  });
}

function createWaybackStoreLayer(options: {
  id: string;
  name: string;
  nativeLayerId: string;
  release?: EsriWaybackRelease;
  sourceId: string;
  sourceKind: "esri-wayback-current" | "esri-wayback-persistent";
}): GeoLibreLayer {
  return {
    id: options.id,
    name: options.name,
    type: "raster",
    source: {
      type: "raster",
      sourceId: options.sourceId,
      url: options.release?.itemURL,
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      externalNativeLayer: true,
      identifiable: false,
      nativeLayerIds: [options.nativeLayerId],
      sourceId: options.sourceId,
      sourceIds: [options.sourceId],
      sourceKind: options.sourceKind,
      waybackItemId: options.release?.itemID,
      waybackItemUrl: options.release?.itemURL,
      waybackMetadataLayerUrl: options.release?.metadataLayerUrl,
      waybackReleaseDate: options.release?.releaseDateLabel,
      waybackReleaseNumber: options.release?.releaseNum,
    },
    sourcePath: options.release?.itemURL,
  };
}

function getStyleLayerSourceId(layer: LayerSpecification): string | undefined {
  return "source" in layer && typeof layer.source === "string" ? layer.source : undefined;
}

function layerNameFromPersistentWaybackId(layerId: string): string {
  const label = layerId.replace(`${PERSISTENT_LAYER_PREFIX}-`, "").replaceAll("-", " ");
  return label ? `Esri Wayback ${label}` : "Esri Wayback";
}
