// Which plugins the read-only viewer preset (`?layout=viewer`) refuses to run.
//
// The viewer hides the authoring chrome in React — menus, panels, dialogs,
// keyboard shortcuts, drag and drop. A plugin that paints its UI with
// `addMapControl` bypasses all of that: the control lives on the map, not in
// the dock, so nothing the shell hides can reach it. And a plugin is activated
// by whatever the *loaded project* lists in `projectPlugins.activePluginIds`,
// which the host does not control — so a project saved with an editing plugin
// active would otherwise hand a viewer embed a drawing toolbar.

// Read from `plugin-ids`, not from the plugin modules: `maplibre-geoagent.ts`
// pulls in `maplibre-gl-earth-engine`, which touches `window` at module load,
// so importing it here would make this list browser-only.
import { ANNOTATIONS_PLUGIN_ID, GEOAGENT_PLUGIN_ID, GEO_EDITOR_PLUGIN_ID } from "./plugin-ids";

/**
 * Plugins that must never be active under the viewer preset, because their
 * on-map control creates or edits project data:
 *
 * - {@link GEO_EDITOR_PLUGIN_ID} — vertex/geometry editing handles.
 * - {@link ANNOTATIONS_PLUGIN_ID} — the drawing toolbar (text, pin, note,
 *   image, arrow, rectangle, ellipse, freehand).
 * - {@link GEOAGENT_PLUGIN_ID} — an AI chat control whose results are synced
 *   into the store by `geoagent-layer-sync`, which calls `addLayer`,
 *   `updateLayer`, and `removeLayer`. It writes to the project through a
 *   companion module rather than the plugin's own `app` handle, which is
 *   exactly why "does this file call a store mutator?" is the wrong question
 *   to ask of a candidate — follow what its control can *do*.
 *
 * A blocklist rather than an allowlist on purpose: the viewer's job is to show
 * the project as saved, so the display plugins a project relies on (layer
 * control, basemaps, time slider, legend/colorbar components, data browsers)
 * have to keep working, and an allowlist would silently blank them out. The
 * cost is that this list is the thing to update: **a new plugin whose map
 * control writes to the project belongs here.** Adding one is cheap; missing
 * one is a viewer embed that can be drawn on.
 *
 * **Async activation is handled, not assumed away.** `PluginManager.activate`
 * and `restoreProjectState` add a plugin to `active` before an async
 * `activate()` has resolved (see `watchAsyncActivation`), so a guard that
 * called `deactivate` in the same tick would tear down nothing and let the
 * mount land afterwards — the guard passing while the thing it guards against
 * happens. GeoAgent mounts behind a dynamic import and is exactly that case, so
 * the viewer guard awaits {@link PluginManager.pendingActivation} before
 * deactivating. A plugin added here needs no special handling for this.
 */
export const VIEWER_BLOCKED_PLUGIN_IDS: readonly string[] = [
  GEO_EDITOR_PLUGIN_ID,
  ANNOTATIONS_PLUGIN_ID,
  GEOAGENT_PLUGIN_ID,
];
