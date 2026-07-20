import { createHostedMapPlugin } from "../hosted-map-plugin";

function isOvertureMapsProjectState(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    ("themes" in value || "release" in value || "collapsed" in value)
  );
}

export const maplibreOvertureMapsPlugin = createHostedMapPlugin({
  id: "maplibre-gl-overture-maps",
  name: "Overture Maps",
  version: "0.2.0",
  initialPosition: "top-left",
  acceptsProjectState: isOvertureMapsProjectState,
  forwardsTextFileExports: true,
});
