import type { Map as MapLibreMap } from "maplibre-gl";

const pendingMercatorIdleGuards = new WeakSet<MapLibreMap>();

export function ensureMercatorProjection(map: MapLibreMap | null | undefined): void {
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

/** Minimal app surface the shared mercator lock needs. */
interface MercatorProjectionApp {
  getMapProjection?: () => "globe" | "mercator";
  setMapProjection?: (projection: "globe" | "mercator") => void;
  getMap?: () => MapLibreMap | null;
}

// `setMapProjection`/`getMapProjection` drive a single global map setting, but
// multiple deck.gl overlays (Google Photorealistic 3D Tiles, ArcGIS I3S) each
// need the map forced to mercator while they are mounted. A lock keyed by
// overlay type lets them share that override: the projection worth restoring is
// captured once when the first holder acquires, and restored only when the last
// holder releases — so removing one overlay no longer clobbers a mercator
// override another overlay still needs.
//
// Membership is keyed by overlay TYPE, not per acquire() call: `acquire` runs
// on every store-driven render (many times per overlay) and is idempotent,
// while each overlay type calls `release` exactly once when its last layer is
// removed. A per-call reference count would therefore never reach zero (acquire
// fires far more often than release) and the projection would never restore, so
// a Set of held overlay-type keys is the correct model here.
const mercatorProjectionHolders = new Set<string>();
let capturedProjectionToRestore: "globe" | "mercator" | null = null;

/**
 * Force the map to mercator on behalf of an overlay and register it as a holder.
 *
 * @param key Stable per-overlay-type key (e.g. "google", "arcgis-i3s").
 * @param app The app surface used to read/set the projection and get the map.
 * @param mapOverride A map instance to guard when `app.getMap()` isn't ready.
 */
export function acquireMercatorProjectionLock(
  key: string,
  app: MercatorProjectionApp,
  mapOverride?: MapLibreMap | null,
): void {
  if (mercatorProjectionHolders.size === 0 && capturedProjectionToRestore === null) {
    // Only remember "globe" as worth restoring. Never capture "mercator": it may
    // be a value WE forced and persisted into the project file, so a reopened
    // overlay-only project would otherwise capture the forced mercator as the
    // "previous" and stay stuck in mercator after the last overlay is removed.
    const current = app.getMapProjection?.() ?? null;
    capturedProjectionToRestore = current === "globe" ? "globe" : null;
  }
  mercatorProjectionHolders.add(key);
  app.setMapProjection?.("mercator");
  ensureMercatorProjection(mapOverride ?? app.getMap?.());
}

/**
 * Release an overlay's mercator hold, restoring the captured projection only
 * once no overlay is holding the lock anymore.
 *
 * @param key The same key passed to {@link acquireMercatorProjectionLock}.
 * @param app The app surface used to restore the projection.
 */
export function releaseMercatorProjectionLock(key: string, app: MercatorProjectionApp): void {
  if (!mercatorProjectionHolders.delete(key)) return;
  if (mercatorProjectionHolders.size > 0) return;
  if (capturedProjectionToRestore === null) return;
  app.setMapProjection?.(capturedProjectionToRestore);
  capturedProjectionToRestore = null;
}
