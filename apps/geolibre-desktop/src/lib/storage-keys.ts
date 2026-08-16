/**
 * localStorage keys shared across modules. Kept in a tiny, dependency-free file
 * so it can be imported from anywhere (including the i18n layer, which reads the
 * persisted language before the settings store loads) without creating import
 * cycles.
 */

/** Persisted desktop settings blob (layout, language, plugin sources, …). */
export const DESKTOP_SETTINGS_STORAGE_KEY = "geolibre.desktopSettings";

/** Basemap used to seed the empty workspace on the next app launch. */
export const LAST_BASEMAP_STORAGE_KEY = "geolibre.lastBasemap";

/**
 * Latest version the user dismissed via "Skip this version" in the automated
 * startup update prompt. Suppresses the prompt for that one version so it does
 * not reappear on every launch (desktop only).
 */
export const UPDATE_DISMISSED_VERSION_STORAGE_KEY = "geolibre.updateDismissedVersion";

/**
 * Epoch-millisecond timestamp of the last automated startup update check.
 * Throttles the unauthenticated GitHub API call so frequent relaunches do not
 * exhaust the per-IP rate limit (desktop only).
 */
export const UPDATE_LAST_CHECK_STORAGE_KEY = "geolibre.lastUpdateCheck";

/**
 * Which project each durable startup snapshot was copied from. Only the index
 * lives here; the project text itself is a file in the app's private data
 * directory. See `lib/startup-project-snapshot.ts`.
 */
export const STARTUP_SNAPSHOTS_STORAGE_KEY = "geolibre.startupProjectSnapshots";
