import { CHOSEN_REGIONAL_BASEMAP_STORAGE_KEY, LAST_BASEMAP_STORAGE_KEY } from "./storage-keys";

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

/**
 * Read the regional basemap the user last chose, or null.
 *
 * @param storage - Storage to read; defaults to `localStorage`.
 * @returns The chosen regional style URL, or null when none is recorded.
 */
export function readChosenRegionalBasemap(storage?: Storage): string | null {
  try {
    const target = storage ?? globalThis.localStorage;
    return target.getItem(CHOSEN_REGIONAL_BASEMAP_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Record that the user chose a regional basemap, so the launch restore may
 * apply it without asking.
 *
 * @param styleUrl - The regional style URL the user picked or accepted.
 * @param storage - Storage to write; defaults to `localStorage`.
 */
export function writeChosenRegionalBasemap(styleUrl: string, storage?: Storage): void {
  try {
    const target = storage ?? globalThis.localStorage;
    target.setItem(CHOSEN_REGIONAL_BASEMAP_STORAGE_KEY, styleUrl);
  } catch {
    // Best-effort, like writeLastBasemap.
  }
}
