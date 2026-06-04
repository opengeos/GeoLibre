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
// Set while a project is reopening so the replayed basemapchange does not
// rewrite the (already-persisted) store layer and flag the project as dirty.
let restoringBasemapId: string | null = null;

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
  if (source.type !== "style" && source.type !== "vector-style") return;
  // A style basemap ends any in-flight raster restore (e.g. a persisted id that
  // now resolves to a non-raster catalog entry), so clear the guard.
  restoringBasemapId = null;
  unregisterActiveRasterBasemap(app);
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

  // On project restore the mirror layer is already in the store with matching
  // (deterministic) source/layer ids, so skip the write-back that would mark
  // the freshly opened project dirty. The control has still re-rendered the
  // tiles on the map by this point.
  if (restoringBasemapId === basemap.id) {
    restoringBasemapId = null;
    registeredRasterLayerId = layerId;
    return;
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
      tileUrl: basemap.source.tiles[0],
    },
  });
  registeredRasterLayerId = layerId;
}

function unregisterActiveRasterBasemap(app: GeoLibreAppAPI): void {
  if (!registeredRasterLayerId) return;
  app.unregisterExternalNativeLayer?.(registeredRasterLayerId);
  registeredRasterLayerId = null;
}

/**
 * Re-apply a persisted raster basemap after a project is reopened.
 *
 * Raster basemaps are rendered by the basemap control itself, not by the
 * generic layer-sync path, so the saved store layer alone does not put the
 * tiles back on the map. Replaying `setBasemap` drives the control's own
 * render path (correct source, layer, and stacking order) and re-emits the
 * `basemapchange` event that refreshes the store layer. Mirrors how 3D Tiles
 * layers are restored from the store on project load.
 */
export function restoreBasemapControlLayers(app: GeoLibreAppAPI): void {
  if (!basemapControl) return;

  const basemapId = useAppStore
    .getState()
    .layers.filter(
      (layer) =>
        layer.type === "raster" &&
        layer.metadata?.sourceKind === "maplibre-basemap-control",
    )
    .map((layer) => layer.metadata?.basemapId)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .at(-1);
  if (!basemapId) return;

  restoringBasemapId = basemapId;
  basemapControl.setBasemap(basemapId).catch((error) => {
    restoringBasemapId = null;
    console.error("[GeoLibre] Failed to restore raster basemap", error);
  });
}

function getManagedRaster(
  event: BasemapChangeEvent,
  basemap: BasemapDefinition,
): ManagedRasterBasemap | null {
  if (event.managedRaster) {
    return event.managedRaster;
  }

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
