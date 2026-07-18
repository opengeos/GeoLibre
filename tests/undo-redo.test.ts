import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  getHistoryCoalesceMs,
  getMaxHistoryFeatureCount,
  leadingDebounce,
  setHistoryCoalesceMs,
  setMaxHistoryFeatureCount,
  trimHistoryBySize,
} from "../packages/core/src/history";
import { clearHistory, redo, undo, useAppStore } from "../packages/core/src/store";
import { createEmptyProject } from "../packages/core/src/project";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("leadingDebounce", () => {
  it("passes every call through when the wait is <= 0", () => {
    const calls: number[] = [];
    const fn = leadingDebounce(
      (n: number) => calls.push(n),
      () => 0,
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
      () => 20,
    );
    fn(1); // leading edge -> fires
    fn(2); // within window -> suppressed
    fn(3); // within window -> suppressed
    assert.deepEqual(calls, [1]);
    // Wait well past the 20 ms window so the timer has cleared even on a loaded
    // CI runner (wide margin avoids flakiness from late setTimeout firing).
    await sleep(150); // quiet period elapses
    fn(4); // new burst -> fires
    assert.deepEqual(calls, [1, 4]);
  });

  it("cancel() resets the window so the next call fires immediately", () => {
    const calls: number[] = [];
    const fn = leadingDebounce(
      (n: number) => calls.push(n),
      () => 1000,
    );
    fn(1); // leading edge -> fires
    fn(2); // within window -> suppressed
    assert.deepEqual(calls, [1]);
    fn.cancel(); // clear the active window
    fn(3); // window reset -> fires again
    assert.deepEqual(calls, [1, 3]);
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

/** A snapshot with one layer whose geojson holds `n` placeholder features. */
function snapshot(features: number, geojson?: { features: unknown[] }) {
  const gj = geojson ?? { features: Array.from({ length: features }) };
  return { layers: [{ geojson: gj }] };
}

describe("trimHistoryBySize", () => {
  it("returns the input unchanged when under the budget", () => {
    const past = [snapshot(10), snapshot(10), snapshot(10)];
    assert.equal(trimHistoryBySize(past, 1000), past);
  });

  it("does not trim a zero- or one-entry history", () => {
    assert.deepEqual(trimHistoryBySize([], 0), []);
    const one = [snapshot(10_000)];
    assert.equal(trimHistoryBySize(one, 1), one);
  });

  it("drops the oldest snapshots once the budget is exceeded", () => {
    // Each snapshot carries 100 distinct features; budget 250 keeps the newest 2.
    const past = [snapshot(100), snapshot(100), snapshot(100), snapshot(100)];
    const trimmed = trimHistoryBySize(past, 250);
    assert.deepEqual(trimmed, [past[2], past[3]]);
  });

  it("always keeps the newest snapshot even if it alone exceeds the budget", () => {
    const past = [snapshot(100), snapshot(5000)];
    const trimmed = trimHistoryBySize(past, 250);
    assert.deepEqual(trimmed, [past[1]]);
  });

  it("counts feature sets shared by reference only once", () => {
    // An unchanged layer keeps the same geojson reference across snapshots, so a
    // long history of shared payloads stays cheap and is never trimmed.
    const shared = { features: Array.from({ length: 1000 }) };
    const past = Array.from({ length: 50 }, () => snapshot(0, shared));
    assert.equal(trimHistoryBySize(past, 1500), past);
  });
});

const emptyFC = { type: "FeatureCollection" as const, features: [] };

function bigFC(n: number) {
  return {
    type: "FeatureCollection" as const,
    features: Array.from({ length: n }, (_, i) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [i, i] },
      properties: { i },
    })),
  };
}

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

describe("history size budget (issue #341)", () => {
  beforeEach(() => {
    setHistoryCoalesceMs(0);
    useAppStore.getState().newProject({ name: "reset" });
    useAppStore.temporal.getState().clear();
  });

  it("caps retained snapshots by feature payload for a large layer", () => {
    const original = getMaxHistoryFeatureCount();
    setMaxHistoryFeatureCount(250); // budget fits ~2 snapshots of a 100-feature layer
    try {
      const id = useAppStore.getState().addGeoJsonLayer("big", bigFC(100));
      // Each edit replaces the layer's geojson with a fresh 100-feature set, so
      // every edit would otherwise retain another full copy in history.
      for (let i = 0; i < 10; i++) {
        useAppStore.getState().updateLayer(id, { geojson: bigFC(100) });
      }
      // Without the budget this would be 11 snapshots (add + 10 edits); the
      // budget (250) keeps exactly the newest 2 of the 100-feature snapshots.
      assert.equal(pastLen(), 2, `got ${pastLen()} snapshots`);
      // The most recent edit is still undoable: undo swaps in the prior payload.
      const latestGeojson = useAppStore.getState().layers[0].geojson;
      undo();
      const revertedGeojson = useAppStore.getState().layers[0].geojson;
      assert.notStrictEqual(revertedGeojson, latestGeojson);
      assert.equal(revertedGeojson?.features.length, 100);
    } finally {
      setMaxHistoryFeatureCount(original);
    }
  });

  it("keeps full history depth for small layers under the budget", () => {
    const original = getMaxHistoryFeatureCount();
    setMaxHistoryFeatureCount(500_000);
    try {
      const id = useAppStore.getState().addGeoJsonLayer("small", bigFC(1));
      for (let i = 0; i < 10; i++) {
        useAppStore.getState().updateLayer(id, { geojson: bigFC(1) });
      }
      assert.equal(pastLen(), 11); // add + 10 edits, nothing trimmed
    } finally {
      setMaxHistoryFeatureCount(original);
    }
  });

  it("round-trips the feature-count budget", () => {
    const original = getMaxHistoryFeatureCount();
    setMaxHistoryFeatureCount(1234);
    assert.equal(getMaxHistoryFeatureCount(), 1234);
    setMaxHistoryFeatureCount(original);
  });

  it("rejects non-finite or negative budgets", () => {
    const original = getMaxHistoryFeatureCount();
    assert.throws(() => setMaxHistoryFeatureCount(Number.NaN), RangeError);
    assert.throws(() => setMaxHistoryFeatureCount(-1), RangeError);
    assert.throws(() => setMaxHistoryFeatureCount(Infinity), RangeError);
    assert.throws(() => trimHistoryBySize([], Number.NaN), RangeError);
    assert.equal(getMaxHistoryFeatureCount(), original); // unchanged by failed sets
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

  it("clears the redo stack when a new action follows an undo", () => {
    useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    useAppStore.getState().addGeoJsonLayer("B", emptyFC);
    undo(); // removes B -> futureStates has 1
    assert.equal(futureLen(), 1);
    useAppStore.getState().addGeoJsonLayer("C", emptyFC); // new branch
    assert.equal(futureLen(), 0); // redo stack discarded
  });

  it("undo/redo are no-ops on an empty stack and leave isDirty unchanged", () => {
    useAppStore.getState().markSaved();
    assert.equal(pastLen(), 0);
    undo(); // nothing to undo
    assert.equal(useAppStore.getState().isDirty, false);
    redo(); // nothing to redo
    assert.equal(useAppStore.getState().isDirty, false);
  });

  it("drops a selectedLayerId that no longer exists after undo", () => {
    const a = useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    assert.equal(useAppStore.getState().selectedLayerId, a); // add selects it
    undo(); // removes A; selection would otherwise dangle
    assert.equal(useAppStore.getState().selectedLayerId, null);
  });

  it("resets the coalesce window when history is cleared mid-burst", () => {
    setHistoryCoalesceMs(50); // non-zero so a burst window is active
    useAppStore.getState().addGeoJsonLayer("A", emptyFC); // opens the window
    assert.equal(pastLen(), 1);
    clearHistory(); // must cancel the active window
    useAppStore.getState().addGeoJsonLayer("B", emptyFC); // would be suppressed
    assert.equal(pastLen(), 1); // records despite being within the window
    setHistoryCoalesceMs(0);
  });

  it("cancels an in-flight coalesce window on undo so the next edit records", () => {
    setHistoryCoalesceMs(50); // non-zero so a burst window is active
    useAppStore.getState().addGeoJsonLayer("A", emptyFC); // opens the window
    assert.equal(pastLen(), 1);
    undo(); // must cancel the active window while stepping back
    assert.equal(pastLen(), 0);
    useAppStore.getState().addGeoJsonLayer("B", emptyFC); // would be suppressed
    assert.equal(pastLen(), 1); // records despite being within the window
    setHistoryCoalesceMs(0);
  });

  it("clears history when a project is loaded", () => {
    useAppStore.getState().addGeoJsonLayer("A", emptyFC);
    assert.ok(pastLen() > 0);
    useAppStore.getState().loadProject(createEmptyProject("loaded"));
    assert.equal(pastLen(), 0);
    assert.equal(futureLen(), 0);
  });
});
