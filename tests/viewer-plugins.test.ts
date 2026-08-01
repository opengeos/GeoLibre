import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ANNOTATIONS_PLUGIN_ID,
  maplibreAnnotationsPlugin,
} from "../packages/plugins/src/plugins/maplibre-annotations";
import {
  GEO_EDITOR_PLUGIN_ID,
  maplibreGeoEditorPlugin,
} from "../packages/plugins/src/plugins/maplibre-geo-editor";
import { VIEWER_BLOCKED_PLUGIN_IDS } from "../packages/plugins/src/viewer-plugins";

describe("VIEWER_BLOCKED_PLUGIN_IDS", () => {
  it("names the plugins whose on-map control writes to the project", () => {
    assert.deepEqual([...VIEWER_BLOCKED_PLUGIN_IDS].sort(), [
      ANNOTATIONS_PLUGIN_ID,
      GEO_EDITOR_PLUGIN_ID,
    ]);
  });

  it("uses the id the annotations plugin actually registers under", () => {
    // The viewer preset looks each id up through `PluginManager.isActive`, so a
    // plugin renamed without updating the list would silently stop being
    // blocked and the embed would quietly become drawable again.
    // (`maplibre-geo-editor.ts` has the same assertion for its own id.)
    assert.equal(maplibreAnnotationsPlugin.id, ANNOTATIONS_PLUGIN_ID);
  });

  it("lists only plugins that mount synchronously", () => {
    // PluginManager marks a plugin active before an async `activate()` has
    // resolved, and the viewer guard deactivates in that same tick — so an
    // async blocked plugin would be torn down before its control existed and
    // then mount anyway, leaving a live authoring control in a read-only
    // embed. Making one async means teaching the guard to await the pending
    // activation (see the note on VIEWER_BLOCKED_PLUGIN_IDS).
    for (const plugin of [maplibreGeoEditorPlugin, maplibreAnnotationsPlugin]) {
      assert.equal(
        plugin.activate.constructor.name,
        "Function",
        `${plugin.id} must not declare activate as async`,
      );
    }
  });
});
