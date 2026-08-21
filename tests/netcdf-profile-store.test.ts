import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  addNetcdfProfileSample,
  clearNetcdfProfileSamples,
  clearNetcdfProfileSamplesForLayer,
  getNetcdfProfileSamples,
  isNetcdfProfilePoppedOut,
  MAX_PROFILE_SAMPLES,
  removeNetcdfProfileSample,
  setNetcdfProfilePoppedOut,
  setNetcdfProfileSampleProfile,
  subscribeNetcdfProfile,
  type NetcdfProfileSample,
} from "../apps/geolibre-desktop/src/lib/netcdf-profile-store";

/** A clicked pixel with just enough shape for the store's bookkeeping. */
function sample(layerId: string, lng: number): Omit<NetcdfProfileSample, "id" | "order"> {
  return { layerId, variable: "reflectance", lng, lat: 0 };
}

const PROFILE = { axis: { name: "bands", size: 2 }, values: [0.1, 0.2] };

describe("netcdf profile store", () => {
  beforeEach(() => clearNetcdfProfileSamples());

  it("accumulates samples from the same layer", () => {
    addNetcdfProfileSample(sample("a", 1));
    addNetcdfProfileSample(sample("a", 2));
    assert.deepEqual(
      getNetcdfProfileSamples().map((item) => item.lng),
      [1, 2],
    );
  });

  it("numbers samples from 1 so the marker matches the legend", () => {
    addNetcdfProfileSample(sample("a", 1));
    addNetcdfProfileSample(sample("a", 2));
    assert.deepEqual(
      getNetcdfProfileSamples().map((item) => item.order),
      [1, 2],
    );
  });

  it("replaces the list when the sample comes from another layer", () => {
    // Two variables share no y-axis, so charting them together would mislead.
    addNetcdfProfileSample(sample("a", 1));
    addNetcdfProfileSample(sample("b", 9));
    assert.deepEqual(
      getNetcdfProfileSamples().map((item) => [item.layerId, item.lng, item.order]),
      [["b", 9, 1]],
    );
  });

  it("drops the oldest sample past the cap, without renumbering the rest", () => {
    for (let i = 0; i <= MAX_PROFILE_SAMPLES; i++) addNetcdfProfileSample(sample("a", i));
    const kept = getNetcdfProfileSamples();
    assert.equal(kept.length, MAX_PROFILE_SAMPLES);
    assert.equal(kept[0].lng, 1);
    // The survivor keeps the number (and so the color) it was drawn with.
    assert.equal(kept[0].order, 2);
    assert.equal(kept[kept.length - 1].lng, MAX_PROFILE_SAMPLES);
  });

  it("attaches a profile to the sample it was read for", () => {
    const first = addNetcdfProfileSample(sample("a", 1));
    addNetcdfProfileSample(sample("a", 2));
    setNetcdfProfileSampleProfile(first, PROFILE);
    assert.deepEqual(
      getNetcdfProfileSamples().map((item) => item.profile?.values ?? null),
      [[0.1, 0.2], null],
    );
  });

  it("ignores a profile for a sample that is gone", () => {
    // A slow read whose pixel the user has since cleared must land nowhere
    // rather than charting a stale spectrum.
    const id = addNetcdfProfileSample(sample("a", 1));
    clearNetcdfProfileSamples();
    setNetcdfProfileSampleProfile(id, PROFILE);
    assert.deepEqual(getNetcdfProfileSamples(), []);
  });

  it("clears the samples and restarts numbering", () => {
    addNetcdfProfileSample(sample("a", 1));
    clearNetcdfProfileSamples();
    assert.deepEqual(getNetcdfProfileSamples(), []);
    addNetcdfProfileSample(sample("a", 5));
    assert.equal(getNetcdfProfileSamples()[0].order, 1);
  });

  it("never reissues an id, so a stale read cannot land on a later sample", () => {
    // Marker numbering restarts at 1 after a clear, but ids must not: a read
    // still in flight when the user cleared would otherwise resolve onto a new,
    // unrelated point that happened to recycle its number.
    const stale = addNetcdfProfileSample(sample("a", 1));
    clearNetcdfProfileSamples();
    const fresh = addNetcdfProfileSample(sample("a", 2));
    assert.notEqual(stale, fresh);
    assert.equal(getNetcdfProfileSamples()[0].order, 1);

    setNetcdfProfileSampleProfile(stale, PROFILE);
    assert.equal(getNetcdfProfileSamples()[0].profile, undefined);
  });

  it("never reissues an id after a per-layer clear either", () => {
    const stale = addNetcdfProfileSample(sample("a", 1));
    clearNetcdfProfileSamplesForLayer("a");
    const fresh = addNetcdfProfileSample(sample("a", 2));
    assert.notEqual(stale, fresh);
    setNetcdfProfileSampleProfile(stale, PROFILE);
    assert.equal(getNetcdfProfileSamples()[0].profile, undefined);
  });

  it("clears one layer's samples without touching another's", () => {
    // An off-grid click on the identify target must not wipe a chart another
    // layer's Style panel is still showing.
    addNetcdfProfileSample(sample("b", 9));
    clearNetcdfProfileSamplesForLayer("a");
    assert.deepEqual(
      getNetcdfProfileSamples().map((item) => [item.layerId, item.lng]),
      [["b", 9]],
    );
    clearNetcdfProfileSamplesForLayer("b");
    assert.deepEqual(getNetcdfProfileSamples(), []);
  });

  it("does not notify when a per-layer clear matches nothing", () => {
    addNetcdfProfileSample(sample("b", 9));
    let calls = 0;
    const unsubscribe = subscribeNetcdfProfile(() => calls++);
    clearNetcdfProfileSamplesForLayer("a");
    assert.equal(calls, 0);
    unsubscribe();
  });

  it("docks the chart when the samples are cleared", () => {
    addNetcdfProfileSample(sample("a", 1));
    setNetcdfProfilePoppedOut(true);
    clearNetcdfProfileSamples();
    assert.equal(isNetcdfProfilePoppedOut(), false);
  });

  it("docks the chart when a per-layer clear empties the list", () => {
    // Otherwise the window is left floating over the map with nothing in it.
    addNetcdfProfileSample(sample("a", 1));
    setNetcdfProfilePoppedOut(true);
    clearNetcdfProfileSamplesForLayer("a");
    assert.equal(isNetcdfProfilePoppedOut(), false);
    assert.deepEqual(getNetcdfProfileSamples(), []);
  });

  it("notifies subscribers, and stops after unsubscribe", () => {
    let calls = 0;
    const unsubscribe = subscribeNetcdfProfile(() => calls++);
    addNetcdfProfileSample(sample("a", 1));
    assert.equal(calls, 1);
    setNetcdfProfilePoppedOut(true);
    assert.equal(calls, 2);
    unsubscribe();
    addNetcdfProfileSample(sample("a", 2));
    assert.equal(calls, 2);
    setNetcdfProfilePoppedOut(false);
  });

  it("gives the number back when the newest sample is dropped", () => {
    // The COG path adds a marker on click and removes it if the read comes back
    // with nothing to chart. Without the rollback the next click is labelled
    // "3" beside a "1", and the series color, keyed off the number, skips too.
    addNetcdfProfileSample(sample("a", 1));
    const pending = addNetcdfProfileSample(sample("a", 2));
    removeNetcdfProfileSample(pending);
    addNetcdfProfileSample(sample("a", 3));
    assert.deepEqual(
      getNetcdfProfileSamples().map((item) => item.order),
      [1, 2],
    );
  });

  it("keeps the numbers of the samples it did not drop", () => {
    // Only the newest gives its number back: `order` is assigned once, so a
    // read that resolves after a later click leaves a gap rather than
    // renumbering points the user is already looking at.
    const first = addNetcdfProfileSample(sample("a", 1));
    addNetcdfProfileSample(sample("a", 2));
    removeNetcdfProfileSample(first);
    assert.deepEqual(
      getNetcdfProfileSamples().map((item) => item.order),
      [2],
    );
  });

  it("restarts numbering when the last sample is dropped", () => {
    const only = addNetcdfProfileSample(sample("a", 1));
    setNetcdfProfilePoppedOut(true);
    removeNetcdfProfileSample(only);
    addNetcdfProfileSample(sample("a", 2));
    assert.equal(getNetcdfProfileSamples()[0].order, 1);
    // Emptying the list docks the chart, as a full clear does — an empty window
    // stranded over the map is the thing being avoided.
    assert.equal(isNetcdfProfilePoppedOut(), false);
  });

  it("does not notify when removing an id that is not in the list", () => {
    addNetcdfProfileSample(sample("a", 1));
    let calls = 0;
    const unsubscribe = subscribeNetcdfProfile(() => calls++);
    removeNetcdfProfileSample(9999);
    assert.equal(calls, 0);
    unsubscribe();
  });

  it("does not notify when clearing an already-empty list", () => {
    let calls = 0;
    const unsubscribe = subscribeNetcdfProfile(() => calls++);
    clearNetcdfProfileSamples();
    assert.equal(calls, 0);
    unsubscribe();
  });
});
