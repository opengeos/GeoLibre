import type { Map as MapLibreMap } from "maplibre-gl";

const pendingMercatorIdleGuards = new WeakSet<MapLibreMap>();

export function ensureMercatorProjection(
  map: MapLibreMap | null | undefined,
): void {
  if (!map) return;
  setMercatorProjection(map);
  scheduleMercatorIdleGuard(map);
}

function setMercatorProjection(map: MapLibreMap): void {
  try {
    if (map.getProjection()?.type === "mercator") return;
    map.setProjection({ type: "mercator" });
  } catch {
    // MapLibre can reject projection changes while the style is still settling.
  }
}

// Scheduled even when the projection already reads mercator: while the
// style is settling, getProjection() can report a value the settled style
// will overwrite (and setMercatorProjection swallows rejections in that
// window), so the cheap re-check on idle covers both cases.
function scheduleMercatorIdleGuard(map: MapLibreMap): void {
  if (pendingMercatorIdleGuards.has(map)) return;
  pendingMercatorIdleGuards.add(map);
  map.once("idle", () => {
    pendingMercatorIdleGuards.delete(map);
    setMercatorProjection(map);
  });
}
