import { createHostedMapPlugin } from "../hosted-map-plugin";

export const maplibreEsriWaybackPlugin = createHostedMapPlugin({
  id: "maplibre-gl-esri-wayback",
  name: "Historical Imagery",
  version: "0.2.0",
  initialPosition: "top-left",
});
