import {
  LidarControl,
  type LidarControlOptions,
} from "maplibre-gl-lidar";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

const LIDAR_OPTIONS = {
  title: "LiDAR Viewer",
  collapsed: false,
  position: "top-left",
  panelWidth: 365,
  maxHeight: 520,
  pointSize: 2,
  colorScheme: "elevation",
  pickable: true,
  autoZoom: true,
  shareUrl: true,
  restoreFromUrl: true,
} satisfies LidarControlOptions;

let lidarControl: LidarControl | null = null;

export const maplibreLidarPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-lidar",
  name: "LiDAR Viewer",
  version: "0.14.1",
  activate: (app: GeoLibreAppAPI) => {
    if (!lidarControl) {
      lidarControl = new LidarControl(LIDAR_OPTIONS);
    }

    const added = app.addMapControl(lidarControl, LIDAR_OPTIONS.position);
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
};
