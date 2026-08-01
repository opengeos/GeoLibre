import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ANNOTATIONS_PLUGIN_ID,
  maplibreAnnotationsPlugin,
} from "../packages/plugins/src/plugins/maplibre-annotations";
import { GEO_EDITOR_PLUGIN_ID } from "../packages/plugins/src/plugins/maplibre-geo-editor";
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
});
