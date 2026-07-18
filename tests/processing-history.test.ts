import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  MAX_PROCESSING_HISTORY,
  normalizeProcessingHistory,
  parseProject,
  projectFromStore,
  serializeProject,
  useAppStore,
  type ProcessingRun,
} from "@geolibre/core";

function makeRun(patch: Partial<ProcessingRun> = {}): ProcessingRun {
  return {
    id: "run-1",
    kind: "vector",
    toolId: "buffer",
    toolName: "Buffer",
    engine: "client",
    parameters: { layer: "layer-a", distance: 10, units: "kilometers" },
    startedAt: "2026-07-17T12:00:00.000Z",
    durationMs: 42,
    status: "success",
    ...patch,
  };
}

describe("processing history store actions", () => {
  beforeEach(() => {
    useAppStore.getState().newProject();
  });

  it("appends runs, de-dupes by id, and marks the project dirty", () => {
    const store = useAppStore.getState();
    store.addProcessingRun(makeRun());
    store.addProcessingRun(makeRun({ toolName: "Duplicate id" }));
    store.addProcessingRun(makeRun({ id: "run-2", toolId: "centroids" }));

    const history = useAppStore.getState().processingHistory;
    assert.equal(history.length, 2);
    assert.equal(history[0].toolName, "Buffer");
    assert.equal(history[1].toolId, "centroids");
    assert.equal(useAppStore.getState().isDirty, true);
  });

  it("caps the history at MAX_PROCESSING_HISTORY, dropping the oldest", () => {
    const store = useAppStore.getState();
    for (let i = 0; i < MAX_PROCESSING_HISTORY + 5; i += 1) {
      store.addProcessingRun(makeRun({ id: `run-${i}` }));
    }
    const history = useAppStore.getState().processingHistory;
    assert.equal(history.length, MAX_PROCESSING_HISTORY);
    assert.equal(history[0].id, "run-5");
    assert.equal(history.at(-1)?.id, `run-${MAX_PROCESSING_HISTORY + 4}`);
  });

  it("patches a recorded run in place and ignores unknown ids", () => {
    const store = useAppStore.getState();
    store.addProcessingRun(makeRun());
    store.updateProcessingRun("run-1", {
      outputLayerNames: ["Buffer result"],
    });
    store.updateProcessingRun("missing", { toolName: "nope" });

    const history = useAppStore.getState().processingHistory;
    assert.equal(history.length, 1);
    assert.deepEqual(history[0].outputLayerNames, ["Buffer result"]);
  });

  it("clears the history", () => {
    const store = useAppStore.getState();
    store.addProcessingRun(makeRun());
    store.clearProcessingHistory();
    assert.equal(useAppStore.getState().processingHistory.length, 0);
  });

  it("does not create undo entries when recording runs", () => {
    const before = useAppStore.temporal.getState().pastStates.length;
    useAppStore.getState().addProcessingRun(makeRun());
    assert.equal(useAppStore.temporal.getState().pastStates.length, before);
  });
});

describe("processing history persistence", () => {
  beforeEach(() => {
    useAppStore.getState().newProject();
  });

  it("round-trips through the project file", () => {
    const store = useAppStore.getState();
    store.addProcessingRun(makeRun());
    store.addProcessingRun(
      makeRun({
        id: "run-2",
        kind: "whitebox",
        toolId: "slope",
        toolName: "Slope",
        engine: "wasm",
        parameters: { dem: "layer:layer-b" },
        inputLayerNames: { "layer-b": "DEM" },
        outputLayerNames: ["Slope Output"],
        status: "error",
        error: "boom",
      }),
    );

    const state = useAppStore.getState();
    const project = projectFromStore({
      projectName: state.projectName,
      mapView: state.mapView,
      basemapStyleUrl: state.basemapStyleUrl,
      basemapVisible: state.basemapVisible,
      basemapOpacity: state.basemapOpacity,
      layers: state.layers,
      preferences: state.preferences,
      processingHistory: state.processingHistory,
      metadata: state.metadata,
    });
    const reloaded = parseProject(serializeProject(project));
    assert.equal(reloaded.processingHistory?.length, 2);
    assert.deepEqual(reloaded.processingHistory?.[0], makeRun());
    assert.equal(reloaded.processingHistory?.[1].status, "error");
    assert.equal(reloaded.processingHistory?.[1].error, "boom");
    assert.deepEqual(reloaded.processingHistory?.[1].inputLayerNames, {
      "layer-b": "DEM",
    });

    useAppStore.getState().loadProject(reloaded);
    assert.equal(useAppStore.getState().processingHistory.length, 2);
    assert.equal(useAppStore.getState().processingHistory[1].toolId, "slope");
  });

  it("omits the key entirely for a history-less project", () => {
    const state = useAppStore.getState();
    const project = projectFromStore({
      projectName: state.projectName,
      mapView: state.mapView,
      basemapStyleUrl: state.basemapStyleUrl,
      basemapVisible: state.basemapVisible,
      basemapOpacity: state.basemapOpacity,
      layers: state.layers,
      preferences: state.preferences,
      processingHistory: state.processingHistory,
      metadata: state.metadata,
    });
    assert.ok(!("processingHistory" in project));
  });

  it("resets the history when a new project is created", () => {
    useAppStore.getState().addProcessingRun(makeRun());
    useAppStore.getState().newProject();
    assert.equal(useAppStore.getState().processingHistory.length, 0);
  });
});

describe("normalizeProcessingHistory", () => {
  it("drops invalid entries, de-dupes by id, and defaults fields", () => {
    const runs = normalizeProcessingHistory([
      makeRun(),
      makeRun({ toolName: "duplicate" }),
      { id: "", toolId: "buffer", kind: "vector" },
      { id: "no-tool", toolId: "", kind: "vector" },
      { id: "bad-kind", toolId: "buffer", kind: "nope" },
      {
        id: "sparse",
        toolId: "centroids",
        kind: "vector",
        parameters: "not-an-object",
        durationMs: "NaN",
        status: "weird",
      },
      "not-an-object",
    ]);
    assert.equal(runs?.length, 2);
    assert.equal(runs?.[0].toolName, "Buffer");
    const sparse = runs?.[1];
    assert.equal(sparse?.toolName, "centroids");
    assert.deepEqual(sparse?.parameters, {});
    // An unknown/missing status must not present as a green "success".
    assert.equal(sparse?.status, "error");
    assert.equal(sparse?.durationMs, undefined);
  });

  it("returns null for absent or empty input", () => {
    assert.equal(normalizeProcessingHistory(undefined), null);
    assert.equal(normalizeProcessingHistory([]), null);
    assert.equal(normalizeProcessingHistory([{}]), null);
  });

  it("caps a hand-edited list at MAX_PROCESSING_HISTORY keeping the newest", () => {
    const runs = normalizeProcessingHistory(
      Array.from({ length: MAX_PROCESSING_HISTORY + 10 }, (_, i) => makeRun({ id: `run-${i}` })),
    );
    assert.equal(runs?.length, MAX_PROCESSING_HISTORY);
    assert.equal(runs?.[0].id, "run-10");
  });
});
