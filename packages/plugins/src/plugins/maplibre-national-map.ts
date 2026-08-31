import {
  buildLayerSpec,
  NationalMapControl,
  type NationalMapControlEventHandler,
  type NationalMapControlOptions,
} from "maplibre-gl-national-map";
import type { GeoLibreLayer } from "@geolibre/core";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { mountMapControlInPanel, unmountMapControlFromPanel } from "./dockable-map-control";
import {
  createWebServiceStoreSync,
  layerTypeForTiles,
  readNativeRasterSource,
  stringMetadata,
  type WebServiceAdapter,
  type WebServiceLayerEntry,
} from "./web-service-sync";

const SOURCE_KIND = "national-map";

const PANEL_ID = "national-map-panel";

const NATIONAL_MAP_OPTIONS = {
  collapsed: false,
  title: "USGS National Map",
  panelWidth: 340,
  className: "geolibre-national-map-control",
} satisfies NationalMapControlOptions;

let nationalMapControl: NationalMapControl | null = null;
let controlEventHandler: NationalMapControlEventHandler | null = null;
let unregisterPanel: (() => void) | null = null;

function serviceId(entry: WebServiceLayerEntry): string | undefined {
  return stringMetadata(entry.metadata?.nationalMapServiceId);
}

const nationalMapAdapter: WebServiceAdapter<NationalMapControl> = {
  sourceKind: SOURCE_KIND,
  attachEvents: (control, listener) => {
    // statechange accompanies every layer mutation, so a single
    // subscription is enough.
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
    const entries: WebServiceLayerEntry[] = [];
    for (const active of control.getActiveLayers()) {
      const native = readNativeRasterSource(map, active.sourceId);
      const spec = native ? null : buildLayerSpec(active.service);
      const tiles = native?.tiles ?? spec?.source.tiles ?? [];
      // A store layer without tiles cannot be rebuilt on reload; skip it.
      if (tiles.length === 0) continue;
      entries.push({
        id: active.layerId,
        name: `USGS ${active.service.title}`,
        sourceId: active.sourceId,
        tiles,
        opacity: active.opacity,
        visible: active.visible,
        layerType: layerTypeForTiles(tiles),
        source:
          native?.source ??
          (spec
            ? {
                ...(spec.source.tileSize !== undefined ? { tileSize: spec.source.tileSize } : {}),
                ...(spec.source.minzoom !== undefined ? { minzoom: spec.source.minzoom } : {}),
                ...(spec.source.maxzoom !== undefined ? { maxzoom: spec.source.maxzoom } : {}),
                ...(spec.source.attribution ? { attribution: spec.source.attribution } : {}),
              }
            : {}),
        metadata: { nationalMapServiceId: active.service.id },
      });
    }
    return entries;
  },
  removeFromControl: (control, entry) => {
    const id = serviceId(entry);
    if (id) control.removeService(id);
  },
  setControlOpacity: (control, entry, opacity) => {
    const id = serviceId(entry);
    if (id) control.setServiceOpacity(id, opacity);
  },
  setControlVisibility: (control, entry, visible) => {
    const id = serviceId(entry);
    if (id) control.setServiceVisibility(id, visible);
  },
  adopt: (control, layers) => {
    const existingIds = new Set(control.getState().activeLayerIds ?? []);
    const restorable = layers
      .map((layer) => ({
        layer,
        serviceId: stringMetadata(layer.metadata.nationalMapServiceId),
      }))
      .filter(
        (item): item is { layer: GeoLibreLayer; serviceId: string } =>
          item.serviceId !== undefined && !existingIds.has(item.serviceId),
      );
    if (restorable.length === 0) return;
    // setState reconciles activeLayerIds against the map, adopting native
    // layers that were already rebuilt from the saved project.
    control.setState({
      activeLayerIds: [
        ...(control.getState().activeLayerIds ?? []),
        ...restorable.map((item) => item.serviceId),
      ],
    });
    // Freshly created natives start visible at full opacity; re-apply the
    // persisted values (no-ops when the natives were adopted as-is).
    for (const item of restorable) {
      control.setServiceOpacity(item.serviceId, item.layer.opacity);
      control.setServiceVisibility(item.serviceId, item.layer.visible);
    }
  },
};

const nationalMapStoreSync = createWebServiceStoreSync(nationalMapAdapter);

export const maplibreNationalMapPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-national-map",
  name: "USGS National Map",
  version: "0.1.1",
  activate: (app: GeoLibreAppAPI) => {
    if (!app.getMap?.() || !app.registerRightPanel || !app.openRightPanel) return false;
    if (!nationalMapControl) {
      nationalMapControl = new NationalMapControl(getNationalMapControlOptions());
    }

    const activeControl = nationalMapControl;
    unregisterPanel = app.registerRightPanel({
      id: PANEL_ID,
      title: "USGS National Map",
      dock: "replace-style",
      defaultWidth: 340,
      deactivatePluginOnClose: true,
      render: (container) => {
        const unmount = mountMapControlInPanel(app, activeControl, container, () =>
          app.closeRightPanel?.(PANEL_ID),
        );
        if (!unmount) return;
        nationalMapStoreSync.attach(activeControl);
        activeControl.expand();
        return () => {
          nationalMapStoreSync.detach();
          unmount();
        };
      },
    });
    if (!app.openRightPanel(PANEL_ID)) {
      unregisterPanel();
      unregisterPanel = null;
      nationalMapControl = null;
      return false;
    }
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (!nationalMapControl) return;
    nationalMapStoreSync.detach();
    unmountMapControlFromPanel(nationalMapControl);
    app.closeRightPanel?.(PANEL_ID);
    unregisterPanel?.();
    unregisterPanel = null;
    nationalMapControl = null;
  },
};

function getNationalMapControlOptions(): NationalMapControlOptions {
  return {
    ...NATIONAL_MAP_OPTIONS,
    position: "top-left",
  };
}
