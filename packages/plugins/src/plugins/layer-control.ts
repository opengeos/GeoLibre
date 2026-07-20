import { createHostedMapPlugin } from "../hosted-map-plugin";

export const maplibreLayerControlPlugin = createHostedMapPlugin({
  id: "maplibre-layer-control",
  name: "Layer Control",
  version: "0.16.0",
  activeByDefault: true,
  initialPosition: "top-right",
});
