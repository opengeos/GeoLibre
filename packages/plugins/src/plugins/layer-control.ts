import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export const maplibreLayerControlPlugin: GeoLibrePlugin = {
  id: "maplibre-layer-control",
  name: "Layer Control",
  version: "0.14.1",
  activeByDefault: true,
  activate: (app: GeoLibreAppAPI) =>
    app.setBuiltInMapControlVisible("layer-control", true),
  deactivate: (app: GeoLibreAppAPI) => {
    app.setBuiltInMapControlVisible("layer-control", false);
  },
};
