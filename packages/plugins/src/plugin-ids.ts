// Plugin ids kept apart from the plugin implementations that use them.
//
// `VIEWER_BLOCKED_PLUGIN_IDS` has to name plugins without pulling their code
// in: `maplibre-geoagent.ts` imports `maplibre-gl-earth-engine`, which touches
// `window` at module load, so importing the plugin module just to read a string
// would make the blocklist — and every test of it — browser-only. Each plugin
// module imports its id from here and re-exports it, so the id a plugin
// registers under and the id the viewer guard blocks are the same binding and
// cannot drift.

/** The geometry editor: vertex and geometry editing handles on the map. */
export const GEO_EDITOR_PLUGIN_ID = "maplibre-gl-geo-editor";

/** Annotations: the drawing toolbar (text, pin, note, arrow, freehand, …). */
export const ANNOTATIONS_PLUGIN_ID = "maplibre-gl-annotations";

/** GeoAgent: the AI chat control, whose results sync into the store. */
export const GEOAGENT_PLUGIN_ID = "maplibre-gl-geoagent";
