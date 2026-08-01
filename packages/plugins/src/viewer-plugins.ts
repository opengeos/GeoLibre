// Which plugins the read-only viewer preset (`?layout=viewer`) refuses to run.
//
// The viewer hides the authoring chrome in React — menus, panels, dialogs,
// keyboard shortcuts, drag and drop. A plugin that paints its UI with
// `addMapControl` bypasses all of that: the control lives on the map, not in
// the dock, so nothing the shell hides can reach it. And a plugin is activated
// by whatever the *loaded project* lists in `projectPlugins.activePluginIds`,
// which the host does not control — so a project saved with an editing plugin
// active would otherwise hand a viewer embed a drawing toolbar.

import { ANNOTATIONS_PLUGIN_ID } from "./plugins/maplibre-annotations";
import { GEO_EDITOR_PLUGIN_ID } from "./plugins/maplibre-geo-editor";

/**
 * Plugins that must never be active under the viewer preset, because their
 * on-map control creates or edits project data:
 *
 * - {@link GEO_EDITOR_PLUGIN_ID} — vertex/geometry editing handles.
 * - {@link ANNOTATIONS_PLUGIN_ID} — the drawing toolbar (text, pin, note,
 *   image, arrow, rectangle, ellipse, freehand).
 *
 * A blocklist rather than an allowlist on purpose: the viewer's job is to show
 * the project as saved, so the display plugins a project relies on (layer
 * control, basemaps, time slider, legend/colorbar components, data browsers)
 * have to keep working, and an allowlist would silently blank them out. The
 * cost is that this list is the thing to update: **a new plugin whose map
 * control writes to the project belongs here.** Adding one is cheap; missing
 * one is a viewer embed that can be drawn on.
 */
export const VIEWER_BLOCKED_PLUGIN_IDS: readonly string[] = [
  GEO_EDITOR_PLUGIN_ID,
  ANNOTATIONS_PLUGIN_ID,
];
