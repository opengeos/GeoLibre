import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { IDENTIFY_ALL_LAYERS_ID, useAppStore } from "@geolibre/core";
import {
  getScriptIdentify,
  isScriptableMapControl,
  isScriptablePanel,
  setScriptIdentify,
} from "../apps/geolibre-desktop/src/lib/scripting/ui-controls";

const POINTS = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      properties: { name: "A" },
      geometry: { type: "Point" as const, coordinates: [0, 0] },
    },
  ],
};

describe("scripted Identify", () => {
  beforeEach(() => {
    useAppStore.getState().newProject();
  });

  it("maps 'all' to the store's all-layers id and back", () => {
    assert.equal(setScriptIdentify("all"), "all");
    assert.equal(useAppStore.getState().identifyLayerId, IDENTIFY_ALL_LAYERS_ID);
    assert.equal(getScriptIdentify(), "all");
  });

  it("arms a known layer and disarms on null", () => {
    const id = useAppStore.getState().addGeoJsonLayer("Points", POINTS);
    assert.equal(setScriptIdentify(id), id);
    assert.equal(getScriptIdentify(), id);
    assert.equal(setScriptIdentify(null), null);
    assert.equal(useAppStore.getState().identifyLayerId, null);
  });

  it("rejects an unknown layer or a non-string", () => {
    assert.throws(() => setScriptIdentify("missing"), /No layer with id "missing"/);
    assert.throws(() => setScriptIdentify(42), /layerId must be/);
    assert.equal(useAppStore.getState().identifyLayerId, null);
  });
});

describe("scriptable control names", () => {
  it("separates panels from built-in map controls", () => {
    assert.ok(isScriptablePanel("bookmark"));
    assert.ok(isScriptablePanel("search"));
    assert.ok(!isScriptablePanel("globe"));
    assert.ok(isScriptableMapControl("globe"));
    // Terrain is project state, and the layer control is always on.
    assert.ok(!isScriptableMapControl("terrain"));
    assert.ok(!isScriptableMapControl("layer-control"));
  });
});
