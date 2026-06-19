/// <reference path="../maplibre-gl-usgs-lidar.d.ts" />
import { type MapProjection, useAppStore } from "@geolibre/core";
import type {
  UsgsLidarControl,
  UsgsLidarControlOptions,
} from "maplibre-gl-usgs-lidar";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";

let usgsLidarPosition: GeoLibreMapControlPosition = "top-left";

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
  },
} satisfies Omit<UsgsLidarControlOptions, "position">;

let usgsLidarControl: UsgsLidarControl | null = null;
let pluginActive = false;

const mountUsgsLidarControl = (app: GeoLibreAppAPI): boolean => {
  if (!usgsLidarControl) return false;
  const added = app.addMapControl(usgsLidarControl, usgsLidarPosition);
  if (!added) {
    usgsLidarControl = null;
    return false;
  }
  setTimeout(() => usgsLidarControl?.expand(), 0);
  return true;
};

/**
 * Standalone USGS 3DEP LiDAR plugin. Wraps the same `UsgsLidarControl` that the
 * Components plugin surfaces via its `usgsLidar` default control, exposing it as
 * a top-level Plugins-menu entry.
 */
export const maplibreUsgsLidarPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-usgs-lidar",
  name: "USGS LiDAR",
  version: "0.9.0",
  activate: (app: GeoLibreAppAPI) => {
    pluginActive = true;
    forceMercatorProjection();
    if (usgsLidarControl) return mountUsgsLidarControl(app);

    // Defer the heavy deck.gl/loaders.gl dependency tree until the user first
    // enables the viewer, so it stays out of the startup bundle.
    void import("maplibre-gl-usgs-lidar").then(
      ({ UsgsLidarControl: UsgsLidarControlClass }) => {
        if (!pluginActive || usgsLidarControl) return;
        usgsLidarControl = new UsgsLidarControlClass(getUsgsLidarOptions());
        mountUsgsLidarControl(app);
      },
    );
  },
  deactivate: (app: GeoLibreAppAPI) => {
    pluginActive = false;
    restoreProjection();
    if (!usgsLidarControl) return;
    app.removeMapControl(usgsLidarControl);
    usgsLidarControl = null;
  },
  getMapControlPosition: () => usgsLidarPosition,
  setMapControlPosition: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => {
    usgsLidarPosition = position;
    if (!usgsLidarControl) return;
    app.removeMapControl(usgsLidarControl);
    const added = app.addMapControl(usgsLidarControl, usgsLidarPosition);
    if (!added) return false;
    setTimeout(() => usgsLidarControl?.expand(), 0);
  },
};

function getUsgsLidarOptions(): UsgsLidarControlOptions {
  return {
    ...USGS_LIDAR_OPTIONS,
    position: usgsLidarPosition,
  };
}
