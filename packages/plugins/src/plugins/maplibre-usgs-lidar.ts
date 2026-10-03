/// <reference path="../maplibre-gl-usgs-lidar.d.ts" />
import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  type MapProjection,
  useAppStore,
} from "@geolibre/core";
import type { UsgsLidarControl, UsgsLidarControlOptions } from "maplibre-gl-usgs-lidar";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { mountMapControlInPanel, unmountMapControlFromPanel } from "./dockable-map-control";
import { getControlMap } from "./style-map";

const PANEL_ID = "usgs-lidar-panel";

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
  // Not used for layout (the dock owns placement); the control still reads it
  // for its hidden toggle and the internal LidarControl it registers.
  position: "top-left",
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
} satisfies UsgsLidarControlOptions;

let usgsLidarControl: UsgsLidarControl | null = null;
let unregisterPanel: (() => void) | null = null;
let pluginActive = false;

/**
 * Standalone USGS 3DEP LiDAR plugin. Wraps the same `UsgsLidarControl` that the
 * Components plugin surfaces via its `usgsLidar` default control, hosting its
 * panel in GeoLibre's dockable side panel (listed under Plugins > Web Services).
 */
export const maplibreUsgsLidarPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-usgs-lidar",
  name: "USGS LiDAR",
  version: "0.12.0",
  // The point clouds stream through a deck.gl overlay (`lidar-url` layers are
  // plugin-owned on Mapbox) and the 3DEP coverage index is a raster tile
  // layer the engine adopts under its native ids.
  engines: ["maplibre", "mapbox"],
  activate: (app: GeoLibreAppAPI) => {
    if (!getControlMap(app) || !app.registerRightPanel || !app.openRightPanel) return false;
    pluginActive = true;

    // Apply the side effects up front: the plugin manager marks the plugin
    // active as soon as activate returns, so deactivate is always reachable to
    // undo them, and the control below loads asynchronously.
    forceMercatorProjection();
    addDepIndexLayer();

    unregisterPanel = app.registerRightPanel({
      id: PANEL_ID,
      title: "USGS LiDAR",
      dock: "replace-style",
      defaultWidth: 380,
      deactivatePluginOnClose: true,
      render: (container) => {
        let unmount: (() => void) | null = null;
        let disposed = false;
        // Defer the heavy deck.gl/loaders.gl dependency tree until the user
        // first enables the viewer, so it stays out of the startup bundle.
        void import("maplibre-gl-usgs-lidar")
          .then(({ UsgsLidarControl: UsgsLidarControlClass }) => {
            if (disposed || !pluginActive) return;
            const control = new UsgsLidarControlClass(USGS_LIDAR_OPTIONS);
            const mounted = mountMapControlInPanel(app, control, container, () =>
              app.closeRightPanel?.(PANEL_ID),
            );
            if (!mounted) return;
            usgsLidarControl = control;
            unmount = mounted;
            control.expand();
          })
          .catch((error: unknown) => {
            console.error("[maplibre-usgs-lidar] failed to load control:", error);
            // Closing the panel deactivates the plugin, which restores the
            // projection and removes the coverage layer applied above.
            app.closeRightPanel?.(PANEL_ID);
          });
        return () => {
          disposed = true;
          unmount?.();
          unmount = null;
          usgsLidarControl = null;
        };
      },
    });
    if (!app.openRightPanel(PANEL_ID)) {
      unregisterPanel();
      unregisterPanel = null;
      pluginActive = false;
      restoreProjection();
      removeDepIndexLayer();
      return false;
    }
  },
  deactivate: (app: GeoLibreAppAPI) => {
    pluginActive = false;
    restoreProjection();
    removeDepIndexLayer();
    if (usgsLidarControl) unmountMapControlFromPanel(usgsLidarControl);
    app.closeRightPanel?.(PANEL_ID);
    unregisterPanel?.();
    unregisterPanel = null;
    usgsLidarControl = null;
  },
};
