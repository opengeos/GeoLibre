import { createHostedMapPlugin } from "../hosted-map-plugin";

/** Renderer-neutral descriptor for the lazy MapLibre GeoAgent runtime. */
export const maplibreGeoAgentPlugin = createHostedMapPlugin({
  id: "maplibre-gl-geoagent",
  name: "GeoAgent",
  version: "0.4.2",
  initialPosition: "top-left",
});
