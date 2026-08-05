import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  clearNetcdfProfileReadings,
  clearNetcdfProfileReadingsForLayer,
  getNetcdfProfileReadings,
  MAX_PROFILE_READINGS,
  setNetcdfProfileReading,
  subscribeNetcdfProfileReadings,
  type NetcdfProfileReading,
} from "../apps/geolibre-desktop/src/lib/netcdf-profile-store";

/** A reading with just enough shape for the store's bookkeeping. */
function reading(layerId: string, lng: number): NetcdfProfileReading {
  return {
    layerId,
    variable: "reflectance",
    lng,
    lat: 0,
    profile: { axis: { name: "bands", size: 2 }, values: [0.1, 0.2] },
  };
}

describe("netcdf profile store", () => {
  beforeEach(() => clearNetcdfProfileReadings());

  it("accumulates readings from the same layer", () => {
    setNetcdfProfileReading(reading("a", 1));
    setNetcdfProfileReading(reading("a", 2));
    assert.deepEqual(
      getNetcdfProfileReadings().map((item) => item.lng),
      [1, 2],
    );
  });

  it("replaces the list when the reading comes from another layer", () => {
    // Two variables share no y-axis, so charting them together would mislead.
    setNetcdfProfileReading(reading("a", 1));
    setNetcdfProfileReading(reading("b", 9));
    assert.deepEqual(
      getNetcdfProfileReadings().map((item) => [item.layerId, item.lng]),
      [["b", 9]],
    );
  });

  it("drops the oldest reading past the cap", () => {
    for (let i = 0; i <= MAX_PROFILE_READINGS; i++) setNetcdfProfileReading(reading("a", i));
    const kept = getNetcdfProfileReadings();
    assert.equal(kept.length, MAX_PROFILE_READINGS);
    assert.equal(kept[0].lng, 1);
    assert.equal(kept[kept.length - 1].lng, MAX_PROFILE_READINGS);
  });

  it("clears on a null reading", () => {
    setNetcdfProfileReading(reading("a", 1));
    setNetcdfProfileReading(null);
    assert.deepEqual(getNetcdfProfileReadings(), []);
  });

  it("clears one layer's readings without touching another's", () => {
    // An off-grid click on the identify target must not wipe a chart another
    // layer's Style panel is still showing.
    setNetcdfProfileReading(reading("b", 9));
    clearNetcdfProfileReadingsForLayer("a");
    assert.deepEqual(
      getNetcdfProfileReadings().map((item) => [item.layerId, item.lng]),
      [["b", 9]],
    );
    clearNetcdfProfileReadingsForLayer("b");
    assert.deepEqual(getNetcdfProfileReadings(), []);
  });

  it("does not notify when a per-layer clear matches nothing", () => {
    setNetcdfProfileReading(reading("b", 9));
    let calls = 0;
    const unsubscribe = subscribeNetcdfProfileReadings(() => calls++);
    clearNetcdfProfileReadingsForLayer("a");
    assert.equal(calls, 0);
    unsubscribe();
  });

  it("notifies subscribers, and stops after unsubscribe", () => {
    let calls = 0;
    const unsubscribe = subscribeNetcdfProfileReadings(() => calls++);
    setNetcdfProfileReading(reading("a", 1));
    assert.equal(calls, 1);
    unsubscribe();
    setNetcdfProfileReading(reading("a", 2));
    assert.equal(calls, 1);
  });

  it("does not notify when clearing an already-empty list", () => {
    let calls = 0;
    const unsubscribe = subscribeNetcdfProfileReadings(() => calls++);
    setNetcdfProfileReading(null);
    assert.equal(calls, 0);
    unsubscribe();
  });
});
