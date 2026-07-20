import { createHostedMapPlugin } from "../hosted-map-plugin";

export const maplibreStreetViewPlugin = createHostedMapPlugin({
  id: "maplibre-gl-streetview",
  name: "Street View",
  version: "0.4.0",
  initialPosition: "top-right",
});
