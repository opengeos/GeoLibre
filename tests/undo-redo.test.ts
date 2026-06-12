import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  getHistoryCoalesceMs,
  leadingDebounce,
  setHistoryCoalesceMs,
} from "../packages/core/src/history";
import { clearHistory, redo, undo, useAppStore } from "../packages/core/src/store";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("leadingDebounce", () => {
  it("passes every call through when the wait is <= 0", () => {
    const calls: number[] = [];
    const fn = leadingDebounce(
      (n: number) => calls.push(n),
      () => 0
    );
    fn(1);
    fn(2);
    fn(3);
    assert.deepEqual(calls, [1, 2, 3]);
  });

  it("fires on the leading edge and suppresses the rest of a burst", async () => {
    const calls: number[] = [];
    const fn = leadingDebounce(
      (n: number) => calls.push(n),
      () => 30
    );
    fn(1); // leading edge -> fires
    fn(2); // within window -> suppressed
    fn(3); // within window -> suppressed
    assert.deepEqual(calls, [1]);
    await sleep(50); // quiet period elapses
    fn(4); // new burst -> fires
    assert.deepEqual(calls, [1, 4]);
  });
});

describe("history coalesce config", () => {
  it("round-trips the coalesce window", () => {
    const original = getHistoryCoalesceMs();
    setHistoryCoalesceMs(0);
    assert.equal(getHistoryCoalesceMs(), 0);
    setHistoryCoalesceMs(250);
    assert.equal(getHistoryCoalesceMs(), 250);
    setHistoryCoalesceMs(original);
  });
});

const emptyFC = { type: "FeatureCollection" as const, features: [] };

function pastLen(): number {
  return useAppStore.temporal.getState().pastStates.length;
}

describe("store history tracking", () => {
  beforeEach(() => {
    setHistoryCoalesceMs(0);
    useAppStore.getState().newProject({ name: "reset" });
    useAppStore.temporal.getState().clear();
  });

  it("records tracked changes and ignores transient changes", () => {
    setHistoryCoalesceMs(0);
    useAppStore.getState().newProject({ name: "T" });
    assert.equal(pastLen(), 0);

    // Tracked change: adding a layer.
    useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    assert.equal(pastLen(), 1);

    // Tracked change: basemap opacity.
    useAppStore.getState().setBasemapOpacity(0.5);
    assert.equal(pastLen(), 2);

    // Transient changes must NOT create history entries.
    const before = pastLen();
    const id = useAppStore.getState().layers[0].id;
    useAppStore.getState().selectLayer(id);
    useAppStore.getState().setAttributeTableOpen(true);
    useAppStore.getState().setMapView({ zoom: 7 });
    useAppStore.getState().setPointerCoords([1, 2]);
    useAppStore.getState().setAttributeFilter("abc");
    assert.equal(pastLen(), before);
  });
});

function futureLen(): number {
  return useAppStore.temporal.getState().futureStates.length;
}

describe("undo/redo behavior", () => {
  beforeEach(() => {
    setHistoryCoalesceMs(0);
    useAppStore.getState().newProject({ name: "reset" });
  });

  it("restores a removed layer with its style and stack position", () => {
    const a = useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    useAppStore.getState().addGeoJsonLayer("B", emptyFC);
    useAppStore.getState().setLayerStyle(a, { fillColor: "#abcdef" });
    useAppStore.getState().removeLayer(a);
    assert.equal(
      useAppStore.getState().layers.find((l) => l.id === a),
      undefined,
    );

    undo(); // reverts the remove
    const restored = useAppStore.getState().layers;
    assert.equal(restored[0].id, a); // original index 0
    assert.equal(restored[0].style.fillColor, "#abcdef"); // style preserved

    redo(); // re-removes it
    assert.equal(
      useAppStore.getState().layers.find((l) => l.id === a),
      undefined,
    );
  });

  it("undoes and redoes a style edit", () => {
    const a = useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    useAppStore.getState().setLayerStyle(a, { fillColor: "#abcdef" });

    undo();
    assert.equal(useAppStore.getState().layers[0].style.fillColor, "#3b82f6");
    redo();
    assert.equal(useAppStore.getState().layers[0].style.fillColor, "#abcdef");
  });

  it("undoes a reorder", () => {
    const a = useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    const b = useAppStore.getState().addGeoJsonLayer("B", emptyFC);
    useAppStore.getState().moveLayer(a, 1); // [B, A]
    assert.deepEqual(
      useAppStore.getState().layers.map((l) => l.id),
      [b, a],
    );
    undo();
    assert.deepEqual(
      useAppStore.getState().layers.map((l) => l.id),
      [a, b],
    );
  });

  it("undoes a basemap change", () => {
    useAppStore.getState().setBasemapOpacity(0.4);
    assert.equal(useAppStore.getState().basemapOpacity, 0.4);
    undo();
    assert.equal(useAppStore.getState().basemapOpacity, 1);
  });

  it("marks the project dirty on undo and redo", () => {
    useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    useAppStore.getState().markSaved();
    assert.equal(useAppStore.getState().isDirty, false);
    undo();
    assert.equal(useAppStore.getState().isDirty, true);
    useAppStore.getState().markSaved();
    redo();
    assert.equal(useAppStore.getState().isDirty, true);
  });

  it("clears history when a new project is created", () => {
    useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    assert.ok(pastLen() > 0);
    useAppStore.getState().newProject({ name: "U" });
    assert.equal(pastLen(), 0);
    assert.equal(futureLen(), 0);
  });

  it("clearHistory empties both stacks", () => {
    useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    assert.ok(pastLen() > 0);
    clearHistory();
    assert.equal(pastLen(), 0);
    assert.equal(futureLen(), 0);
  });
});
