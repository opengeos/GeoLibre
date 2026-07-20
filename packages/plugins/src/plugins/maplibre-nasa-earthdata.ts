import { createHostedMapPlugin } from "../hosted-map-plugin";

export const maplibreNasaEarthdataPlugin = createHostedMapPlugin({
  id: "maplibre-gl-nasa-earthdata",
  name: "NASA Earthdata",
  version: "0.1.4",
  initialPosition: "top-left",
});
