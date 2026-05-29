import type {
  LidarControl,
  LidarControlOptions,
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
let pluginActive = false;

const mountLidarControl = (app: GeoLibreAppAPI): boolean => {
  if (!lidarControl) return false;
  const added = app.addMapControl(lidarControl, lidarPosition);
  if (!added) {
    lidarControl = null;
    return false;
  }
  setTimeout(() => lidarControl?.expand(), 0);
  return true;
};

export const maplibreLidarPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-lidar",
  name: "LiDAR Viewer",
  version: "0.14.1",
  activate: (app: GeoLibreAppAPI) => {
    pluginActive = true;
    if (lidarControl) return mountLidarControl(app);

    // Defer the heavy deck.gl/loaders.gl dependency tree until the user first
    // enables the viewer, so it stays out of the startup bundle.
    void import("maplibre-gl-lidar").then(
      ({ LidarControl: LidarControlClass }) => {
        if (!pluginActive || lidarControl) return;
        lidarControl = new LidarControlClass(getLidarOptions());
        mountLidarControl(app);
      },
    );
  },
  deactivate: (app: GeoLibreAppAPI) => {
    pluginActive = false;
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
