import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GEO_EDITOR_PLUGIN_ID,
  maplibreGeoEditorPlugin as plugin,
} from "../packages/plugins/src/plugins/maplibre-geo-editor";

describe("maplibreGeoEditorPlugin", () => {
  // The Layers panel toggle keys its active-state highlight on the exported
  // constant, so the two must never drift apart.
  it("has the exported id", () => {
    assert.equal(plugin.id, GEO_EDITOR_PLUGIN_ID);
  });
});
