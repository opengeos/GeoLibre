import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { reserveLayerSourceRemoval, useAppStore } from "../packages/core/src/store";
import { setHistoryCoalesceMs } from "../packages/core/src/history";
import { projectFromStore } from "../packages/core/src/project";

let release: (() => void) | undefined;
beforeEach(() => {
  setHistoryCoalesceMs(0);
  useAppStore.getState().newProject({ name: "Removal guard" });
});
afterEach(() => {
  release?.();
  release = undefined;
});

it("rejects existing references and concurrent import, project load and direct state writes", () => {
  const state = useAppStore.getState();
  const id = state.addGeoJsonLayer("Reserved", { type: "FeatureCollection", features: [] });
  const layer = useAppStore.getState().layers[0];
  assert.throws(() => reserveLayerSourceRemoval((item) => item.id === id, "In use"), /In use/);
  const project = projectFromStore(useAppStore.getState());
  state.removeLayer(id);
  release = reserveLayerSourceRemoval((item) => item.id === id, "Deleting");
  const before = useAppStore.getState();
  const history = useAppStore.temporal.getState().pastStates.slice();
  assert.throws(() => state.addLayer(layer), /Deleting/);
  assert.throws(() => state.loadProject(project), /Deleting/);
  assert.throws(() => useAppStore.setState({ layers: [layer] }), /Deleting/);
  assert.throws(() => useAppStore.setState(() => ({ layers: [layer] })), /Deleting/);
  assert.equal(useAppStore.getState(), before);
  assert.deepEqual(useAppStore.temporal.getState().pastStates, history);
  state.addGeoJsonLayer("Unrelated", { type: "FeatureCollection", features: [] });
  assert.equal(useAppStore.getState().layers.length, 1);
  release();
  state.loadProject(project);
  assert.equal(useAppStore.getState().layers[0].id, id);
});

it("rejects temporal restores without consuming undo or redo history", () => {
  const state = useAppStore.getState();
  const id = state.addGeoJsonLayer("Reserved", { type: "FeatureCollection", features: [] });
  state.removeLayer(id);
  release = reserveLayerSourceRemoval((item) => item.id === id, "Deleting");
  const history = useAppStore.temporal.getState().pastStates.slice();
  assert.throws(() => useAppStore.temporal.getState().undo(), /Deleting/);
  assert.deepEqual(useAppStore.temporal.getState().pastStates, history);
  assert.equal(useAppStore.getState().layers.length, 0);
  release();
  useAppStore.temporal.getState().undo();
  useAppStore.temporal.getState().undo();
  release = reserveLayerSourceRemoval((item) => item.id === id, "Deleting");
  const future = useAppStore.temporal.getState().futureStates.slice();
  assert.throws(() => useAppStore.temporal.getState().redo(), /Deleting/);
  assert.deepEqual(useAppStore.temporal.getState().futureStates, future);
  release();
  useAppStore.temporal.getState().redo();
  assert.equal(useAppStore.getState().layers[0].id, id);
});
