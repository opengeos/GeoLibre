import {
  LidarControl,
  type LidarControlOptions,
} from "maplibre-gl-lidar";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";

let lidarPosition: GeoLibreMapControlPosition = "top-left";

const LIDAR_OPTIONS = {
  title: "LiDAR Viewer",
  collapsed: false,
  panelWidth: 365,
  maxHeight: 520,
  pointSize: 2,
  colorScheme: "elevation",
  pickable: true,
  autoZoom: true,
  shareUrl: true,
  restoreFromUrl: true,
} satisfies Omit<LidarControlOptions, "position">;

let lidarControl: LidarControl | null = null;

export const maplibreLidarPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-lidar",
  name: "LiDAR Viewer",
  version: "0.14.1",
  activate: (app: GeoLibreAppAPI) => {
    if (!lidarControl) {
      lidarControl = new LidarControl(getLidarOptions());
    }

    const added = app.addMapControl(lidarControl, lidarPosition);
    if (!added) {
      lidarControl = null;
      return false;
    }
    setTimeout(() => lidarControl?.expand(), 0);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (!lidarControl) return;
    app.removeMapControl(lidarControl);
    lidarControl = null;
  },
  getMapControlPosition: () => lidarPosition,
  setMapControlPosition: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => {
    lidarPosition = position;
    if (!lidarControl) return;
    app.removeMapControl(lidarControl);
    const added = app.addMapControl(lidarControl, lidarPosition);
    if (!added) return false;
    setTimeout(() => lidarControl?.expand(), 0);
  },
};

function getLidarOptions(): LidarControlOptions {
  return {
    ...LIDAR_OPTIONS,
    position: lidarPosition,
  };
}
