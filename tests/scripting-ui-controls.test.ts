import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { IDENTIFY_ALL_LAYERS_ID, useAppStore } from "@geolibre/core";
import {
  clearScriptMapControls,
  forgetScriptMapControl,
  getScriptIdentify,
  getScriptMapControls,
  isScriptableMapControl,
  isScriptablePanel,
  recordScriptMapControl,
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

// The record `useScriptControlRestore` replays onto each new controller. It
// lives outside the toolbar because `?maponly` embeds never mount one, and a
// renderer swap or project load drops whatever the old controller had mounted.
describe("recorded script map controls", () => {
  beforeEach(() => {
    clearScriptMapControls();
  });

  it("records what a script asked for so it can be replayed", () => {
    recordScriptMapControl("navigation", false);
    recordScriptMapControl("scale", true);
    assert.deepEqual(getScriptMapControls(), [
      ["navigation", false],
      ["scale", true],
    ]);
  });

  it("keeps only the latest request per control", () => {
    recordScriptMapControl("navigation", false);
    recordScriptMapControl("navigation", true);
    assert.deepEqual(getScriptMapControls(), [["navigation", true]]);
  });

  it("starts empty so an untouched control is left to the toolbar", () => {
    assert.deepEqual(getScriptMapControls(), []);
  });

  it("drops a control the user toggled so the replay stops forcing it", () => {
    // A script hides navigation, then the user shows it from the Controls menu.
    // Without the drop, the next renderer swap or project load would replay the
    // scripted `false` and hide it again behind the user's back.
    recordScriptMapControl("navigation", false);
    forgetScriptMapControl("navigation");
    assert.deepEqual(getScriptMapControls(), []);
  });

  it("leaves other controls recorded when one is toggled", () => {
    recordScriptMapControl("navigation", false);
    recordScriptMapControl("scale", false);
    forgetScriptMapControl("navigation");
    assert.deepEqual(getScriptMapControls(), [["scale", false]]);
  });

  it("ignores a toggle of a control no script touched", () => {
    recordScriptMapControl("scale", false);
    forgetScriptMapControl("navigation");
    // Terrain and the Maptoolkit logo are not scriptable at all.
    forgetScriptMapControl("terrain");
    assert.deepEqual(getScriptMapControls(), [["scale", false]]);
  });
});
