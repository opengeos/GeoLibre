import { LAYER_CONTROL_PLUGIN_ID } from "../plugin-ids";
export { LAYER_CONTROL_PLUGIN_ID } from "../plugin-ids";
import { builtInPluginProperties } from "../builtin-plugin-metadata";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "../types";

let layerControlPosition: GeoLibreMapControlPosition = "top-right";

export const maplibreLayerControlPlugin: GeoLibrePlugin = {
  ...builtInPluginProperties("maplibre-layer-control"),

  // GL engines share LayerControlHost; ArcGIS hosts its native LayerList.
  // The plugin only drives the engine-neutral visibility/position methods.

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
