import { evictOfflineBasemapStyle, unregisterPMTilesArchive } from "@geolibre/map";

/**
 * Tracks the in-memory archive (and style-registry id) backing the currently
 * applied styled offline basemap. A styled basemap is not a GeoLibreLayer, so
 * removeLayerFromMap never frees its archive; the previous one is freed here
 * when a different basemap is applied, deleted, or superseded.
 *
 * Kept on globalThis (like the style registry and archive-key set) so it
 * survives a Vite HMR reload of this module — a plain module `let` would reset
 * to null on reload and then fail to free the archive the live PMTiles
 * protocol still holds.
 */
export type ActiveStyledBasemap = { archiveKey: string; id: string; persistent?: boolean } | null;
const ACTIVE_STYLED_BASEMAP_KEY = "__geolibreActiveStyledBasemap";

type TrackerScope = typeof globalThis & { [ACTIVE_STYLED_BASEMAP_KEY]?: ActiveStyledBasemap };

/**
 * The styled basemap this session applied last, if any.
 *
 * Returns:
 *   Its id, archive key and whether its archive is persistent.
 */
export function activeStyledBasemap(): ActiveStyledBasemap {
  return (globalThis as TrackerScope)[ACTIVE_STYLED_BASEMAP_KEY] ?? null;
}

function setActiveStyledBasemap(value: ActiveStyledBasemap): void {
  (globalThis as TrackerScope)[ACTIVE_STYLED_BASEMAP_KEY] = value;
}

/**
 * Record the archive/id now backing the styled basemap, freeing the one it
 * replaces (a different id) so archives don't accumulate for the session. A
 * persistent archive (a native package on disk) is never freed.
 *
 * Args:
 *   id: The style-registry id of the applied basemap.
 *   archiveKey: The PMTiles archive key (or protocol URL) backing it.
 *   persistent: Whether the archive lives in native storage.
 */
export function trackStyledBasemap(id: string, archiveKey: string, persistent = false): void {
  const active = activeStyledBasemap();
  if (active && active.id !== id && !active.persistent) {
    unregisterPMTilesArchive(active.archiveKey);
    evictOfflineBasemapStyle(active.id);
  }
  setActiveStyledBasemap({ id, archiveKey, persistent });
}

/**
 * Free a styled basemap's archive/style if it is the active one (e.g. on
 * delete), so nothing keeps its bytes resident after it's gone.
 *
 * Args:
 *   id: The style-registry id of the basemap being removed.
 */
export function forgetStyledBasemap(id: string): void {
  const active = activeStyledBasemap();
  if (active?.id !== id) return;
  unregisterPMTilesArchive(active.archiveKey);
  evictOfflineBasemapStyle(id);
  setActiveStyledBasemap(null);
}
