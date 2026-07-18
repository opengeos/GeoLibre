import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

const OSM_STYLE = "https://tiles.openfreemap.org/styles/liberty";

export const osmBasemapPlugin: GeoLibrePlugin = {
  id: "osm-basemap",
  name: "OpenStreetMap Basemap",
  version: "0.1.0",
  activate: (app: GeoLibreAppAPI) => {
    app.setBasemap(OSM_STYLE);
  },
  deactivate: () => {
    /* basemap remains until user changes it */
  },
};
