import type {
  MapEngineExternalLayerHost,
  MapEngineFloatingPanelHost,
  MapEngineClient,
} from "@geolibre/map";
import type {
  GeoLibreAppAPI,
  GeoLibreExternalNativeLayerRegistration,
  GeoLibreFloatingPanelRegistration,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";

export const MAPILLARY_PLUGIN_ID = "maplibre-gl-mapillary";

export interface MapillaryLabels {
  title: string;
  getTitle?: () => string;
  hint: string;
  noToken: string;
  tokenPlaceholder: string;
  tokenSave: string;
  tokenHelp: string;
  tokenLabel: string;
  loading: string;
  loadError: string;
  coverageLines: string;
  coveragePoints: string;
}

let labels: MapillaryLabels = {
  title: "Mapillary",
  hint: "Click a coverage point on the map to view street-level imagery.",
  noToken:
    "A Mapillary access token is required to load coverage and imagery. Paste one below to get started.",
  tokenPlaceholder: "MLY|…",
  tokenSave: "Save token",
  tokenHelp: "Get a token",
  tokenLabel: "Mapillary access token",
  loading: "Loading imagery…",
  loadError: "Could not load this image.",
  coverageLines: "Mapillary Sequences",
  coveragePoints: "Mapillary Images",
};
let position: GeoLibreMapControlPosition = "top-left";
let activeApp: GeoLibreAppAPI | null = null;

function floatingPanelHost(app: GeoLibreAppAPI): MapEngineFloatingPanelHost | undefined {
  if (!app.registerFloatingPanel || !app.openFloatingPanel) return undefined;
  return {
    register: (panel) => app.registerFloatingPanel!(panel as GeoLibreFloatingPanelRegistration),
    open: (id) => app.openFloatingPanel!(id),
  };
}

function externalLayerHost(app: GeoLibreAppAPI): MapEngineExternalLayerHost | undefined {
  if (!app.registerExternalNativeLayer || !app.unregisterExternalNativeLayer) return undefined;
  return {
    register: (layer) =>
      app.registerExternalNativeLayer!(layer as GeoLibreExternalNativeLayerRegistration),
    unregister: (id) => app.unregisterExternalNativeLayer!(id),
  };
}

function runtimeState(): { labels: MapillaryLabels } {
  return { labels: { ...labels } };
}

export function setMapillaryLabels(next: Partial<MapillaryLabels>): void {
  labels = { ...labels, ...next };
  activeApp?.map.invoke("hosted-plugin.apply-state", {
    pluginId: MAPILLARY_PLUGIN_ID,
    state: runtimeState(),
  });
}

function activate(app: GeoLibreAppAPI): boolean | Promise<boolean> {
  activeApp = app;
  return app.map.invoke("hosted-plugin.activate", {
    pluginId: MAPILLARY_PLUGIN_ID,
    position,
    state: runtimeState(),
    floatingPanelHost: floatingPanelHost(app),
    externalLayerHost: externalLayerHost(app),
  });
}

export const maplibreMapillaryPlugin: GeoLibrePlugin = {
  id: MAPILLARY_PLUGIN_ID,
  name: "Mapillary",
  version: "0.1.0",
  activate,
  deactivate: (app) => {
    app.map.invoke("hosted-plugin.deactivate", { pluginId: MAPILLARY_PLUGIN_ID });
    if (activeApp === app) activeApp = null;
  },
  getMapControlPosition: () => position,
  setMapControlPosition: (app, next) => {
    position = next;
    return app.map.invoke("hosted-plugin.set-position", {
      pluginId: MAPILLARY_PLUGIN_ID,
      position: next,
    });
  },
};
