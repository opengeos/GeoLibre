/// <reference path="./maplibre-gl-usgs-lidar.d.ts" />
import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  type MapProjection,
  useAppStore,
} from "@geolibre/core";
import type { UsgsLidarControl, UsgsLidarControlOptions } from "maplibre-gl-usgs-lidar";
import type { MapControlPosition } from "../engine/types";
import {
  restoreHostedControlPanel,
  type MapLibreHostedRuntime,
  type MapLibreHostedRuntimeContext,
} from "./types";

let usgsLidarPosition: MapControlPosition = "top-left";

// The deck.gl point-cloud overlay only renders correctly under the Mercator
// projection: the streaming loader's viewport math breaks under GeoLibre's
// default Globe projection, so the cloud is invisible at the dataset extent and
// only appears once zoomed in close. Force Mercator while the plugin is active
// and restore the user's previous projection on deactivate.
let projectionToRestore: MapProjection | null = null;

function forceMercatorProjection(): void {
  const store = useAppStore.getState();
  const { map } = store.preferences;
  if (map.projection === "mercator") return;
  projectionToRestore = map.projection;
  store.setPreferences({
    ...store.preferences,
    map: { ...map, projection: "mercator" },
  });
}

function restoreProjection(): void {
  if (projectionToRestore === null) return;
  const previous = projectionToRestore;
  projectionToRestore = null;
  const store = useAppStore.getState();
  const { map } = store.preferences;
  // Only restore if we are still in the Mercator projection we forced; if the
  // user changed it manually in the meantime, leave their choice alone.
  if (map.projection !== "mercator") return;
  store.setPreferences({
    ...store.preferences,
    map: { ...map, projection: previous },
  });
}

// USGS 3DEP Elevation Index (WMS) showing where 3DEP LiDAR point clouds exist,
// added as a store layer alongside the control so users can see coverage before
// searching. Hidden once zoomed past the survey overview, where the point cloud
// itself takes over.
const DEP_INDEX_LAYER_ID = "usgs-lidar-3dep-index";
const DEP_INDEX_SOURCE_ID = "usgs-lidar-3dep-index-source";
// LAYERS=23 is the 3DEP LiDAR (point-cloud) coverage footprint layer in the
// USGS 3DEPElevationIndex WMS. If USGS re-orders the service this silently shows
// the wrong coverage; verify the index against the service's GetCapabilities:
// https://index.nationalmap.gov/arcgis/services/3DEPElevationIndex/MapServer/WMSServer?SERVICE=WMS&REQUEST=GetCapabilities
const DEP_INDEX_TILE_URL =
  "https://index.nationalmap.gov/arcgis/services/3DEPElevationIndex/MapServer/WMSServer?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&FORMAT=image/png&TRANSPARENT=true&LAYERS=23&SRS=EPSG:3857&STYLES=&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}";

function addDepIndexLayer(): void {
  const store = useAppStore.getState();
  if (store.layers.some((layer) => layer.id === DEP_INDEX_LAYER_ID)) return;
  const layer: GeoLibreLayer = {
    id: DEP_INDEX_LAYER_ID,
    name: "3DEP LiDAR Coverage",
    type: "raster",
    source: {
      type: "raster",
      sourceId: DEP_INDEX_SOURCE_ID,
      tiles: [DEP_INDEX_TILE_URL],
      tileSize: 256,
    },
    visible: true,
    opacity: 0.7,
    style: { ...DEFAULT_LAYER_STYLE, maxZoom: 10 },
    metadata: {
      externalNativeLayer: true,
      identifiable: false,
      nativeLayerIds: [DEP_INDEX_LAYER_ID],
      sourceId: DEP_INDEX_SOURCE_ID,
      sourceIds: [DEP_INDEX_SOURCE_ID],
      tileUrl: DEP_INDEX_TILE_URL,
    },
    sourcePath: DEP_INDEX_TILE_URL,
  };
  store.addLayer(layer);
}

function removeDepIndexLayer(): void {
  useAppStore.getState().removeLayer(DEP_INDEX_LAYER_ID);
}

const USGS_LIDAR_OPTIONS = {
  title: "USGS LiDAR",
  collapsed: false,
  panelWidth: 380,
  maxHeight: 600,
  // Forward render settings to the internal LidarControl. `copcLoadingMode:
  // "dynamic"` streams viewport-appropriate octree levels so the cloud stays
  // visible when zoomed out to the dataset extent; the default "full" mode only
  // renders once zoomed in close.
  lidarControlOptions: {
    pointSize: 2,
    colorScheme: "elevation",
    copcLoadingMode: "dynamic",
    // Match the deleted standalone plugin and the Components LidarControl: keep
    // the point cloud non-pickable so deck.gl doesn't register hover/click
    // handlers on every tile (avoids interaction jank and stray tooltips).
    pickable: false,
  },
} satisfies Omit<UsgsLidarControlOptions, "position">;

let usgsLidarControl: UsgsLidarControl | null = null;
let pluginActive = false;

const mountUsgsLidarControl = (
  context: MapLibreHostedRuntimeContext,
  collapsed: boolean | undefined,
): boolean => {
  if (!usgsLidarControl) return false;
  const added = context.addControl?.(usgsLidarControl, usgsLidarPosition) ?? false;
  if (!added) {
    usgsLidarControl = null;
    return false;
  }
  restoreHostedControlPanel(usgsLidarControl, collapsed);
  return true;
};

/**
 * MapLibre-only USGS 3DEP LiDAR runtime. The public plugin descriptor is
 * renderer-neutral and dispatches lifecycle calls to this adapter-owned module.
 */
export const maplibreUsgsLidarRuntime: MapLibreHostedRuntime = {
  activate: (context, { position, collapsed }) => {
    if (position) usgsLidarPosition = position;
    pluginActive = true;

    // Defensive re-activation path for callers that invoke the plugin API
    // directly (the PluginManager guards against double-activate, so it does not
    // reach this — deactivate always nulls the control first). If a control
    // instance somehow still exists, apply the side effects only after it
    // re-mounts so a failed mount can't strand the projection.
    if (usgsLidarControl) {
      if (!mountUsgsLidarControl(context, collapsed)) {
        pluginActive = false;
        return false;
      }
      forceMercatorProjection();
      addDepIndexLayer();
      return;
    }

    // First activation: the plugin manager marks it active as soon as activate
    // returns (undefined), so deactivate is always reachable to undo these even
    // if the async control load below fails — apply them up front.
    forceMercatorProjection();
    addDepIndexLayer();

    // Defer the heavy deck.gl/loaders.gl dependency tree until the user first
    // enables the viewer, so it stays out of the startup bundle.
    void import("maplibre-gl-usgs-lidar")
      .then(({ UsgsLidarControl: UsgsLidarControlClass }) => {
        if (!pluginActive || usgsLidarControl) return;
        usgsLidarControl = new UsgsLidarControlClass(getUsgsLidarOptions());
        if (!mountUsgsLidarControl(context, collapsed)) {
          console.warn(
            "[maplibre-usgs-lidar] control failed to mount; deactivate the plugin to restore the projection.",
          );
        }
      })
      .catch((error: unknown) => {
        console.error("[maplibre-usgs-lidar] failed to load control:", error);
        // Roll back the side effects applied before the import so a failed load
        // (chunk/network error) doesn't strand the map in Mercator with an
        // orphaned coverage layer and no control to interact with.
        if (pluginActive) {
          pluginActive = false;
          restoreProjection();
          removeDepIndexLayer();
        }
      });
  },
  deactivate: (context) => {
    pluginActive = false;
    restoreProjection();
    removeDepIndexLayer();
    if (!usgsLidarControl) return;
    context.removeControl?.(usgsLidarControl);
    usgsLidarControl = null;
  },
  setPosition: (context, position) => {
    usgsLidarPosition = position;
    if (!usgsLidarControl) return;
    context.removeControl?.(usgsLidarControl);
    const added = context.addControl?.(usgsLidarControl, usgsLidarPosition) ?? false;
    if (!added) {
      // The control is now detached; drop the stale reference so a later
      // deactivate doesn't call removeMapControl on an already-removed control
      // (matches mountUsgsLidarControl's failure handling).
      usgsLidarControl = null;
      return false;
    }
    setTimeout(() => usgsLidarControl?.expand(), 0);
  },
};

function getUsgsLidarOptions(): UsgsLidarControlOptions {
  return {
    ...USGS_LIDAR_OPTIONS,
    position: usgsLidarPosition,
  };
}
