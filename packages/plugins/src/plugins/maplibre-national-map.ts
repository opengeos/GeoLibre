import { createHostedMapPlugin } from "../hosted-map-plugin";

export const maplibreNationalMapPlugin = createHostedMapPlugin({
  id: "maplibre-gl-national-map",
  name: "USGS National Map",
  version: "0.1.1",
  initialPosition: "top-left",
});
