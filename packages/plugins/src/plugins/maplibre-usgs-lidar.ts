import { createHostedMapPlugin } from "../hosted-map-plugin";

export const maplibreUsgsLidarPlugin = createHostedMapPlugin({
  id: "maplibre-gl-usgs-lidar",
  name: "USGS LiDAR",
  version: "0.11.1",
  initialPosition: "top-left",
});
