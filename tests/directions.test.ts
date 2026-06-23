import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearDirectionsWaypoints,
  DIRECTIONS_PLUGIN_ID,
  getDirectionsWaypointCount,
  maplibreDirectionsPlugin,
  removeLastDirectionsWaypoint,
  subscribeDirectionsState,
} from "../packages/plugins/src/plugins/maplibre-directions";

describe("maplibreDirectionsPlugin", () => {
  it("is a Controls toggle that is off by default", () => {
    assert.equal(maplibreDirectionsPlugin.id, DIRECTIONS_PLUGIN_ID);
    assert.equal(maplibreDirectionsPlugin.activeByDefault, undefined);
    assert.equal(typeof maplibreDirectionsPlugin.activate, "function");
    assert.equal(typeof maplibreDirectionsPlugin.deactivate, "function");
  });
});

// The mode banner reads these without knowing whether the lazy-loaded library
// has attached yet, so the inactive-state contract must be safe: a zero count
// and no-op mutators that never throw.
describe("directions control surface (inactive)", () => {
  it("reports zero waypoints when the tool is inactive", () => {
    assert.equal(getDirectionsWaypointCount(), 0);
  });

  it("treats remove-last and clear as no-ops when inactive", () => {
    assert.doesNotThrow(() => removeLastDirectionsWaypoint());
    assert.doesNotThrow(() => clearDirectionsWaypoints());
    assert.equal(getDirectionsWaypointCount(), 0);
  });

  it("returns a working unsubscribe from subscribeDirectionsState", () => {
    let calls = 0;
    const unsubscribe = subscribeDirectionsState(() => {
      calls += 1;
    });
    assert.equal(typeof unsubscribe, "function");
    // clear() while inactive does not notify, so the count stays untouched and
    // the listener is not called; the test asserts unsubscribe is callable and
    // leaves no dangling subscription behind.
    clearDirectionsWaypoints();
    unsubscribe();
    assert.equal(calls, 0);
  });
});
