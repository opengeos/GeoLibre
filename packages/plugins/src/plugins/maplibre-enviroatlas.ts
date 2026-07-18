import {
  buildTileTemplate,
  EnviroAtlasControl,
  type AddedLayer,
  type EnviroAtlasControlEventHandler,
  type EnviroAtlasControlOptions,
  type ServiceRef,
} from "maplibre-gl-enviroatlas";
import type { GeoLibreLayer } from "@geolibre/core";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "../types";
import {
  createWebServiceStoreSync,
  layerTypeForTiles,
  readNativeRasterSource,
  stringMetadata,
  type WebServiceAdapter,
  type WebServiceLayerEntry,
} from "./web-service-sync";

const SOURCE_KIND = "enviroatlas";

// Matches the package's AddedLayer.bounds type, which is not exported.
type LngLatBoundsArray = [number, number, number, number];

let enviroAtlasPosition: GeoLibreMapControlPosition = "top-left";

const ENVIROATLAS_OPTIONS = {
  collapsed: false,
  title: "US EPA EnviroAtlas",
  panelWidth: 360,
  className: "geolibre-enviroatlas-control",
  // Tile mode is required for persistence: the default image mode renders a
  // single viewport export that cannot be rebuilt from saved project state.
  renderMode: "tiles",
} satisfies EnviroAtlasControlOptions;

let enviroAtlasControl: EnviroAtlasControl | null = null;
let controlEventHandler: EnviroAtlasControlEventHandler | null = null;

function isServiceRef(value: unknown): value is ServiceRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.folder === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.fullName === "string" &&
    (candidate.type === "MapServer" || candidate.type === "ImageServer")
  );
}

function isBounds(value: unknown): value is LngLatBoundsArray {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

function addedLayerId(entry: WebServiceLayerEntry): string {
  return stringMetadata(entry.metadata?.enviroatlasId) ?? entry.id;
}

function addedLayerFromStoreLayer(layer: GeoLibreLayer): AddedLayer | null {
  const service = layer.metadata.enviroatlasService;
  if (!isServiceRef(service)) return null;
  const sublayerId = layer.metadata.enviroatlasSublayerId;
  const bounds = layer.metadata.enviroatlasBounds;
  return {
    id: stringMetadata(layer.metadata.enviroatlasId) ?? layer.id,
    sourceId: stringMetadata(layer.metadata.sourceId) ?? layer.id,
    layerId: layer.id,
    service,
    ...(typeof sublayerId === "number" ? { sublayerId } : {}),
    label: stringMetadata(layer.metadata.enviroatlasLabel) ?? layer.name,
    visible: layer.visible,
    opacity: layer.opacity,
    ...(isBounds(bounds) ? { bounds } : {}),
  };
}

const enviroAtlasAdapter: WebServiceAdapter<EnviroAtlasControl> = {
  sourceKind: SOURCE_KIND,
  attachEvents: (control, listener) => {
    // statechange accompanies every layer mutation (add/remove/opacity/
    // visibility), so a single subscription is enough.
    controlEventHandler = (event) => {
      if (event.type === "statechange") listener();
    };
    control.on("statechange", controlEventHandler);
  },
  detachEvents: (control) => {
    if (!controlEventHandler) return;
    control.off("statechange", controlEventHandler);
    controlEventHandler = null;
  },
  listActive: (control) => {
    const map = control.getMap();
    return control.getState().addedLayers.map((added) => {
      const native = readNativeRasterSource(map, added.sourceId);
      const tiles = native?.tiles ?? [buildTileTemplate(added.service, added.sublayerId)];
      return {
        id: added.layerId,
        name: `EnviroAtlas ${added.label}`,
        sourceId: added.sourceId,
        tiles,
        opacity: added.opacity,
        visible: added.visible,
        layerType: layerTypeForTiles(tiles),
        source: native?.source ?? {
          tileSize: 256,
          attribution: "U.S. EPA EnviroAtlas",
          ...(added.bounds ? { bounds: added.bounds } : {}),
        },
        metadata: {
          enviroatlasId: added.id,
          enviroatlasService: { ...added.service },
          ...(added.sublayerId !== undefined ? { enviroatlasSublayerId: added.sublayerId } : {}),
          enviroatlasLabel: added.label,
          ...(added.bounds ? { enviroatlasBounds: added.bounds } : {}),
        },
      };
    });
  },
  removeFromControl: (control, entry) => {
    control.removeLayer(addedLayerId(entry));
  },
  setControlOpacity: (control, entry, opacity) => {
    control.setLayerOpacity(addedLayerId(entry), opacity);
  },
  setControlVisibility: (control, entry, visible) => {
    control.setLayerVisibility(addedLayerId(entry), visible);
  },
  adopt: (control, layers) => {
    const restored = layers
      .map(addedLayerFromStoreLayer)
      .filter((entry): entry is AddedLayer => entry !== null);
    if (restored.length === 0) return;
    control.restoreLayers(restored);
  },
};

const enviroAtlasStoreSync = createWebServiceStoreSync(enviroAtlasAdapter);

export const maplibreEnviroAtlasPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-enviroatlas",
  name: "US EPA EnviroAtlas",
  version: "0.1.1",
  activate: (app: GeoLibreAppAPI) => {
    if (!enviroAtlasControl) {
      enviroAtlasControl = new EnviroAtlasControl(getEnviroAtlasControlOptions());
    }

    const added = app.addMapControl(enviroAtlasControl, enviroAtlasPosition);
    if (!added) {
      enviroAtlasControl = null;
      return false;
    }
    enviroAtlasStoreSync.attach(enviroAtlasControl);
    setTimeout(() => enviroAtlasControl?.expand(), 0);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (!enviroAtlasControl) return;
    enviroAtlasStoreSync.detach();
    app.removeMapControl(enviroAtlasControl);
    enviroAtlasControl = null;
  },
  getMapControlPosition: () => enviroAtlasPosition,
  setMapControlPosition: (app: GeoLibreAppAPI, position: GeoLibreMapControlPosition) => {
    enviroAtlasPosition = position;
    if (!enviroAtlasControl) return;
    app.removeMapControl(enviroAtlasControl);
    const added = app.addMapControl(enviroAtlasControl, enviroAtlasPosition);
    if (!added) {
      enviroAtlasStoreSync.detach();
      enviroAtlasControl = null;
      return false;
    }
    setTimeout(() => enviroAtlasControl?.expand(), 0);
  },
};

function getEnviroAtlasControlOptions(): EnviroAtlasControlOptions {
  return {
    ...ENVIROATLAS_OPTIONS,
    position: enviroAtlasPosition,
  };
}
