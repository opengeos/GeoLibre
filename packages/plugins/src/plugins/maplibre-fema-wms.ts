import { createHostedMapPlugin } from "../hosted-map-plugin";

export const maplibreFemaWmsPlugin = createHostedMapPlugin({
  id: "maplibre-gl-fema-wms",
  name: "FEMA NFHL",
  version: "0.1.2",
  initialPosition: "top-left",
});
