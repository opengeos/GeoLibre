import type {
  ControlGrid,
  ControlGridOptions,
  DefaultControlName,
} from "maplibre-gl-components";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";

let componentsControlPosition: GeoLibreMapControlPosition = "top-right";

const COMPONENT_CONTROL_NAMES = [
  "globe",
  "spinGlobe",
  "fullscreen",
  "north",
  "terrain",
  "search",
  "viewState",
  "inspect",
  "vectorDataset",
  "basemap",
  "measure",
  "geoEditor",
  "bookmark",
  "print",
  "swipe",
  "streetView",
  "addVector",
  "cogLayer",
  "zarrLayer",
  "pmtilesLayer",
  "stacLayer",
  "stacSearch",
  "planetaryComputer",
  "gaussianSplat",
  "lidar",
  "usgsLidar",
] satisfies DefaultControlName[];

const COMPONENTS_OPTIONS = {
  className: "geolibre-components-control",
  collapsed: false,
  columns: 5,
  defaultControls: COMPONENT_CONTROL_NAMES,
  excludeLayers: [
    "usgs-lidar-*",
    "lidar-*",
    "mapbox-gl-draw-*",
    "gl-draw-*",
    "gm_*",
    "inspect-highlight-*",
    "measure-*",
  ],
  gap: 2,
  rows: 5,
  showRowColumnControls: true,
} satisfies Omit<ControlGridOptions, "position" | "basemapStyleUrl">;

let componentsControl: ControlGrid | null = null;
let pluginActive = false;

const mountComponentsControl = (app: GeoLibreAppAPI): boolean => {
  if (!componentsControl) return false;
  const added = app.addMapControl(
    componentsControl,
    componentsControlPosition,
  );
  if (!added) {
    componentsControl = null;
    return false;
  }
  setTimeout(() => componentsControl?.expand(), 0);
  return true;
};

export const maplibreComponentsPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-components",
  name: "Components",
  version: "0.16.3",
  activate: (app: GeoLibreAppAPI) => {
    pluginActive = true;
    if (componentsControl) return mountComponentsControl(app);

    void import("maplibre-gl-components").then(
      ({ ControlGrid: ControlGridClass }) => {
        if (!pluginActive || componentsControl) return;
        componentsControl = new ControlGridClass(
          getComponentsOptions(app),
        );
        mountComponentsControl(app);
      },
    );
  },
  deactivate: (app: GeoLibreAppAPI) => {
    pluginActive = false;
    if (!componentsControl) return;
    app.removeMapControl(componentsControl);
    componentsControl = null;
  },
  getMapControlPosition: () => componentsControlPosition,
  setMapControlPosition: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => {
    componentsControlPosition = position;
    if (!componentsControl) return;
    app.removeMapControl(componentsControl);
    const added = app.addMapControl(
      componentsControl,
      componentsControlPosition,
    );
    if (!added) return false;
    setTimeout(() => componentsControl?.expand(), 0);
  },
};

function getComponentsOptions(
  app: GeoLibreAppAPI,
): ControlGridOptions {
  return {
    ...COMPONENTS_OPTIONS,
    basemapStyleUrl: app.getActiveBasemap(),
    position: componentsControlPosition,
  };
}
