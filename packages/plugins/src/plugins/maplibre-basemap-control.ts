import { useAppStore } from "@geolibre/core";
import {
  BasemapControl,
  type BasemapChangeEvent,
  type BasemapDefinition,
  type BasemapControlEventPayload,
  type BasemapControlOptions,
  type ManagedRasterBasemap,
} from "maplibre-gl-basemap-control";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";

let basemapControlPosition: GeoLibreMapControlPosition = "top-left";

let basemapControl: BasemapControl | null = null;
let registeredRasterLayerId: string | null = null;

export const maplibreBasemapControlPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-basemap-control",
  name: "Basemaps",
  version: "0.2.2",
  activate: (app: GeoLibreAppAPI) => {
    if (!basemapControl) {
      basemapControl = new BasemapControl(getBasemapControlOptions(app));
      basemapControl.on("basemapchange", (event) => {
        handleBasemapChange(app, event);
      });
    }

    const added = app.addMapControl(
      basemapControl,
      basemapControlPosition,
    );
    if (!added) {
      basemapControl = null;
      return false;
    }
    basemapControl.setState({
      activeBasemapId: getBasemapIdForStyleUrl(app.getActiveBasemap()),
    });
    // Re-link a raster basemap layer restored from a reopened project so that a
    // later switch to a style basemap can unregister it (the module state does
    // not survive a new session).
    relinkRestoredRasterBasemap();
    setTimeout(() => basemapControl?.expand(), 0);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (!basemapControl) return;
    unregisterActiveRasterBasemap(app);
    app.removeMapControl(basemapControl);
    basemapControl = null;
  },
  getMapControlPosition: () => basemapControlPosition,
  setMapControlPosition: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => {
    basemapControlPosition = position;
    if (!basemapControl) return;
    app.removeMapControl(basemapControl);
    const added = app.addMapControl(basemapControl, basemapControlPosition);
    if (!added) return false;
    basemapControl.setState({
      activeBasemapId: getBasemapIdForStyleUrl(app.getActiveBasemap()),
    });
    setTimeout(() => basemapControl?.expand(), 0);
  },
};

function getBasemapControlOptions(
  app: GeoLibreAppAPI,
): BasemapControlOptions {
  return {
    collapsed: false,
    position: basemapControlPosition,
    title: "Basemaps",
  };
}

function handleBasemapChange(
  app: GeoLibreAppAPI,
  event: BasemapControlEventPayload,
): void {
  if (event.type !== "basemapchange") return;
  const { source } = event.basemap;
  if (source.type === "raster") {
    registerRasterBasemap(app, event.basemap, event);
    return;
  }
  // Any non-raster basemap (including an unrecognized future source type)
  // clears a previously registered raster layer so it does not linger in the
  // layer manager.
  unregisterActiveRasterBasemap(app);
  if (source.type !== "style" && source.type !== "vector-style") return;
  app.setBasemap(source.url);
}

function registerRasterBasemap(
  app: GeoLibreAppAPI,
  basemap: BasemapDefinition,
  event: BasemapChangeEvent,
): void {
  if (basemap.source.type !== "raster") return;
  const managedRaster = getManagedRaster(event, basemap);
  if (!managedRaster || !app.registerExternalNativeLayer) return;

  const layerId = `basemap-${basemap.id}`;
  if (registeredRasterLayerId && registeredRasterLayerId !== layerId) {
    app.unregisterExternalNativeLayer?.(registeredRasterLayerId);
  }

  app.registerExternalNativeLayer({
    id: layerId,
    name: basemap.name,
    type: "raster",
    source: {
      attribution: basemap.attribution,
      maxzoom: basemap.source.maxzoom,
      minzoom: basemap.source.minzoom,
      scheme: basemap.source.scheme,
      sourceId: managedRaster.sourceId,
      tileSize: basemap.source.tileSize ?? 256,
      tiles: basemap.source.tiles,
      type: "raster",
    },
    nativeLayerIds: [managedRaster.layerId],
    sourceId: managedRaster.sourceId,
    sourceIds: [managedRaster.sourceId],
    beforeId: managedRaster.beforeId,
    metadata: {
      basemapId: basemap.id,
      basemapProvider: basemap.provider,
      category: basemap.category,
      externalNativeLayer: true,
      identifiable: false,
      sourceKind: "maplibre-basemap-control",
      // Tile URL template lives in metadata, not sourcePath, which is reserved
      // for local file paths (GeoJSON, FlatGeobuf, etc.).
      tileType: "raster",
      tileUrl:
        basemap.source.tiles.length > 0 ? basemap.source.tiles[0] : undefined,
    },
  });
  registeredRasterLayerId = layerId;
}

function unregisterActiveRasterBasemap(app: GeoLibreAppAPI): void {
  if (!registeredRasterLayerId) return;
  app.unregisterExternalNativeLayer?.(registeredRasterLayerId);
  registeredRasterLayerId = null;
}

function relinkRestoredRasterBasemap(): void {
  if (registeredRasterLayerId) return;
  const restored = useAppStore
    .getState()
    .layers.find(
      (layer) => layer.metadata?.sourceKind === "maplibre-basemap-control",
    );
  if (restored) registeredRasterLayerId = restored.id;
}

function getManagedRaster(
  event: BasemapChangeEvent,
  basemap: BasemapDefinition,
): ManagedRasterBasemap | null {
  if (event.managedRaster) {
    return event.managedRaster;
  }

  // Fallback for library versions that omit `managedRaster` on the event. These
  // ids must mirror the native source/layer ids maplibre-gl-basemap-control
  // creates: `${CONTROL_SOURCE_PREFIX}-${id}` for the source and the bare
  // `${id}` for the layer (CONTROL_LAYER_PREFIX is empty). Verified against
  // maplibre-gl-basemap-control@0.2.2.
  return {
    sourceId: `maplibre-basemap-control-source-${basemap.id}`,
    layerId: basemap.id,
    beforeId: normalizeBeforeId(event.state.beforeId),
  };
}

function normalizeBeforeId(
  value: string | undefined | null,
): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") return undefined;
  return trimmed;
}

function getBasemapIdForStyleUrl(url: string): string | undefined {
  if (url === "https://tiles.openfreemap.org/styles/positron") {
    return "openfreemap-positron";
  }
  if (url === "https://tiles.openfreemap.org/styles/bright") {
    return "openfreemap-bright";
  }
  if (url === "https://tiles.openfreemap.org/styles/liberty") {
    return "openfreemap-liberty";
  }
  if (url === "https://tiles.openfreemap.org/styles/dark") {
    return "openfreemap-dark";
  }
  if (url === "https://tiles.openfreemap.org/styles/fiord") {
    return "openfreemap-fiord";
  }
  return undefined;
}
