import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "../types";

let layerControlPosition: GeoLibreMapControlPosition = "top-right";

export const maplibreLayerControlPlugin: GeoLibrePlugin = {
  id: "maplibre-layer-control",
  name: "Layer Control",
  version: "0.16.0",
  activeByDefault: true,
  activate: (app: GeoLibreAppAPI) => app.setBuiltInMapControlVisible("layer-control", true),
  deactivate: (app: GeoLibreAppAPI) => {
    app.setBuiltInMapControlVisible("layer-control", false);
  },
  getMapControlPosition: () => layerControlPosition,
  setMapControlPosition: (app: GeoLibreAppAPI, position: GeoLibreMapControlPosition) => {
    layerControlPosition = position;
    return app.setBuiltInMapControlPosition("layer-control", position);
  },
};
