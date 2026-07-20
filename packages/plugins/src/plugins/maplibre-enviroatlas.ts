import { createHostedMapPlugin } from "../hosted-map-plugin";

export const maplibreEnviroAtlasPlugin = createHostedMapPlugin({
  id: "maplibre-gl-enviroatlas",
  name: "US EPA EnviroAtlas",
  version: "0.1.1",
  initialPosition: "top-left",
});
