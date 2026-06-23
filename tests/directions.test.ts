import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearDirectionsWaypoints,
  DIRECTIONS_PLUGIN_ID,
  getDirectionsWaypointCount,
  isDirectionsRemovalInFlight,
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
    // A no-op removal must not leave the in-flight flag stuck on.
    assert.equal(isDirectionsRemovalInFlight(), false);
  });

  it("returns an idempotent unsubscribe from subscribeDirectionsState", () => {
    // The notify path needs a live routing instance (created by the lazy
    // import on activate), which the Playwright verification exercises end to
    // end. Here we only assert the subscribe contract that is reachable without
    // one: unsubscribe is a function and can be called repeatedly without
    // throwing, so a teardown that double-unsubscribes is safe.
    const unsubscribe = subscribeDirectionsState(() => {});
    assert.equal(typeof unsubscribe, "function");
    assert.doesNotThrow(() => {
      unsubscribe();
      unsubscribe();
    });
  });
});
