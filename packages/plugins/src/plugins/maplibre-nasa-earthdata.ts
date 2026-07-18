import {
  buildTileUrl,
  NasaEarthdataControl,
  type AddedLayerState,
  type GibsLayer,
  type NasaEarthdataControlOptions,
  type NasaEarthdataEventHandler,
} from "maplibre-gl-nasa-earthdata";
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

const SOURCE_KIND = "nasa-earthdata";
// Matches the control's native source/layer id scheme (`nasa-gibs-<key>`).
const NATIVE_ID_PREFIX = "nasa-gibs-";

let nasaEarthdataPosition: GeoLibreMapControlPosition = "top-left";

const NASA_EARTHDATA_OPTIONS = {
  collapsed: false,
  title: "NASA Earthdata",
  panelWidth: 360,
  className: "geolibre-nasa-earthdata-control",
} satisfies NasaEarthdataControlOptions;

let nasaEarthdataControl: NasaEarthdataControl | null = null;
let controlEventHandler: NasaEarthdataEventHandler | null = null;

// GIBS catalog entries seen in layeradd events, keyed by GIBS layer id. The
// control state alone does not carry the catalog data needed to rebuild
// tile URLs, so the payloads are cached for the reconciler.
const gibsLayerCache = new Map<string, GibsLayer>();

function instanceKey(entry: WebServiceLayerEntry): string {
  return stringMetadata(entry.metadata?.nasaKey) ?? entry.id.slice(NATIVE_ID_PREFIX.length);
}

function addedLayerStateFromStoreLayer(layer: GeoLibreLayer): AddedLayerState | null {
  const key =
    stringMetadata(layer.metadata.nasaKey) ??
    (layer.id.startsWith(NATIVE_ID_PREFIX) ? layer.id.slice(NATIVE_ID_PREFIX.length) : undefined);
  if (!key) return null;
  // Instance keys for time-enabled layers are `<gibsId>@<date>`.
  const gibsId = stringMetadata(layer.metadata.nasaLayerId) ?? key.split("@")[0];
  if (!gibsId) return null;
  const date = stringMetadata(layer.metadata.nasaDate);
  return {
    key,
    id: gibsId,
    ...(date ? { date } : {}),
    opacity: layer.opacity,
    visible: layer.visible,
  };
}

const nasaEarthdataAdapter: WebServiceAdapter<NasaEarthdataControl> = {
  sourceKind: SOURCE_KIND,
  attachEvents: (control, listener) => {
    controlEventHandler = (event) => {
      if (event.type === "layeradd" && event.layer) {
        gibsLayerCache.set(event.layer.id, event.layer);
      }
      // layeradd/layerremove are always followed by statechange; reconciling
      // on statechange alone keeps one reconcile per control mutation while
      // the layeradd subscription still fills the catalog cache first.
      if (event.type === "statechange") listener();
    };
    control.on("layeradd", controlEventHandler);
    control.on("layerremove", controlEventHandler);
    control.on("statechange", controlEventHandler);
  },
  detachEvents: (control) => {
    if (!controlEventHandler) return;
    control.off("layeradd", controlEventHandler);
    control.off("layerremove", controlEventHandler);
    control.off("statechange", controlEventHandler);
    controlEventHandler = null;
    gibsLayerCache.clear();
  },
  listActive: (control) => {
    const map = control.getMap();
    const entries: WebServiceLayerEntry[] = [];
    for (const added of control.getState().addedLayers) {
      const id = `${NATIVE_ID_PREFIX}${added.key}`;
      const gibs = gibsLayerCache.get(added.id);
      const native = readNativeRasterSource(map, id);
      const tiles = native?.tiles ?? (gibs ? [buildTileUrl(gibs, added.date)] : storeTiles(id));
      if (!tiles || tiles.length === 0) continue;
      entries.push({
        id,
        name: gibs
          ? `NASA ${gibs.title}${added.date ? ` ${added.date}` : ""}`
          : `NASA Earthdata ${added.id}`,
        sourceId: id,
        tiles,
        opacity: added.opacity,
        visible: added.visible,
        layerType: layerTypeForTiles(tiles),
        source: native?.source ?? {
          tileSize: 256,
          ...(gibs ? { maxzoom: gibs.maxZoom } : {}),
          attribution: "NASA EOSDIS GIBS",
        },
        metadata: {
          nasaKey: added.key,
          nasaLayerId: added.id,
          ...(added.date ? { nasaDate: added.date } : {}),
        },
      });
    }
    return entries;
  },
  removeFromControl: (control, entry) => {
    control.removeLayer(instanceKey(entry));
  },
  setControlOpacity: (control, entry, opacity) => {
    control.setLayerOpacity(instanceKey(entry), opacity);
  },
  setControlVisibility: (control, entry, visible) => {
    control.setLayerVisibility(instanceKey(entry), visible);
  },
  adopt: (control, layers) => {
    const existingKeys = new Set(control.getState().addedLayers.map((added) => added.key));
    const restored = layers
      .map(addedLayerStateFromStoreLayer)
      .filter((state): state is AddedLayerState => state !== null && !existingKeys.has(state.key));
    if (restored.length === 0) return;
    // setState reconciles addedLayers against the map, deferring until the
    // GIBS capabilities have loaded when necessary.
    control.setState({
      addedLayers: [...control.getState().addedLayers, ...restored],
    });
  },
};

// Tile URL recorded in the store layer, used when neither the native source
// nor the catalog cache is available yet (e.g. right after a project load).
function storeTiles(layerId: string): string[] | null {
  const layer = useAppStore.getState().layers.find((candidate) => candidate.id === layerId);
  const tileUrl = layer ? stringMetadata(layer.metadata.tileUrl) : undefined;
  return tileUrl ? [tileUrl] : null;
}

const nasaEarthdataStoreSync = createWebServiceStoreSync(nasaEarthdataAdapter);

export const maplibreNasaEarthdataPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-nasa-earthdata",
  name: "NASA Earthdata",
  version: "0.1.4",
  activate: (app: GeoLibreAppAPI) => {
    if (!nasaEarthdataControl) {
      nasaEarthdataControl = new NasaEarthdataControl(getNasaEarthdataControlOptions());
    }

    const added = app.addMapControl(nasaEarthdataControl, nasaEarthdataPosition);
    if (!added) {
      nasaEarthdataControl = null;
      return false;
    }
    nasaEarthdataStoreSync.attach(nasaEarthdataControl);
    setTimeout(() => nasaEarthdataControl?.expand(), 0);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (!nasaEarthdataControl) return;
    nasaEarthdataStoreSync.detach();
    app.removeMapControl(nasaEarthdataControl);
    nasaEarthdataControl = null;
  },
  getMapControlPosition: () => nasaEarthdataPosition,
  setMapControlPosition: (app: GeoLibreAppAPI, position: GeoLibreMapControlPosition) => {
    nasaEarthdataPosition = position;
    if (!nasaEarthdataControl) return;
    app.removeMapControl(nasaEarthdataControl);
    const added = app.addMapControl(nasaEarthdataControl, nasaEarthdataPosition);
    if (!added) {
      nasaEarthdataStoreSync.detach();
      nasaEarthdataControl = null;
      return false;
    }
    setTimeout(() => nasaEarthdataControl?.expand(), 0);
  },
};

function getNasaEarthdataControlOptions(): NasaEarthdataControlOptions {
  return {
    ...NASA_EARTHDATA_OPTIONS,
    position: nasaEarthdataPosition,
  };
}
