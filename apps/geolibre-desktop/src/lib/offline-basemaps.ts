/**
 * Device-local catalogue of offline basemaps the user has extracted (see
 * BasemapExtractPanel). Each extract writes a `.pmtiles` file to disk and
 * records one entry here — its name, area, zoom range, flavor, size, and (on
 * desktop) the saved file path — so the panel's "Saved basemaps" list can
 * rename, delete, and re-apply them.
 *
 * Records are device-scoped (localStorage), not part of `.geolibre.json`: they
 * mirror what this device has downloaded and would be meaningless elsewhere.
 */

/** localStorage key for the persisted manifest (versioned for migrations). */
export const OFFLINE_BASEMAPS_KEY = "geolibre.offlineBasemaps.v1";

export interface OfflineBasemap {
  /** Stable id; also the synthetic pmtiles archive key used this session. */
  id: string;
  /** User-facing label (editable). */
  name: string;
  /** `[west, south, east, north]` in WGS84 degrees. */
  bbox: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  /** Protomaps flavor applied as a basemap, or null when added as an overlay. */
  flavor: string | null;
  tileType: "vector" | "raster";
  /** Archive size in bytes. */
  bytes: number;
  /** Absolute path the archive was saved to (desktop), for reload; null if the
   * user cancelled the save or on web (no persistent path). */
  savedPath: string | null;
  /** Epoch ms when extracted. */
  createdAt: number;
}

function storageOrNull(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Accessing localStorage can throw (disabled cookies/storage).
    return null;
  }
}

export function loadOfflineBasemaps(storage?: Storage): OfflineBasemap[] {
  const store = storageOrNull(storage);
  if (!store) return [];
  try {
    const raw = store.getItem(OFFLINE_BASEMAPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is OfflineBasemap =>
        item &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        Array.isArray(item.bbox) &&
        item.bbox.length === 4,
    );
  } catch {
    return [];
  }
}

function persist(list: OfflineBasemap[], storage?: Storage): void {
  const store = storageOrNull(storage);
  if (!store) return;
  try {
    store.setItem(OFFLINE_BASEMAPS_KEY, JSON.stringify(list));
  } catch {
    // Quota or disabled storage: keep the in-memory list; nothing to persist to.
  }
  notify();
}

/** Adds (or replaces by id) a basemap, newest first. */
export function upsertOfflineBasemap(entry: OfflineBasemap, storage?: Storage): OfflineBasemap[] {
  const list = [entry, ...loadOfflineBasemaps(storage).filter((b) => b.id !== entry.id)];
  persist(list, storage);
  return list;
}

/** Renames a basemap; a blank name is ignored. Returns the updated list. */
export function renameOfflineBasemap(
  id: string,
  name: string,
  storage?: Storage,
): OfflineBasemap[] {
  const trimmed = name.trim();
  const list = loadOfflineBasemaps(storage).map((b) =>
    b.id === id && trimmed ? { ...b, name: trimmed } : b,
  );
  persist(list, storage);
  return list;
}

/** Sets a basemap's Protomaps flavor (its raw tiles are flavor-independent, so
 * this just changes how it's styled). Returns the updated list. */
export function setOfflineBasemapFlavor(
  id: string,
  flavor: string,
  storage?: Storage,
): OfflineBasemap[] {
  const list = loadOfflineBasemaps(storage).map((b) => (b.id === id ? { ...b, flavor } : b));
  persist(list, storage);
  return list;
}

/** Removes a basemap. Returns the updated list. */
export function deleteOfflineBasemap(id: string, storage?: Storage): OfflineBasemap[] {
  const list = loadOfflineBasemaps(storage).filter((b) => b.id !== id);
  persist(list, storage);
  return list;
}

// Cross-component change notification, so an open panel re-renders its list
// after an extract records a new entry.
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

export function subscribeOfflineBasemaps(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
