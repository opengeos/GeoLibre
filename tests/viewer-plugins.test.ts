import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maplibreAnnotationsPlugin } from "../packages/plugins/src/plugins/maplibre-annotations";
import { maplibreGeoEditorPlugin } from "../packages/plugins/src/plugins/maplibre-geo-editor";
import {
  ANNOTATIONS_PLUGIN_ID,
  GEOAGENT_PLUGIN_ID,
  GEO_EDITOR_PLUGIN_ID,
} from "../packages/plugins/src/plugin-ids";
import { VIEWER_BLOCKED_PLUGIN_IDS } from "../packages/plugins/src/viewer-plugins";

describe("VIEWER_BLOCKED_PLUGIN_IDS", () => {
  it("names every plugin whose on-map control writes to the project", () => {
    assert.deepEqual(
      [...VIEWER_BLOCKED_PLUGIN_IDS].sort(),
      [ANNOTATIONS_PLUGIN_ID, GEOAGENT_PLUGIN_ID, GEO_EDITOR_PLUGIN_ID].sort(),
    );
  });

  it("uses the ids the plugins actually register under", () => {
    // The viewer preset looks each id up through `PluginManager.isActive`, so a
    // plugin renamed without updating the list would silently stop being
    // blocked and the embed would quietly become drawable again. GeoAgent
    // cannot be checked this way — importing its module pulls in
    // `maplibre-gl-earth-engine`, which touches `window` at load — which is
    // precisely why the ids live in `plugin-ids` and the plugin imports its own
    // from there, making the two the same binding rather than two literals.
    assert.equal(maplibreAnnotationsPlugin.id, ANNOTATIONS_PLUGIN_ID);
    assert.equal(maplibreGeoEditorPlugin.id, GEO_EDITOR_PLUGIN_ID);
  });

  it("keeps the list importable without a browser", () => {
    // `viewer-plugins` reads `plugin-ids` rather than the plugin modules, so
    // the guard and its tests do not drag plugin implementations (and their
    // window-touching dependencies) in. This test passing IS that check.
    assert.ok(VIEWER_BLOCKED_PLUGIN_IDS.every((id) => typeof id === "string" && id.length > 0));
  });
});
