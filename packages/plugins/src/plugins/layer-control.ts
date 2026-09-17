import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "../types";

let layerControlPosition: GeoLibreMapControlPosition = "top-right";

export const maplibreLayerControlPlugin: GeoLibrePlugin = {
  id: "maplibre-layer-control",
  name: "Layer Control",
  version: "0.16.0",
  // GL engines share LayerControlHost; ArcGIS hosts its native LayerList.
  // The plugin only drives the engine-neutral visibility/position methods.
  engines: ["maplibre", "mapbox", "arcgis"],
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
