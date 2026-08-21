import { LAST_BASEMAP_STORAGE_KEY } from "./storage-keys";

/** Read the last selected basemap. An empty string is the valid blank basemap. */
export function readLastBasemap(storage?: Storage): string | null {
  try {
    const target = storage ?? globalThis.localStorage;
    return target.getItem(LAST_BASEMAP_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persist the current basemap without making storage availability app-critical. */
export function writeLastBasemap(styleUrl: string, storage?: Storage): void {
  try {
    const target = storage ?? globalThis.localStorage;
    target.setItem(LAST_BASEMAP_STORAGE_KEY, styleUrl);
  } catch {
    // Persistence is best-effort; storage can be disabled or full.
  }
}
