import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getHistoryCoalesceMs,
  leadingDebounce,
  setHistoryCoalesceMs,
} from "../packages/core/src/history";
import { useAppStore } from "../packages/core/src/store";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("leadingDebounce", () => {
  it("passes every call through when the wait is <= 0", () => {
    const calls: number[] = [];
    const fn = leadingDebounce((n: number) => calls.push(n), () => 0);
    fn(1);
    fn(2);
    fn(3);
    assert.deepEqual(calls, [1, 2, 3]);
  });

  it("fires on the leading edge and suppresses the rest of a burst", async () => {
    const calls: number[] = [];
    const fn = leadingDebounce((n: number) => calls.push(n), () => 30);
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
