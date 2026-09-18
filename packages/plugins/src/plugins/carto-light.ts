import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

const CARTO_LIGHT = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

export const cartoLightPlugin: GeoLibrePlugin = {
  id: "carto-light",
  name: "Carto Light Basemap",
  version: "0.1.0",
  engines: ["maplibre", "cesium"],
  activate: (app: GeoLibreAppAPI) => {
    app.setBasemap(CARTO_LIGHT);
  },
  deactivate: () => {},
};
