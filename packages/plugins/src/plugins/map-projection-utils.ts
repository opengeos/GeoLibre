import type { Map as MapLibreMap } from "maplibre-gl";

export function ensureMercatorProjection(
  map: MapLibreMap | null | undefined,
): void {
  try {
    if (!map || map.getProjection()?.type === "mercator") return;
    map.setProjection({ type: "mercator" });
  } catch {
    // MapLibre can reject projection changes while the style is still settling.
  }
}
