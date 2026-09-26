import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  IDENTIFY_ALL_LAYERS_ID,
  identifyAllIncludes,
  parseProject,
  projectFromStore,
  serializeProject,
  useAppStore,
} from "@geolibre/core";
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

describe("Identify on a list of layers (issue #2688)", () => {
  beforeEach(() => {
    useAppStore.getState().newProject();
  });

  it("limits the all-layers mode to the listed layers", () => {
    const store = useAppStore.getState();
    const a = store.addGeoJsonLayer("A", POINTS);
    const b = store.addGeoJsonLayer("B", POINTS);
    const c = store.addGeoJsonLayer("C", POINTS);
    assert.deepEqual(setScriptIdentify([a, c]), [a, c]);
    const state = useAppStore.getState();
    assert.equal(state.identifyLayerId, IDENTIFY_ALL_LAYERS_ID);
    assert.deepEqual(state.identifyLayerIds, [a, c]);
    assert.ok(identifyAllIncludes(a, state.identifyLayerIds));
    assert.ok(!identifyAllIncludes(b, state.identifyLayerIds));
    assert.deepEqual(getScriptIdentify(), [a, c]);
  });

  it("treats a one-layer list as that layer, and rejects unknown ids", () => {
    const a = useAppStore.getState().addGeoJsonLayer("A", POINTS);
    assert.equal(setScriptIdentify([a]), a);
    assert.equal(useAppStore.getState().identifyLayerIds, null);
    assert.throws(() => setScriptIdentify([a, "missing"]), /No layer with id "missing"/);
    assert.throws(() => setScriptIdentify([]), /layerId must be/);
  });

  it("narrows the list as listed layers are removed", () => {
    const store = useAppStore.getState();
    const a = store.addGeoJsonLayer("A", POINTS);
    const b = store.addGeoJsonLayer("B", POINTS);
    const c = store.addGeoJsonLayer("C", POINTS);
    setScriptIdentify([a, b, c]);
    useAppStore.getState().removeLayer(b);
    assert.deepEqual(useAppStore.getState().identifyLayerIds, [a, c]);
    useAppStore.getState().removeLayer(c);
    assert.equal(useAppStore.getState().identifyLayerId, a);
    assert.equal(useAppStore.getState().identifyLayerIds, null);
  });

  it("is cleared by the in-app Identify buttons", () => {
    const store = useAppStore.getState();
    const a = store.addGeoJsonLayer("A", POINTS);
    const b = store.addGeoJsonLayer("B", POINTS);
    setScriptIdentify([a, b]);
    useAppStore.getState().setIdentifyLayer(IDENTIFY_ALL_LAYERS_ID);
    assert.equal(useAppStore.getState().identifyLayerIds, null);
  });
});

/** Snapshot the store the way the app's save path maps its fields. */
function savedProject() {
  const state = useAppStore.getState();
  return projectFromStore({ ...state, interaction: state.projectInteraction });
}

describe("project interaction block (issue #2688)", () => {
  beforeEach(() => {
    useAppStore.getState().newProject();
  });

  it("arms the saved Identify target on load and writes the block back", () => {
    const store = useAppStore.getState();
    const a = store.addGeoJsonLayer("A", POINTS);
    store.addGeoJsonLayer("B", POINTS);
    const c = store.addGeoJsonLayer("C", POINTS);
    const saved = projectFromStore(useAppStore.getState());
    const project = parseProject(
      serializeProject({
        ...saved,
        interaction: {
          identify: [a, c, "gone"],
          controls: { search: true, globe: false },
        },
      }),
    );
    useAppStore.getState().loadProject(project);
    const state = useAppStore.getState();
    assert.equal(state.identifyLayerId, IDENTIFY_ALL_LAYERS_ID);
    assert.deepEqual(state.identifyLayerIds, [a, c]);
    assert.deepEqual(savedProject().interaction, {
      identify: [a, c, "gone"],
      controls: { search: true, globe: false },
    });
  });

  it("drops malformed entries and omits an empty block", () => {
    const base = projectFromStore(useAppStore.getState());
    const project = parseProject(
      JSON.stringify({ ...base, interaction: { identify: 7, controls: { search: "yes" } } }),
    );
    assert.equal(project.interaction, undefined);
    useAppStore.getState().loadProject(project);
    assert.equal(useAppStore.getState().identifyLayerId, null);
    assert.equal(savedProject().interaction, undefined);
  });

  it("arms 'all' and disarms on a project without the block", () => {
    const base = projectFromStore(useAppStore.getState());
    useAppStore.getState().loadProject({ ...base, interaction: { identify: "all" } });
    assert.equal(useAppStore.getState().identifyLayerId, IDENTIFY_ALL_LAYERS_ID);
    useAppStore.getState().loadProject(base);
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

  it("forgets every override when the user starts a New Project", () => {
    // New Project resets all controls to their defaults, so the scripted
    // overrides are spent; leaving them would let the replay re-apply them
    // over the reset.
    recordScriptMapControl("navigation", false);
    recordScriptMapControl("scale", false);
    clearScriptMapControls();
    assert.deepEqual(getScriptMapControls(), []);
  });

  it("ignores a toggle of a control no script touched", () => {
    recordScriptMapControl("scale", false);
    forgetScriptMapControl("navigation");
    // Terrain and the Maptoolkit logo are not scriptable at all.
    forgetScriptMapControl("terrain");
    assert.deepEqual(getScriptMapControls(), [["scale", false]]);
  });
});
