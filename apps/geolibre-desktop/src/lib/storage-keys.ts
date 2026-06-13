/**
 * localStorage keys shared across modules. Kept in a tiny, dependency-free file
 * so it can be imported from anywhere (including the i18n layer, which reads the
 * persisted language before the settings store loads) without creating import
 * cycles.
 */

/** Persisted desktop settings blob (layout, language, plugin sources, …). */
export const DESKTOP_SETTINGS_STORAGE_KEY = "geolibre.desktopSettings";
