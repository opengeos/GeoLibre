import {
  buildGetMapTileUrl,
  FemaWmsControl,
  type FemaWmsControlOptions,
  type FemaWmsEventHandler,
} from "maplibre-gl-fema-wms";
import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "../types";
import {
  createWebServiceStoreSync,
  layerTypeForTiles,
  readNativeRasterSource,
  stringMetadata,
  type WebServiceAdapter,
  type WebServiceLayerEntry,
} from "./web-service-sync";

const SOURCE_KIND = "fema-wms";
// Matches the control's native source/layer id scheme (`fema-wms-<name>`).
const NATIVE_ID_PREFIX = "fema-wms-";

let femaWmsPosition: GeoLibreMapControlPosition = "top-left";

const FEMA_WMS_OPTIONS = {
  collapsed: false,
  title: "FEMA NFHL",
  panelWidth: 340,
  className: "geolibre-fema-wms-control",
} satisfies Partial<FemaWmsControlOptions>;

let femaWmsControl: FemaWmsControl | null = null;
let controlEventHandler: FemaWmsEventHandler | null = null;

function layerNameFromStoreLayer(layer: GeoLibreLayer): string | undefined {
  const fromMetadata = stringMetadata(layer.metadata.femaLayerName);
  if (fromMetadata) return fromMetadata;
  return layer.id.startsWith(NATIVE_ID_PREFIX)
    ? layer.id.slice(NATIVE_ID_PREFIX.length)
    : undefined;
}

function storedVisibility(layerId: string): boolean | undefined {
  return useAppStore.getState().layers.find((candidate) => candidate.id === layerId)?.visible;
}

function wmsLayerName(entry: WebServiceLayerEntry): string {
  const fromMetadata = stringMetadata(entry.metadata?.femaLayerName);
  if (fromMetadata) return fromMetadata;
  if (!entry.id.startsWith(NATIVE_ID_PREFIX)) return entry.id;
  return entry.id.slice(NATIVE_ID_PREFIX.length);
}

const femaWmsAdapter: WebServiceAdapter<FemaWmsControl> = {
  sourceKind: SOURCE_KIND,
  attachEvents: (control, listener) => {
    // The control emits statechange alongside layeradd/layerremove/
    // opacitychange, so one subscription covers every relevant change.
    controlEventHandler = () => listener();
    control.on("statechange", controlEventHandler);
  },
  detachEvents: (control) => {
    if (!controlEventHandler) return;
    control.off("statechange", controlEventHandler);
    controlEventHandler = null;
  },
  listActive: (control) => {
    const map = control.getMap();
    const state = control.getState();
    const titles = new Map(control.getLayers().map((info) => [info.name, info.title]));
    return state.activeLayers.map((active) => {
      const id = `${NATIVE_ID_PREFIX}${active.name}`;
      const native = readNativeRasterSource(map, id);
      const tiles = native?.tiles ?? [buildGetMapTileUrl(state.url, active.name)];
      const title = titles.get(active.name);
      return {
        id,
        name: title ? `FEMA NFHL ${title}` : `FEMA NFHL ${active.name}`,
        sourceId: id,
        tiles,
        opacity: active.opacity,
        // The control has no per-layer visibility toggle; visibility is
        // driven from the Layers panel alone. Echo the store value so a
        // hidden layer is never reported (and persisted) as visible.
        visible: storedVisibility(id) ?? true,
        layerType: layerTypeForTiles(tiles),
        source: native?.source ?? {
          tileSize: 256,
          attribution: "FEMA National Flood Hazard Layer",
        },
        metadata: { femaLayerName: active.name, femaWmsUrl: state.url },
      };
    });
  },
  removeFromControl: (control, entry) => {
    control.removeLayer(wmsLayerName(entry));
  },
  setControlOpacity: (control, entry, opacity) => {
    control.setLayerOpacity(wmsLayerName(entry), opacity);
  },
  adopt: (control, layers) => {
    const activeNames = new Set(control.getState().activeLayers.map((active) => active.name));
    for (const layer of layers) {
      const name = layerNameFromStoreLayer(layer);
      if (!name || activeNames.has(name)) continue;
      control.addLayer(name, layer.opacity);
    }
  },
};

const femaWmsStoreSync = createWebServiceStoreSync(femaWmsAdapter);

export const maplibreFemaWmsPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-fema-wms",
  name: "FEMA NFHL",
  version: "0.1.2",
  activate: (app: GeoLibreAppAPI) => {
    if (!femaWmsControl) {
      femaWmsControl = new FemaWmsControl(getFemaWmsControlOptions());
    }

    const added = app.addMapControl(femaWmsControl, femaWmsPosition);
    if (!added) {
      femaWmsControl = null;
      return false;
    }
    femaWmsStoreSync.attach(femaWmsControl);
    setTimeout(() => femaWmsControl?.expand(), 0);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (!femaWmsControl) return;
    femaWmsStoreSync.detach();
    app.removeMapControl(femaWmsControl);
    femaWmsControl = null;
  },
  getMapControlPosition: () => femaWmsPosition,
  setMapControlPosition: (app: GeoLibreAppAPI, position: GeoLibreMapControlPosition) => {
    femaWmsPosition = position;
    if (!femaWmsControl) return;
    app.removeMapControl(femaWmsControl);
    const added = app.addMapControl(femaWmsControl, femaWmsPosition);
    if (!added) {
      femaWmsStoreSync.detach();
      femaWmsControl = null;
      return false;
    }
    setTimeout(() => femaWmsControl?.expand(), 0);
  },
};

function getFemaWmsControlOptions(): Partial<FemaWmsControlOptions> {
  return {
    ...FEMA_WMS_OPTIONS,
    position: femaWmsPosition,
  };
}
